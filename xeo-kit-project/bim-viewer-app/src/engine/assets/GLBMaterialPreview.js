import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh';
import { Node } from '@xeokit/xeokit-sdk/src/viewer/scene/nodes/Node';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry';
import { Texture } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/Texture';
import { MetallicMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/MetallicMaterial';
import { sRGBEncoding } from '@xeokit/xeokit-sdk/src/viewer/scene/constants/constants.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const modelBaselines = new WeakMap();
const previewRecords = new WeakMap();
const syncSubscriptions = new WeakMap();
const sourceGeometryCache = new Map();
const MAX_PREVIEW_VERTICES = 1_500_000;
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const cloneColor = (value) => {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, Number);
  return value ?? null;
};

const getBaselineMap = (viewer) => {
  let map = modelBaselines.get(viewer);
  if (!map) { map = new Map(); modelBaselines.set(viewer, map); }
  return map;
};

const getPreviewMap = (viewer) => {
  let map = previewRecords.get(viewer);
  if (!map) { map = new Map(); previewRecords.set(viewer, map); }
  return map;
};

const collectionValues = (value) => {
  if (!value) return [];
  if (value instanceof Map) return Array.from(value.values());
  if (Array.isArray(value)) return value;
  return Object.values(value);
};

const isGLBAssetModel = (model) => {
  if (!model) return false;
  const meta = model._assetMeta || {};
  const format = String(meta.assetFormat || meta.fileType || meta.file_type || '').toLowerCase();
  const source = String(meta.srcUrl || '').split('?')[0].split('#')[0].toLowerCase();
  return format === 'glb' || format === 'gltf' || source.endsWith('.glb') || source.endsWith('.gltf');
};

const resolveGLBAssetModel = (viewer, targetId) => {
  const scene = viewer?.scene;
  if (!scene || !targetId) return null;
  const direct = scene.models?.[targetId];
  if (isGLBAssetModel(direct)) return direct;

  // Some selection routes identify a named GLTF child Entity rather than its
  // SceneModel root. Route those IDs to their owning GLB without changing the
  // project's saved material key (which remains targetId).
  const entity = scene.objects?.[targetId];
  const owner = entity?.model || entity?.parent?.model || null;
  if (isGLBAssetModel(owner)) return owner;

  for (const model of Object.values(scene.models || {})) {
    if (model?._assetMeta?.instanceId === targetId && isGLBAssetModel(model)) return model;
  }
  return null;
};

const entityVisibilitySnapshot = (model) => collectionValues(model?.objects).map((entity) => ({
  entity,
  visible: entity?.visible !== false,
}));

const ensureBaseline = (viewer, targetId, model) => {
  const baselines = getBaselineMap(viewer);
  const existing = baselines.get(targetId);
  if (existing?.model === model) return existing;
  const baseline = {
    model,
    modelVisible: model.visible !== false,
    colorize: cloneColor(model.colorize),
    entities: entityVisibilitySnapshot(model),
  };
  baselines.set(targetId, baseline);
  return baseline;
};

const restoreModelState = (model, baseline) => {
  if (!model || !baseline || baseline.model !== model) return;
  try { model.visible = baseline.modelVisible !== false; } catch (_) {}
  // SceneModel.visible fans out to all entities; restore the original per-node
  // visibility flags afterwards so hidden GLTF nodes stay hidden.
  for (const item of baseline.entities || []) {
    try { if (item.entity) item.entity.visible = item.visible !== false; } catch (_) {}
  }
  try { model.colorize = cloneColor(baseline.colorize); } catch (_) {}
};

const destroyPreviewRecord = (record) => {
  if (!record) return;
  try { record.mesh?.destroy?.(); } catch (_) {}
  try { record.geometry?.destroy?.(); } catch (_) {}
  try { record.root?.destroy?.(); } catch (_) {}
  try { record.material?.destroy?.(); } catch (_) {}
  try { record.texture?.destroy?.(); } catch (_) {}
};

