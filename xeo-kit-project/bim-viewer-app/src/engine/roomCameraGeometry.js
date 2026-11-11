const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const normalizeRing = (points) => (Array.isArray(points) ? points : [])
  .map((point) => ({ x: finite(point?.x, NaN), z: finite(point?.z, NaN) }))
  .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));

const distanceToSegment = (point, a, b) => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - a.x, point.z - a.z);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.z - (a.z + t * dz));
};

const pointInRing = (point, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const crosses = ((a.z > point.z) !== (b.z > point.z))
      && (point.x < ((b.x - a.x) * (point.z - a.z)) / ((b.z - a.z) || 1e-12) + a.x);
    if (crosses) inside = !inside;
  }
  return inside;
};

const minDistanceToRing = (point, ring) => {
  let minimum = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    minimum = Math.min(minimum, distanceToSegment(point, ring[i], ring[(i + 1) % ring.length]));
  }
  return minimum;
};

const pointInRoom = (point, outer, holes) => pointInRing(point, outer)
  && !holes.some((hole) => pointInRing(point, hole));

/**
 * Finds a stable camera position inside a room polygon. A coarse pole-of-
 * inaccessibility search keeps the camera away from walls and polygon holes,
 * including for concave rooms where a vertex-average centroid can be outside.
 */
export const findRoomInteriorPoint = (room, divisions = 28, { avoidFurniture = true } = {}) => {
  const outer = normalizeRing(room?.boundary?.outer);
  const holes = (Array.isArray(room?.boundary?.holes) ? room.boundary.holes : [])
    .map(normalizeRing)
    .filter((ring) => ring.length >= 3);
  if (outer.length < 3) return null;

  const xs = outer.map((point) => point.x);
  const zs = outer.map((point) => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  if (spanX <= 1e-5 || spanZ <= 1e-5) return null;

  const obstacles = avoidFurniture
    ? (Array.isArray(room?.elements) ? room.elements : []).map((element) => {
      const center = element?.center || {};
      const size = element?.size || {};
      const halfX = Math.max(0, finite(size.x, 0)) / 2;
      const halfZ = Math.max(0, finite(size.z, 0)) / 2;
      if (![center.x, center.z].every((value) => Number.isFinite(Number(value)))) return null;
      if (halfX <= 0 || halfZ <= 0) return null;
      return { x: Number(center.x), z: Number(center.z), halfX, halfZ };
    }).filter(Boolean)
    : [];

  let best = null;
  let bestClearance = -Infinity;
  let bestWithoutObstacleAvoidance = null;
  let bestWithoutObstacleClearance = -Infinity;
  const nx = Math.max(10, Math.min(64, divisions));
  const nz = Math.max(10, Math.min(64, Math.round(divisions * (spanZ / spanX))));

  for (let ix = 0; ix <= nx; ix += 1) {
    for (let iz = 0; iz <= nz; iz += 1) {
      const point = {
        x: minX + (spanX * (ix + 0.5)) / (nx + 1),
        z: minZ + (spanZ * (iz + 0.5)) / (nz + 1),
      };
      if (!pointInRoom(point, outer, holes)) continue;
      let boundaryClearance = minDistanceToRing(point, outer);
      for (const hole of holes) boundaryClearance = Math.min(boundaryClearance, minDistanceToRing(point, hole));
      if (boundaryClearance > bestWithoutObstacleClearance) {
        bestWithoutObstacleClearance = boundaryClearance;
        bestWithoutObstacleAvoidance = point;
      }

      let obstacleClearance = Infinity;
      let blockedByFurniture = false;
      for (const obstacle of obstacles) {
        const dx = Math.max(Math.abs(point.x - obstacle.x) - obstacle.halfX - 0.28, 0);
        const dz = Math.max(Math.abs(point.z - obstacle.z) - obstacle.halfZ - 0.28, 0);
        const distance = Math.hypot(dx, dz);
        obstacleClearance = Math.min(obstacleClearance, distance);
        if (distance <= 1e-6) blockedByFurniture = true;
      }
      if (blockedByFurniture) continue;
      const clearance = Math.min(boundaryClearance, obstacleClearance);
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = point;
      }
    }
  }

  if (best) return { ...best, clearance: bestClearance, outer, holes, furnitureAvoided: obstacles.length > 0 };
  if (obstacles.length && bestWithoutObstacleAvoidance) {
    return { ...bestWithoutObstacleAvoidance, clearance: bestWithoutObstacleClearance, outer, holes, furnitureAvoided: false };
  }

  // Fallback to the bounds centre only when it is actually inside the room.
  const fallback = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
  if (!pointInRoom(fallback, outer, holes)) return null;
  return { ...fallback, clearance: minDistanceToRing(fallback, outer), outer, holes, furnitureAvoided: obstacles.length === 0 };
};

