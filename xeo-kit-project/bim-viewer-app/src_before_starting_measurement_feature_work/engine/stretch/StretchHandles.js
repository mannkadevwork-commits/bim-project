import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry';
import { buildBoxGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/builders/buildBoxGeometry';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';
import { buildSelectionCage, destroySelectionCage } from '../viewer/SelectionController';
import { axesKey, axisDirKey } from '../utils/helpers';
import {
  AXIS_HANDLE_COLORS,
  STRETCH_HANDLE_FACE_OPACITY,
  STRETCH_HANDLE_EDGE_OPACITY,
  STRETCH_HANDLE_CORNER_OPACITY,
  STRETCH_HANDLE_ANIM_MS,
} from '../utils/constants';

export const animateHandleTo = (mesh, stretchAnimFramesRef, { opacity, scale, onComplete }) => {
  if (!mesh) return;
  if (mesh._stretchAnimId) {
    cancelAnimationFrame(mesh._stretchAnimId);
    stretchAnimFramesRef.current.delete(mesh._stretchAnimId);
    mesh._stretchAnimId = null;
  }
  const startOpacity = mesh.material.opacity;
  const startScale = Array.isArray(mesh.scale) ? mesh.scale[0] : 1;
  const startTime = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - startTime) / STRETCH_HANDLE_ANIM_MS);
    try {
      mesh.material.opacity = startOpacity + (opacity - startOpacity) * t;
      const s = startScale + (scale - startScale) * t;
      mesh.scale = [s, s, s];
    } catch (_) {
      stretchAnimFramesRef.current.delete(mesh._stretchAnimId);
      mesh._stretchAnimId = null;
      return;
    }
    if (t < 1) {
      mesh._stretchAnimId = requestAnimationFrame(tick);
      stretchAnimFramesRef.current.add(mesh._stretchAnimId);
    } else {
      mesh._stretchAnimId = null;
      if (onComplete) onComplete();
    }
  };
  mesh._stretchAnimId = requestAnimationFrame(tick);
  stretchAnimFramesRef.current.add(mesh._stretchAnimId);
};

export const revealGroupForFace = (faceKey, stretchFaceAdjacencyRef, revealedFaceKeyRef, revealedHandlesRef, stretchAnimFramesRef) => {
  const group = stretchFaceAdjacencyRef.current.get(faceKey) || [];
  group.forEach(mesh => {
    mesh.visible = true;
    mesh.pickable = true;
    animateHandleTo(mesh, stretchAnimFramesRef, { opacity: mesh._stretchMeta.restOpacity, scale: 1 });
  });
  revealedFaceKeyRef.current = faceKey;
  revealedHandlesRef.current = group;
};

export const hideRevealedGroup = (revealedFaceKeyRef, revealedHandlesRef, stretchAnimFramesRef) => {
  if (!revealedFaceKeyRef.current) return;
  revealedHandlesRef.current.forEach(mesh => {
    mesh.pickable = false;
    animateHandleTo(mesh, stretchAnimFramesRef, { opacity: 0, scale: 1, onComplete: () => { try { mesh.visible = false; } catch (_) {} } });
  });
  revealedFaceKeyRef.current = null;
  revealedHandlesRef.current = [];
};

export const destroyStretchHandles = (ctx) => {
  const {
    stretchAnimFramesRef, stretchHandlesRef, selectionCageRef,
    hoveredStretchMeshRef, revealedFaceKeyRef, revealedHandlesRef,
    stretchFaceAdjacencyRef, canvasRef
  } = ctx;
  stretchAnimFramesRef.current.forEach(id => cancelAnimationFrame(id));
  stretchAnimFramesRef.current.clear();
  stretchHandlesRef.current.forEach(mesh => { try { mesh.destroy(); } catch (_) {} });
  stretchHandlesRef.current = [];
  destroySelectionCage(selectionCageRef);
  hoveredStretchMeshRef.current = null;
  revealedFaceKeyRef.current = null;
  revealedHandlesRef.current = [];
  stretchFaceAdjacencyRef.current = new Map();
  if (canvasRef.current) canvasRef.current.style.cursor = '';
};

