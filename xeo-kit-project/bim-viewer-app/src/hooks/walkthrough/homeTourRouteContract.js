// Pure helpers for the approved Home Tour route (schema v2). No Three.js, no DOM.
// HCI is Y-up; X/Z is the horizontal plane. Coordinates are scene units.

export const HOME_TOUR_ROUTE_SCHEMA_VERSION = 2;

const finite3 = (p) => Array.isArray(p) && p.length >= 3 && p.every((v) => Number.isFinite(Number(v)));
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Preflight the COMPLETE itinerary before playback starts. Playback must refuse a
 * route that fails here instead of improvising. Returns structured issues (for
 * developer logs); the customer UI should only show a generic message.
 */
export function preflightHomeTourRoute(route, { expectedZoneIds = null, metersPerUnit = 1, minClearanceMeters = 0.35, joinToleranceMeters = 0.01 } = {}) {
  const issues = [];
  const add = (code, extra = {}) => issues.push({ code, ...extra });
  if (!route || typeof route !== 'object') return { ok: false, issues: [{ code: 'NO_ROUTE' }] };
  if (route.schemaVersion !== HOME_TOUR_ROUTE_SCHEMA_VERSION) add('SCHEMA_MISMATCH', { found: route.schemaVersion });
  if (route.validation?.status !== 'validated') add('ROUTE_NOT_VALIDATED');
  const stops = Array.isArray(route.stops) ? route.stops : [];
  if (!stops.length) add('NO_STOPS');
  if (expectedZoneIds) {
    const want = new Set(expectedZoneIds.map(String));
    const got = stops.map((s) => String(s.areaId ?? s.id));
    if (new Set(got).size !== got.length) add('DUPLICATE_ZONE');
    for (const id of want) if (!got.includes(id)) add('ZONE_MISSING', { zoneId: id });
    for (const id of got) if (!want.has(id)) add('UNKNOWN_ZONE', { zoneId: id });
  }
  const tol = joinToleranceMeters / Math.max(metersPerUnit, 1e-9);
  let prev = finite3(route.startPosition) ? route.startPosition : null;
  if (!prev) add('NO_START_POSITION');
  stops.forEach((s, i) => {
    if (!finite3(s.position)) return add('STOP_POSITION_INVALID', { index: i });
    if (!(Number(s.clearanceMeters) >= minClearanceMeters)) add('STOP_CLEARANCE_TOO_LOW', { index: i, zoneId: s.areaId, clearanceMeters: s.clearanceMeters });
    const path = Array.isArray(s.path) ? s.path : [];
    if (path.length < 2 || !path.every(finite3)) return add('LEG_PATH_INVALID', { index: i, zoneId: s.areaId });
    if (prev && dist3(path[0], prev) > tol) add('LEG_NOT_CONTINUOUS', { index: i, zoneId: s.areaId });
    if (dist3(path[path.length - 1], s.position) > tol) add('LEG_DOES_NOT_REACH_STOP', { index: i, zoneId: s.areaId });
    prev = s.position;
  });
  return { ok: issues.length === 0, issues };
}

/**
 * Follows the approved polyline. It can only move ALONG a leg's validated points;
 * it never interpolates between two stop centres and never replans. Leg changes
 * are only allowed by `beginNextLeg()` after the current stop was reached.
 */
export function createHomeTourPathFollower(route) {
  const stops = route.stops;
  let leg = 0; let seg = 0; let along = 0; let atStop = false; let finished = stops.length === 0;
  let position = (route.startPosition || stops[0]?.path?.[0] || [0, 0, 0]).slice(0, 3);

  const follower = {
    get position() { return position.slice(); },
    get stopIndex() { return leg; },
    get atStop() { return atStop; },
    get finished() { return finished; },
    /** Advance `distance` scene units along the current leg. Never crosses into the next leg. */
    advance(distance) {
      if (finished || atStop) return follower.state();
      const path = stops[leg].path;
      let remaining = Math.max(0, distance);
      while (remaining > 0 && seg < path.length - 1) {
        const a = path[seg]; const b = path[seg + 1];
        const room = dist3(a, b) - along;
        if (remaining < room) { along += remaining; remaining = 0; } else { remaining -= room; seg += 1; along = 0; }
      }
      if (seg >= path.length - 1) { position = path[path.length - 1].slice(0, 3); atStop = true; }
      else {
        const a = path[seg]; const b = path[seg + 1]; const t = along / (dist3(a, b) || 1);
        position = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      }
      return follower.state();
    },
    /** Called by the camera director once the zone presentation is done. */
    beginNextLeg() {
      if (!atStop) return false;
      if (leg >= stops.length - 1) { finished = true; return false; }
      leg += 1; seg = 0; along = 0; atStop = false;
      return true;
    },
    /** Unit tangent on the horizontal plane, for heading while travelling. */
    heading() {
      const path = stops[leg]?.path || [];
      const a = path[Math.min(seg, path.length - 2)]; const b = path[Math.min(seg + 1, path.length - 1)];
      if (!a || !b) return [0, 1];
      const dx = b[0] - a[0]; const dz = b[2] - a[2]; const l = Math.hypot(dx, dz) || 1;
      return [dx / l, dz / l];
    },
    state() { return { position: follower.position, stopIndex: leg, atStop, finished }; },
  };
  return follower;
}
