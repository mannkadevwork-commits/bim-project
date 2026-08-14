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

// FIXED: Defining the missing getLocalAxes helper
const getLocalAxes = (viewer, targetId, isAsset) => {
    const target = isAsset ? viewer.scene.models[targetId] : viewer.scene.objects[targetId];
    const rotationY = target?.rotation?.[1] || 0;
    const rad = (rotationY * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return {
        rotationY,
        axes: [
            [c, 0, -s],
            [0, 1, 0],
            [s, 0, c]
        ]
    };
};

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
  if (revealedFaceKeyRef.current === faceKey) return;
  
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
  const center = [cx, cy, cz];
  
  const worldHalf = [
    (xMax - xMin) / 2,
    (yMax - yMin) / 2,
    (zMax - zMin) / 2,
  ];

  const { rotationY, axes: localAxes } = getLocalAxes(viewer, entityId, isAsset);
  
  const pointFor = (axesList) => {
    const p = [...center];
    axesList.forEach(({ axis, dir }) => {
      const v = localAxes[axis];
      const extent = worldHalf[axis];
      p[0] += v[0] * extent * dir;
      p[1] += v[1] * extent * dir;
      p[2] += v[2] * extent * dir;
    });
    return p;
  };
  
  const FACE_SIZE = { 
     0: [0.01, 0.25, 0.25], 
     1: [0.25, 0.01, 0.25], 
     2: [0.25, 0.25, 0.01] 
   };
  const CORNER_2D_SIZE = [0.08, 0.08, 0.08];
  const CORNER_3D_SIZE = [0.11, 0.11, 0.11];
  
  const handleDefs = [];
  
  for (let axis = 0; axis < 3; axis++) {
    for (const dir of [+1, -1]) {
      handleDefs.push({ pos: pointFor([{axis, dir}]), size: FACE_SIZE[axis], axesList: [{axis, dir}] });
    }
  }
  
  [[0, 1], [0, 2], [1, 2]].forEach(([a1, a2]) => {
    for (const d1 of [+1, -1]) {
      for (const d2 of [+1, -1]) {
        const axesList = [{ axis: a1, dir: d1 }, { axis: a2, dir: d2 }];
        handleDefs.push({ pos: pointFor(axesList), size: CORNER_2D_SIZE, axesList, handleType: 'corner2d' });
      }
    }
  });

  // Eight corner handles for true 3-axis stretch.
  for (const dx of [+1, -1]) {
    for (const dy of [+1, -1]) {
      for (const dz of [+1, -1]) {
        const axesList = [
          { axis: 0, dir: dx },
          { axis: 1, dir: dy },
          { axis: 2, dir: dz },
        ];
        handleDefs.push({ pos: pointFor(axesList), size: CORNER_3D_SIZE, axesList, handleType: 'corner3d' });
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
    const isFace = def.axesList.length === 1;
    const [xSize, ySize, zSize] = def.size;
    const color = AXIS_HANDLE_COLORS[axesKey(def.axesList)] || AXIS_HANDLE_COLORS.XYZ;
    
    const mesh = new Mesh(viewer.scene, {
      id: `sh_${ts}_${i}`,
      geometry: new ReadableGeometry(viewer.scene, buildBoxGeometry({
        xSize, ySize, zSize,
      })),
      material: new PhongMaterial(viewer.scene, {
        diffuse: color,
        emissive: color,
        opacity: isFace ? STRETCH_HANDLE_FACE_OPACITY : 0, 
      }),
      position: def.pos,
      visible: isFace,
      pickable: isFace,
    });
    
    mesh._stretchMeta = {
       isStretchHandle: true,
       axes: def.axesList,
       targetId: entityId,
       isAsset,
       color,
       type: isFace ? 'face' : (def.handleType || 'corner2d'),
       transformMode: 'stretch',
       localAxes, 
       restOpacity: isFace ? STRETCH_HANDLE_FACE_OPACITY : STRETCH_HANDLE_EDGE_OPACITY 
    };
    
    stretchHandlesRef.current.push(mesh);
    if (!isFace) {
      def.axesList.forEach(({ axis, dir }) => {
        stretchFaceAdjacencyRef.current.get(axisDirKey(axis, dir))?.push(mesh);
      });
    }
  });

  // Modern rotate UX: two directional circular-arrow controls at the
  // left and right of the selected object. The existing drag math still
  // performs the Y-axis rotation; only the visual affordance changes here.
  const ROTATION_COLOR = [0.13, 0.58, 0.95];
  const ROTATION_HOVER = [0.25, 0.78, 1.0];
  const radiusX = (xMax - xMin) / 2;
  const radiusZ = (zMax - zMin) / 2;
  const radius = Math.max(radiusX, radiusZ) + 0.42;
  const ringY = cy;
  const segments = 28;

  const createRotateArc = (startDeg, endDeg, id) => {
    const positions = [];
    const indices = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const theta = (startDeg + (endDeg - startDeg) * t) * Math.PI / 180;
      positions.push(
        cx + Math.cos(theta) * radius,
        ringY,
        cz + Math.sin(theta) * radius,
      );
      if (i < segments) indices.push(i, i + 1);
    }

    const mesh = new Mesh(viewer.scene, {
      id,
      geometry: new ReadableGeometry(viewer.scene, {
        primitive: 'lines',
        positions,
        indices,
      }),
      material: new PhongMaterial(viewer.scene, {
        emissive: ROTATION_COLOR,
        lineWidth: 4,
        opacity: 0.78,
      }),
      pickable: true,
      collidable: false,
      visible: true,
    });

    mesh._stretchMeta = {
      isStretchHandle: true,
      type: 'rotate',
      transformMode: 'rotate',
      axes: [],
      targetId: entityId,
      isAsset,
      color: ROTATION_COLOR,
      hoverColor: ROTATION_HOVER,
      restOpacity: 0.78,
    };
    stretchHandlesRef.current.push(mesh);
    return mesh;
  };

  const createRotateArrow = (angleDeg, direction, id) => {
    const theta = angleDeg * Math.PI / 180;
    const x = cx + Math.cos(theta) * radius;
    const z = cz + Math.sin(theta) * radius;
    const tangent = [-Math.sin(theta) * direction, Math.cos(theta) * direction];
    const normal = [Math.cos(theta), Math.sin(theta)];
    const tip = [x + tangent[0] * 0.16, ringY + 0.012, z + tangent[1] * 0.16];
    const base = [x - tangent[0] * 0.07, ringY + 0.012, z - tangent[1] * 0.07];
    const wing = 0.08;
    const p1 = [base[0] + normal[0] * wing, base[1], base[2] + normal[1] * wing];
    const p2 = [base[0] - normal[0] * wing, base[1], base[2] - normal[1] * wing];

    const mesh = new Mesh(viewer.scene, {
      id,
      geometry: new ReadableGeometry(viewer.scene, {
        primitive: 'triangles',
        positions: [
          tip[0], tip[1], tip[2],
          p1[0], p1[1], p1[2],
          p2[0], p2[1], p2[2],
        ],
        indices: [0, 1, 2],
      }),
      material: new PhongMaterial(viewer.scene, {
        diffuse: ROTATION_COLOR,
        emissive: ROTATION_COLOR,
        opacity: 0.98,
      }),
      pickable: true,
      collidable: false,
      visible: true,
    });

    mesh._stretchMeta = {
      isStretchHandle: true,
      type: 'rotate',
      transformMode: 'rotate',
      axes: [],
      targetId: entityId,
      isAsset,
      color: ROTATION_COLOR,
      hoverColor: ROTATION_HOVER,
      restOpacity: 0.98,
    };
    stretchHandlesRef.current.push(mesh);
  };

  // Two opposite circular arrows communicate: "drag here to rotate".
  createRotateArc(200, 335, `sh_${ts}_rot_left_arc`);
  createRotateArrow(335, +1, `sh_${ts}_rot_left_arrow`);
  createRotateArc(25, 160, `sh_${ts}_rot_right_arc`);
  createRotateArrow(160, -1, `sh_${ts}_rot_right_arrow`);

  // Keep the currently approved Move affordance unchanged; only the
  // rotation visual is being redesigned in this pass.
  const MOVE_HANDLE_COLOR = [1, 0.78, 0.2];
  const moveHandle = new Mesh(viewer.scene, {
      id: `sh_${ts}_move`,
      geometry: new ReadableGeometry(viewer.scene, buildBoxGeometry({
          xSize: 0.22, ySize: 0.04, zSize: 0.22,
      })),
      material: new PhongMaterial(viewer.scene, {
          diffuse: MOVE_HANDLE_COLOR,
          emissive: MOVE_HANDLE_COLOR,
          opacity: 0.85,
      }),
      position: [cx, yMax + 0.15, cz],
      visible: true,
      pickable: true,
  });
  moveHandle._stretchMeta = {
      isStretchHandle: true,
      type: 'move',
      transformMode: 'move',
      axes: [],
      targetId: entityId,
      isAsset,
      color: MOVE_HANDLE_COLOR,
      restOpacity: 0.85,
  };
  stretchHandlesRef.current.push(moveHandle);

};