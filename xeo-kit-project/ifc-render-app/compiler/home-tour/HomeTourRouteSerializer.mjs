import crypto from 'node:crypto';
import { HOME_TOUR_PLANNER_VERSION, HOME_TOUR_ROUTE_SCHEMA_VERSION } from './HomeTourConfig.mjs';
import { dedupeConsecutive, polylineLength, toArray } from './HomeTourGeometry.mjs';

/**
 * Cache signature. EVERY input that can change the route is hashed, including the
 * planner version, route schema, thresholds and start position. A stale artifact
 * (e.g. the old one-room route) can therefore never be served.
 */
export function computeSourceSignature({ buffers = {}, origin, config, extra = {} }) {
  const h = crypto.createHash('sha256');
  h.update(`planner:${HOME_TOUR_PLANNER_VERSION}|schema:${HOME_TOUR_ROUTE_SCHEMA_VERSION}|`);
  for (const key of Object.keys(buffers).sort()) {
    h.update(`|${key}:`);
    const b = buffers[key];
    h.update(b && b.length ? b : 'absent');
  }
  h.update(`|origin:${[origin.x, origin.y, origin.z].map((v) => Number(v).toFixed(2)).join(',')}`);
  h.update(`|config:${JSON.stringify(config)}`);
  h.update(`|extra:${JSON.stringify(extra)}`);
  return h.digest('hex');
}

const round = (v, d = 3) => Number(Number(v).toFixed(d));

/** Build the route contract consumed by the frontend. All coordinates scene units, Y-up. */
export function serializeRoute({ jobId, metersPerUnit, origin, startSnap, stops, legs, zones, collisionChecked, config, now = new Date() }) {
  const flat = [];
  for (const leg of legs) {
    for (const p of leg.points) flat.push(p);
  }
  const waypoints = dedupeConsecutive(flat, 1e-3 / Math.max(metersPerUnit, 1e-9));
  const totalDistanceMeters = round(legs.reduce((s, l) => s + polylineLength(l.points) * metersPerUnit, 0));

  return {
    schemaVersion: HOME_TOUR_ROUTE_SCHEMA_VERSION,
    plannerVersion: HOME_TOUR_PLANNER_VERSION,
    jobId,
    generatedAt: now.toISOString(),
    source: 'server-recast-complete-paths',
    metersPerUnit,
    origin: toArray(origin),
    startPosition: toArray(startSnap),
    totalDistanceMeters,
    areaCount: stops.length,
    zoneCount: zones.length,
    stopCount: stops.length,
    waypointCount: waypoints.length,
    targetSource: 'navigation-zones',
    targetRoomCount: zones.filter((z) => z.labelSource === 'architectural-room').length,
    validation: {
      status: 'validated',
      zonesVisitedExactlyOnce: new Set(stops.map((s) => s.zoneId)).size === zones.length && stops.length === zones.length,
      collisionChecked: Boolean(collisionChecked),
      sampleStepMeters: config.sampleStepMeters,
    },
    stops: stops.map((s, index) => {
      const leg = legs[index];
      return {
        id: s.zoneId,
        areaId: s.zoneId,
        label: s.label,
        kind: 'navigation-zone',
        labelSource: s.labelSource,
        order: index,
        position: toArray(s.candidate.position),
        candidateId: s.candidate.id,
        candidateRole: s.candidate.role,
        clearanceMeters: s.candidate.clearanceMeters,
        opennessMeters: s.candidate.opennessMeters,
        entrances: s.entrances.map((e) => ({ id: e.id, label: e.label, position: toArray(e.position) })),
        distanceFromPreviousMeters: round(polylineLength(leg.points) * metersPerUnit),
        path: leg.points.map(toArray),
        pathValidation: leg.validation,
      };
    }),
  };
}

/** Structured, developer-facing diagnostics. Never rendered in the customer UI. */
export function serializeFailure({ code, error, diagnostics, jobId, now = new Date() }) {
  return {
    schemaVersion: HOME_TOUR_ROUTE_SCHEMA_VERSION,
    plannerVersion: HOME_TOUR_PLANNER_VERSION,
    jobId,
    generatedAt: now.toISOString(),
    status: 'failed',
    code,
    error,
    diagnostics,
  };
}

/** Does a cached artifact still describe a complete, current six-zone route? */
export function isCachedRouteUsable(cached, { signature, expectedZoneCount }) {
  const route = cached?.route;
  return Boolean(
    cached
    && cached.sourceSignature === signature
    && route
    && route.schemaVersion === HOME_TOUR_ROUTE_SCHEMA_VERSION
    && route.plannerVersion === HOME_TOUR_PLANNER_VERSION
    && Array.isArray(route.stops)
    && route.stops.length > 0
    && route.stops.length === expectedZoneCount
    && route.validation?.status === 'validated',
  );
}
