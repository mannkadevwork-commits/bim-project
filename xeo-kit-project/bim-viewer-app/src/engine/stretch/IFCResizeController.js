/**
 * IFC resize interaction for editable/isolate IFC SceneModels.
 *
 * Design:
 *  - The selected IFC is treated as an oriented box (OBB), not a world AABB.
 *  - Pointer motion is measured in screen-space along the projected local axis.
 *  - Scaling is applied to the existing SceneModel matrix around the opposite
 *    local face/corner, so the opposite side stays anchored.
 *  - GLB assets do not use this controller.
 */

const EPSILON = 1e-8;
const MIN_PROJECTED_HALF_PX = 12;
const MIN_SCALE = 0.05;

const IDENTITY_4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

const finite16 = (value) => {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 16) return null;
  const result = Array.from(value, Number);
  return result.every(Number.isFinite) ? result : null;
};

const finite3 = (value, fallback = [0, 0, 0]) => {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 3) return [...fallback];
  const result = Array.from(value, Number);
  return result.every(Number.isFinite) ? result : [...fallback];
};

export const mat4Mul = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + r] * b[c * 4 + k];
      }
      out[c * 4 + r] = sum;
    }
  }
  return out;
};

export const mat4TransformPoint = (m, p) => {
  const out = [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (Math.abs(w) > EPSILON && Math.abs(w - 1) > EPSILON) {
    return [out[0] / w, out[1] / w, out[2] / w];
  }
  return out;
};

const normalize3 = (v, fallback) => {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(length) || length <= EPSILON) return [...fallback];
  return [v[0] / length, v[1] / length, v[2] / length];
};

const column3 = (m, column) => [m[column * 4], m[column * 4 + 1], m[column * 4 + 2]];

const columnLength = (m, column) => Math.hypot(...column3(m, column));

const translationMatrix = (x, y, z) => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  x, y, z, 1,
];

const scaleMatrix = (sx, sy, sz) => [
  sx, 0, 0, 0,
  0, sy, 0, 0,
  0, 0, sz, 0,
  0, 0, 0, 1,
];

const aabbCorners = (aabb) => {
  const [xMin, yMin, zMin, xMax, yMax, zMax] = aabb;
  return [
    [xMin, yMin, zMin], [xMax, yMin, zMin], [xMax, yMin, zMax], [xMin, yMin, zMax],
    [xMin, yMax, zMin], [xMax, yMax, zMin], [xMax, yMax, zMax], [xMin, yMax, zMax],
  ];
};

const getBoundsFromPoints = (points) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  points.forEach((p) => {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  });
  return { min, max };
};

const getInverse = (m) => {
  const inv = new Array(16);
  inv[0]=m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
  inv[4]=-m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
  inv[8]=m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
  inv[12]=-m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
  inv[1]=-m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
  inv[5]=m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
  inv[9]=-m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
  inv[13]=m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
  inv[2]=m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
  inv[6]=-m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
  inv[10]=m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
  inv[14]=-m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
  inv[3]=-m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
  inv[7]=m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
  inv[11]=-m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
  inv[15]=m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
  let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  if (Math.abs(det) <= EPSILON) return null;
  det = 1 / det;
  return inv.map((value) => value * det);
};

export const isIFCModel = (model) => {
  const format = String(model?._assetMeta?.fileType || model?._assetMeta?.assetFormat || '').toLowerCase();
  return format === 'ifc';
};

/**
 * Capture local geometry bounds before user transforms are applied.
 * AssetManager also calls this at load time; this fallback makes the controller
 * safe for models created by older code.
 */
export const ensureIFCResizeMetadata = (model) => {
  if (!model || !isIFCModel(model)) return null;
  if (model._ifcResizeMeta?.localCenter && model._ifcResizeMeta?.localHalf) {
    return model._ifcResizeMeta;
  }

  const worldAabb = model.aabb;
  const matrix = finite16(model.matrix) || [...IDENTITY_4];
  if (!worldAabb || worldAabb.length < 6) return null;

  const inv = getInverse(matrix);
  const worldCorners = aabbCorners(worldAabb);
  const localCorners = inv ? worldCorners.map((p) => mat4TransformPoint(inv, p)) : worldCorners;
  const { min, max } = getBoundsFromPoints(localCorners);
  const localCenter = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const localHalf = [
    Math.max(EPSILON, (max[0] - min[0]) / 2),
    Math.max(EPSILON, (max[1] - min[1]) / 2),
    Math.max(EPSILON, (max[2] - min[2]) / 2),
  ];

  model._ifcResizeMeta = {
    localCenter,
    localHalf,
    captureMatrix: [...matrix],
  };
  return model._ifcResizeMeta;
};

/**
 * Builds the current oriented resize frame from the model matrix.
 */
export const getIFCResizeFrame = (model) => {
  const meta = ensureIFCResizeMetadata(model);
  const matrix = finite16(model?.matrix);
  if (!meta || !matrix) return null;

  const axes = [0, 1, 2].map((axis) => normalize3(column3(matrix, axis), [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0]));
  const scales = [0, 1, 2].map((axis) => Math.max(EPSILON, columnLength(matrix, axis)));
  const center = mat4TransformPoint(matrix, meta.localCenter);
  const halfWorld = [
    meta.localHalf[0] * scales[0],
    meta.localHalf[1] * scales[1],
    meta.localHalf[2] * scales[2],
  ];

  return {
    matrix,
    localCenter: [...meta.localCenter],
    localHalf: [...meta.localHalf],
    center,
    axes,
    scales,
    halfWorld,
  };
};

