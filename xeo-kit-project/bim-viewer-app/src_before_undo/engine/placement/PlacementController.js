import { WALL_IFC_CLASSES } from '../utils/constants';

export const resolveCollisionFreePosition = (pos, projectStateRef, minDistance = 0.9) => {
  const furniture = projectStateRef.current.furniture || [];
  let [x, y, z] = pos;

  const isClear = (px, pz) =>
    furniture.every(f => {
      const dx = (f.position?.[0] ?? 0) - px;
      const dz = (f.position?.[2] ?? 0) - pz;
      return Math.sqrt(dx * dx + dz * dz) >= minDistance;
    });

  let attempt = 0;
  const maxAttempts = 24;
  while (!isClear(x, z) && attempt < maxAttempts) {
    attempt++;
    const angle = attempt * 0.8;
    const radius = 0.3 * attempt;
    x = pos[0] + Math.cos(angle) * radius;
    z = pos[2] + Math.sin(angle) * radius;
  }

  return [x, y, z];
};

export const getWallSnapData = (viewerRef, canvasPos) => {
  const viewer = viewerRef.current;
  if (!viewer || !canvasPos) return null;

  const wallPick = viewer.scene.pick({
    canvasPos,
    pickSurface: true,
  });

  if (!wallPick?.worldPos || !wallPick?.worldNormal || !wallPick?.entity) return null;

  const normal = wallPick.worldNormal;
  const horizontalMag = Math.sqrt(normal[0] * normal[0] + normal[2] * normal[2]);
  const isVertical = Math.abs(normal[1]) < 0.25 && horizontalMag > 0.9;
  if (!isVertical) return null;

  const metaObject = viewer.metaScene.metaObjects[wallPick.entity.id];
  if (!metaObject || !WALL_IFC_CLASSES.has(metaObject.type)) return null;

  // Wall hosting is backend-authoritative. Xeokit only supplies the host wall
  // identity, click point and surface validation. The IFC wall placement/profile
  // determines the final center and rotation.
  return {
    position: [...wallPick.worldPos],
    rotation: [0, 0, 0],
    wallGlobalId: wallPick.entity.id,
    wallNormal: [...normal],
    wallEntityId: wallPick.entity.id,
    wallEntityModelId: wallPick.entity.model?.id ?? null,
  };
};

export const getDropPosition = (viewerRef, projectStateRef, canvasPos, assetType = null) => {
  const viewer = viewerRef.current;
  if (!viewer) {
    return assetType === 'door'
      ? { position: [0, 0, 0], rotation: [0, 0, 0], wallGlobalId: null, snapped: false }
      : [0, 0, 0];
  }

  if (assetType === 'door') {
    const wallSnap = getWallSnapData(viewerRef, canvasPos);
    if (wallSnap) return { ...wallSnap, snapped: true };

    const cursorPick = viewer.scene.pick({ canvasPos, pickSurface: true });
    return {
      position: cursorPick?.worldPos ? [...cursorPick.worldPos] : [viewer.camera.look[0], 0, viewer.camera.look[2]],
      rotation: [0, 0, 0],
      wallGlobalId: null,
      snapped: false,
    };
  }

  const cursorPick = viewer.scene.pick({ canvasPos, pickSurface: true });
  let x = cursorPick?.worldPos?.[0] ?? viewer.camera.look[0];
  let z = cursorPick?.worldPos?.[2] ?? viewer.camera.look[2];
  let y = 0;

  const floorPick = viewer.scene.pick({
    origin: [x, 1000, z],
    direction: [0, -1, 0],
    pickSurface: true,
  });

  if (floorPick?.worldPos && floorPick?.worldNormal && floorPick.worldNormal[1] > 0.7) {
    x = floorPick.worldPos[0];
    y = floorPick.worldPos[1];
    z = floorPick.worldPos[2];
  }

  return resolveCollisionFreePosition([x, y, z], projectStateRef);
};

export const getCursorWorldPosition = (viewerRef, canvasPos) => {
  const viewer = viewerRef.current;
  if (!viewer) return null;
  const cursorPick = viewer.scene.pick({ canvasPos, pickSurface: true });
  return cursorPick?.worldPos || null;
};
