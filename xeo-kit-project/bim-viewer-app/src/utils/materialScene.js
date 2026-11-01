import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh';
import { Texture } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/Texture';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';
import { MetallicMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/MetallicMaterial';
import { sRGBEncoding } from '@xeokit/xeokit-sdk/src/viewer/scene/constants/constants.js';
import { NativeIFCMaterialController } from '../engine/NativeIFCMaterialController';
import { applyGLBSceneModelMaterial, clearGLBSceneModelMaterial } from '../engine/assets/GLBMaterialPreview';

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
// GLB materials are rendered by Xeokit Mesh instances. Mesh.material is a
// getter-only property, so replacing object.material cannot work. Instead we
// add a render-only overlay Mesh that shares the source geometry/UVs and uses
// the selected PBR finish. The source mesh remains alive/pickable for selection,
// transforms, visibility and project identity.
const glbMaterialOverrides = new WeakMap();

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

const getGLBOverrideMap = (viewer) => {
  let overrides = glbMaterialOverrides.get(viewer);
  if (!overrides) {
    overrides = new Map();
    glbMaterialOverrides.set(viewer, overrides);
  }
  return overrides;
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
  // The editor may create either a legacy Phong material (IFC / non-PBR
  // entities) or a PBR MetallicMaterial (GLB furniture). Keep explicit
  // references to the textures we own so undo/redo does not leak GPU memory.
  const textureMap = material._hciTextureMap
    || material._hciDiffuseMap
    || material.diffuseMap
    || material.baseColorMap;
  try { textureMap?.destroy?.(); } catch (_) {}
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

const isRenderableMesh = (object) => Boolean(
  object
  && object.isMesh === true
  && object.geometry
  && object.material
);

const resolveTargets = (viewer, targetId) => {
  const scene = viewer?.scene;
  if (!scene || !targetId) return [];

  const model = scene.models?.[targetId];
  const direct = scene.objects?.[targetId];

  // A catalogued GLB is selected by its SceneModel ID. Its renderable pieces
  // are the child Mesh/Entity objects, not the SceneModel root. Use the same
  // ownership relation as useBIMEngine's editable-asset selection code.
  if (model) {
    const candidates = new Set();
    const sceneObjects = Object.values(scene.objects || {});
    const modelObjects = model.objects instanceof Map
      ? Array.from(model.objects.values())
      : Array.isArray(model.objects)
        ? model.objects
        : Object.values(model.objects || {});
    const sceneComponents = Object.values(scene.components || {});

    const belongsToModel = (object) => {
      if (!object || object === model || object.id === targetId) return false;
      if (object.model === model || object.model?.id === targetId) return true;

      // GLTF hierarchy can use unnamed parent nodes between the model and a
      // named mesh. Walk ancestors without assuming every node is registered
      // in scene.objects.
      let parent = object.parent;
      const visited = new Set();
      while (parent && !visited.has(parent)) {
        if (parent === model || parent.id === targetId || parent.model === model) return true;
        visited.add(parent);
        parent = parent.parent;
      }
      return false;
    };

    [...sceneObjects, ...modelObjects, ...sceneComponents].forEach((object) => {
      if (object !== model
          && object?._hciMaterialOverlay !== true
          && isRenderableMesh(object)
          && belongsToModel(object)) {
        candidates.add(object);
      }
    });

    // A few GLTFLoaderPlugin versions expose an entity list only on model.objects.
    // Since those entries came from the requested model, accept its renderable
    // children even if the SDK version does not expose object.model.
    modelObjects.forEach((object) => {
      if (object !== model && object?._hciMaterialOverlay !== true && isRenderableMesh(object)) candidates.add(object);
    });

    if (candidates.size) return [...candidates];

    // Some single-node GLBs expose their only drawable directly as the model.
    // Only use the root if it has actual triangles and there are no child meshes.
    if (direct === model && isRenderableMesh(model) && Number(model.numTriangles) > 0) {
      return [model];
    }
    return [];
  }

  // IFC elements are directly addressable entities and remain on the existing
  // native IFC/Phong path.
  return direct ? [direct] : [];
};

const isPBRAssetTarget = (viewer, targetId, targets) => {
  const model = viewer?.scene?.models?.[targetId]
    || targets.find((object) => object?.model)?.model
    || null;
  const meta = model?._assetMeta || {};
  const format = String(meta.assetFormat || meta.fileType || meta.file_type || '').toLowerCase();
  if (format === 'glb' || format === 'gltf' || meta.instanceId) return true;

  // A main-model GLB may not have _assetMeta because it is loaded via the main
  // project path. Its GLTFLoaderPlugin-created child materials still identify
  // the PBR workflow reliably.
  return targets.some((object) => {
    const material = object?.material;
    const typeName = String(material?.type || material?.constructor?.name || '').toLowerCase();
    try {
      if (material?.isType?.('MetallicMaterial') || material?.isType?.('SpecularMaterial')) return true;
    } catch (_) {}
    return typeName.includes('metallicmaterial') || typeName.includes('specularmaterial');
  });
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`Failed to load material texture: ${src}`));
  image.src = src;
});


