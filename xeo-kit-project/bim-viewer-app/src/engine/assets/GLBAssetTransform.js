/**
 * GLB asset transform normalization.
 *
 * GLB/GLTF files can arrive with arbitrary exporter origins, baked node
 * transforms, units and local offsets. The editor should not use that source
 * origin as its interaction pivot.
 *
 * This module establishes one contract for independently loaded GLB assets:
 *   - authored position = world-space location of the normalized pivot
 *   - authored rotation/scale are independent of the source exporter origin
 *   - pivotLocal is calculated once in the model's local/root coordinate space
 *   - runtime model.position is derived from the semantic pivot target
 *
 * NOTE: This is intentionally isolated from the existing IFC/native transform
 * path. GLB-001 only changes the independently loaded GLB path.
 */

export const GLB_TRANSFORM_VERSION = 3;
export const GLB_DEFAULT_PIVOT_MODE = 'bottom-center';

const EPSILON = 1e-8;

const finite = (value, fallback = 0) => (
  Number.isFinite(Number(value)) ? Number(value) : fallback
);

const vector3 = (value, fallback) => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return [...fallback];
  if (value.length !== 3) return [...fallback];
  return Array.from(value, (entry, index) => finite(entry, fallback[index]));
};

const matrix16 = (value) => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  if (value.length !== 16) return null;
  const result = Array.from(value, Number);
  return result.every(Number.isFinite) ? result : null;
};

export const sanitizePosition = (value) => vector3(value, [0, 0, 0]);
export const sanitizeRotation = (value) => vector3(value, [0, 0, 0]);

export const sanitizeScale = (value) => {
  const scale = vector3(value, [1, 1, 1]);
  return scale.map(entry => Math.max(0.000001, entry));
};

export const isValidMatrix16 = (matrix) => Boolean(matrix16(matrix));

/**
 * Generic column-major 4x4 inverse.
 * Returns null for a singular matrix. Kept local to avoid coupling the GLB
 * normalization contract to a particular renderer math helper.
 */
export const invertMatrix4 = (matrix) => {
  const m = matrix16(matrix);
  if (!m) return null;

  const a00 = m[0], a01 = m[4], a02 = m[8], a03 = m[12];
  const a10 = m[1], a11 = m[5], a12 = m[9], a13 = m[13];
  const a20 = m[2], a21 = m[6], a22 = m[10], a23 = m[14];
  const a30 = m[3], a31 = m[7], a32 = m[11], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  const det = (
    b00 * b11 - b01 * b10 + b02 * b09 +
    b03 * b08 - b04 * b07 + b05 * b06
  );

  if (!Number.isFinite(det) || Math.abs(det) <= EPSILON) return null;

  const invDet = 1 / det;

  return [
    ( a11 * b11 - a12 * b10 + a13 * b09) * invDet,
    (-a10 * b11 + a12 * b08 - a13 * b07) * invDet,
    ( a10 * b10 - a11 * b08 + a13 * b06) * invDet,
    (-a10 * b09 + a11 * b07 - a12 * b06) * invDet,

    (-a01 * b11 + a02 * b10 - a03 * b09) * invDet,
    ( a00 * b11 - a02 * b08 + a03 * b07) * invDet,
    (-a00 * b10 + a01 * b08 - a03 * b06) * invDet,
    ( a00 * b09 - a01 * b07 + a02 * b06) * invDet,

    ( a31 * b05 - a32 * b04 + a33 * b03) * invDet,
    (-a30 * b05 + a32 * b02 - a33 * b01) * invDet,
    ( a30 * b04 - a31 * b02 + a33 * b00) * invDet,
    (-a30 * b03 + a31 * b01 - a32 * b00) * invDet,

    (-a21 * b05 + a22 * b04 - a23 * b03) * invDet,
    ( a20 * b05 - a22 * b02 + a23 * b01) * invDet,
    (-a20 * b04 + a21 * b02 - a23 * b00) * invDet,
    ( a20 * b03 - a21 * b01 + a22 * b00) * invDet,
  ];
};

