/**
 * Standalone transform contract for separately loaded IFC catalogue assets.
 * Native IFC and GLB assets do not use this module.
 *
 * Semantic target = floor/contact-center in world space.
 * Runtime model.position = xeokit model origin, derived from the current
 * rotated/scaled AABB around that semantic target.
 */

const finite3 = (value, fallback) => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    return [...fallback];
  }
  return [Number(value[0]), Number(value[1]), Number(value[2])];
};

const runtimePosition = (model) => finite3(model?.position, [0, 0, 0]);

const aabbAnchorOffset = (model) => {
  const aabb = model?.aabb;
  const p = runtimePosition(model);
  if (!aabb || aabb.length < 6) return [0, 0, 0];
  return [
    ((aabb[0] + aabb[3]) / 2) - p[0],
    aabb[1] - p[1],
    ((aabb[2] + aabb[5]) / 2) - p[2],
  ];
};

export const getIFCPosition = (model) =>
  finite3(model?._ifcTransform?.runtimePosition, model?.position || [0, 0, 0]);

export const getIFCPlacementTarget = (model) => {
  const stored = model?._ifcTransform?.target;
  if (Array.isArray(stored) && stored.length === 3 && stored.every(Number.isFinite)) {
    return [...stored];
  }

  // Safe fallback for a model that predates the semantic target.
  const aabb = model?.aabb;
  if (aabb && aabb.length >= 6) {
    return [
      (aabb[0] + aabb[3]) / 2,
      aabb[1],
      (aabb[2] + aabb[5]) / 2,
    ];
  }

  return runtimePosition(model);
};

export const getIFCRotation = (model) =>
  finite3(model?._ifcTransform?.rotation, model?.rotation || [0, 0, 0]);

export const getIFCScale = (model) => {
  const semantic = model?._ifcTransform?.scale;
  if (Array.isArray(semantic) && semantic.length === 3 && semantic.every(Number.isFinite)) {
    return [...semantic];
  }

  const scale = model?.scale;
  if (Array.isArray(scale) && scale.length === 3 && scale.every(Number.isFinite)) {
    return finite3(scale, [1, 1, 1]);
  }

  const matrix = model?.matrix;
  if (matrix && matrix.length >= 11) {
    return [
      Math.hypot(matrix[0], matrix[1], matrix[2]) || 1,
      Math.hypot(matrix[4], matrix[5], matrix[6]) || 1,
      Math.hypot(matrix[8], matrix[9], matrix[10]) || 1,
    ];
  }

  return [1, 1, 1];
};

const composeYRotationMatrix = (position, rotation, scale) => {
  const p = finite3(position, [0, 0, 0]);
  const r = finite3(rotation, [0, 0, 0]);
  const s = finite3(scale, [1, 1, 1]);
  const ry = (r[1] * Math.PI) / 180;
  const c = Math.cos(ry);
  const sn = Math.sin(ry);
  return [
    s[0] * c, 0, -s[0] * sn, 0,
    0, s[1], 0, 0,
    s[2] * sn, 0, s[2] * c, 0,
    p[0], p[1], p[2], 1,
  ];
};

export const applyIFCAssetTransform = (model, placementTarget, rotation, scale) => {
  if (!model) return null;

  const target = finite3(placementTarget, getIFCPlacementTarget(model));
  const nextRotation = finite3(rotation, getIFCRotation(model));
  const nextScale = finite3(scale, getIFCScale(model));

  // Keep xeokit TRS and the runtime matrix synchronized.
  try { model.scale = [...nextScale]; } catch (_) {}
  try { model.rotation = [...nextRotation]; } catch (_) {}

  // Scaling/rotation changes the AABB. Read the transformed AABB and derive the
  // runtime origin that places its floor/contact center exactly on `target`.
  const offset = aabbAnchorOffset(model);
  const nextRuntimePosition = [
    target[0] - offset[0],
    target[1] - offset[1],
    target[2] - offset[2],
  ];

  try { model.position = [...nextRuntimePosition]; } catch (_) {}
  try {
    model.matrix = composeYRotationMatrix(nextRuntimePosition, nextRotation, nextScale);
  } catch (_) {}

  model._ifcTransform = {
    target: [...target],
    runtimePosition: [...nextRuntimePosition],
    rotation: [...nextRotation],
    scale: [...nextScale],
    version: 2,
  };

  return model._ifcTransform;
};

export const initializeIFCAssetTransform = (model, placementTarget, rotation, scale) =>
  applyIFCAssetTransform(model, placementTarget, rotation, scale);

export const isIFCAssetModel = (model) => {
  const format = String(model?._assetMeta?.assetFormat || model?._assetMeta?.fileType || '').toLowerCase();
  // Only standalone catalogue IFCs. Native-isolated IFCs remain on legacy path.
  return format === 'ifc' && model?._assetMeta?.isPlacedAsset === true;
};