export const getIFCResizePoint = (frame, axesList) => {
  const point = [...frame.center];
  axesList.forEach(({ axis, dir }) => {
    const v = frame.axes[axis];
    const extent = frame.halfWorld[axis];
    point[0] += v[0] * extent * dir;
    point[1] += v[1] * extent * dir;
    point[2] += v[2] * extent * dir;
  });
  return point;
};

export const getIFCOBBCorners = (frame) => {
  const corners = [];
  for (const dx of [-1, 1]) {
    for (const dy of [-1, 1]) {
      for (const dz of [-1, 1]) {
        corners.push(getIFCResizePoint(frame, [
          { axis: 0, dir: dx },
          { axis: 1, dir: dy },
          { axis: 2, dir: dz },
        ]));
      }
    }
  }
  return corners;
};

const projectedAxis = (projectWorldToCanvas, viewerRef, canvas, center, axisPoint) => {
  const centerScreen = projectWorldToCanvas(viewerRef, canvas, center);
  const pointScreen = projectWorldToCanvas(viewerRef, canvas, axisPoint);
  if (!centerScreen || !pointScreen) return null;
  const dx = pointScreen[0] - centerScreen[0];
  const dy = pointScreen[1] - centerScreen[1];
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 1) return null;
  return {
    centerScreen,
    unit: [dx / length, dy / length],
    halfPx: Math.max(MIN_PROJECTED_HALF_PX, length),
  };
};

export const beginIFCResize = ({ viewerRef, canvas, pointer, axesList, model, projectWorldToCanvas }) => {
  if (!model || !canvas || !Array.isArray(axesList) || !axesList.length) return null;
  const frame = getIFCResizeFrame(model);
  if (!frame) return null;

  const axisProjection = [0, 1, 2].map((axis) => projectedAxis(
    projectWorldToCanvas,
    viewerRef,
    canvas,
    frame.center,
    getIFCResizePoint(frame, [{ axis, dir: 1 }]),
  ));

  return {
    axesList: axesList.map((item) => ({ axis: item.axis, dir: item.dir })),
    startMatrix: [...frame.matrix],
    localCenter: [...frame.localCenter],
    localHalf: [...frame.localHalf],
    frame,
    axisProjection,
    startPointer: [...pointer],
    currentFactors: [1, 1, 1],
    currentScale: [...frame.scales],
    currentMatrix: [...frame.matrix],
  };
};

export const updateIFCResize = ({ state, pointer, model }) => {
  if (!state || !model) return state;

  const pointerDelta = [pointer[0] - state.startPointer[0], pointer[1] - state.startPointer[1]];
  const factors = [1, 1, 1];

  state.axesList.forEach(({ axis, dir }) => {
    const projection = state.axisProjection[axis];
    if (!projection) return;

    const signedPixels = (pointerDelta[0] * projection.unit[0] + pointerDelta[1] * projection.unit[1]) * dir;
    const factor = Math.max(MIN_SCALE, 1 + signedPixels / projection.halfPx);
    factors[axis] = factor;
  });

  const anchorLocal = [...state.localCenter];
  state.axesList.forEach(({ axis, dir }) => {
    anchorLocal[axis] -= state.localHalf[axis] * dir;
  });

  const localScale = scaleMatrix(factors[0], factors[1], factors[2]);
  const anchorScale = mat4Mul(
    translationMatrix(anchorLocal[0], anchorLocal[1], anchorLocal[2]),
    mat4Mul(localScale, translationMatrix(-anchorLocal[0], -anchorLocal[1], -anchorLocal[2])),
  );
  const nextMatrix = mat4Mul(state.startMatrix, anchorScale);

  try {
    model.matrix = nextMatrix;
  } catch (_) {
    return state;
  }

  const currentScale = state.frame.scales.map((value, axis) => value * factors[axis]);
  return {
    ...state,
    currentFactors: factors,
    currentScale,
    currentMatrix: nextMatrix,
  };
};

export const commitIFCResize = (model, state) => {
  if (!model || !state) return null;
  const finalMatrix = state.currentMatrix || model.matrix;
  const currentScale = state.currentScale || [1, 1, 1];

  // Keep semantic TRS in sync for property panels/next interactions, but restore
  // the exact anchored matrix immediately afterward so the visual transform wins.
  const finalPosition = finalMatrix
    ? [finalMatrix[12], finalMatrix[13], finalMatrix[14]]
    : [...(model.position || [0, 0, 0])];
  try { model.position = [...finalPosition]; } catch (_) {}
  try { model.scale = [...currentScale]; } catch (_) {}
  if (finalMatrix) {
    try { model.matrix = [...finalMatrix]; } catch (_) {}
  }

  return {
    matrix: finalMatrix ? [...finalMatrix] : null,
    scale: [...currentScale],
    position: finalPosition,
  };
};
