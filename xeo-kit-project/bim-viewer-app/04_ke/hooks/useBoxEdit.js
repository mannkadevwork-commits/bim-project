import { useEffect, useRef, useState, useCallback } from 'react';

const FACES = [
  { id: 'xMax', axis: 0, sign: 1, color: '#f43f5e' },
  { id: 'xMin', axis: 0, sign: -1, color: '#f43f5e' },
  { id: 'yMax', axis: 1, sign: 1, color: '#22c55e' },
  { id: 'yMin', axis: 1, sign: -1, color: '#22c55e' },
  { id: 'zMax', axis: 2, sign: 1, color: '#3b82f6' },
  { id: 'zMin', axis: 2, sign: -1, color: '#3b82f6' },
];

const MIN_AXIS_LENGTH = 0.05;
const degToRad = (d) => (d * Math.PI) / 180;

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const normalize3 = (a) => {
  const len = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  return len > 0 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
};

const mat3Mul = (a, b) => {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] =
        a[i * 3 + 0] * b[0 * 3 + j] +
        a[i * 3 + 1] * b[1 * 3 + j] +
        a[i * 3 + 2] * b[2 * 3 + j];
    }
  }
  return r;
};

const mat3MulVec3 = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const mat3Transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

const buildRotationMat3 = (rotationDeg) => {
  const [rx, ry, rz] = (rotationDeg || [0, 0, 0]).map(degToRad);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const rX = [1, 0, 0, 0, cx, sx, 0, -sx, cx];
  const rY = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  const rZ = [cz, sz, 0, -sz, cz, 0, 0, 0, 1];
  return mat3Mul(mat3Mul(rZ, rY), rX);
};

const transformPointByMat4 = (m, p) => {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
};

const invertMat4 = (m) => {
  const inv = new Array(16);
  inv[0] = m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15] - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14] + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15] + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14] - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15] - m[1]*m[7]*m[14] - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7] - m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15] + m[0]*m[7]*m[14] + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7] + m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15] - m[0]*m[7]*m[13] - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7] - m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14] + m[0]*m[6]*m[13] + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6] + m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11] + m[1]*m[7]*m[10] + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7] + m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11] - m[0]*m[7]*m[10] - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7] - m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11] + m[0]*m[7]*m[9] + m[4]*m[1]*m[11] - m[4]*m[3]*m[9] - m[8]*m[1]*m[7] + m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10] - m[0]*m[6]*m[9] - m[4]*m[1]*m[10] + m[4]*m[2]*m[9] + m[8]*m[1]*m[6] - m[8]*m[2]*m[5];

  let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  if (det === 0) return null;
  det = 1.0 / det;
  for (let i = 0; i < 16; i++) inv[i] = inv[i] * det;
  return inv;
};

const getUnprojectedRay = (camera, canvasX, canvasY, rect) => {
  const ndcX = (canvasX / rect.width) * 2 - 1;
  const ndcY = -(canvasY / rect.height) * 2 + 1;

  const invProj = invertMat4(camera.projMatrix);
  const invView = invertMat4(camera.viewMatrix);
  if (!invProj || !invView) return null;

  const mult = (m, v) => [
    m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12]*v[3],
    m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13]*v[3],
    m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
    m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3]
  ];

  let pNear = mult(invProj, [ndcX, ndcY, -1, 1]);
  pNear = scale3(pNear, 1/pNear[3]); pNear[3] = 1;
  pNear = mult(invView, pNear);

  let pFar = mult(invProj, [ndcX, ndcY, 1, 1]);
  pFar = scale3(pFar, 1/pFar[3]); pFar[3] = 1;
  pFar = mult(invView, pFar);

  return {
    origin: [pNear[0], pNear[1], pNear[2]],
    dir: normalize3(sub3(pFar, pNear))
  };
};

const worldToCanvas = (viewer, worldPos, rect) => {
  const camera = viewer.camera;
  const viewPos = transformPointByMat4(camera.viewMatrix, worldPos);
  const clipPos = transformPointByMat4(camera.projMatrix, viewPos.slice(0, 3));
  const w = clipPos[3] || 1;
  const ndcX = clipPos[0] / w;
  const ndcY = clipPos[1] / w;
  return {
    x: (ndcX * 0.5 + 0.5) * rect.width,
    y: (1 - (ndcY * 0.5 + 0.5)) * rect.height,
    behindCamera: w <= 0,
  };
};

