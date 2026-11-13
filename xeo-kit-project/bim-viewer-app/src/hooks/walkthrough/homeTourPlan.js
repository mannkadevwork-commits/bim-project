const ROLE_ORDER = {
  viewpoint: 0,
  'room-center': 1,
  'room-entrance': 2,
  transition: 3,
  walkpoint: 4,
};

// Home Tour presentation defaults are kept in one pure module so timing and
// camera-heading conventions can be regression-tested without a WebGL runtime.
export const HOME_TOUR_ROOM_HOLD_MS = 15_000;
export const HOME_TOUR_COMPOSITION_SETTLE_MS = 1_400;
export const HOME_TOUR_CRUISE_SPEED_MPS = 0.38;
export const HOME_TOUR_APPROACH_SPEED_MPS = 0.14;
export const HOME_TOUR_MAX_STEP_METERS = 0.025;
export const HOME_TOUR_TRAVEL_FOV_DEGREES = 72;
export const HOME_TOUR_SHOWCASE_FOV_DEGREES = 66;

/** Camera yaw for a world-space X/Z travel direction. Three.js looks down -Z. */
export function homeTourYawFromDirection(dx, dz) {
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || Math.hypot(dx, dz) < 1e-7) return null;
  return Math.atan2(-dx, -dz);
}

/**
 * Choose the direction used by the Home Tour camera. Detour's accepted
 * displacement wins when it disagrees with the ideal route tangent; otherwise
 * blend both so corner anticipation remains gentle and physically grounded.
 */
export function homeTourCameraDirection(routeDx, routeDz, actualDx, actualDz, actualIsFresh = true) {
  const routeLength = Math.hypot(Number(routeDx), Number(routeDz));
  if (!Number.isFinite(routeLength) || routeLength < 1e-7) return null;
  const route = { x: Number(routeDx) / routeLength, z: Number(routeDz) / routeLength };
  const actualLength = Math.hypot(Number(actualDx), Number(actualDz));
  if (!actualIsFresh || !Number.isFinite(actualLength) || actualLength < 1e-7) return route;
  const actual = { x: Number(actualDx) / actualLength, z: Number(actualDz) / actualLength };
  const agreement = route.x * actual.x + route.z * actual.z;
  if (agreement < 0.35) return actual;
  const x = route.x * 0.32 + actual.x * 0.68;
  const z = route.z * 0.32 + actual.z * 0.68;
  const length = Math.hypot(x, z);
  return length > 1e-7 ? { x: x / length, z: z / length } : actual;
}

/** Interpolate a yaw over the shortest angular arc (never spin the long way). */
export function homeTourAngleLerp(from, to, alpha) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.isFinite(to) ? to : from;
  const t = Math.max(0, Math.min(1, Number(alpha) || 0));
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * t;
}

/** Slow architectural walking speed with a gentle final approach. */
export function homeTourSpeedForDistance(distanceMeters) {
  const distance = Math.max(0, Number(distanceMeters) || 0);
  const blend = Math.max(0, Math.min(1, distance / 3.0));
  return HOME_TOUR_APPROACH_SPEED_MPS
    + (HOME_TOUR_CRUISE_SPEED_MPS - HOME_TOUR_APPROACH_SPEED_MPS) * blend;
}

export function routePolylineLength(path, start) {
  if (!Array.isArray(path) || !path.length || !start) return Infinity;
  let total = 0;
  let previous = start;
  for (const point of path) {
    if (![point?.x, point?.y, point?.z].every(Number.isFinite)) return Infinity;
    total += Math.hypot(point.x - previous.x, point.z - previous.z);
    previous = point;
  }
  return total;
}

/**
 * Order every validated room stop. Complete NavMesh routes are preferred, but
 * a room is never silently removed from the sequence: a disconnected or
 * locally blocked stop is explicitly marked for a fade-through presentation
 * transition at its separately validated room anchor.
 */
