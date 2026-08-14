import { axesKey } from '../utils/helpers';
import { AXIS_HANDLE_COLORS, STRETCH_HANDLE_FACE_OPACITY } from '../utils/constants';
import { animateHandleTo } from './StretchHandles';

export const applyScale = (viewerRef, targetId, isAsset, scaleVec) => {
  const viewer = viewerRef.current;
  const [sx, sy, sz] = scaleVec;
  if (isAsset) {
    const model = viewer.scene.models[targetId];
    if (!model) return;
    const p = model.position || [0, 0, 0];
    model.matrix = [
      sx, 0,  0,  0,
      0,  sy, 0,  0,
      0,  0,  sz, 0,
      p[0], p[1], p[2], 1,
    ];
  } else {
    const entity = viewer.scene.objects[targetId];
    if (!entity) return;
    const p = entity.position || [0, 0, 0];
    entity.matrix = [
      sx, 0,  0,  0,
      0,  sy, 0,  0,
      0,  0,  sz, 0,
      p[0], p[1], p[2], 1,
    ];
  }
};

export const resetHoveredStretchHandle = (hoveredStretchMeshRef, stretchAnimFramesRef) => {
  const prev = hoveredStretchMeshRef.current;
  if (prev) {
    try {
      const base = prev._stretchMeta?.color || AXIS_HANDLE_COLORS.X;
      prev.material.diffuse = base;
      prev.material.emissive = base;
      const restOpacity = prev._stretchMeta?.restOpacity ?? STRETCH_HANDLE_FACE_OPACITY;
      animateHandleTo(prev, stretchAnimFramesRef, { opacity: restOpacity, scale: 1 });
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