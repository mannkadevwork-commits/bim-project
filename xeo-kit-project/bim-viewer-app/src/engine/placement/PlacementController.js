import { WALL_IFC_CLASSES } from '../utils/constants';
import { classifyWallHost, createWallHostPlacement, isVerticalWallNormal } from './wallHostPlacement.mjs';

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



const resolveWallStandoff = (asset = {}) => {
  const explicit = Number(asset.wallMountOffset ?? asset.wall_mount_offset);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(0.35, explicit);
  const dimensions = asset.dimensions || asset.size || {};
  const depth = Number(
    asset.wallMountDepth ?? asset.wall_mount_depth ??
    asset.depth ?? dimensions.depth ?? dimensions.z ??
    (Array.isArray(dimensions) ? dimensions[2] : NaN)
  );
  return Number.isFinite(depth) && depth > 0 ? Math.min(0.35, Math.max(0.02, depth / 2 + 0.012)) : 0.06;
};

/**
 * Resolve a reusable IFC/GLB wall host from a xeokit surface pick.
 * This is intentionally separate from getWallSnapData(): legacy door insertion
 * retains its existing IFC-only backend contract until the new opening adapter
 * is implemented.
 */
export const getWallHostData = (viewerRef, canvasPos, asset = {}) => {
  const viewer = viewerRef?.current;
  if (!viewer || !canvasPos) return null;

  let wallPick = null;
  try {
    wallPick = viewer.scene.pick({ canvasPos, pickSurface: true });
  } catch (_) {
    return null;
  }

  const entity = wallPick?.entity;
  const position = wallPick?.worldPos;
  const normal = wallPick?.worldNormal;
  if (!entity || !position || !normal || !isVerticalWallNormal(normal)) return null;

  const metaObject = viewer.metaScene?.metaObjects?.[entity.id] ||
    viewer.metaScene?.metaObjects?.[String(entity.id)] || null;
  const model = entity.model || viewer.scene?.models?.[entity.modelId] || null;
  const modelMeta = {
    ...(model?._assetMeta || {}),
    fileType: model?._assetMeta?.fileType || model?._assetMeta?.assetFormat || model?.fileType || null,
    name: model?._assetMeta?.name || model?.name || null,
  };
  const classification = classifyWallHost({
    entityId: entity.id,
    entityName: metaObject?.name || entity.name || entity.id,
    entityType: metaObject?.type || metaObject?.ifcType || entity.type,
    modelMeta,
    aabb: entity.aabb || entity.worldAABB || entity.bounds || null,
    allowGeometricFallback: true,
  });
  if (!classification.accepted) return null;

  const isGLBAsset = String(asset.file_type || asset.fileType || asset.url || '').toLowerCase().includes('glb');
  const forwardAxis = asset.wallMountForwardAxis || asset.wall_mount_forward_axis || (isGLBAsset ? '-Z' : '+Z');
  const placement = createWallHostPlacement({
    position,
    normal,
    entityId: entity.id,
    modelId: model?.id || entity.modelId || null,
    globalId: metaObject && /^ifc/i.test(String(metaObject.type || metaObject.ifcType || ''))
      ? (metaObject.globalId || metaObject.id || entity.id)
      : null,
    hostType: classification.hostType,
    bounds: classification.bounds,
    confidence: classification.confidence,
    reason: classification.reason,
    forwardAxis,
    standoff: resolveWallStandoff(asset),
  });
  if (!placement) return null;

  return {
    ...placement,
    wallEntityId: String(entity.id),
    wallEntityModelId: model?.id || entity.modelId || null,
    wallGlobalId: metaObject && /^ifc/i.test(String(metaObject.type || metaObject.ifcType || ''))
      ? String(metaObject.globalId || metaObject.id || entity.id)
      : null,
    snapped: true,
  };
};

export const getDropPosition = (viewerRef, projectStateRef, canvasPos, assetType = null) => {
  const viewer = viewerRef.current;
  if (!viewer) {
    if (assetType === 'surface') return null;
    return assetType === 'door'
      ? { position: [0, 0, 0], rotation: [0, 0, 0], wallGlobalId: null, snapped: false }
      : [0, 0, 0];
  }

  if (assetType === 'surface') {
    const surfacePick = viewer.scene.pick({ canvasPos, pickSurface: true });
    const normal = surfacePick?.worldNormal;
    const worldPos = surfacePick?.worldPos;
    const hasVec3 = worldPos && typeof worldPos.length === 'number' && worldPos.length >= 3;
    const hasNormal = normal && typeof normal.length === 'number' && normal.length >= 3;
    const isCeilingUnderside = hasNormal && Number(normal[1]) <= -0.65;
    return hasVec3 && isCeilingUnderside ? Array.from(worldPos).slice(0, 3).map(Number) : null;
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

  // Manual catalog placement must honor the exact floor point under the cursor.
  // Automatic collision nudging makes the asset appear to "jump" after drop,
  // which is especially confusing for GLB furniture. Collision avoidance can be
  // handled as a separate optional UX step; it must not silently rewrite a drop.
  return [x, y, z];
};

export const getCursorWorldPosition = (viewerRef, canvasPos) => {
  const viewer = viewerRef.current;
  if (!viewer) return null;
  const cursorPick = viewer.scene.pick({ canvasPos, pickSurface: true });
  return cursorPick?.worldPos || null;
};
