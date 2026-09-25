import { Texture } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/Texture';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';
import { NativeIFCMaterialController } from '../engine/NativeIFCMaterialController';

const nativeControllers = new WeakMap();
const rgbFallback = [1, 1, 1];

// Material applications can be asynchronous (especially native IFC wall
// overlays). Keep a per-viewer/per-target generation so an older operation
// can never repaint the scene after a newer undo/redo restore has started.
const materialGenerations = new WeakMap();

const getGenerationMap = (viewer) => {
  let map = materialGenerations.get(viewer);
  if (!map) {
    map = new Map();
    materialGenerations.set(viewer, map);
  }
  return map;
};

const beginMaterialMutation = (viewer, targetId) => {
  const map = getGenerationMap(viewer);
  const next = (map.get(targetId) || 0) + 1;
  map.set(targetId, next);
  return next;
};

const isMaterialMutationCurrent = (viewer, targetId, generation) => {
  return getGenerationMap(viewer).get(targetId) === generation;
};

export const invalidateMaterialMutations = (viewer, targetIds = null) => {
  if (!viewer) return;
  const map = getGenerationMap(viewer);
  if (Array.isArray(targetIds) && targetIds.length) {
    targetIds.forEach((targetId) => beginMaterialMutation(viewer, targetId));
    return;
  }

  // Bump every target currently known to the material layer. This is used by
  // full project reconciliation before undo/redo restores the authored state.
  [...map.keys()].forEach((targetId) => beginMaterialMutation(viewer, targetId));
};

export const configureNativeIFCMaterialController = (viewer, ifcAPI, ifcData, modelId = 'main_structure') => {
  if (!viewer) return null;
  let controller = nativeControllers.get(viewer);
  if (!controller) {
    controller = new NativeIFCMaterialController(viewer);
    nativeControllers.set(viewer, controller);
  }
  if (ifcAPI && ifcData) controller.setSource(ifcAPI, ifcData, modelId);
  return controller;
};

export const disposeNativeIFCMaterialController = (viewer) => {
  const controller = nativeControllers.get(viewer);
  if (!controller) return;
  controller.clearSource();
  nativeControllers.delete(viewer);
};

const normalizeBaseMaterialDefinition = (definition) => ({
  kind: ['color', 'fabric', 'texture'].includes(definition?.kind) ? definition.kind : 'color',
  id: definition?.id || definition?.textureId || definition?.texture?.id || null,
  name: definition?.name || definition?.texture?.name || null,
  color: definition?.color || '#FFFFFF',
  rgb: Array.isArray(definition?.rgb) ? definition.rgb : rgbFallback,
  textureSrc: definition?.textureSrc || definition?.texture?.src || null,
  repeat: Array.isArray(definition?.repeat)
    ? definition.repeat
    : Array.isArray(definition?.texture?.repeat) ? definition.texture.repeat : [2, 2],
  roughness: Number.isFinite(definition?.roughness) ? definition.roughness : 0.8,
  metallic: Number.isFinite(definition?.metallic) ? definition.metallic : 0,
});

export const normalizeMaterialDefinition = (definition) => {
  const base = normalizeBaseMaterialDefinition(definition);
  const normalized = {
    ...base,
    surfaceScope: ['interior', 'exterior', 'both', 'scoped'].includes(definition?.surfaceScope)
      ? definition.surfaceScope
      : null,
  };

  if (definition?.surfaces && typeof definition.surfaces === 'object') {
    normalized.surfaces = {
      interior: definition.surfaces.interior ? normalizeBaseMaterialDefinition(definition.surfaces.interior) : null,
      exterior: definition.surfaces.exterior ? normalizeBaseMaterialDefinition(definition.surfaces.exterior) : null,
    };
  }

  return normalized;
};

const resolveTargets = (viewer, targetId) => {
  const direct = viewer?.scene?.objects?.[targetId];
  if (direct) return [direct];
  const model = viewer?.scene?.models?.[targetId];
  if (model) return Object.values(viewer.scene.objects || {}).filter(o => o?.model?.id === targetId);
  return [];
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`Failed to load material texture: ${src}`));
  image.src = src;
});

