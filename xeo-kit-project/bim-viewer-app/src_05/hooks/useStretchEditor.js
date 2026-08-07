import { useCallback, useEffect, useRef, useState } from 'react';
import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry';
import { buildBoxGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/builders/buildBoxGeometry';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';

const mat4Mul = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
};

const mat4Invert = (m) => {
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
  if (!det) return null;
  det = 1.0 / det;
  return inv.map(v => v * det);
};

const transformVec4 = (m, v) => [
  m[0]*v[0] + m[4]*v[1] + m[8]*v[2]  + m[12]*v[3],
  m[1]*v[0] + m[5]*v[1] + m[9]*v[2]  + m[13]*v[3],
  m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
  m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3],
];

const unprojectToWorld = (px, py, ndcZ, invViewProj, w, h) => {
  const ndcX = (px / w) * 2 - 1;
  const ndcY = 1 - (py / h) * 2;
  const world = transformVec4(invViewProj, [ndcX, ndcY, ndcZ, 1]);
  return [world[0] / world[3], world[1] / world[3], world[2] / world[3]];
};

const intersectXZPlane = (px, py, invViewProj, planeY, w, h) => {
  const near = unprojectToWorld(px, py, -1, invViewProj, w, h);
  const far = unprojectToWorld(px, py, 1, invViewProj, w, h);
  const rd = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
  if (Math.abs(rd[1]) < 1e-9) return null;
  const t = (planeY - near[1]) / rd[1];
  return [near[0] + t * rd[0], near[1] + t * rd[1], near[2] + t * rd[2]];
};

const worldToScreen = (worldPos, camera, w, h) => {
  const viewProj = mat4Mul(camera.project.matrix, camera.viewMatrix);
  const clip = transformVec4(viewProj, [worldPos[0], worldPos[1], worldPos[2], 1]);
  if (!clip[3]) return null;
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  return [((ndcX + 1) / 2) * w, ((1 - ndcY) / 2) * h];
};

const getTargetAABB = (viewer, targetId, isAsset) => {
  if (isAsset) {
    const model = viewer.scene.models[targetId];
    return model ? model.aabb : null;
  }
  const entity = viewer.scene.objects[targetId];
  return entity ? entity.aabb : null;
};

const buildHandleDefs = (aabb) => {
  const [xMin, yMin, zMin, xMax, yMax, zMax] = aabb;
  const cx = (xMin + xMax) / 2;
  const cy = (yMin + yMax) / 2;
  const cz = (zMin + zMax) / 2;
  return [
    { id: 'face_x_pos', type: 'face', axis: 0, dir: +1, worldPos: [xMax, cy, cz] },
    { id: 'face_x_neg', type: 'face', axis: 0, dir: -1, worldPos: [xMin, cy, cz] },
    { id: 'face_y_pos', type: 'face', axis: 1, dir: +1, worldPos: [cx, yMax, cz] },
    { id: 'face_y_neg', type: 'face', axis: 1, dir: -1, worldPos: [cx, yMin, cz] },
    { id: 'face_z_pos', type: 'face', axis: 2, dir: +1, worldPos: [cx, cy, zMax] },
    { id: 'face_z_neg', type: 'face', axis: 2, dir: -1, worldPos: [cx, cy, zMin] },
    { id: 'corner_pp', type: 'corner', axes: [0, 2], xDir: +1, zDir: +1, worldPos: [xMax, cy, zMax] },
    { id: 'corner_pn', type: 'corner', axes: [0, 2], xDir: +1, zDir: -1, worldPos: [xMax, cy, zMin] },
    { id: 'corner_np', type: 'corner', axes: [0, 2], xDir: -1, zDir: +1, worldPos: [xMin, cy, zMax] },
    { id: 'corner_nn', type: 'corner', axes: [0, 2], xDir: -1, zDir: -1, worldPos: [xMin, cy, zMin] },
  ];
};

const boxCorners = (aabb) => {
  const [xMin, yMin, zMin, xMax, yMax, zMax] = aabb;
  return [
    [xMin, yMin, zMin], [xMax, yMin, zMin], [xMax, yMin, zMax], [xMin, yMin, zMax],
    [xMin, yMax, zMin], [xMax, yMax, zMin], [xMax, yMax, zMax], [xMin, yMax, zMax],
  ];
};

