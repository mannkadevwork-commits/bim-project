const toFinite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

export function pointInRoomRing(point, ring) {
  if (!point || !Array.isArray(ring) || ring.length < 3) return false;
  const x = Number(point.x);
  const z = Number(point.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = Number(ring[i]?.x);
    const zi = Number(ring[i]?.z);
    const xj = Number(ring[j]?.x);
    const zj = Number(ring[j]?.z);
    if (![xi, zi, xj, zj].every(Number.isFinite)) continue;

    // Treat points on a boundary segment as inside. This avoids dropping an
    // object whose persisted placement pivot sits exactly on the room outline.
    const cross = (x - xi) * (zj - zi) - (z - zi) * (xj - xi);
    const dot = (x - xi) * (xj - xi) + (z - zi) * (zj - zi);
    const lengthSq = (xj - xi) ** 2 + (zj - zi) ** 2;
    if (Math.abs(cross) <= 1e-7 && dot >= -1e-7 && dot <= lengthSq + 1e-7) return true;

    const intersects = ((zi > z) !== (zj > z)) &&
      (x < ((xj - xi) * (z - zi)) / ((zj - zi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

export function isPositionInsideRoom(room, position, assignedRoomIds = []) {
  if (!room || !Array.isArray(position) || position.length < 3) return false;
  const x = toFinite(position[0]);
  const y = toFinite(position[1]);
  const z = toFinite(position[2]);
  if (x == null || y == null || z == null) return false;

  const outer = room?.boundary?.outer;
  if (!Array.isArray(outer) || outer.length < 3) return false;
  if (!pointInRoomRing({ x, z }, outer)) return false;

  const holes = Array.isArray(room?.boundary?.holes) ? room.boundary.holes : [];
  if (holes.some((hole) => pointInRoomRing({ x, z }, hole))) return false;

  const roomIds = [room.id, room.navigationRoomId].filter(Boolean).map(String);
  const explicitlyAssigned = (Array.isArray(assignedRoomIds) ? assignedRoomIds : [])
    .filter(Boolean).some((id) => roomIds.includes(String(id)));
  // A matching explicit room assignment wins over a small vertical discrepancy
  // (common for imported furniture pivots and ceiling-mounted fixtures).
  // XZ containment still has to match, so an item moved into another room is
  // grouped by its new spatial location instead of stale metadata.
  if (explicitlyAssigned) return true;

  const floorY = toFinite(room.floorY);
  const ceilingY = toFinite(room.recommendedCeilingY);
  if (floorY != null && y < floorY - 1.25) return false;
  if (ceilingY != null && y > ceilingY + 1.25) return false;
  return true;
}

/**
 * Lists persisted furniture whose semantic placement point is inside a detected
 * room. This is a UI grouping heuristic, not an IFC spatial containment claim.
 */
export function getFurnitureInRoom(room, furniture = []) {
  if (!room?.id || !Array.isArray(furniture)) return [];
  return furniture.filter((item) => {
    if (!item?.instanceId) return false;
    if (isPositionInsideRoom(room, item.position, [item.roomId, item.ceilingRoomId])) return true;
    // Explicit room IDs are a fallback only when geometry/position is missing.
    // When a valid placement exists, spatial position wins so moved furniture
    // naturally appears under its new room rather than its original room.
    const hasPosition = Array.isArray(item.position) && item.position.length >= 3 &&
      item.position.slice(0, 3).every((value) => Number.isFinite(Number(value)));
    if (hasPosition) return false;
    return [item.roomId, item.ceilingRoomId].some((id) => (
      id != null && [room.id, room.navigationRoomId].filter(Boolean).map(String).includes(String(id))
    ));
  });
}

export function getRoomAssetKind(item) {
  const category = String(item?.assetCategory || item?.catalogCategory || '').trim();
  if (category) return category.replace(/[_-]+/g, ' ');
  const type = String(item?.fileType || item?.file_type || 'asset').toUpperCase();
  return `${type} asset`;
}
