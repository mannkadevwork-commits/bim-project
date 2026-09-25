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

export const buildStretchHandles = (ctx, entityId, isAsset) => {
  const { viewerRef, stretchHandlesRef, stretchFaceAdjacencyRef, selectionCageRef, activeResizeFaceKeyRef } = ctx;
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
  
  // Keep handles readable across different asset sizes without turning
  // them into oversized boxes. Use the object's local dimensions as the
  // scale reference.
  const maxDim = Math.max(worldHalf[0] * 2, worldHalf[1] * 2, worldHalf[2] * 2, 0.5);
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
  const radiusX = (xMax - xMin) / 2;
  const radiusZ = (zMax - zMin) / 2;
  const radius = Math.max(radiusX, radiusZ) + Math.max(0.38, maxDim * 0.16);
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
      position: center,
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
      position: center,
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
      position: center,
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
      rotationCenter: center,
    };
    stretchHandlesRef.current.push(mesh);
  });

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