const matrixArray = (model) => {
  const matrix = model?.matrix;
  if ((Array.isArray(matrix) || ArrayBuffer.isView(matrix)) && matrix.length === 16) {
    const result = Array.from(matrix, Number);
    if (result.every(Number.isFinite)) return result;
  }
  return [...IDENTITY_MATRIX];
};

const matricesEqual = (a, b, epsilon = 1e-7) => (
  Array.isArray(a) && Array.isArray(b) && a.length === 16 && b.length === 16
    && a.every((value, index) => Math.abs(value - b[index]) <= epsilon)
);

const ensureTransformSync = (viewer) => {
  if (syncSubscriptions.has(viewer)) return;
  const onTick = () => {
    const map = getPreviewMap(viewer);
    for (const [targetId, record] of map) {
      const model = record.model;
      if (!model || viewer?.scene?.models?.[model.id] !== model || model.destroyed === true) {
        destroyPreviewRecord(record);
        map.delete(targetId);
        getBaselineMap(viewer).delete(targetId);
        continue;
      }
      const nextMatrix = matrixArray(model);
      if (!matricesEqual(record.lastMatrix, nextMatrix)) {
        try { record.root.matrix = nextMatrix; record.lastMatrix = nextMatrix; }
        catch (error) {
          console.warn('[Material] Could not sync GLB texture preview transform:', targetId, error?.message || error);
        }
      }
    }
    if (map.size === 0) {
      try { viewer.scene.off('tick', onTick); } catch (_) {}
      syncSubscriptions.delete(viewer);
    }
  };
  viewer.scene.on('tick', onTick);
  syncSubscriptions.set(viewer, onTick);
};

const loadImage = async (src) => {
  const response = await fetch(src, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
  if (!response.ok) throw new Error(`Material image request failed (${response.status}): ${src}`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error(`Material asset is not an image (${blob.type || 'unknown type'}): ${src}`);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = url;
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`Unable to decode material texture: ${src}`));
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error(`Invalid material image dimensions: ${src}`);
    return { image, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
};

const parseThreeGLB = (arrayBuffer, basePath) => new Promise((resolve, reject) => {
  const loader = new GLTFLoader();
  // Some catalogue GLBs use EXT_meshopt_compression. Keep the preview parser
  // aligned with the app's own GLTFLoader configuration.
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.parse(arrayBuffer, basePath, resolve, reject);
});

const generatePlanarUVs = (positionAttribute) => {
  const count = positionAttribute.count;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    const p = [positionAttribute.getX(i), positionAttribute.getY(i), positionAttribute.getZ(i)];
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], p[axis]);
      max[axis] = Math.max(max[axis], p[axis]);
    }
  }
  const extents = max.map((value, index) => Math.max(1e-7, value - min[index]));
  const axes = [0, 1, 2].sort((a, b) => extents[b] - extents[a]);
  const uAxis = axes[0];
  const vAxis = axes[1];
  const uvs = [];
  for (let i = 0; i < count; i += 1) {
    const p = [positionAttribute.getX(i), positionAttribute.getY(i), positionAttribute.getZ(i)];
    uvs.push((p[uAxis] - min[uAxis]) / extents[uAxis], (p[vAxis] - min[vAxis]) / extents[vAxis]);
  }
  return uvs;
};