const rayDistanceToRing = (origin, direction, ring) => {
  let nearest = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const sx = b.x - a.x;
    const sz = b.z - a.z;
    const denominator = direction.x * sz - direction.z * sx;
    if (Math.abs(denominator) < 1e-10) continue;
    const ax = a.x - origin.x;
    const az = a.z - origin.z;
    const t = (ax * sz - az * sx) / denominator;
    const u = (ax * direction.z - az * direction.x) / denominator;
    if (t > 0.08 && u >= -1e-8 && u <= 1 + 1e-8) nearest = Math.min(nearest, t);
  }
  return nearest;
};

/**
 * Resolves a human-eye camera pose for a room. The viewing direction is the
 * longest unobstructed horizontal ray from the interior point, so long/narrow
 * rooms are framed along their usable dimension rather than from outside.
 */
export const getRoomInteriorCameraPose = (room, { eyeHeight = 1.55, raySamples = 48, viewPreset = 'auto' } = {}) => {
  const interior = findRoomInteriorPoint(room);
  if (!interior) return null;

  const floorY = finite(room?.floorY, 0);
  const ceilingY = finite(room?.recommendedCeilingY, floorY + 2.8);
  const clearHeight = Math.max(ceilingY - floorY, 2.0);
  const safeEyeHeight = Math.max(1.2, Math.min(finite(eyeHeight, 1.55), clearHeight - 0.25));
  const bestRing = interior.outer;
  let bestDirection = { x: 1, z: 0 };
  let bestDistance = 0;
  const measureDirection = (direction) => {
    let distance = rayDistanceToRing(interior, direction, bestRing);
    for (const hole of interior.holes) {
      distance = Math.min(distance, rayDistanceToRing(interior, direction, hole));
    }
    return Number.isFinite(distance) ? distance : 0;
  };

  for (let index = 0; index < raySamples; index += 1) {
    const angle = (Math.PI * 2 * index) / raySamples;
    const direction = { x: Math.cos(angle), z: Math.sin(angle) };
    const distance = measureDirection(direction);
    if (distance > bestDistance) {
      bestDistance = distance;
      bestDirection = direction;
    }
  }

  const presetDirections = {
    front: { x: 0, z: 1 },
    back: { x: 0, z: -1 },
    left: { x: -1, z: 0 },
    right: { x: 1, z: 0 },
    'front-left': { x: -Math.SQRT1_2, z: Math.SQRT1_2 },
    'front-right': { x: Math.SQRT1_2, z: Math.SQRT1_2 },
    'back-left': { x: -Math.SQRT1_2, z: -Math.SQRT1_2 },
    'back-right': { x: Math.SQRT1_2, z: -Math.SQRT1_2 },
  };
  const requestedDirection = presetDirections[String(viewPreset || 'auto').toLowerCase()];
  if (requestedDirection) {
    const requestedDistance = measureDirection(requestedDirection);
    // Honour the requested camera angle only when it has useful room depth.
    // Otherwise keep the automatically chosen clear direction; this avoids
    // dropping the camera into a wall on narrow/concave footprints.
    if (requestedDistance >= 0.55) {
      bestDirection = requestedDirection;
      bestDistance = requestedDistance;
    }
  }

  if (bestDistance < 0.4) return null;
  // Keep the look target inside the room even for narrow rooms.
  const lookDistance = Math.max(0.25, bestDistance * 0.72);
  const eye = [interior.x, floorY + safeEyeHeight, interior.z];
  const look = [
    interior.x + bestDirection.x * lookDistance,
    floorY + safeEyeHeight + 0.015,
    interior.z + bestDirection.z * lookDistance,
  ];

  return {
    roomId: room?.id ? String(room.id) : null,
    eye,
    look,
    up: [0, 1, 0],
    projection: 'perspective',
    eyeHeight: safeEyeHeight,
    direction: [bestDirection.x, bestDirection.z],
    requestedViewPreset: String(viewPreset || 'auto'),
    interiorPoint: { x: interior.x, z: interior.z },
    clearance: interior.clearance,
    furnitureAvoided: interior.furnitureAvoided !== false,
  };
};