const cloneVector = (value) => (
  Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : undefined
);

const destroyGLBOverrideRecord = (record, { restoreSources = true } = {}) => {
  if (!record) return;

  (record.entries || []).forEach((entry) => {
    // Restore the original mesh only when removing an override (undo/redo or
    // clear). During a successful finish-to-finish swap, keep source meshes
    // hidden so the new coplanar overlay remains the visible surface.
    if (restoreSources && entry.source && entry.sourceVisibleBefore !== undefined) {
      try { entry.source.visible = entry.sourceVisibleBefore; } catch (_) {}
    }

    try {
      if (entry.visibilitySubscription && entry.source?.off) {
        entry.source.off(entry.visibilitySubscription);
      }
    } catch (_) {}
    try { entry.mesh?.destroy?.(); } catch (_) {}
    try { entry.material?.destroy?.(); } catch (_) {}
  });

  try { record.texture?.destroy?.(); } catch (_) {}
};

const sameObjectList = (left = [], right = []) => (
  left.length === right.length && left.every((object, index) => object === right[index])
);

const sourcePBRMaterialConfig = (sourceMaterial, materialDef, textureMap) => {
  const config = {
    // Image-based finishes use their texture's authored colors. The library HEX
    // is descriptive/sample metadata, not a tint; neutral factor prevents darkening.
    // This rule is matched in the backend compiler for final-render parity.
    baseColor: textureMap ? [1, 1, 1] : materialDef.rgb,
    ...(textureMap ? { baseColorMap: textureMap } : {}),
    // The selected surface finish owns the base-color, roughness and metallic
    // response. Preserve useful geometric detail maps from the authored GLB.
    metallic: Math.max(0, Math.min(1, Number(materialDef.metallic) || 0)),
    roughness: Math.max(0, Math.min(1, Number.isFinite(materialDef.roughness) ? materialDef.roughness : 0.8)),
    emissive: [0, 0, 0],
    alpha: Number.isFinite(sourceMaterial?.alpha) ? sourceMaterial.alpha : 1,
    alphaMode: sourceMaterial?.alphaMode || 'opaque',
    backfaces: Boolean(sourceMaterial?.backfaces),
    specularF0: Number.isFinite(sourceMaterial?.specularF0) ? sourceMaterial.specularF0 : 0,
  };
  // These map getters are intentionally read-only in Xeokit. Copy them into
  // the new material at construction instead of trying to assign to them.
  ['normalMap', 'occlusionMap', 'alphaMap'].forEach((key) => {
    try {
      if (sourceMaterial?.[key]) config[key] = sourceMaterial[key];
    } catch (_) {}
  });
  if (sourceMaterial?.frontface) config.frontface = sourceMaterial.frontface;
  if (Number.isFinite(sourceMaterial?.alphaCutoff)) config.alphaCutoff = sourceMaterial.alphaCutoff;
  return config;
};

