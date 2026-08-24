import { Texture } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/Texture';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';
import { NativeIFCMaterialController } from '../engine/NativeIFCMaterialController';

const nativeControllers = new WeakMap();
const rgbFallback = [1, 1, 1];

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

export const normalizeMaterialDefinition = (definition) => ({
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

export const applyMaterialDefinitionToSceneTarget = async (viewer, targetId, definition) => {
  if (!viewer || !targetId || !definition) return false;
  const materialDef = normalizeMaterialDefinition(definition);

  const nativeController = nativeControllers.get(viewer);
  if (nativeController) {
    const nativeResult = await nativeController.apply(targetId, materialDef);
    if (nativeResult.handled) {
      if (nativeResult.applied) return true;
      // Color on native IFC falls through to the existing proven colorize path.
      if (materialDef.kind !== 'color') return false;
    }
  }

  const targets = resolveTargets(viewer, targetId);
  if (!targets.length) return false;

  try {
    let diffuseMap = null;
    if (materialDef.textureSrc) {
      const image = await loadImage(materialDef.textureSrc);
      diffuseMap = new Texture(viewer.scene, { image });
    }

    const material = new PhongMaterial(viewer.scene, {
      diffuse: materialDef.textureSrc ? [1, 1, 1] : materialDef.rgb,
      emissive: [0, 0, 0],
      shininess: Math.max(8, Math.round((1 - materialDef.roughness) * 100)),
      ...(diffuseMap ? { diffuseMap } : {}),
    });
    material._hciOwned = true;

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