const extractSourceGeometry = async (srcUrl) => {
  if (!srcUrl) throw new Error('The GLB preview cannot be built because the original asset URL is missing.');
  const cacheKey = new URL(srcUrl, window.location.href).href;
  if (sourceGeometryCache.has(cacheKey)) return sourceGeometryCache.get(cacheKey);

  const promise = (async () => {
    const response = await fetch(cacheKey, { credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) throw new Error(`GLB source fetch failed (${response.status}): ${cacheKey}`);
    const arrayBuffer = await response.arrayBuffer();
    const gltf = await parseThreeGLB(arrayBuffer, new URL('.', cacheKey).href);
    const gltfScene = gltf.scene || gltf.scenes?.[0];
    if (!gltfScene) throw new Error('The uploaded GLB does not contain a usable scene.');
    gltfScene.updateMatrixWorld(true);

    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    let triangleCount = 0;
    let geometryError = null;

    gltfScene.traverse((object) => {
      if (geometryError || !object?.isMesh || !object.geometry?.attributes?.position) return;
      const geometry = object.geometry.clone();
      try {
        geometry.applyMatrix4(object.matrixWorld);
        if (!geometry.attributes.normal) geometry.computeVertexNormals();
        const p = geometry.attributes.position;
        const n = geometry.attributes.normal;
        const uv = geometry.attributes.uv || geometry.attributes.uv1;
        const uvFallback = uv ? null : generatePlanarUVs(p);
        const vertexCount = p.count;
        if (positions.length / 3 + vertexCount > MAX_PREVIEW_VERTICES) {
          geometryError = new Error(`This GLB is too complex for an interactive material preview (${positions.length / 3 + vertexCount} vertices).`);
          return;
        }
        const baseVertex = positions.length / 3;
        for (let i = 0; i < vertexCount; i += 1) {
          positions.push(p.getX(i), p.getY(i), p.getZ(i));
          normals.push(n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
          if (uv) uvs.push(uv.getX(i), uv.getY(i));
          else uvs.push(uvFallback[i * 2], uvFallback[i * 2 + 1]);
        }
        const index = geometry.index;
        if (index) {
          for (let i = 0; i < index.count; i += 1) indices.push(baseVertex + index.getX(i));
          triangleCount += index.count / 3;
        } else {
          for (let i = 0; i < vertexCount; i += 1) indices.push(baseVertex + i);
          triangleCount += vertexCount / 3;
        }
      } finally {
        geometry.dispose();
      }
    });

    if (geometryError) throw geometryError;
    if (!positions.length || !indices.length) throw new Error('No triangle geometry was found in the GLB.');

    // Release parser-side material/texture references; the visible preview is
    // rendered by Xeokit with a single new material and the original UVs.
    gltfScene.traverse((object) => {
      if (!object?.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
          try { material[key]?.dispose?.(); } catch (_) {}
        }
        try { material.dispose?.(); } catch (_) {}
      }
    });

    return { positions, normals, uvs, indices, triangleCount, vertexCount: positions.length / 3 };
  })();

  sourceGeometryCache.set(cacheKey, promise);
  while (sourceGeometryCache.size > 8) {
    const oldestKey = sourceGeometryCache.keys().next().value;
    if (oldestKey === cacheKey && sourceGeometryCache.size === 1) break;
    sourceGeometryCache.delete(oldestKey);
  }
  try { return await promise; }
  catch (error) { sourceGeometryCache.delete(cacheKey); throw error; }
};

const restorePreviousOverride = (viewer, targetId, { restoreBaseline = true } = {}) => {
  const map = getPreviewMap(viewer);
  const existing = map.get(targetId);
  if (!existing) return false;
  map.delete(targetId);
  destroyPreviewRecord(existing);
  if (restoreBaseline) restoreModelState(existing.model, getBaselineMap(viewer).get(targetId));
  return true;
};

const buildTexturePreviewRecord = (viewer, targetId, model, materialDef, geometryData, textureMap, sourceVisible) => {
  const matrix = matrixArray(model);
  const safeId = String(targetId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const root = new Node(viewer.scene, {
    id: `hci_glb_finish_root_${safeId}_${token}`,
    matrix,
    visible: false,
    isObject: false,
    pickable: false,
    collidable: false,
  });
  let geometry = null;
  let material = null;
  let mesh = null;
  try {
    geometry = new ReadableGeometry(viewer.scene, {
      id: `hci_glb_finish_geometry_${safeId}_${token}`,
      primitive: 'triangles',
      positions: geometryData.positions,
      normals: geometryData.normals,
      uv: geometryData.uvs,
      indices: geometryData.indices,
    });
    // A fabric/texture image already contains its authored surface colors.
    // `color_hex` is palette/catalog metadata (often sampled from a PDF swatch),
    // not an implicit tint. Keep the factor neutral for image-based finishes so
    // darker sampled HEX values do not multiply the image into near-black.
    // The backend compiler uses the same rule for the final GLB.
    material = new MetallicMaterial(viewer.scene, {
      baseColor: textureMap ? [1, 1, 1] : materialDef.rgb,
      ...(textureMap ? { baseColorMap: textureMap } : {}),
      metallic: Math.max(0, Math.min(1, Number(materialDef.metallic) || 0)),
      roughness: Math.max(0, Math.min(1, Number.isFinite(materialDef.roughness) ? materialDef.roughness : 0.85)),
      emissive: [0, 0, 0],
      alpha: 1,
      alphaMode: 'opaque',
      // Use glTF's standard single-sided behavior for furniture shells. Showing
      // every backside can expose internal triangles and make surfaces look
      // striped/technical when the material override is active.
      backfaces: false,
    });
    mesh = new Mesh(viewer.scene, {
      id: `hci_glb_finish_mesh_${safeId}_${token}`,
      parent: root,
      geometry,
      material,
      isObject: true,
      pickable: true,
      collidable: false,
      clippable: false,
      visible: true,
      edges: false,
      castsShadow: true,
      receivesShadow: true,
    });
    mesh._hciMaterialOverlay = true;
    mesh._hciMaterialTargetId = targetId;
    mesh._hciSourceModel = model;
    root._hciMaterialOverlayRoot = true;
    root._hciMaterialTargetId = targetId;
    return { model, root, mesh, geometry, material, texture: textureMap, sourceVisible, lastMatrix: matrix, signature: JSON.stringify(materialDef) };
  } catch (error) {
    try { mesh?.destroy?.(); } catch (_) {}
    try { geometry?.destroy?.(); } catch (_) {}
    try { material?.destroy?.(); } catch (_) {}
    try { root?.destroy?.(); } catch (_) {}
    throw error;
  }
};

/**
 * Apply a finish to a GLTFLoaderPlugin SceneModel.
 * Xeokit's GLTFLoaderPlugin creates an immutable GPU-batched SceneModel, not
 * legacy Mesh components. Solid color uses the supported SceneModel.colorize
 * API. Textures use a real Xeokit Mesh built from source GLB vertex data, with
 * a mirrored root transform; the original SceneModel is hidden only while the
 * preview exists. This keeps the editor's real renderer/camera/picking path.
 */
export const applyGLBSceneModelMaterial = async (viewer, targetId, materialDef, isCurrent = () => true) => {
  const model = resolveGLBAssetModel(viewer, targetId);
  if (!model) return { handled: false, applied: false };
  // Once a target is identified as GLB, never fall through to the old
  // legacy-Mesh material replacement path. Report missing source metadata
  // explicitly instead of creating another misleading/incorrect overlay.
  if (!model._assetMeta?.srcUrl) {
    console.error('[Material] GLB material preview cannot start: the source URL was not retained on the loaded SceneModel.', {
      targetId, modelId: model.id, assetMeta: model._assetMeta,
    });
    return { handled: true, applied: false };
  }
  const baseline = ensureBaseline(viewer, targetId, model);
  const map = getPreviewMap(viewer);

  const isSolidColor = materialDef.kind === 'color';
  const textureSrc = isSolidColor ? null : (materialDef.textureSrc || materialDef.texture?.src);
  if (!isSolidColor && !textureSrc) {
    console.warn('[Material] GLB fabric/texture finish has no resolved image URL.', { targetId, kind: materialDef.kind });
    return { handled: true, applied: false };
  }
  if (!model._assetMeta?.srcUrl) {
    console.warn('[Material] GLB source URL is unavailable; cannot build live editor finish geometry.', { targetId, meta: model._assetMeta });
    return { handled: true, applied: false };
  }

  let textureMap = null;
  let record = null;
  let loadedImageUrl = null;
  try {
    const geometryPromise = extractSourceGeometry(model._assetMeta.srcUrl);
    const texturePromise = isSolidColor ? Promise.resolve(null) : loadImage(textureSrc);
    const [geometryData, loadedImage] = await Promise.all([geometryPromise, texturePromise]);
    if (loadedImage) loadedImageUrl = loadedImage.url;
    if (!isCurrent()) {
      if (loadedImageUrl) { try { URL.revokeObjectURL(loadedImageUrl); } catch (_) {} }
      return { handled: true, applied: false };
    }

    if (loadedImage) {
      textureMap = new Texture(viewer.scene, {
        image: loadedImage.image,
        encoding: sRGBEncoding,
        scale: Array.isArray(materialDef.repeat) ? [...materialDef.repeat] : [2, 2],
      });
      // The decoded image object remains valid after its blob URL is revoked.
      URL.revokeObjectURL(loadedImageUrl);
      loadedImageUrl = null;
    }

    // Use the exact same geometry-overlay mechanism for solid colors and image
    // finishes. SceneModel.colorize multiplies the source material/texture and
    // cannot act as a true replacement color on dark textured furniture.
    record = buildTexturePreviewRecord(
      viewer, targetId, model, materialDef, geometryData, textureMap,
      baseline.modelVisible !== false,
    );
    if (!isCurrent()) {
      destroyPreviewRecord(record);
      return { handled: true, applied: false };
    }

    const oldRecord = map.get(targetId);
    // Hide the source only after the complete replacement surface is ready.
    try { model.colorize = cloneColor(baseline.colorize); } catch (_) {}
    try { model.visible = false; } catch (_) {}
    record.root.visible = record.sourceVisible;
    map.set(targetId, record);
    if (oldRecord && oldRecord !== record) destroyPreviewRecord(oldRecord);
    ensureTransformSync(viewer);

    console.info(`[Material] Applied GLB ${isSolidColor ? 'solid color' : 'fabric/texture'} using decoded source geometry.`, {
      targetId, kind: materialDef.kind, textureSrc,
      color: materialDef.color,
      rgbFactor: materialDef.rgb,
      vertices: geometryData.vertexCount, triangles: geometryData.triangleCount,
      previewMeshId: record.mesh.id,
    });
    return { handled: true, applied: true };
  } catch (error) {
    if (record) destroyPreviewRecord(record);
    else if (textureMap) { try { textureMap.destroy(); } catch (_) {} }
    if (loadedImageUrl) { try { URL.revokeObjectURL(loadedImageUrl); } catch (_) {} }
    if (isCurrent()) {
      console.error('[Material] GLB material preview failed.', {
        targetId, sourceUrl: model._assetMeta?.srcUrl, textureSrc,
        kind: materialDef.kind,
        error: error?.message || String(error),
      });
    }
    return { handled: true, applied: false };
  }
};

/** Restore the source GLB and remove any runtime finish preview. */
export const clearGLBSceneModelMaterial = (viewer, targetId) => {
  if (!viewer || !targetId) return false;
  const map = getPreviewMap(viewer);
  const baselineMap = getBaselineMap(viewer);
  const record = map.get(targetId);
  const baseline = baselineMap.get(targetId);
  if (!record && !baseline) return false;
  if (record) {
    map.delete(targetId);
    destroyPreviewRecord(record);
  }
  const model = viewer.scene?.models?.[targetId] || baseline?.model;
  if (model && baseline) restoreModelState(model, baseline);
  baselineMap.delete(targetId);
  if (map.size === 0) {
    const onTick = syncSubscriptions.get(viewer);
    if (onTick) {
      try { viewer.scene.off('tick', onTick); } catch (_) {}
      syncSubscriptions.delete(viewer);
    }
  }
  return true;
};