const createGLBOverlayEntry = (viewer, targetId, source, materialDef, textureMap, meshIndex, sourceVisibleBefore = true) => {
  const sourceMaterial = source.material;
  const material = new MetallicMaterial(
    viewer.scene,
    sourcePBRMaterialConfig(sourceMaterial, materialDef, textureMap),
  );

  const matrix = cloneVector(source.matrix);
  const offset = cloneVector(source.offset);
  const origin = cloneVector(source.origin);
  const meshConfig = {
    id: `hci_glb_finish_${String(targetId).replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}_${meshIndex}_${Math.random().toString(36).slice(2, 7)}`,
    geometry: source.geometry,
    material,
    parent: source.parent || undefined,
    ...(matrix?.length === 16 ? { matrix } : {
      position: cloneVector(source.position) || [0, 0, 0],
      rotation: cloneVector(source.rotation) || [0, 0, 0],
      scale: cloneVector(source.scale) || [1, 1, 1],
      ...(cloneVector(source.quaternion)?.length === 4 ? { quaternion: cloneVector(source.quaternion) } : {}),
    }),
    ...(origin?.length >= 3 ? { origin } : {}),
    ...(offset?.length >= 3 ? { offset } : {}),
    // The overlay becomes the renderable/pickable surface while the source
    // mesh is temporarily hidden. Two opaque coplanar meshes cannot reliably
    // overlay one another: the source wins the depth test even if `layer` differs.
    // Register the overlay as an object so picking still resolves to its parent
    // GLB model and transforms/selection continue to target the original asset.
    isObject: true,
    pickable: source.pickable !== false,
    collidable: false,
    occluder: false,
    clippable: source.clippable !== false,
    castsShadow: source.castsShadow !== false,
    receivesShadow: source.receivesShadow !== false,
    visible: false, // revealed atomically once every overlay mesh is ready
    colorize: [1, 1, 1],
    opacity: Number.isFinite(source._hciSelectionVisualBackup?.opacity)
      ? source._hciSelectionVisualBackup.opacity
      : (Number.isFinite(source.opacity) ? source.opacity : 1),
    edges: false,
    layer: Number.isFinite(Number(source.layer)) ? Number(source.layer) : 0,
  };

  try {
    const mesh = new Mesh(viewer.scene, meshConfig);
    // Tag the overlay so it is never re-discovered as a source mesh when the
    // user changes finish or undo/redo reconciles the same target.
    mesh._hciMaterialOverlay = true;
    mesh._hciMaterialTargetId = targetId;
    mesh._hciMaterialSource = source;
    // Do not subscribe overlay visibility directly to source.visible: the
    // source is intentionally hidden while this overlay is active. Mirroring
    // that event would hide the finish too (the previous implementation's bug).
    return { source, mesh, material, visibilitySubscription: null, sourceVisibleBefore };
  } catch (error) {
    try { material.destroy(); } catch (_) {}
    throw error;
  }
};