const computeLocalExtents = (aabb, position, rotationDeg) => {
  const R = buildRotationMat3(rotationDeg);
  const RT = mat3Transpose(R);
  const localMin = [Infinity, Infinity, Infinity];
  const localMax = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < 8; i++) {
    const wx = i & 1 ? aabb[3] : aabb[0];
    const wy = i & 2 ? aabb[4] : aabb[1];
    const wz = i & 4 ? aabb[5] : aabb[2];
    const rel = sub3([wx, wy, wz], position);
    const local = mat3MulVec3(RT, rel);
    for (let a = 0; a < 3; a++) {
      if (local[a] < localMin[a]) localMin[a] = local[a];
      if (local[a] > localMax[a]) localMax[a] = local[a];
    }
  }
  return { localMin, localMax, R };
};

const getFurnitureAdapter = (viewer, id) => {
  if (!viewer || !id) return null;
  const m = viewer.scene.models[id];
  if (!m) return null;
  return {
    id,
    getPosition: () => m.position ? [...m.position] : [0, 0, 0],
    getRotation: () => m.rotation ? [...m.rotation] : [0, 0, 0],
    getAABB: () => m.aabb,
    setPosition: (p) => { m.position = p; },
    setScale: (s) => { m.scale = s; },
  };
};

const zeroFaceOffsets = () => ({
  xMin: 0, xMax: 0, yMin: 0, yMax: 0, zMin: 0, zMax: 0,
});

const namedToVectors = (fo) => ({
  min: [fo?.xMin || 0, fo?.yMin || 0, fo?.zMin || 0],
  max: [fo?.xMax || 0, fo?.yMax || 0, fo?.zMax || 0],
});

const vectorsToNamed = (v) => ({
  xMin: v.min[0], yMin: v.min[1], zMin: v.min[2],
  xMax: v.max[0], yMax: v.max[1], zMax: v.max[2],
});

const deriveFaceBox = (baseBox, scale, offsetVectors) => {
  const min = [0, 0, 0], max = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const s = scale[a] || 1;
    min[a] = baseBox.min[a] * s - offsetVectors.min[a];
    max[a] = baseBox.max[a] * s + offsetVectors.max[a];
  }
  return { min, max };
};

const deriveRenderTransform = (baseBox, faceBox) => {
  const localScale = [1, 1, 1];
  const t = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const baseSize = baseBox.max[a] - baseBox.min[a];
    const newSize = faceBox.max[a] - faceBox.min[a];
    localScale[a] = baseSize > 1e-9 ? newSize / baseSize : 1;
    t[a] = faceBox.min[a] - baseBox.min[a] * localScale[a];
  }
  return { localScale, t };
};

export const applyBoxEdit = (viewer, id, anchorPosition, rotationDeg, scale, baseBox, offsetVectors) => {
  const adapter = getFurnitureAdapter(viewer, id);
  if (!adapter || !baseBox) return null;
  const R = buildRotationMat3(rotationDeg);
  const faceBox = deriveFaceBox(baseBox, scale, offsetVectors);
  const { localScale, t } = deriveRenderTransform(baseBox, faceBox);
  adapter.setScale(localScale);
  adapter.setPosition(add3(anchorPosition, mat3MulVec3(R, t)));
  return faceBox;
};