export function buildCinematicTourOrder({ stops, origin, routeBetween }) {
  if (!Array.isArray(stops) || !stops.length) {
    return { ok: false, reason: 'No validated room stops are available for Home Tour.' };
  }
  if (!origin || ![origin.x, origin.y, origin.z].every(Number.isFinite) || typeof routeBetween !== 'function') {
    return { ok: false, reason: 'The current camera position or NavMesh query is unavailable.' };
  }

  const remaining = [...stops];
  const ordered = [];
  let cursor = { x: origin.x, y: origin.y, z: origin.z };

  while (remaining.length) {
    let bestIndex = -1;
    let best = null;
    for (let i = 0; i < remaining.length; i += 1) {
      const stop = remaining[i];
      const route = routeBetween(cursor, stop);
      const directDistance = Math.hypot(stop.point.x - cursor.x, stop.point.z - cursor.z);
      const usableRoute = Boolean(route?.complete && Number.isFinite(route.length));
      // Keep disconnected rooms in the route, but order them after nearby rooms
      // that can be reached continuously. Their transition is explicitly faded.
      const score = usableRoute ? route.length : (directDistance + 1000);
      if (!best || score < best.score) {
        bestIndex = i;
        best = {
          score,
          route: usableRoute ? route : null,
          transition: !usableRoute,
          fallbackDistance: directDistance,
        };
      }
    }

    if (bestIndex < 0 || !best) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    ordered.push({
      ...chosen,
      plannedRoute: best.route,
      transitionRequired: best.transition,
      plannedDistance: best.route?.length ?? best.fallbackDistance,
    });
    cursor = { x: chosen.point.x, y: chosen.point.y, z: chosen.point.z };
  }

  return {
    ok: ordered.length === stops.length,
    ordered,
    totalStops: ordered.length,
    reason: ordered.length === stops.length ? null : 'Home Tour could not build a stop for every validated room.',
  };
}

export function sortRoomStopCandidates(candidates = []) {
  return [...candidates].sort((a, b) => {
    const roleA = ROLE_ORDER[a?.presentationRole] ?? 8;
    const roleB = ROLE_ORDER[b?.presentationRole] ?? 8;
    if (roleA !== roleB) return roleA - roleB;
    const clearanceA = Number(a?.clearanceMeters) || 0;
    const clearanceB = Number(b?.clearanceMeters) || 0;
    if (Math.abs(clearanceB - clearanceA) > 0.025) return clearanceB - clearanceA;
    return (Number(a?.displayOrder) || 999) - (Number(b?.displayOrder) || 999);
  });
}

export function inferHomeTourRoomKind(heroName = '') {
  const normalized = String(heroName || '').toLowerCase().replace(/[_-]+/g, ' ');
  if (/sofa|couch|sectional|armchair|recliner|lounge chair/.test(normalized)) return 'living';
  if (/dining|dinning|dinner table/.test(normalized)) return 'dining';
  if (/bed|daybed/.test(normalized)) return 'bedroom';
  if (/kitchen|hob|oven|fridge|refrigerator|kitchen island/.test(normalized)) return 'kitchen';
  if (/bathroom|toilet|shower|bathtub|basin|vanity/.test(normalized)) return 'bathroom';
  return null;
}

export function resolveHomeTourRoomLabel({ areaId, fallbackLabel, heroName, areas = [], subjects = [] }) {
  const explicit = String(fallbackLabel || '').trim();
  const generic = !explicit || /^(?:space|room)\s*\d*$/i.test(explicit);
  if (!generic) return explicit;

  const kind = inferHomeTourRoomKind(heroName);
  if (kind === 'living') return 'Living Room';
  if (kind === 'dining') return 'Dining Area';
  if (kind === 'kitchen') return 'Kitchen';
  if (kind === 'bathroom') return 'Bathroom';
  if (kind === 'bedroom') {
    if (/master/i.test(String(heroName || ''))) return 'Master Bedroom';
    const bedroomIds = [...new Set((subjects || [])
      .filter((subject) => subject?.areaId && /bed|daybed/i.test(String(subject.name || '')))
      .map((subject) => subject.areaId))];
    const bedroomAreas = [...(areas || [])].filter((area) => bedroomIds.includes(area?.id));
    const index = bedroomAreas.findIndex((area) => area.id === areaId);
    return index >= 0 ? `Bedroom ${index + 1}` : 'Bedroom';
  }

  const match = explicit.match(/(?:space|room)\s*(\d+)/i);
  return match ? `Room ${match[1]}` : (explicit || 'Room');
}