export const buildStretchHandles = (ctx, entityId, isAsset) => {
  const { viewerRef, stretchHandlesRef, stretchFaceAdjacencyRef, selectionCageRef } = ctx;
  destroyStretchHandles(ctx);
  const viewer = viewerRef.current;
  if (!viewer) return;

  let aabb;
  if (isAsset) {
    const model = viewer.scene.models[entityId];
    if (!model) return;
    aabb = model.aabb;
  } else {
    const entity = viewer.scene.objects[entityId];
    if (!entity) return;
    aabb = entity.aabb;
  }
  if (!aabb) return;

  buildSelectionCage(viewerRef, selectionCageRef, aabb);

  const [xMin, yMin, zMin, xMax, yMax, zMax] = aabb;
  const cx = (xMin + xMax) / 2;
  const cy = (yMin + yMax) / 2;
  const cz = (zMin + zMax) / 2;
  const AXIS_MIN = [xMin, yMin, zMin];
  const AXIS_MAX = [xMax, yMax, zMax];
  const AXIS_CENTER = [cx, cy, cz];
  const pointFor = (axesList) => {
    const p = [...AXIS_CENTER];
    axesList.forEach(({ axis, dir }) => { p[axis] = dir > 0 ? AXIS_MAX[axis] : AXIS_MIN[axis]; });
    return p;
  };

  const FACE_SIZE = { 0: [0.07, 0.22, 0.07], 1: [0.22, 0.07, 0.07], 2: [0.22, 0.07, 0.07] };
  const EDGE_SIZE = [0.075, 0.075, 0.075];
  const CORNER_SIZE = [0.05, 0.05, 0.05];

  const handleDefs = [];

  for (let axis = 0; axis < 3; axis++) {
    for (const dir of [+1, -1]) {
      const axesList = [{ axis, dir }];
      handleDefs.push({ pos: pointFor(axesList), size: FACE_SIZE[axis], axesList });
    }
  }

  [[0, 1], [0, 2], [1, 2]].forEach(([a1, a2]) => {
    for (const d1 of [+1, -1]) {
      for (const d2 of [+1, -1]) {
        const axesList = [{ axis: a1, dir: d1 }, { axis: a2, dir: d2 }];
        handleDefs.push({ pos: pointFor(axesList), size: EDGE_SIZE, axesList });
      }
    }
  });

  for (const dx of [+1, -1]) {
    for (const dy of [+1, -1]) {
      for (const dz of [+1, -1]) {
        const axesList = [{ axis: 0, dir: dx }, { axis: 1, dir: dy }, { axis: 2, dir: dz }];
        handleDefs.push({ pos: pointFor(axesList), size: CORNER_SIZE, axesList });
      }
    }
  }

  stretchFaceAdjacencyRef.current = new Map();
  for (let axis = 0; axis < 3; axis++) {
    for (const dir of [+1, -1]) {
      stretchFaceAdjacencyRef.current.set(axisDirKey(axis, dir), []);
    }
  }

  const ts = Date.now();
  handleDefs.forEach((def, i) => {
    const [xSize, ySize, zSize] = def.size;
    const color = AXIS_HANDLE_COLORS[axesKey(def.axesList)] || AXIS_HANDLE_COLORS.XYZ;
    const type = def.axesList.length === 1 ? 'face' : def.axesList.length === 2 ? 'edge' : 'corner';
    const isFaceHandle = type === 'face';
    const restOpacity = type === 'face'
      ? STRETCH_HANDLE_FACE_OPACITY
      : type === 'edge'
        ? STRETCH_HANDLE_EDGE_OPACITY
        : STRETCH_HANDLE_CORNER_OPACITY;
    const mesh = new Mesh(viewer.scene, {
      id: `sh_${ts}_${i}`,
      geometry: new ReadableGeometry(viewer.scene, buildBoxGeometry({
        xSize, ySize, zSize,
      })),
      material: new PhongMaterial(viewer.scene, {
        diffuse: color,
        emissive: color,
        opacity: isFaceHandle ? restOpacity : 0,
      }),
      position: def.pos,
      visible: isFaceHandle,
      pickable: isFaceHandle,
    });
    mesh._stretchMeta = { isStretchHandle: true, axes: def.axesList, targetId: entityId, isAsset, color, type, restOpacity };
    stretchHandlesRef.current.push(mesh);
    if (!isFaceHandle) {
      def.axesList.forEach(({ axis, dir }) => {
        stretchFaceAdjacencyRef.current.get(axisDirKey(axis, dir))?.push(mesh);
      });
    }
  });
};