export const applyMaterialDefinitionToSceneTarget = async (viewer, targetId, definition, options = {}) => {
  if (!viewer || !targetId || !definition) return false;
  const materialDef = normalizeMaterialDefinition(definition);
  const generation = beginMaterialMutation(viewer, targetId);
  const callerIsCurrent = typeof options?.isCurrent === 'function' ? options.isCurrent : () => true;
  const isCurrent = () => callerIsCurrent() && isMaterialMutationCurrent(viewer, targetId, generation);

  const nativeController = nativeControllers.get(viewer);
  if (nativeController) {
    const nativeResult = await nativeController.apply(targetId, materialDef, { ...options, isCurrent });
    if (nativeResult.handled) {
      if (nativeResult.applied) return true;
      if (!isCurrent()) return false;
      // Color on native IFC falls through to the existing proven colorize path.
      if (materialDef.kind !== 'color') return false;
    }
  }

  if (!isCurrent()) return false;
  const targets = resolveTargets(viewer, targetId);
  if (!targets.length) return false;

  try {
    let diffuseMap = null;
    if (materialDef.textureSrc) {
      const image = await loadImage(materialDef.textureSrc);
      if (!isCurrent()) return false;
      diffuseMap = new Texture(viewer.scene, { image });
    }

    const material = new PhongMaterial(viewer.scene, {
      diffuse: materialDef.textureSrc ? [1, 1, 1] : materialDef.rgb,
      emissive: [0, 0, 0],
      shininess: Math.max(8, Math.round((1 - materialDef.roughness) * 100)),
      ...(diffuseMap ? { diffuseMap } : {}),
    });
    material._hciOwned = true;

    if (!isCurrent()) {
      try { material.destroy(); } catch (_) {}
      try { diffuseMap?.destroy(); } catch (_) {}
      return false;
    }

    targets.forEach(object => {
      try {
        const previous = object.material;
        object.material = material;
        if (previous && previous !== material && previous._hciOwned) {
          try { previous.destroy(); } catch (_) {}
        }
      } catch (_) {}
      try { object.colorize = materialDef.textureSrc ? [1, 1, 1] : materialDef.rgb; } catch (_) {}
    });
    return true;
  } catch (error) {
    console.warn('[Material] Texture application failed, keeping color fallback.', error);
    targets.forEach(object => {
      try { object.colorize = materialDef.rgb; } catch (_) {}
    });
    return false;
  }
};

export const applyMaterialDefinitionToObjects = async (viewer, targetIds, definition) => {
  let changed = 0;
  for (const id of (Array.isArray(targetIds) ? targetIds : [])) {
    if (await applyMaterialDefinitionToSceneTarget(viewer, id, definition)) changed += 1;
  }
  return changed;
};

export const clearNativeIFCMaterialOverride = (viewer, targetId) => {
  if (!viewer || !targetId) return;

  // Invalidate any in-flight native material operation for this target first.
  // This prevents a late async color/texture job from recreating the overlay
  // immediately after the user deletes the wall.
  invalidateMaterialMutations(viewer, [targetId]);

  const controller = nativeControllers.get(viewer);
  if (!controller) return;

  try {
    controller.destroyOverlay(targetId);
  } catch (error) {
    console.warn('[Material] Failed to clear native IFC material overlay:', targetId, error);
  }
};

export const clearNativeIFCMaterialOverrides = (viewer) => {
  if (!viewer) return;
  // Cancel outstanding async native/generic material work before the scene
  // baseline is restored. Without this, a late texture/geometry promise can
  // repaint a wall immediately after Ctrl+Z.
  invalidateMaterialMutations(viewer);

  const controller = nativeControllers.get(viewer);
  if (!controller) return;
  try {
    controller.clearAll();
  } catch (error) {
    console.warn('[Material] Failed to clear native IFC material overrides.', error);
  }
};
