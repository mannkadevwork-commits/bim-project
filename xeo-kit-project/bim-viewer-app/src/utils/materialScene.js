import { Texture } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/Texture';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';
import { NativeIFCMaterialController } from '../engine/NativeIFCMaterialController';

const nativeControllers = new WeakMap();
const rgbFallback = [1, 1, 1];

// Material applications can be asynchronous (especially native IFC wall
// overlays). Keep a per-viewer/per-target generation so an older operation
// can never repaint the scene after a newer undo/redo restore has started.
const materialGenerations = new WeakMap();
// Keep the original Xeokit material/colorize per object so undoing the first
// material assignment can restore the actual scene baseline (not only React state).
const materialBaselines = new WeakMap();
// Targets touched by this material layer, including direct UI applies that can
// race with the React project-state effect. This makes undo reconciliation robust.
const knownMaterialTargets = new WeakMap();

const getGenerationMap = (viewer) => {
  let map = materialGenerations.get(viewer);
  if (!map) {
    map = new Map();
    materialGenerations.set(viewer, map);
  }
  return map;
};

const getBaselineMap = (viewer) => {
  let map = materialBaselines.get(viewer);
  if (!map) {
    map = new Map();
    materialBaselines.set(viewer, map);
  }
  return map;
};

const getKnownTargetSet = (viewer) => {
  let targets = knownMaterialTargets.get(viewer);
  if (!targets) {
    targets = new Set();
    knownMaterialTargets.set(viewer, targets);
  }
  return targets;
};

const cloneColorize = (value) => {
  if (Array.isArray(value)) return [...value];
  if (ArrayBuffer.isView(value)) return Array.from(value);
  return value;
};

const captureMaterialBaseline = (viewer, object) => {
  if (!viewer || !object?.id) return;
  const baselines = getBaselineMap(viewer);
  const cached = baselines.get(object.id);
  // Object IDs can be reused after a project/IFC reload. Never carry the old
  // model's baseline onto a different SceneObject instance.
  if (cached?.object === object) return;
  baselines.set(object.id, {
    object,
    material: object.material,
    colorize: cloneColorize(object.colorize),
  });
};

