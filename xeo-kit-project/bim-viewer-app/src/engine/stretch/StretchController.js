import { axesKey } from '../utils/helpers';
import { AXIS_HANDLE_COLORS, STRETCH_HANDLE_FACE_OPACITY } from '../utils/constants';
import { animateHandleTo } from './StretchHandles';
import {
  applyGLBPlacementTransform,
  applyGLBResizeTransform,
  getGLBPlacementTarget,
  getGLBRotation,
  getGLBScale,
  isGLBModel,
} from '../assets/GLBAssetTransform';

/**
 * Apply resize to the selected asset.
 *
 * IMPORTANT:
 * - GLB assets use the new normalized GLB transform contract.
 * - IFC catalogue assets deliberately keep the exact safe-point resize
 *   representation: a direct scale matrix, followed by the existing
 *   model.position update in useBIMEngine.
 *
 * Do not route IFC assets through GLB normalization.
 */
export const applyScale = (
  viewerRef,
  targetId,
  isAsset,
  scaleVec,
  targetPosition = null,
) => {
  const viewer = viewerRef.current;
  if (!viewer || !Array.isArray(scaleVec) || scaleVec.length !== 3) return;

  const [sx, sy, sz] = scaleVec;

  if (isAsset) {
    const model = viewer.scene.models[targetId];
    if (!model) return;

    if (isGLBModel(model)) {
      const target = Array.isArray(targetPosition) && targetPosition.length === 3
        ? targetPosition
        : getGLBPlacementTarget(model);

      // GLB path is unchanged: normalized pivot + semantic transform.
      applyGLBResizeTransform(
        model,
        target,
        getGLBRotation(model),
        [sx, sy, sz],
      );
      return;
    }

    // IFC catalogue asset SAFE POINT:
    // Preserve the original working resize representation. The surrounding
    // useBIMEngine logic updates model.position after this matrix write.
    const p = model.position || [0, 0, 0];
    model.matrix = [
      sx, 0,  0,  0,
      0,  sy, 0,  0,
      0,  0,  sz, 0,
      p[0], p[1], p[2], 1,
    ];
    return;
  }

  // Native IFC entity SAFE POINT.
  const entity = viewer.scene.objects[targetId];
  if (!entity) return;

  const p = entity.position || [0, 0, 0];
  entity.matrix = [
    sx, 0,  0,  0,
    0,  sy, 0,  0,
    0,  0,  sz, 0,
    p[0], p[1], p[2], 1,
  ];
};

export const resetHoveredStretchHandle = (hoveredStretchMeshRef, stretchAnimFramesRef) => {
  const prev = hoveredStretchMeshRef.current;
  if (prev) {
    try {
      const meta = prev._stretchMeta || {};
      const group = meta.rotationGroup || [prev];
      if (meta.type === 'rotate') {
        group.forEach(mesh => {
          const base = mesh._stretchMeta?.color || AXIS_HANDLE_COLORS.X;
          mesh.material.diffuse = base;
          mesh.material.emissive = base;
          mesh.material.opacity = mesh._stretchMeta?.restOpacity ?? STRETCH_HANDLE_FACE_OPACITY;
        });
      } else {
        const base = meta.color || AXIS_HANDLE_COLORS.X;
        prev.material.diffuse = base;
        prev.material.emissive = base;
        const restOpacity = meta.restOpacity ?? STRETCH_HANDLE_FACE_OPACITY;
        animateHandleTo(prev, stretchAnimFramesRef, { opacity: restOpacity, scale: 1 });
      }
    } catch (_) {}
    hoveredStretchMeshRef.current = null;
  }
};

export const cursorForAxes = (axesList) => {
  if (axesList.length === 1) {
    const { axis } = axesList[0];
    return axis === 1 ? 'ns-resize' : axis === 0 ? 'ew-resize' : 'nwse-resize';
  }
  if (axesList.length === 2) {
    const key = axesKey(axesList);
    if (key === 'XY') {
      const x = axesList.find(a => a.axis === 0).dir;
      const y = axesList.find(a => a.axis === 1).dir;
      return (x * y > 0) ? 'nwse-resize' : 'nesw-resize';
    }
    return 'move';
  }
  return 'move';
};