export const useStretchEditor = (viewerRef, canvasRef) => {
  const targetRef = useRef(null);
  const handleDefsRef = useRef([]);
  const proxyMeshesRef = useRef([]);
  const dragRef = useRef(null);
  const isStretchingRef = useRef(false);

  const [isStretching, setIsStretching] = useState(false);
  const [aabb, setAabb] = useState(null);
  const [handles, setHandles] = useState([]);
  const [hoveredHandleId, setHoveredHandleId] = useState(null);
  const [screenGeometry, setScreenGeometry] = useState(null);

  const destroyHandles = useCallback(() => {
    proxyMeshesRef.current.forEach(mesh => { try { mesh.destroy(); } catch (_) {} });
    proxyMeshesRef.current = [];
    targetRef.current = null;
    handleDefsRef.current = [];
    setAabb(null);
    setHandles([]);
    setHoveredHandleId(null);
    setScreenGeometry(null);
  }, []);

  const buildHandles = useCallback((entityId, isAsset) => {
    proxyMeshesRef.current.forEach(mesh => { try { mesh.destroy(); } catch (_) {} });
    proxyMeshesRef.current = [];

    const viewer = viewerRef.current;
    if (!viewer) return;
    const box = getTargetAABB(viewer, entityId, isAsset);
    if (!box) return;

    targetRef.current = { entityId, isAsset };
    const defs = buildHandleDefs(box);
    handleDefsRef.current = defs;

    const handleSize = 0.15;
    const ts = Date.now();
    defs.forEach((def, i) => {
      const mesh = new Mesh(viewer.scene, {
        id: `sh_${ts}_${i}`,
        geometry: new ReadableGeometry(viewer.scene, buildBoxGeometry({
          xSize: handleSize, ySize: handleSize, zSize: handleSize,
        })),
        material: new PhongMaterial(viewer.scene, {
          diffuse: [1, 1, 1],
          emissive: [1, 1, 1],
          opacity: 0,
        }),
        position: def.worldPos,
        pickable: true,
      });
      mesh._stretchMeta = def.type === 'corner'
        ? { isStretchHandle: true, type: 'corner', axes: def.axes, xDir: def.xDir, zDir: def.zDir, targetId: entityId, isAsset, handleId: def.id }
        : { isStretchHandle: true, type: 'face', axis: def.axis, dir: def.dir, targetId: entityId, isAsset, handleId: def.id };
      proxyMeshesRef.current.push(mesh);
    });

    setAabb(box);
    setHandles(defs);
  }, [viewerRef]);

  const startDrag = useCallback((canvasPos, meta) => {
    const viewer = viewerRef.current;
    const { targetId, isAsset } = meta;
    let startScale;
    if (isAsset) {
      const model = viewer?.scene.models[targetId];
      startScale = model ? [...(model.scale || [1, 1, 1])] : [1, 1, 1];
    } else {
      const entity = viewer?.scene.objects[targetId];
      startScale = entity ? [...(entity.scale || [1, 1, 1])] : [1, 1, 1];
    }
    dragRef.current = { ...meta, startCanvasX: canvasPos[0], startCanvasY: canvasPos[1], startScale };
    isStretchingRef.current = true;
    setIsStretching(true);
  }, [viewerRef]);

  const updateDrag = useCallback((canvasPos) => {
    if (!isStretchingRef.current) return;
    const drag = dragRef.current;
    if (!drag) return;
    const { axis, dir, axes, xDir, zDir, targetId, isAsset, startCanvasX, startCanvasY, startScale } = drag;
    const viewer = viewerRef.current;

    if (axes && axes.length === 2) {
      return;
    }

    const pixelDelta = axis === 1
      ? (startCanvasY - canvasPos[1])
      : (canvasPos[0] - startCanvasX);
    const newScaleOnAxis = Math.max(0.05, startScale[axis] + pixelDelta * 0.005 * dir);
    if (isAsset) {
      const model = viewer?.scene.models[targetId];
      if (model) { const s = [...(model.scale || [1, 1, 1])]; s[axis] = newScaleOnAxis; model.scale = s; }
    } else {
      const entity = viewer?.scene.objects[targetId];
      if (entity) { const s = [...(entity.scale || [1, 1, 1])]; s[axis] = newScaleOnAxis; entity.scale = s; }
    }

    const newBox = getTargetAABB(viewer, targetId, isAsset);
    if (newBox) setAabb(newBox);
  }, [viewerRef]);

  const endDrag = useCallback((persistCallback) => {
    if (!isStretchingRef.current) return;
    const drag = dragRef.current;
    if (!drag) return;
    const { axis, axes, targetId, isAsset } = drag;
    const viewer = viewerRef.current;

    if (axes && axes.length === 2) {
      dragRef.current = null;
      isStretchingRef.current = false;
      setIsStretching(false);
      buildHandles(targetId, isAsset);
      return;
    }

    let finalScale;
    if (isAsset) {
      const model = viewer?.scene.models[targetId];
      finalScale = model?.scale || [1, 1, 1];
    } else {
      const entity = viewer?.scene.objects[targetId];
      finalScale = entity?.scale || [1, 1, 1];
    }
    if (persistCallback) persistCallback(targetId, 'scale', axis, finalScale[axis]);
    dragRef.current = null;
    isStretchingRef.current = false;
    setIsStretching(false);
    buildHandles(targetId, isAsset);
  }, [viewerRef, buildHandles]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const canvas = canvasRef.current;
    if (!viewer || !canvas) return;

    const onCanvasMouseDown = (e) => {
      const canvasPos = [e.offsetX, e.offsetY];
      const pick = viewer.scene.pick({ canvasPos, pickSurface: false });
      if (pick?.entity?._stretchMeta?.isStretchHandle) {
        e.stopPropagation();
        e.preventDefault();
        viewer.cameraControl.active = false;
        startDrag(canvasPos, pick.entity._stretchMeta);
      }
    };

    const onCanvasMouseMove = (e) => {
      if (isStretchingRef.current) return;
      const canvasPos = [e.offsetX, e.offsetY];
      const pick = viewer.scene.pick({ canvasPos, pickSurface: false });
      const handleId = pick?.entity?._stretchMeta?.isStretchHandle
        ? pick.entity._stretchMeta.handleId
        : null;
      setHoveredHandleId(prev => (prev === handleId ? prev : handleId));
    };

    const onDocMouseMove = (e) => {
      if (!isStretchingRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const curX = e.clientX - rect.left;
      const curY = e.clientY - rect.top;
      updateDrag([curX, curY]);
    };

    const onDocMouseUp = () => {
      if (!isStretchingRef.current) return;
      endDrag();
      viewer.cameraControl.active = true;
    };

    canvas.addEventListener('mousedown', onCanvasMouseDown, { capture: true });
    canvas.addEventListener('mousemove', onCanvasMouseMove);
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);

    return () => {
      canvas.removeEventListener('mousedown', onCanvasMouseDown, { capture: true });
      canvas.removeEventListener('mousemove', onCanvasMouseMove);
      document.removeEventListener('mousemove', onDocMouseMove);
      document.removeEventListener('mouseup', onDocMouseUp);
    };
  }, [viewerRef, canvasRef, startDrag, updateDrag, endDrag]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const canvas = canvasRef.current;
    if (!viewer || !canvas || !aabb) {
      setScreenGeometry(null);
      return;
    }

    const recompute = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const camera = viewer.scene.camera;
      const corners = boxCorners(aabb).map(p => worldToScreen(p, camera, w, h));
      const handlePoints = handleDefsRef.current.map(def => ({
        ...def,
        screenPos: worldToScreen(def.worldPos, camera, w, h),
      }));
      setScreenGeometry({ corners, handles: handlePoints, width: w, height: h });
    };

    recompute();
    viewer.scene.on('tick', recompute);
    return () => viewer.scene.off('tick', recompute);
  }, [viewerRef, canvasRef, aabb]);

  return {
    state: { isStretching, aabb, handles, hoveredHandleId, screenGeometry },
    actions: { buildHandles, destroyHandles, startDrag, updateDrag, endDrag },
  };
};