export const transformLocalPoint = (point, rotation, scale) => {
  const p = vector3(point, [0, 0, 0]);
  const r = sanitizeRotation(rotation);
  const s = sanitizeScale(scale);

  let x = p[0] * s[0];
  let y = p[1] * s[1];
  let z = p[2] * s[2];

  const rx = r[0] * Math.PI / 180;
  const ry = r[1] * Math.PI / 180;
  const rz = r[2] * Math.PI / 180;

  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  // R = Rz * Ry * Rx.
  const y1 = y * cx - z * sx;
  const z1 = y * sx + z * cx;
  const x1 = x;

  const x2 = x1 * cy + z1 * sy;
  const z2 = -x1 * sy + z1 * cy;
  const y2 = y1;

  const x3 = x2 * cz - y2 * sz;
  const y3 = x2 * sz + y2 * cz;
  const z3 = z2;

  return [x3, y3, z3];
};

export const transformPointByMatrix = (point, matrix) => {
  const m = matrix16(matrix);
  if (!m) return vector3(point, [0, 0, 0]);
  const p = vector3(point, [0, 0, 0]);
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
};

/**
 * Fallback only: once an asset has been loaded without a source descriptor,
 * xeokit's initial AABB is already expressed in the GLB scene coordinate frame.
 * Do not invert model.matrix here: model.matrix represents the external runtime
 * placement, while the GLB's internal node/root matrices have already been
 * resolved inside the loaded model.
 */
export const computeGLBLocalPivot = (model, pivotMode = GLB_DEFAULT_PIVOT_MODE, customPivot = null) => {
  const aabb = Array.isArray(model?.aabb) && model.aabb.length >= 6
    ? Array.from(model.aabb, Number)
    : null;

  if (!aabb || !aabb.every(Number.isFinite)) {
    return { pivotLocal: [0, 0, 0], dimensions: [0, 0, 0], pivotMode };
  }

  if (pivotMode === 'custom' && (Array.isArray(customPivot) || ArrayBuffer.isView(customPivot)) && customPivot.length === 3) {
    return {
      pivotLocal: vector3(customPivot, [0, 0, 0]),
      dimensions: [
        Math.max(0, aabb[3] - aabb[0]),
        Math.max(0, aabb[4] - aabb[1]),
        Math.max(0, aabb[5] - aabb[2]),
      ],
      pivotMode,
    };
  }

  const center = [
    (aabb[0] + aabb[3]) / 2,
    (aabb[1] + aabb[4]) / 2,
    (aabb[2] + aabb[5]) / 2,
  ];

  const pivotLocal = pivotMode === 'center'
    ? center
    : [center[0], aabb[1], center[2]];

  return {
    pivotLocal,
    dimensions: [
      Math.max(0, aabb[3] - aabb[0]),
      Math.max(0, aabb[4] - aabb[1]),
      Math.max(0, aabb[5] - aabb[2]),
    ],
    pivotMode: pivotMode === 'center' ? 'center' : GLB_DEFAULT_PIVOT_MODE,
  };
};

