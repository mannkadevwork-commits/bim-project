import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry';
import { buildBoxGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/builders/buildBoxGeometry';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';
import { buildSelectionCage, buildOrientedSelectionCage, destroySelectionCage } from '../viewer/SelectionController';
import { axesKey, axisDirKey } from '../utils/helpers';
import { getGLBPlacementTarget, getGLBRotation, getGLBScale, isGLBModel } from '../assets/GLBAssetTransform';
import { getIFCOBBCorners, getIFCResizeFrame, getIFCResizePoint, isIFCModel } from './IFCResizeController';
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
    stretchFaceAdjacencyRef, activeResizeFaceKeyRef, canvasRef
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
  if (activeResizeFaceKeyRef) activeResizeFaceKeyRef.current = null;
  
  if (canvasRef.current) canvasRef.current.style.cursor = '';
};


const addVisualHandleMeta = (mesh, meta) => {
  mesh._stretchMeta = meta;
  return mesh;
};

const buildFlatOctahedronGeometry = (size) => {
  const p = [
    [size, 0, 0], [-size, 0, 0], [0, size, 0], [0, -size, 0], [0, 0, size], [0, 0, -size],
  ];
  const triangles = [
    [0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0],
    [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5],
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  triangles.forEach((tri) => {
    const start = positions.length / 3;
    const a = p[tri[0]];
    const b = p[tri[1]];
    const c = p[tri[2]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    const normal = [n[0] / length, n[1] / length, n[2] / length];
    [a, b, c].forEach((v) => {
      positions.push(v[0], v[1], v[2]);
      normals.push(normal[0], normal[1], normal[2]);
    });
    indices.push(start, start + 1, start + 2);
  });
  return { positions, normals, indices };
};

const buildFaceArrowGeometry = (shaftLength = 0.30, shaftHalf = 0.035, headLength = 0.16, headHalf = 0.09) => {
  const positions = [];
  const normals = [];
  const indices = [];
  const addFace = (a, b, c) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const normal = [n[0] / len, n[1] / len, n[2] / len];
    const base = positions.length / 3;
    [a, b, c].forEach((v) => {
      positions.push(v[0], v[1], v[2]);
      normals.push(normal[0], normal[1], normal[2]);
    });
    indices.push(base, base + 1, base + 2);
  };

  // Shaft: a short rectangular rail ending exactly at the arrowhead base.
  const x0 = -shaftLength;
  const x1 = 0;
  const sy = shaftHalf;
  const sz = shaftHalf;
  const s = [
    [x0, -sy, -sz], [x1, -sy, -sz], [x1, sy, -sz], [x0, sy, -sz],
    [x0, -sy, sz], [x1, -sy, sz], [x1, sy, sz], [x0, sy, sz],
  ];
  const faces = [
    [s[0], s[1], s[2]], [s[0], s[2], s[3]],
    [s[4], s[6], s[5]], [s[4], s[7], s[6]],
    [s[0], s[4], s[5]], [s[0], s[5], s[1]],
    [s[3], s[2], s[6]], [s[3], s[6], s[7]],
    [s[1], s[5], s[6]], [s[1], s[6], s[2]],
    [s[0], s[3], s[7]], [s[0], s[7], s[4]],
  ];
  faces.forEach((face) => addFace(face[0], face[1], face[2]));

  // Arrow head: square base at x=0, tip at +headLength.
  const base = [
    [0, -headHalf, -headHalf], [0, -headHalf, headHalf],
    [0, headHalf, headHalf], [0, headHalf, -headHalf],
  ];
  const tip = [headLength, 0, 0];
  addFace(base[0], base[1], tip);
  addFace(base[1], base[2], tip);
  addFace(base[2], base[3], tip);
  addFace(base[3], base[0], tip);
  addFace(base[0], base[3], base[2]);
  addFace(base[0], base[2], base[1]);

  return { positions, normals, indices };
};

/**
 * Xeokit Mesh.rotation uses degrees. Keep all gizmo orientation math in
 * degrees so the handles follow model.rotation consistently.
 */
const rotationForDirection = (axis, dir, axes) => {
  const v = axes[axis];
  const d = [v[0] * dir, v[1] * dir, v[2] * dir];

  if (axis === 1) {
    // Canonical arrow points +X. Rotate +X to ±Y around Z.
    return [0, 0, d[1] >= 0 ? -90 : 90];
  }

  // For horizontal local axes, align +X with the requested world direction.
  return [0, Math.atan2(d[2], d[0]) * 180 / Math.PI, 0];
};

const createIFCResizeArrow = ({ viewer, ts, axis, dir, position, color, size, meta, localAxes }) => {
  // A shorter shaft + smaller arrowhead reads like a scale grip instead of a
  // floating arrow icon. Each side points OUTWARD from the OBB.
  const geometryData = buildFaceArrowGeometry(
    size * 1.55,
    size * 0.23,
    size * 0.75,
    size * 0.46
  );
  const mesh = new Mesh(viewer.scene, {
    id: `ifc_rg_${ts}_face_${axis}_${dir > 0 ? 'p' : 'n'}`,
    geometry: new ReadableGeometry(viewer.scene, {
      primitive: 'triangles',
      positions: geometryData.positions,
      normals: geometryData.normals,
      indices: geometryData.indices,
    }),
    material: new PhongMaterial(viewer.scene, {
      diffuse: color,
      emissive: color,
      opacity: 0.96,
    }),
    position,
    rotation: rotationForDirection(axis, dir, localAxes),
    pickable: true,
    collidable: false,
    visible: true,
  });
  return addVisualHandleMeta(mesh, {
    ...meta,
    type: 'face',
    handleId: `face_${axis}_${dir}`,
    direction: dir,
    color,
    restOpacity: 0.96,
    gizmoRole: 'face-handle',
    cursorAxes: meta.axes,
  });
};

const buildPlanArrowGeometry = (length = 0.52, width = 0.12, thickness = 0.045) => {
  // Thin arrow in the XZ floor plane; this communicates planar movement without
  // pretending the user is dragging a 3D box along an invisible Y constraint.
  const half = width / 2;
  const wing = width * 0.84;
  const tail = -length * 0.56;
  const neck = length * 0.10;
  const tip = length * 0.56;
  const polygon = [
    [tail, -half], [neck, -half], [neck, -wing], [tip, 0],
    [neck, wing], [neck, half], [tail, half],
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  const y0 = -thickness / 2;
  const y1 = thickness / 2;

  polygon.forEach(([x, z]) => { positions.push(x, y0, z); normals.push(0, -1, 0); });
  polygon.forEach(([x, z]) => { positions.push(x, y1, z); normals.push(0, 1, 0); });

  for (let i = 1; i < polygon.length - 1; i += 1) {
    indices.push(0, i + 1, i);
    indices.push(polygon.length, polygon.length + i, polygon.length + i + 1);
  }

  for (let i = 0; i < polygon.length; i += 1) {
    const j = (i + 1) % polygon.length;
    const a = polygon[i];
    const b = polygon[j];
    const edgeX = b[0] - a[0];
    const edgeZ = b[1] - a[1];
    const len = Math.hypot(edgeX, edgeZ) || 1;
    const nx = edgeZ / len;
    const nz = -edgeX / len;
    const base = positions.length / 3;
    positions.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y1, a[1]);
    normals.push(nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  return { positions, normals, indices };
};

const createModernMoveArrow = ({ viewer, ts, id, position, rotation, color, meta }) => {
  const geometryData = buildPlanArrowGeometry();
  const mesh = new Mesh(viewer.scene, {
    id: `sh_${ts}_move_${id}`,
    geometry: new ReadableGeometry(viewer.scene, {
      primitive: 'triangles',
      positions: geometryData.positions,
      normals: geometryData.normals,
      indices: geometryData.indices,
    }),
    material: new PhongMaterial(viewer.scene, {
      diffuse: color,
      emissive: color,
      opacity: 0.92,
    }),
    position,
    rotation,
    visible: true,
    pickable: true,
    collidable: false,
  });
  return addVisualHandleMeta(mesh, {
    ...meta,
    type: 'move',
    handleId: `move_${id}`,
    gizmoRole: 'move-handle',
  });
};

const createIFCResizeDiamond = ({ viewer, ts, position, color, size, meta, type, idSuffix }) => {
  const geometryData = buildFlatOctahedronGeometry(size);
  const mesh = new Mesh(viewer.scene, {
    id: `ifc_rg_${ts}_${idSuffix}`,
    geometry: new ReadableGeometry(viewer.scene, {
      primitive: 'triangles',
      positions: geometryData.positions,
      normals: geometryData.normals,
      indices: geometryData.indices,
    }),
    material: new PhongMaterial(viewer.scene, {
      diffuse: color,
      emissive: color,
      opacity: type === 'corner' ? 0.94 : 0.90,
    }),
    position,
    pickable: true,
    collidable: false,
    visible: true,
  });
  return addVisualHandleMeta(mesh, {
    ...meta,
    type,
    handleId: idSuffix,
    color,
    restOpacity: type === 'corner' ? 0.94 : 0.90,
    gizmoRole: `${type}-handle`,
  });
};

const buildModernIFCStretchHandles = (ctx, entityId, model, frameOverride = null, rotationYOverride = null) => {
  const {
    viewerRef, stretchHandlesRef, stretchFaceAdjacencyRef, selectionCageRef,
    activeResizeFaceKeyRef,
  } = ctx;
  const viewer = viewerRef.current;
  if (!viewer || !model) return;

  const frame = frameOverride || getIFCResizeFrame(model);
  if (!frame) return;
  const corners = getIFCOBBCorners(frame);
  buildOrientedSelectionCage(viewerRef, selectionCageRef, corners);

  const { center, axes, halfWorld } = frame;
  const maxDim = Math.max(halfWorld[0] * 2, halfWorld[1] * 2, halfWorld[2] * 2, 0.5);
  const grip = Math.max(0.07, Math.min(0.16, maxDim * 0.032));
  const ts = Date.now();

  const axisColors = [AXIS_HANDLE_COLORS.X, AXIS_HANDLE_COLORS.Y, AXIS_HANDLE_COLORS.Z];
  stretchFaceAdjacencyRef.current = new Map();
  if (activeResizeFaceKeyRef) activeResizeFaceKeyRef.current = null;
  for (let axis = 0; axis < 3; axis += 1) {
    for (const dir of [-1, 1]) {
      stretchFaceAdjacencyRef.current.set(axisDirKey(axis, dir), []);
    }
  }

  // FACE mode: six directional arrows. The shaft visually tells the user which
  // dimension they are dragging; the arrowhead is the actual hit target.
  for (let axis = 0; axis < 3; axis += 1) {
    for (const dir of [-1, 1]) {
      const position = getIFCResizePoint(frame, [{ axis, dir }]);
      const meta = {
        isStretchHandle: true,
        axes: [{ axis, dir }],
        targetId: entityId,
        isAsset: true,
        transformMode: 'stretch',
        localAxes: axes,
      };
      const arrow = createIFCResizeArrow({
        viewer, ts, axis, dir, position, color: axisColors[axis], size: grip, meta, localAxes: axes,
      });
      stretchHandlesRef.current.push(arrow);
    }
  }

  // EDGE mode: small diamonds at the twelve OBB edge centers.
  const edgePairs = [[0, 1], [0, 2], [1, 2]];
  edgePairs.forEach(([a1, a2]) => {
    for (const d1 of [-1, 1]) {
      for (const d2 of [-1, 1]) {
        const axesList = [{ axis: a1, dir: d1 }, { axis: a2, dir: d2 }];
        const position = getIFCResizePoint(frame, axesList);
        const color = AXIS_HANDLE_COLORS[axesKey(axesList)] || AXIS_HANDLE_COLORS.XYZ;
        const mesh = createIFCResizeDiamond({
          viewer, ts, position, color, size: grip * 0.78,
          type: 'edge',
          idSuffix: `edge_${a1}${d1 > 0 ? 'p' : 'n'}_${a2}${d2 > 0 ? 'p' : 'n'}`,
          meta: {
            isStretchHandle: true,
            axes: axesList,
            targetId: entityId,
            isAsset: true,
            transformMode: 'stretch',
            localAxes: axes,
          },
        });
        stretchHandlesRef.current.push(mesh);
        axesList.forEach(({ axis, dir }) => {
          stretchFaceAdjacencyRef.current.get(axisDirKey(axis, dir))?.push(mesh);
        });
      }
    }
  });

  // CORNER mode: eight larger diamonds, visually distinct from 1D/2D grips.
  for (const dx of [-1, 1]) {
    for (const dy of [-1, 1]) {
      for (const dz of [-1, 1]) {
        const axesList = [
          { axis: 0, dir: dx },
          { axis: 1, dir: dy },
          { axis: 2, dir: dz },
        ];
        const position = getIFCResizePoint(frame, axesList);
        const mesh = createIFCResizeDiamond({
          viewer, ts, position, color: AXIS_HANDLE_COLORS.XYZ, size: grip * 1.02,
          type: 'corner', idSuffix: `corner_${dx}_${dy}_${dz}`,
          meta: {
            isStretchHandle: true,
            axes: axesList,
            targetId: entityId,
            isAsset: true,
            transformMode: 'stretch',
            localAxes: axes,
          },
        });
        stretchHandlesRef.current.push(mesh);
        axesList.forEach(({ axis, dir }) => {
          stretchFaceAdjacencyRef.current.get(axisDirKey(axis, dir))?.push(mesh);
        });
      }
    }
  }

  // Rotation and move affordances stay visually consistent with the existing
  // working IFC rotation. Only the resize family is replaced here.
  const rotationY = Number.isFinite(rotationYOverride) ? rotationYOverride : (model.rotation?.[1] || 0);
  const ROTATION_COLOR = [0.48, 0.30, 0.95];
  const ROTATION_HOVER = [1.0, 0.42, 0.12];
  const radius = Math.max(halfWorld[0], halfWorld[2]) + Math.max(0.38, maxDim * 0.16);
  const ringYOffset = Math.max(0.03, maxDim * 0.012);
  const arcThickness = Math.max(0.12, Math.min(0.24, maxDim * 0.058));
  const arcSegments = 36;
  const arcStartDeg = -135;
  const arcEndDeg = 45;

  const createArc = (pickOnly) => {
    const positions = [];
    const indices = [];
    const halfThickness = (pickOnly ? Math.max(0.30, arcThickness * 2.8) : arcThickness) / 2;
    for (let i = 0; i <= arcSegments; i += 1) {
      const t = i / arcSegments;
      const theta = (arcStartDeg + (arcEndDeg - arcStartDeg) * t) * Math.PI / 180;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const outerRadius = radius + halfThickness;
      const innerRadius = Math.max(0.01, radius - halfThickness);
      positions.push(c * outerRadius, ringYOffset + 0.004, s * outerRadius);
      positions.push(c * innerRadius, ringYOffset + 0.004, s * innerRadius);
      if (i < arcSegments) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    return new Mesh(viewer.scene, {
      id: `ifc_rg_${ts}_${pickOnly ? 'rot_pick' : 'rot_arc'}`,
      geometry: new ReadableGeometry(viewer.scene, { primitive: 'triangles', positions, indices }),
      material: new PhongMaterial(viewer.scene, {
        diffuse: ROTATION_COLOR,
        emissive: ROTATION_COLOR,
        opacity: pickOnly ? 0.012 : 0.94,
      }),
      position: [...center],
      rotation: [0, rotationY, 0],
      pickable: true,
      collidable: false,
      visible: true,
    });
  };

  const rotationArcMesh = createArc(false);
  const rotationPickMesh = createArc(true);
  const theta = arcEndDeg * Math.PI / 180;
  const arrowCenterX = Math.cos(theta) * radius;
  const arrowCenterZ = Math.sin(theta) * radius;
  const tangent = [-Math.sin(theta), Math.cos(theta)];
  const normal = [Math.cos(theta), Math.sin(theta)];
  const wing = Math.max(0.10, Math.min(0.32, maxDim * 0.45));
  const tipDistance = 0.42;
  const baseDistance = 0.12;
  const arrowPositions = [
    arrowCenterX + tangent[0] * tipDistance, ringYOffset + 0.018, arrowCenterZ + tangent[1] * tipDistance,
    arrowCenterX - tangent[0] * baseDistance + normal[0] * wing, ringYOffset + 0.018, arrowCenterZ - tangent[1] * baseDistance + normal[1] * wing,
    arrowCenterX - tangent[0] * baseDistance - normal[0] * wing, ringYOffset + 0.018, arrowCenterZ - tangent[1] * baseDistance - normal[1] * wing,
  ];
  const rotationArrowMesh = new Mesh(viewer.scene, {
    id: `ifc_rg_${ts}_rot_arrow`,
    geometry: new ReadableGeometry(viewer.scene, { primitive: 'triangles', positions: arrowPositions, indices: [0, 1, 2] }),
    material: new PhongMaterial(viewer.scene, { diffuse: ROTATION_COLOR, emissive: ROTATION_COLOR, opacity: 1 }),
    position: [...center], rotation: [0, rotationY, 0], pickable: true, collidable: false, visible: true,
  });
  const rotationVisualGroup = [rotationArcMesh, rotationArrowMesh];
  [rotationArcMesh, rotationPickMesh, rotationArrowMesh].forEach((mesh) => {
    mesh._stretchMeta = {
      isStretchHandle: true,
      type: 'rotate',
      transformMode: 'rotate',
      axes: [],
      targetId: entityId,
      isAsset: true,
      color: ROTATION_COLOR,
      hoverColor: ROTATION_HOVER,
      restOpacity: mesh === rotationArcMesh ? 0.94 : (mesh === rotationArrowMesh ? 1.0 : 0.012),
      rotationGroup: rotationVisualGroup,
      rotationPickProxy: mesh === rotationPickMesh,
      rotationCenter: [...center],
    };
    stretchHandlesRef.current.push(mesh);
  });

  // Planar move gizmo: four outward arrows and a compact center puck.
  // The existing interaction remains a single free X/Z move; only the visual
  // affordance changes, so no drag/persistence contract is changed.
  const MOVE_HANDLE_COLOR = [0.18, 0.88, 0.78];
  const moveLift = Math.max(0.08, maxDim * 0.012);
  const moveCenter = [center[0], center[1] + moveLift, center[2]];
  const moveMeta = {
    isStretchHandle: true,
    transformMode: 'move',
    axes: [],
    targetId: entityId,
    isAsset: true,
    color: MOVE_HANDLE_COLOR,
    restOpacity: 0.92,
    // Keep IFC Move interaction consistent with the GLB path. The hover
    // fallback projects these world points into screen space so the user can
    // grab a Move control even when Scene.pick() hits the selected IFC mesh.
    moveInteractionCenterWorld: [...center],
    moveHitRadiusPx: 52,
  };
  const moveArrowOffset = Math.max(0.10, Math.min(0.26, maxDim * 0.055));
  [
    { id: 'xp', position: [moveCenter[0] + moveArrowOffset, moveCenter[1], moveCenter[2]], rotation: [0, 0, 0] },
    { id: 'xn', position: [moveCenter[0] - moveArrowOffset, moveCenter[1], moveCenter[2]], rotation: [0, 180, 0] },
    { id: 'zp', position: [moveCenter[0], moveCenter[1], moveCenter[2] + moveArrowOffset], rotation: [0, -90, 0] },
    { id: 'zn', position: [moveCenter[0], moveCenter[1], moveCenter[2] - moveArrowOffset], rotation: [0, 90, 0] },
  ].forEach((item) => {
    stretchHandlesRef.current.push(createModernMoveArrow({
      viewer, ts, id: item.id, position: item.position, rotation: item.rotation,
      color: MOVE_HANDLE_COLOR,
      meta: { ...moveMeta, moveInteractionPointWorld: [...item.position] },
    }));
  });

  const movePuck = createIFCResizeDiamond({
    viewer, ts, position: moveCenter, color: MOVE_HANDLE_COLOR, size: Math.max(0.055, grip * 0.62),
    type: 'move', idSuffix: 'move_center', meta: moveMeta,
  });
  movePuck._stretchMeta = {
    ...movePuck._stretchMeta,
    type: 'move',
    handleId: 'move_center',
    gizmoRole: 'move-center',
    restOpacity: 0.96,
  };
  stretchHandlesRef.current.push(movePuck);
};


const buildModernGLBStretchHandles = (ctx, entityId, model) => {
  if (!model || !isGLBModel(model)) return;

  const aabb = model.aabb;
  if (!Array.isArray(aabb) && !ArrayBuffer.isView(aabb)) return;
  if (aabb.length < 6) return;

  const rotation = getGLBRotation(model);
  const scale = getGLBScale(model);
  const rotationY = Number(rotation?.[1]) || 0;
  const rad = rotationY * Math.PI / 180;
  const c = Math.cos(rad);
  const sn = Math.sin(rad);
  const axes = [
    [c, 0, -sn],
    [0, 1, 0],
    [sn, 0, c],
  ];

  const dimensions = Array.isArray(model?._assetMeta?.assetDimensions)
    ? model._assetMeta.assetDimensions.map(Number)
    : [
        Math.max(0.001, Number(aabb[3]) - Number(aabb[0])),
        Math.max(0.001, Number(aabb[4]) - Number(aabb[1])),
        Math.max(0.001, Number(aabb[5]) - Number(aabb[2])),
      ];

  const safeDimensions = dimensions.map((value, axis) => (
    Number.isFinite(value) && value > 0
      ? value
      : Math.max(0.001, Math.abs(Number(aabb[axis + 3]) - Number(aabb[axis])))
  ));
  const safeScale = [0, 1, 2].map((axis) => {
    const value = Number(scale?.[axis]);
    return Number.isFinite(value) && Math.abs(value) > 1e-6 ? Math.abs(value) : 1;
  });

  const center = [
    (Number(aabb[0]) + Number(aabb[3])) / 2,
    (Number(aabb[1]) + Number(aabb[4])) / 2,
    (Number(aabb[2]) + Number(aabb[5])) / 2,
  ];
  const halfWorld = safeDimensions.map((value, axis) => Math.max(0.001, value * safeScale[axis] / 2));
  const frame = { center, axes, halfWorld };

  // Reuse the exact same gizmo renderer as isolated IFC. Only the source frame
  // and canonical GLB rotation are different; transform mathematics remains in
  // the dedicated GLB controllers in useBIMEngine/GLBAssetTransform.
  buildModernIFCStretchHandles(ctx, entityId, model, frame, rotationY);
};

export const buildStretchHandles = (ctx, entityId, isAsset) => {
  const { viewerRef, stretchHandlesRef, stretchFaceAdjacencyRef, selectionCageRef, activeResizeFaceKeyRef } = ctx;
  destroyStretchHandles(ctx);
  
  const viewer = viewerRef.current;
  if (!viewer) return;

  if (isAsset) {
    const model = viewer.scene.models[entityId];
    if (model && isIFCModel(model)) {
      buildModernIFCStretchHandles(ctx, entityId, model);
      return;
    }
    if (model && isGLBModel(model)) {
      buildModernGLBStretchHandles(ctx, entityId, model);
      return;
    }
  }
  
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
  const maxDim = Math.max(xMax - xMin, yMax - yMin, zMax - zMin, 0.5);

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
  
  // Keep handles readable across different asset sizes without turning
  // them into oversized boxes. Use the object's local dimensions as the
  // scale reference.
  const grip = Math.max(0.055, Math.min(0.18, maxDim * 0.045));
  const FACE_SIZE = {
     0: [grip * 0.45, grip * 2.2, grip * 2.2],
     1: [grip * 2.2, grip * 0.45, grip * 2.2],
     2: [grip * 2.2, grip * 2.2, grip * 0.45],
   };
  const CORNER_2D_SIZE = [grip * 0.95, grip * 0.95, grip * 0.95];
  const CORNER_3D_SIZE = [grip * 1.15, grip * 1.15, grip * 1.15];
  
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
        handleDefs.push({ pos: pointFor(axesList), size: CORNER_2D_SIZE, axesList, handleType: 'edge' });
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
        handleDefs.push({ pos: pointFor(axesList), size: CORNER_3D_SIZE, axesList, handleType: 'corner' });
      }
    }
  }

  stretchFaceAdjacencyRef.current = new Map();
  if (activeResizeFaceKeyRef) activeResizeFaceKeyRef.current = null;
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

  // Rotation UX: one continuous, thick half-arc with a single directional
  // arrowhead. The gizmo is authored in local X/Z space and rotated around
  // the object, so the arc + arrow visibly follow the furniture rotation.
  const ROTATION_COLOR = [0.48, 0.30, 0.95];
  const ROTATION_HOVER = [1.0, 0.42, 0.12];
  const rotationCenter = isAsset && isGLBModel(viewer.scene.models[entityId])
    ? getGLBPlacementTarget(viewer.scene.models[entityId])
    : center;
  const horizontalHalfX = Math.max(Math.abs(xMin - rotationCenter[0]), Math.abs(xMax - rotationCenter[0]));
  const horizontalHalfZ = Math.max(Math.abs(zMin - rotationCenter[2]), Math.abs(zMax - rotationCenter[2]));
  const radius = Math.max(horizontalHalfX, horizontalHalfZ) + Math.max(0.38, maxDim * 0.16);
  const ringYOffset = Math.max(0.03, maxDim * 0.012);
  // Use real triangle geometry for the arc instead of WebGL line width.
  // Line width is implementation-dependent and was rendering too thin in the
  // browser. A ribbon gives us a consistent, screen-readable interaction band.
  const arcThickness = Math.max(0.12, Math.min(0.24, maxDim * 0.058));
  const arcSegments = 36;
  const arcStartDeg = -135;
  const arcEndDeg = 45; // 180° half-arc; arrow sits at the end.

  const createRotationArc = () => {
    const positions = [];
    const indices = [];
    const halfThickness = arcThickness / 2;

    for (let i = 0; i <= arcSegments; i++) {
      const t = i / arcSegments;
      const theta = (arcStartDeg + (arcEndDeg - arcStartDeg) * t) * Math.PI / 180;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const outerRadius = radius + halfThickness;
      const innerRadius = Math.max(0.01, radius - halfThickness);

      // outer vertex
      positions.push(
        cos * outerRadius,
        ringYOffset,
        sin * outerRadius,
      );
      // inner vertex
      positions.push(
        cos * innerRadius,
        ringYOffset,
        sin * innerRadius,
      );

      if (i < arcSegments) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, b, c, b, d, c);
      }
    }

    return new Mesh(viewer.scene, {
      id: `sh_${ts}_rot_arc`,
      geometry: new ReadableGeometry(viewer.scene, {
        primitive: 'triangles',
        positions,
        indices,
      }),
      material: new PhongMaterial(viewer.scene, {
        diffuse: ROTATION_COLOR,
        emissive: ROTATION_COLOR,
        opacity: 0.94,
      }),
      position: rotationCenter,
      rotation: [0, rotationY, 0],
      pickable: true,
      collidable: false,
      visible: true,
    });
  };

  // Build a separate, intentionally generous interaction halo around the arc.
  // The user does not need to land the cursor on the exact visual stroke: while
  // Rotate mode is active, this halo is the forgiving hit target. It is nearly
  // invisible but remains pickable, so we can keep the visual design clean.
  const createRotationPickArc = () => {
    const positions = [];
    const indices = [];
    const pickThickness = Math.max(0.30, arcThickness * 2.8);
    const halfThickness = pickThickness / 2;
    const pickRadius = radius;

    for (let i = 0; i <= arcSegments; i++) {
      const t = i / arcSegments;
      const theta = (arcStartDeg + (arcEndDeg - arcStartDeg) * t) * Math.PI / 180;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const outerRadius = pickRadius + halfThickness;
      const innerRadius = Math.max(0.01, pickRadius - halfThickness);

      positions.push(cos * outerRadius, ringYOffset + 0.004, sin * outerRadius);
      positions.push(cos * innerRadius, ringYOffset + 0.004, sin * innerRadius);

      if (i < arcSegments) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, b, c, b, d, c);
      }
    }

    return new Mesh(viewer.scene, {
      id: `sh_${ts}_rot_pick_arc`,
      geometry: new ReadableGeometry(viewer.scene, {
        primitive: 'triangles',
        positions,
        indices,
      }),
      material: new PhongMaterial(viewer.scene, {
        diffuse: ROTATION_COLOR,
        emissive: ROTATION_COLOR,
        opacity: 0.012,
      }),
      position: rotationCenter,
      rotation: [0, rotationY, 0],
      pickable: true,
      collidable: false,
      visible: true,
    });
  };

  const createRotationArrow = () => {
    const theta = arcEndDeg * Math.PI / 180;
    const centerX = Math.cos(theta) * radius;
    const centerZ = Math.sin(theta) * radius;
    const tangent = [-Math.sin(theta), Math.cos(theta)];
    const normal = [Math.cos(theta), Math.sin(theta)];

    // The triangle points along the tangent of the arc, making the intended
    // rotation direction obvious rather than looking like a random marker.
      const tipDistance = 0.42
      const baseDistance = 0.12
    
    const wing = Math.max(0.10, Math.min(0.32, maxDim * 0.45));
    const tipX = centerX + tangent[0] * tipDistance;
    const tipZ = centerZ + tangent[1] * tipDistance;
    const baseCenterX = centerX - tangent[0] * baseDistance;
    const baseCenterZ = centerZ - tangent[1] * baseDistance;

    const positions = [
      tipX, ringYOffset + 0.018, tipZ,
      baseCenterX + normal[0] * wing, ringYOffset + 0.018, baseCenterZ + normal[1] * wing,
      baseCenterX - normal[0] * wing, ringYOffset + 0.018, baseCenterZ - normal[1] * wing,
    ];

    return new Mesh(viewer.scene, {
      id: `sh_${ts}_rot_arrow`,
      geometry: new ReadableGeometry(viewer.scene, {
        primitive: 'triangles',
        positions,
        indices: [0, 1, 2],
      }),
      material: new PhongMaterial(viewer.scene, {
        diffuse: ROTATION_COLOR,
        emissive: ROTATION_COLOR,
        opacity: 1.0,
      }),
      position: rotationCenter,
      rotation: [0, rotationY, 0],
      pickable: true,
      collidable: false,
      visible: true,
    });
  };

  const rotationArcMesh = createRotationArc();
  const rotationArrowMesh = createRotationArrow();
  const rotationPickArcMesh = createRotationPickArc();
  const rotationVisualGroup = [rotationArcMesh, rotationArrowMesh];
  const rotationGroup = [...rotationVisualGroup, rotationPickArcMesh];

  rotationGroup.forEach(mesh => {
    mesh._stretchMeta = {
      isStretchHandle: true,
      type: 'rotate',
      transformMode: 'rotate',
      axes: [],
      targetId: entityId,
      isAsset,
      color: ROTATION_COLOR,
      hoverColor: ROTATION_HOVER,
      restOpacity: mesh === rotationArcMesh ? 0.94 : (mesh === rotationArrowMesh ? 1.0 : 0.012),
      rotationGroup: rotationVisualGroup,
      rotationPickProxy: mesh === rotationPickArcMesh,
      rotationCenter,
    };
    stretchHandlesRef.current.push(mesh);
  });

  // Same planar move language for the legacy/native-object fallback.
  const MOVE_HANDLE_COLOR = [0.18, 0.88, 0.78];
  const moveLift = Math.max(0.08, maxDim * 0.012);
  const moveCenter = [cx, cy + moveLift, cz];
  const moveMeta = {
    isStretchHandle: true,
    transformMode: 'move',
    axes: [],
    targetId: entityId,
    isAsset,
    color: MOVE_HANDLE_COLOR,
    restOpacity: 0.92,
    moveInteractionCenterWorld: [...center],
    moveHitRadiusPx: 52,
  };
  const moveArrowOffset = Math.max(0.10, Math.min(0.26, maxDim * 0.055));
  [
    { id: 'xp', position: [moveCenter[0] + moveArrowOffset, moveCenter[1], moveCenter[2]], rotation: [0, 0, 0] },
    { id: 'xn', position: [moveCenter[0] - moveArrowOffset, moveCenter[1], moveCenter[2]], rotation: [0, 180, 0] },
    { id: 'zp', position: [moveCenter[0], moveCenter[1], moveCenter[2] + moveArrowOffset], rotation: [0, -90, 0] },
    { id: 'zn', position: [moveCenter[0], moveCenter[1], moveCenter[2] - moveArrowOffset], rotation: [0, 90, 0] },
  ].forEach((item) => {
    stretchHandlesRef.current.push(createModernMoveArrow({
      viewer, ts, id: item.id, position: item.position, rotation: item.rotation,
      color: MOVE_HANDLE_COLOR,
      meta: { ...moveMeta, moveInteractionPointWorld: [...item.position] },
    }));
  });
  const movePuck = createIFCResizeDiamond({
    viewer, ts, position: moveCenter, color: MOVE_HANDLE_COLOR, size: Math.max(0.055, grip * 0.62),
    type: 'move', idSuffix: 'move_center', meta: moveMeta,
  });
  movePuck._stretchMeta = { ...movePuck._stretchMeta, type: 'move', handleId: 'move_center', gizmoRole: 'move-center', restOpacity: 0.96 };
  stretchHandlesRef.current.push(movePuck);

};