const applyGLBMaterialOverlay = async (viewer, targetId, targets, materialDef, isCurrent) => {
  const overrideMap = getGLBOverrideMap(viewer);
  const renderableTargets = [...new Set(targets)].filter((object) => (
    object && object._hciMaterialOverlay !== true
      && object.isMesh === true && object.geometry && object.material
  ));

  if (!renderableTargets.length) {
    console.warn('[Material] GLB material target contains no renderable child meshes; finish was not applied.', {
      targetId,
      resolvedTargetCount: targets.length,
      sceneModelFound: Boolean(viewer?.scene?.models?.[targetId]),
      sceneObjectIds: Object.keys(viewer?.scene?.objects || {}).filter((id) => {
        const object = viewer?.scene?.objects?.[id];
        return object?.model?.id === targetId || object?.model === viewer?.scene?.models?.[targetId];
      }),
    });
    return false;
  }

  if (materialDef.kind !== 'color' && !materialDef.textureSrc) {
    console.warn('[Material] GLB fabric/texture finish has no image URL; preview was not changed.', {
      targetId,
      kind: materialDef.kind,
      texture: materialDef.texture,
    });
    return false;
  }

  const signature = JSON.stringify(materialDef);
  const existing = overrideMap.get(targetId);
  if (existing?.signature === signature
      && sameObjectList(existing.sources, renderableTargets)
      && existing.entries?.every((entry) => entry.mesh && !entry.mesh.destroyed)) {
    // Reassert the paired visibility state in case a selection/restore operation
    // toggled the source entity since the previous application.
    existing.entries.forEach((entry) => {
      try { entry.source.visible = false; } catch (_) {}
      try { entry.mesh.visible = entry.sourceVisibleBefore !== false; } catch (_) {}
    });
    return true;
  }

  // Reapplying another finish must preserve the visibility baseline recorded by
  // the first override, not treat the intentionally hidden source as originally
  // hidden. Otherwise every subsequent material click would make the overlay
  // invisible.
  const previousVisibility = new Map(
    (existing?.entries || []).map((entry) => [entry.source, entry.sourceVisibleBefore])
  );

  let textureMap = null;
  const nextRecord = {
    signature,
    sources: [...renderableTargets],
    entries: [],
    texture: null,
  };

  try {
    if (materialDef.kind !== 'color' && materialDef.textureSrc) {
      const image = await loadImage(materialDef.textureSrc);
      if (!isCurrent()) return false;
      if (!image?.naturalWidth || !image?.naturalHeight) {
        throw new Error(`Texture image decoded with invalid dimensions: ${materialDef.textureSrc}`);
      }
      textureMap = new Texture(viewer.scene, {
        image,
        encoding: sRGBEncoding,
        scale: materialDef.repeat,
      });
      nextRecord.texture = textureMap;
    }

    if (!isCurrent()) {
      destroyGLBOverrideRecord(nextRecord, { restoreSources: false });
      return false;
    }

    renderableTargets.forEach((source, index) => {
      const sourceVisibleBefore = previousVisibility.has(source)
        ? previousVisibility.get(source)
        : source.visible !== false;
      nextRecord.entries.push(
        createGLBOverlayEntry(
          viewer,
          targetId,
          source,
          materialDef,
          textureMap,
          index,
          sourceVisibleBefore,
        )
      );
    });

    if (!isCurrent()) {
      destroyGLBOverrideRecord(nextRecord, { restoreSources: false });
      return false;
    }

    // Swap atomically. Show each overlay and hide its original source mesh in
    // the same task: this removes coplanar depth fighting and makes colors as
    // well as textures visible in the editor viewport.
    nextRecord.entries.forEach((entry) => {
      entry.mesh.visible = entry.sourceVisibleBefore !== false;
      if (entry.sourceVisibleBefore !== false) {
        try { entry.source.visible = false; } catch (_) {}
      }
    });

    overrideMap.set(targetId, nextRecord);
    destroyGLBOverrideRecord(existing, { restoreSources: false });

    console.info('[Material] Applied GLB finish using visible UV-mapped editor overlays.', {
      targetId,
      kind: materialDef.kind,
      textureSrc: materialDef.textureSrc,
      meshCount: renderableTargets.length,
      textured: Boolean(textureMap),
      overlayIds: nextRecord.entries.map((entry) => entry.mesh?.id),
    });
    return true;
  } catch (error) {
    destroyGLBOverrideRecord(nextRecord, { restoreSources: false });
    if (isCurrent()) {
      console.error('[Material] GLB finish preview failed.', {
        targetId,
        textureSrc: materialDef.textureSrc,
        error: error?.message || String(error),
      });
    }
    return false;
  }
};

const clearGLBMaterialOverlay = (viewer, targetId) => {
  const overrides = getGLBOverrideMap(viewer);
  const record = overrides.get(targetId);
  if (!record) return false;
  overrides.delete(targetId);
  destroyGLBOverrideRecord(record);
  return true;
};