export const useBoxEdit = (viewerRef, canvasElRef, selectedAssetId, projectStateRef, updateBoxEdit) => {
  const [handleScreenPositions, setHandleScreenPositions] = useState(null);
  const dragStateRef = useRef(null);
  const rafRef = useRef(null);
  const baseBoxCacheRef = useRef(new Map());
  const targetId = selectedAssetId || null;

  const getItem = useCallback(() => {
    const state = projectStateRef.current;
    if (!state) return null;
    return (state.furniture || []).find((f) => f.instanceId === targetId) || null;
  }, [targetId, projectStateRef]);

  const getCacheKey = useCallback((item) => `${targetId}:${item?.src || ''}`, [targetId]);

  const invalidateBaseBox = useCallback((instanceId) => {
    for (const key of Array.from(baseBoxCacheRef.current.keys())) {
      if (key.startsWith(`${instanceId}:`)) baseBoxCacheRef.current.delete(key);
    }
  }, []);

  const getGeometry = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || !targetId) return null;
    const adapter = getFurnitureAdapter(viewer, targetId);
    if (!adapter) return null;
    const item = getItem();
    if (!item) return null;

    const position = item.position ? [...item.position] : adapter.getPosition();
    const rotation = item.rotation ? [...item.rotation] : adapter.getRotation();
    const scale = item.scale ? [...item.scale] : [1, 1, 1];
    const offsetVectors = namedToVectors(item.boxEdit?.faceOffsets);

    const cacheKey = getCacheKey(item);
    let baseBox = baseBoxCacheRef.current.get(cacheKey);
    if (!baseBox) {
      const aabb = adapter.getAABB();
      if (!aabb) return null;
      const extents = computeLocalExtents(aabb, position, rotation);
      baseBox = {
        min: [
          extents.localMin[0] / (scale[0] || 1),
          extents.localMin[1] / (scale[1] || 1),
          extents.localMin[2] / (scale[2] || 1),
        ],
        max: [
          extents.localMax[0] / (scale[0] || 1),
          extents.localMax[1] / (scale[1] || 1),
          extents.localMax[2] / (scale[2] || 1),
        ],
      };
      baseBoxCacheRef.current.set(cacheKey, baseBox);
      applyBoxEdit(viewer, targetId, position, rotation, scale, baseBox, offsetVectors);
    }

    const R = buildRotationMat3(rotation);
    const faceBox = deriveFaceBox(baseBox, scale, offsetVectors);
    return { adapter, position, rotation, scale, R, baseBox, offsetVectors, faceBox };
  }, [viewerRef, targetId, getItem, getCacheKey]);

  useEffect(() => {
    if (dragStateRef.current) return;
    if (!targetId) {
      setHandleScreenPositions(null);
      return;
    }

    const tick = () => {
      const viewer = viewerRef.current;
      const canvasEl = canvasElRef.current;
      if (!viewer || !canvasEl || dragStateRef.current) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const geometry = getGeometry();
      if (!geometry) {
        setHandleScreenPositions(null);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const rect = canvasEl.getBoundingClientRect();
      const { position, R, faceBox } = geometry;
      const center = [
        (faceBox.min[0] + faceBox.max[0]) / 2,
        (faceBox.min[1] + faceBox.max[1]) / 2,
        (faceBox.min[2] + faceBox.max[2]) / 2,
      ];

      const next = FACES.map(({ id, axis, sign, color }) => {
        const local = [...center];
        local[axis] = sign === 1 ? faceBox.max[axis] : faceBox.min[axis];
        const worldPos = add3(position, mat3MulVec3(R, local));
        const screen = worldToCanvas(viewer, worldPos, rect);
        return { id, axis, sign, color, x: screen.x, y: screen.y, visible: !screen.behindCamera };
      });

      setHandleScreenPositions(next);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [targetId, viewerRef, canvasElRef, getGeometry]);

  const beginDrag = useCallback((faceId, clientX, clientY, pointerId) => {
    const viewer = viewerRef.current;
    const canvasEl = canvasElRef.current;
    const geometry = getGeometry();
    if (!viewer || !canvasEl || !geometry) return;

    if (viewer.cameraControl) {
      viewer.cameraControl.pointerEnabled = false;
    }

    const face = FACES.find((f) => f.id === faceId);
    if (!face) return;
    const { axis, sign } = face;
    const { adapter, position, rotation, R, scale, baseBox, offsetVectors, faceBox } = geometry;
    const rect = canvasEl.getBoundingClientRect();

    const axisUnit = [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
    const axisDirWorld = normalize3(mat3MulVec3(R, axisUnit));

    const faceLocal = [
      (faceBox.min[0] + faceBox.max[0]) / 2,
      (faceBox.min[1] + faceBox.max[1]) / 2,
      (faceBox.min[2] + faceBox.max[2]) / 2,
    ];
    faceLocal[axis] = sign === 1 ? faceBox.max[axis] : faceBox.min[axis];
    const faceWorldPos = add3(position, mat3MulVec3(R, faceLocal));

    const ray = getUnprojectedRay(viewer.camera, clientX - rect.left, clientY - rect.top, rect);
    if (!ray) return;

    let planeNormal = normalize3(cross3(axisDirWorld, cross3(axisDirWorld, ray.dir)));
    if (planeNormal[0] === 0 && planeNormal[1] === 0 && planeNormal[2] === 0) {
      const camForward = normalize3(sub3(viewer.camera.look, viewer.camera.eye));
      planeNormal = normalize3(cross3(axisDirWorld, cross3(axisDirWorld, camForward)));
    }

    const denom = dot3(planeNormal, ray.dir);
    let initialHitPos = faceWorldPos;
    if (Math.abs(denom) > 1e-6) {
      const t = dot3(planeNormal, sub3(faceWorldPos, ray.origin)) / denom;
      initialHitPos = add3(ray.origin, scale3(ray.dir, t));
    }

    dragStateRef.current = {
      faceId, axis, sign, pointerId, adapter,
      position, rotation, scale, baseBox,
      offsetsStart: offsetVectors,
      axisDirWorld, planeNormal, planePoint: faceWorldPos, initialHitPos, rect,
    };
  }, [viewerRef, canvasElRef, getGeometry]);

  const updateDrag = useCallback((clientX, clientY) => {
    const drag = dragStateRef.current;
    if (!drag) return;

    const viewer = viewerRef.current;
    const ray = getUnprojectedRay(viewer.camera, clientX - drag.rect.left, clientY - drag.rect.top, drag.rect);
    if (!ray) return;

    const denom = dot3(drag.planeNormal, ray.dir);
    if (Math.abs(denom) < 1e-6) return;

    const t = dot3(drag.planeNormal, sub3(drag.planePoint, ray.origin)) / denom;
    const currentHitPos = add3(ray.origin, scale3(ray.dir, t));
    const worldDelta = dot3(sub3(currentHitPos, drag.initialHitPos), drag.axisDirWorld);

    const nextOffsets = { min: [...drag.offsetsStart.min], max: [...drag.offsetsStart.max] };
    const scaledMin = drag.baseBox.min[drag.axis] * drag.scale[drag.axis];
    const scaledMax = drag.baseBox.max[drag.axis] * drag.scale[drag.axis];

    if (drag.sign === 1) {
      const otherFace = scaledMin - drag.offsetsStart.min[drag.axis];
      let candidateOffset = drag.offsetsStart.max[drag.axis] + worldDelta;
      let candidateFace = scaledMax + candidateOffset;
      if (candidateFace - otherFace < MIN_AXIS_LENGTH) {
        candidateFace = otherFace + MIN_AXIS_LENGTH;
        candidateOffset = candidateFace - scaledMax;
      }
      nextOffsets.max[drag.axis] = candidateOffset;
    } else {
      const otherFace = scaledMax + drag.offsetsStart.max[drag.axis];
      let candidateOffset = drag.offsetsStart.min[drag.axis] - worldDelta;
      let candidateFace = scaledMin - candidateOffset;
      if (otherFace - candidateFace < MIN_AXIS_LENGTH) {
        candidateFace = otherFace - MIN_AXIS_LENGTH;
        candidateOffset = scaledMin - candidateFace;
      }
      nextOffsets.min[drag.axis] = candidateOffset;
    }

    const faceBox = deriveFaceBox(drag.baseBox, drag.scale, nextOffsets);
    const { localScale, t: pivot } = deriveRenderTransform(drag.baseBox, faceBox);
    const R = buildRotationMat3(drag.rotation);

    drag.adapter.setScale(localScale);
    drag.adapter.setPosition(add3(drag.position, mat3MulVec3(R, pivot)));

    drag.pendingOffsets = nextOffsets;
  }, [viewerRef]);

  const endDrag = useCallback(() => {
    const drag = dragStateRef.current;
    if (!drag) return;

    const viewer = viewerRef.current;
    if (viewer?.cameraControl) {
      viewer.cameraControl.pointerEnabled = true;
    }

    dragStateRef.current = null;
    if (drag.pendingOffsets && updateBoxEdit) {
      updateBoxEdit(drag.adapter.id, vectorsToNamed(drag.pendingOffsets));
    }
  }, [updateBoxEdit, viewerRef]);

  useEffect(() => {
    const onMove = (e) => {
      const drag = dragStateRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      updateDrag(e.clientX, e.clientY);
    };
    const onUp = (e) => {
      const drag = dragStateRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      endDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [updateDrag, endDrag]);

  const onHandlePointerDown = useCallback((faceId, e) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    beginDrag(faceId, e.clientX, e.clientY, e.pointerId);
  }, [beginDrag]);

  return {
    handleScreenPositions,
    onHandlePointerDown,
    invalidateBaseBox,
    isDragging: !!dragStateRef.current,
  };
};