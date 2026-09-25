import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';
import { SELECTION_CAGE_COLOR } from '../utils/constants';

export const destroySelectionCage = (selectionCageRef) => {
  if (selectionCageRef.current) {
    try { selectionCageRef.current.destroy(); } catch (_) {}
    selectionCageRef.current = null;
  }
};

export const buildSelectionCage = (viewerRef, selectionCageRef, aabb) => {
  destroySelectionCage(selectionCageRef);
  const viewer = viewerRef.current;
  if (!viewer || !aabb) return;
  const [xMin, yMin, zMin, xMax, yMax, zMax] = aabb;
  const positions = [
    xMin, yMin, zMin,  xMax, yMin, zMin,  xMax, yMax, zMin,  xMin, yMax, zMin,
    xMin, yMin, zMax,  xMax, yMin, zMax,  xMax, yMax, zMax,  xMin, yMax, zMax,
  ];
  const indices = [
    0, 1, 1, 2, 2, 3, 3, 0,
    4, 5, 5, 6, 6, 7, 7, 4,
    0, 4, 1, 5, 2, 6, 3, 7,
  ];
  selectionCageRef.current = new Mesh(viewer.scene, {
    id: `sel_cage_${Date.now()}`,
    geometry: new ReadableGeometry(viewer.scene, {
      primitive: 'lines',
      positions,
      indices,
    }),
    material: new PhongMaterial(viewer.scene, {
      diffuse: SELECTION_CAGE_COLOR,
      emissive: SELECTION_CAGE_COLOR,
      lineWidth: 1,
    }),
    pickable: false,
    collidable: false,
  });
};