export const buildGLBNormalization = (model, options = {}) => {
  const pivotMode = options.pivotMode || GLB_DEFAULT_PIVOT_MODE;
  const descriptor = options.descriptor;

  const descriptorPivot = pivotMode === 'center'
    ? descriptor?.pivotModes?.center
    : descriptor?.pivotModes?.bottomCenter;

  const result = descriptor?.coordinateSpace === 'gltf-scene' && Array.isArray(descriptorPivot)
    ? {
        pivotLocal: vector3(options.pivotLocal || descriptorPivot, [0, 0, 0]),
        dimensions: vector3(descriptor.dimensions, [0, 0, 0]),
        pivotMode: pivotMode === 'center' ? 'center' : GLB_DEFAULT_PIVOT_MODE,
      }
    : computeGLBLocalPivot(model, pivotMode, options.pivotLocal);

  return {
    version: GLB_TRANSFORM_VERSION,
    pivotMode: result.pivotMode,
    pivotLocal: [...result.pivotLocal],
    dimensions: [...result.dimensions],
    coordinateSystem: {
      upAxis: descriptor?.upAxis || 'Y',
      forwardAxis: '-Z',
      units: descriptor?.units || 'meters',
      unitScale: Number.isFinite(Number(options.unitScale)) && Number(options.unitScale) > 0
        ? Number(options.unitScale)
        : 1,
    },
    source: descriptor
      ? {
          coordinateSpace: descriptor.coordinateSpace || 'gltf-scene',
          nodeCount: Number(descriptor.nodeCount) || 0,
          meshCount: Number(descriptor.meshCount) || 0,
        }
      : undefined,
  };
};

export const getGLBNormalization = (model) => {
  const meta = model?._assetMeta;
  const normalization = meta?.glbNormalization;
  if (!normalization || normalization.version !== GLB_TRANSFORM_VERSION) return null;
  if (!Array.isArray(normalization.pivotLocal) || normalization.pivotLocal.length !== 3) return null;
  return normalization;
};

export const getGLBLocalPivot = (model, fallbackMode = GLB_DEFAULT_PIVOT_MODE) => {
  const existing = getGLBNormalization(model);
  if (existing) return [...existing.pivotLocal];
  return computeGLBLocalPivot(model, fallbackMode).pivotLocal;
};

export const getGLBPlacementTarget = (model) => {
  if (!model) return [0, 0, 0];

  const pivot = getGLBLocalPivot(model);
  const transformedPivot = transformLocalPoint(
    pivot,
    model.rotation || [0, 0, 0],
    model.scale || [1, 1, 1],
  );

  const position = vector3(model.position, [0, 0, 0]);
  return [
    position[0] + transformedPivot[0],
    position[1] + transformedPivot[1],
    position[2] + transformedPivot[2],
  ];
};

/**
 * Apply the canonical GLB placement contract.
 * `targetPosition` is the semantic world position of the normalized pivot.
 */
export const applyGLBPlacementTransform = (model, targetPosition, rotation, scale) => {
  if (!model) return null;

  const target = sanitizePosition(targetPosition);
  const nextRotation = sanitizeRotation(rotation);
  const nextScale = sanitizeScale(scale);
  const pivot = getGLBLocalPivot(model);
  const transformedPivot = transformLocalPoint(pivot, nextRotation, nextScale);

  model.rotation = [...nextRotation];
  model.scale = [...nextScale];
  model.position = [
    target[0] - transformedPivot[0],
    target[1] - transformedPivot[1],
    target[2] - transformedPivot[2],
  ];

  model._transformPivot = {
    local: [...pivot],
    world: [...target],
    version: GLB_TRANSFORM_VERSION,
  };

  return model;
};

/**
 * Migrate a legacy persisted matrix while preserving the same visible pivot.
 * The supplied pivot is now guaranteed to be in model-local/root space.
 */
export const migrateLegacyGLBTransform = (model, legacyMatrix, rotation, scale) => {
  const pivot = getGLBLocalPivot(model);
  if (!isValidMatrix16(legacyMatrix)) return null;

  const legacyTarget = transformPointByMatrix(pivot, legacyMatrix);
  const nextRotation = sanitizeRotation(rotation);
  const nextScale = sanitizeScale(scale);
  applyGLBPlacementTransform(model, legacyTarget, nextRotation, nextScale);

  return legacyTarget;
};

export const isNormalizedGLBModel = (model) => (
  model?._assetMeta?.assetFormat === 'glb' &&
  model?._assetMeta?.glbNormalization?.version === GLB_TRANSFORM_VERSION
);

export const isGLBModel = (model) => model?._assetMeta?.assetFormat === 'glb';
