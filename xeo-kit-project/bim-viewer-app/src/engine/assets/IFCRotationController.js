/**
 * IFC rotation controller based on the interaction model used by mature 3D
 * transform gizmos: derive the drag angle from the POINTER'S SCREEN POSITION
 * around the projected gizmo center, then apply the resulting quaternion/matrix
 * around a fixed world-space pivot.
 *
 * Why this exists separately from GLB:
 * - GLBs use the normalized GLB placement contract.
 * - Xeokit's SceneModel is not a Three.js Object3D, so Three.js TransformControls
 *   cannot be attached directly to an IFC SceneModel.
 * - We therefore reuse the proven interaction idea (screen-space rotation around
 *   a fixed pivot) and commit it to the Xeokit model matrix.
 */

import { mat4Mul } from '../stretch/TranslationController';

const EPSILON = 1e-8;
const MIN_POINTER_RADIUS_PX = 6;

const finite3 = (value, fallback = [0, 0, 0]) => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return [...fallback];
  if (value.length !== 3) return [...fallback];
  const result = Array.from(value, Number);
  return result.every(Number.isFinite) ? result : [...fallback];
};

const finite16 = (value) => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  if (value.length !== 16) return null;
  const result = Array.from(value, Number);
  return result.every(Number.isFinite) ? result : null;
};

const transformVec4 = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
  m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
];

export const projectWorldToCanvas = (viewerRef, canvas, worldPosition) => {
  try {
    const viewer = viewerRef?.current;
    const camera = viewer?.scene?.camera;
    if (!camera || !canvas) return null;

    const view = finite16(camera.viewMatrix);
    const projection = finite16(camera.project?.matrix);
    if (!view || !projection) return null;

    const viewProjection = mat4Mul(projection, view);
    const clip = transformVec4(viewProjection, [
      ...finite3(worldPosition),
      1,
    ]);

    if (!Number.isFinite(clip[3]) || Math.abs(clip[3]) <= EPSILON) return null;

    const ndcX = clip[0] / clip[3];
    const ndcY = clip[1] / clip[3];
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!(width > 0) || !(height > 0)) return null;

    return [
      (ndcX + 1) * 0.5 * width,
      (1 - ndcY) * 0.5 * height,
    ];
  } catch (_) {
    return null;
  }
};

export const normalizeRadians = (angle) => {
  let normalized = Number(angle) || 0;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
};

const createYRotationMatrix = (angle) => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ];
};

export const rotateMatrixAroundPivotY = (baseMatrix, pivot, angle) => {
  const matrix = finite16(baseMatrix);
  if (!matrix) return null;

  const center = finite3(pivot);
  const toPivot = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -center[0], -center[1], -center[2], 1,
  ];
  const fromPivot = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    center[0], center[1], center[2], 1,
  ];
  const rotation = createYRotationMatrix(angle);

  return mat4Mul(
    fromPivot,
    mat4Mul(rotation, mat4Mul(toPivot, matrix)),
  );
};

const pointerAngle = (pointer, pivotScreen) => {
  const dx = pointer[0] - pivotScreen[0];
  const dy = pointer[1] - pivotScreen[1];
  return Math.atan2(dy, dx);
};

/**
 * Starts an IFC rotation drag. The pivot is projected once and remains fixed
 * throughout the drag (camera interaction is disabled by the caller).
 */
export const beginIFCRotation = ({ viewerRef, canvas, pointer, pivotWorld, model }) => {
  const pivot = finite3(pivotWorld);
  const pivotScreen = projectWorldToCanvas(viewerRef, canvas, pivot);
  if (!pivotScreen) return null;

  const pointerVector = [pointer[0] - pivotScreen[0], pointer[1] - pivotScreen[1]];
  const pointerRadius = Math.hypot(pointerVector[0], pointerVector[1]);
  if (!Number.isFinite(pointerRadius) || pointerRadius < MIN_POINTER_RADIUS_PX) {
    return null;
  }

  const baseMatrix = finite16(model?.matrix);
  if (!baseMatrix) return null;

  return {
    pivotWorld: pivot,
    pivotScreen,
    baseMatrix,
    startRotation: finite3(model?.rotation, [0, 0, 0]),
    accumulatedAngle: 0,
    lastPointerAngle: pointerAngle(pointer, pivotScreen),
    currentRotationY: finite3(model?.rotation, [0, 0, 0])[1] || 0,
  };
};

/**
 * Updates an IFC rotation drag using incremental screen-space angular motion.
 * Unlike the previous XZ-plane unprojection, this does not convert mouse motion
 * into world distance first. One small mouse movement therefore produces one
 * small angular increment, which is the behavior users expect from a rotation
 * ring and is close to TransformControls-style interaction.
 */
export const updateIFCRotation = ({ state, viewerRef, canvas, pointer, model }) => {
  if (!state || !model) return null;

  const currentAngle = pointerAngle(pointer, state.pivotScreen);
  const pointerVector = [
    pointer[0] - state.pivotScreen[0],
    pointer[1] - state.pivotScreen[1],
  ];
  const pointerRadius = Math.hypot(pointerVector[0], pointerVector[1]);
  if (!Number.isFinite(pointerRadius) || pointerRadius < MIN_POINTER_RADIUS_PX) {
    return {
      ...state,
      currentRotationY: state.currentRotationY,
      matrix: state.lastMatrix || state.baseMatrix,
    };
  }

  // Screen coordinates have +Y down. The legacy Xeokit ring direction is kept
  // by using previous - current, which matches the direction of the existing
  // rotation arrow in this application.
  const step = normalizeRadians(state.lastPointerAngle - currentAngle);
  const nextAccumulatedAngle = state.accumulatedAngle + step;
  const nextMatrix = rotateMatrixAroundPivotY(
    state.baseMatrix,
    state.pivotWorld,
    nextAccumulatedAngle,
  );

  if (!nextMatrix) return state;

  try {
    model.matrix = nextMatrix;
  } catch (_) {
    return state;
  }

  const nextRotationY = state.startRotation[1] + (nextAccumulatedAngle * 180) / Math.PI;
  const nextRotation = [
    state.startRotation[0],
    nextRotationY,
    state.startRotation[2],
  ];

  return {
    ...state,
    accumulatedAngle: nextAccumulatedAngle,
    lastPointerAngle: currentAngle,
    lastMatrix: nextMatrix,
    currentRotation: nextRotation,
    currentRotationY: nextRotationY,
  };
};

export const commitIFCRotationState = (model, state) => {
  if (!model || !state) return null;
  const rotation = state.currentRotation || [
    state.startRotation?.[0] || 0,
    state.currentRotationY || state.startRotation?.[1] || 0,
    state.startRotation?.[2] || 0,
  ];
  const finalMatrix = state.lastMatrix || state.baseMatrix || null;

  // Update the semantic Euler value only once, after the drag has finished.
  // Immediately write the final matrix again so SceneModel's TRS setter cannot
  // discard the pivot-correct world transform we just authored.
  try { model.rotation = [...rotation]; } catch (_) {}
  if (finalMatrix) {
    try { model.matrix = [...finalMatrix]; } catch (_) {}
  }

  return {
    rotation: [...rotation],
    matrix: finalMatrix ? [...finalMatrix] : null,
  };
};