const disposeOwnedMaterial = (material) => {
  if (!material?._hciOwned) return;
  const diffuseMap = material._hciDiffuseMap || material.diffuseMap;
  try { diffuseMap?.destroy?.(); } catch (_) {}
  try { material.destroy?.(); } catch (_) {}
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

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function canonicalMaterialTexturePath(source) {
  if (!source) return null;
  const clean = String(source).split('?')[0].split('#')[0];
  if (/^https?:\/\//i.test(clean)) {
    try {
      const url = new URL(clean);
      return url.pathname.startsWith('/assets/') ? url.pathname : null;
    } catch (_) {
      return null;
    }
  }
  return clean.startsWith('/') ? clean : `/${clean}`;
}

function resolveMaterialTextureUrl(source) {
  if (!source) return null;
  if (/^https?:\/\//i.test(String(source))) {
    const canonicalPath = canonicalMaterialTexturePath(source);
    return canonicalPath?.startsWith('/assets/')
      ? `${API_BASE_URL.replace(/\/$/, '')}${canonicalPath}`
      : source;
  }
  if (String(source).startsWith('/assets/')) return `${API_BASE_URL.replace(/\/$/, '')}${source}`;
  return source;
}

const normalizeBaseMaterialDefinition = (definition) => {
  const kind = ['color', 'fabric', 'texture'].includes(definition?.kind) ? definition.kind : 'color';
  const id = definition?.id || definition?.textureId || definition?.texture?.id || null;
  const name = definition?.name || definition?.texture?.name || null;
  const rawRepeat = Array.isArray(definition?.repeat)
    ? definition.repeat
    : Array.isArray(definition?.texture?.repeat) ? definition.texture.repeat : [2, 2];
  const repeat = [0, 1].map((index) => {
    const value = Number(rawRepeat[index]);
    return Number.isFinite(value) && value >= 0.05 ? Math.min(100, value) : 2;
  });
  // texture.src is the portable compiler path. textureSrc is resolved for the browser.
  const storedTexturePath = canonicalMaterialTexturePath(
    definition?.texture?.src || definition?.texturePath || definition?.textureSrc
  );
  const browserTextureSource = resolveMaterialTextureUrl(
    definition?.textureSrc || definition?.texture?.browserSrc || storedTexturePath
  );
  const texture = kind !== 'color' && storedTexturePath
    ? { id, name, src: storedTexturePath, repeat: [...repeat] }
    : null;

  return {
    kind,
    id,
    name,
    brand: definition?.brand || null,
    collection: definition?.collection || null,
    shadeCode: definition?.shadeCode || definition?.shade_code || null,
    sourceDocument: definition?.sourceDocument || definition?.source_document || null,
    sourcePage: definition?.sourcePage || definition?.source_page || null,
    hexSource: definition?.hexSource || definition?.hex_source || 'manual',
    color: definition?.color || '#FFFFFF',
    rgb: Array.isArray(definition?.rgb) ? definition.rgb : rgbFallback,
    textureSrc: browserTextureSource,
    texture,
    repeat,
    roughness: Number.isFinite(definition?.roughness) ? definition.roughness : 0.8,
    metallic: Number.isFinite(definition?.metallic) ? definition.metallic : 0,
  };
};

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
  getKnownTargetSet(viewer).add(targetId);
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
      // A scoped native IFC finish must never fall through to colorize, because
      // colorize paints the whole element and would violate Interior/Exterior.
      // Only unscoped native-element colors may use the legacy fallback.
      if (materialDef.kind !== 'color' || materialDef.surfaceScope === 'scoped' ||
          ['interior', 'exterior', 'both'].includes(materialDef.surfaceScope)) return false;
    }
  }

  if (!isCurrent()) return false;
  const targets = resolveTargets(viewer, targetId);
  if (!targets.length) return false;
  targets.forEach((object) => captureMaterialBaseline(viewer, object));

  try {
    let diffuseMap = null;
    if (materialDef.textureSrc) {
      const image = await loadImage(materialDef.textureSrc);
      if (!isCurrent()) return false;
      diffuseMap = new Texture(viewer.scene, {
        image,
        // Match the texture repeat values applied by the final GLB compiler.
        scale: materialDef.repeat,
      });
    }

    const material = new PhongMaterial(viewer.scene, {
      // Keep diffuse neutral for textured materials; use rgb only for color materials.
      diffuse: materialDef.textureSrc ? [1, 1, 1] : materialDef.rgb,
      emissive: [0, 0, 0],
      shininess: Math.max(8, Math.round((1 - materialDef.roughness) * 100)),
      ...(diffuseMap ? { diffuseMap } : {}),
    });
    material._hciOwned = true;
    if (diffuseMap) material._hciDiffuseMap = diffuseMap;

    if (!isCurrent()) {
      try { material.destroy(); } catch (_) {}
      try { diffuseMap?.destroy(); } catch (_) {}
      return false;
    }

    const disposedPreviousMaterials = new Set();
    targets.forEach(object => {
      try {
        const previous = object.material;
        object.material = material;
        if (previous && previous !== material && previous._hciOwned && !disposedPreviousMaterials.has(previous)) {
          disposedPreviousMaterials.add(previous);
          disposeOwnedMaterial(previous);
        }
      } catch (_) {}
      try { object.colorize = materialDef.textureSrc ? [1, 1, 1] : materialDef.rgb; } catch (_) {}
    });
    return true;
  } catch (error) {
    // An undo/redo may have superseded this async texture load. Do not let a
    // late failure paint its color fallback over the newer restored state.
    if (!isCurrent()) return false;
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

/**
 * Restore the original viewport material for a target after its material entry
 * is removed by undo/redo. Native IFC wall finishes are overlays, so clearing
 * their overlay reveals the untouched source wall; generic objects need their
 * original material and colorize restored explicitly.
 */
export const clearMaterialDefinitionFromSceneTarget = (viewer, targetId) => {
  if (!viewer || !targetId) return;

  clearNativeIFCMaterialOverride(viewer, targetId);

  const baselines = getBaselineMap(viewer);
  const targets = resolveTargets(viewer, targetId);
  const disposedMaterials = new Set();
  targets.forEach((object) => {
    const baseline = baselines.get(object?.id);
    if (!baseline || baseline.object !== object) return;

    const currentMaterial = object.material;
    if (currentMaterial && currentMaterial !== baseline.material && currentMaterial._hciOwned && !disposedMaterials.has(currentMaterial)) {
      disposedMaterials.add(currentMaterial);
      disposeOwnedMaterial(currentMaterial);
    }

    try { object.material = baseline.material; } catch (error) {
      console.warn('[Material] Could not restore original material:', object.id, error);
    }
    try {
      // Xeokit objects normally expose an initial colorize array. Preserve it
      // exactly, with white as a safe reset for older objects lacking a value.
      object.colorize = cloneColorize(baseline.colorize) ?? [1, 1, 1];
    } catch (error) {
      console.warn('[Material] Could not restore original colorize:', object.id, error);
    }
    baselines.delete(object.id);
  });

  getKnownTargetSet(viewer).delete(targetId);
};

/**
 * Reconcile runtime material overrides to the project-state snapshot. This is
 * deliberately authoritative: targets touched by an earlier state but absent
 * from the next snapshot are restored to baseline, which is essential for undo.
 */
export const reconcileMaterialDefinitionsToScene = (viewer, definitions = {}) => {
  if (!viewer) return;
  const entries = Object.entries(definitions || {}).filter(([targetId, definition]) => targetId && definition);
  const desiredIds = new Set(entries.map(([targetId]) => targetId));
  const knownTargets = getKnownTargetSet(viewer);

  [...knownTargets].forEach((targetId) => {
    if (!desiredIds.has(targetId)) clearMaterialDefinitionFromSceneTarget(viewer, targetId);
  });

  entries.forEach(([targetId, definition]) => {
    void applyMaterialDefinitionToSceneTarget(viewer, targetId, definition).catch((error) => {
      console.warn('[Material] Failed to reconcile material from project state:', targetId, error);
    });
  });
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