export const applyMaterialDefinitionToSceneTarget = async (viewer, targetId, definition, options = {}) => {
  if (!viewer || !targetId || !definition) return false;
  getKnownTargetSet(viewer).add(targetId);
  const materialDef = normalizeMaterialDefinition(definition);
  const generation = beginMaterialMutation(viewer, targetId);
  const callerIsCurrent = typeof options?.isCurrent === 'function' ? options.isCurrent : () => true;
  const isCurrent = () => callerIsCurrent() && isMaterialMutationCurrent(viewer, targetId, generation);

  // GLTFLoaderPlugin models are GPU-batched SceneModels, not ordinary Mesh
  // components. Handle catalogue GLBs through the dedicated preview adapter
  // before the IFC/legacy object-material path below.
  const glbSceneModelResult = await applyGLBSceneModelMaterial(viewer, targetId, materialDef, isCurrent);
  if (glbSceneModelResult.handled) return glbSceneModelResult.applied;

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
  if (!targets.length) {
    console.warn('[Material] No renderable scene objects found for material target.', { targetId });
    return false;
  }

  const pbrTarget = isPBRAssetTarget(viewer, targetId, targets);
  if (pbrTarget) {
    // GLTFLoaderPlugin meshes expose material as a getter-only property. Their
    // materials and map slots cannot be replaced by object.material = ...;
    // a same-geometry overlay is the supported way to preserve selection and
    // transforms while previewing the chosen UV-mapped surface finish.
    return applyGLBMaterialOverlay(viewer, targetId, targets, materialDef, isCurrent);
  }

  targets.forEach((object) => captureMaterialBaseline(viewer, object));
  let textureMap = null;
  let material = null;
  try {
    if (materialDef.textureSrc) {
      const image = await loadImage(materialDef.textureSrc);
      if (!isCurrent()) return false;
      if (!image?.naturalWidth || !image?.naturalHeight) {
        throw new Error(`Texture image decoded with invalid dimensions: ${materialDef.textureSrc}`);
      }
      textureMap = new Texture(viewer.scene, {
        image,
        // These are color/albedo textures. sRGB is important for fabrics,
        // wood and tile images to match the final Three.js render.
        encoding: sRGBEncoding,
        // Keep repeat settings consistent with the final GLB compiler.
        scale: materialDef.repeat,
      });
    }

    if (pbrTarget) {
      // GLB furniture is rendered with a glTF/PBR pipeline in the final output.
      // Use the same material family in the editor; replacing it with Phong was
      // the reason finishes could look absent or inconsistent before export.
      material = new MetallicMaterial(viewer.scene, {
        baseColor: textureMap ? [1, 1, 1] : materialDef.rgb,
        ...(textureMap ? { baseColorMap: textureMap } : {}),
        metallic: materialDef.metallic,
        roughness: materialDef.roughness,
        emissive: [0, 0, 0],
        alpha: 1,
        alphaMode: 'opaque',
        backfaces: false,
      });
    } else {
      // IFC/non-PBR objects keep the existing Phong implementation.
      material = new PhongMaterial(viewer.scene, {
        diffuse: textureMap ? [1, 1, 1] : materialDef.rgb,
        emissive: [0, 0, 0],
        shininess: Math.max(8, Math.round((1 - materialDef.roughness) * 100)),
        ...(textureMap ? { diffuseMap: textureMap } : {}),
      });
    }
    material._hciOwned = true;
    if (textureMap) {
      material._hciTextureMap = textureMap;
      // Retain the legacy property name for older owned-material cleanup paths.
      material._hciDiffuseMap = textureMap;
    }

    if (!isCurrent()) {
      disposeOwnedMaterial(material);
      return false;
    }

    let assigned = 0;
    const disposedPreviousMaterials = new Set();
    targets.forEach((object) => {
      try {
        const previous = object.material;
        object.material = material;
        if (object.material === material) assigned += 1;
        if (previous && previous !== material && previous._hciOwned && !disposedPreviousMaterials.has(previous)) {
          disposedPreviousMaterials.add(previous);
          disposeOwnedMaterial(previous);
        }
      } catch (assignmentError) {
        console.warn('[Material] Could not assign editor material to scene object.', {
          targetId,
          objectId: object?.id,
          error: assignmentError?.message || String(assignmentError),
        });
      }
      try { object.colorize = textureMap ? [1, 1, 1] : materialDef.rgb; } catch (_) {}
    });

    if (!assigned) {
      disposeOwnedMaterial(material);
      console.warn('[Material] Material was created but no scene objects accepted it.', {
        targetId,
        pbrTarget,
        objectCount: targets.length,
      });
      return false;
    }
    console.info('[Material] Applied material in editor viewport.', {
      targetId,
      pbrTarget,
      kind: materialDef.kind,
      textured: Boolean(textureMap),
      assignedObjects: assigned,
    });
    return true;
  } catch (error) {
    // Do not repaint a GLB with a flat color if the texture request failed. That
    // would make the editor silently disagree with the saved final render.
    if (!isCurrent()) {
      if (material) disposeOwnedMaterial(material);
      else { try { textureMap?.destroy?.(); } catch (_) {} }
      return false;
    }
    if (material) disposeOwnedMaterial(material);
    else { try { textureMap?.destroy?.(); } catch (_) {} }
    console.error('[Material] Texture application failed in editor viewport.', {
      targetId,
      pbrTarget,
      textureSrc: materialDef.textureSrc,
      error: error?.message || String(error),
    });
    if (!pbrTarget && materialDef.kind === 'color') {
      // Color-only IFC edits retain the legacy colorize fallback. Textured GLB
      // failures leave the source appearance untouched and report the URL error.
      targets.forEach((object) => {
        try { object.colorize = materialDef.rgb; } catch (_) {}
      });
    }
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

  if (clearGLBSceneModelMaterial(viewer, targetId)) {
    getKnownTargetSet(viewer).delete(targetId);
    return;
  }

  if (clearGLBMaterialOverlay(viewer, targetId)) {
    getKnownTargetSet(viewer).delete(targetId);
    return;
  }

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
