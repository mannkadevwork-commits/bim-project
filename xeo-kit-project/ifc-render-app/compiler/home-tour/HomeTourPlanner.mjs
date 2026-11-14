/**
 * Deterministic Home Tour planner.
 *
 * Physical IFC room reconstruction is intentionally not a prerequisite for a
 * tour. The compiler-authored navigation areas in walk_hotspots.json are the
 * tour zones. Every zone must receive one safe presentation stop and a complete
 * Recast path from the previous stop.
 */
export const HOME_TOUR_PLANNER_VERSION = 'navmesh-zone-tour-v2.2';
export const HOME_TOUR_MIN_CLEARANCE_METERS = 0.32;

const ROLE_PENALTY = Object.freeze({
  viewpoint: 0,
  'room-center': 0.045,
  'room-entrance': 0.12,
});

const finitePoint = (value) => {
  const x = Number(Array.isArray(value) ? value[0] : value?.x);
  const y = Number(Array.isArray(value) ? value[1] : value?.y);
  const z = Number(Array.isArray(value) ? value[2] : value?.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
};

const distanceXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const distance3D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function cleanPath(path, start, target, metersPerUnit) {
  if (!Array.isArray(path) || !path.length) return null;
  const points = path.map(finitePoint);
  if (points.some((point) => !point)) return null;

  // Detour must return a corridor/funnel path that starts at the requested
  // snapped source and reaches the requested snapped destination. A merely
  // successful partial result is never accepted.
  if (distance3D(points[0], start) > 0.24 * metersPerUnit) return null;
  const endpoint = points[points.length - 1];
  if (distanceXZ(endpoint, target) > 0.22 * metersPerUnit
    || Math.abs(endpoint.y - target.y) > 0.18 * metersPerUnit) return null;

  const normalized = [];
  const append = (point) => {
    const previous = normalized[normalized.length - 1];
    if (!previous || distance3D(previous, point) > 0.008 * metersPerUnit) {
      normalized.push({ x: point.x, y: point.y, z: point.z });
    }
  };

  append(start);
  for (const point of points) append(point);
  normalized[normalized.length - 1] = { x: target.x, y: target.y, z: target.z };

  let length = 0;
  for (let index = 1; index < normalized.length; index += 1) {
    length += distance3D(normalized[index - 1], normalized[index]);
  }
  return { points: normalized, length, lengthMeters: length / metersPerUnit };
}

function candidateQualityPenalty(candidate) {
  const rolePenalty = ROLE_PENALTY[candidate.role] ?? 0.25;
  // Prefer a wider, more comfortable camera position. The penalty is small
  // relative to route distance, but large enough to avoid a cramped room
  // center when a substantially clearer interior/entrance viewpoint exists.
  const clearancePenalty = Math.max(0, 0.85 - candidate.clearanceMeters) * 0.42;
  return rolePenalty + clearancePenalty;
}

function buildAreaCandidates(area, hotspots, query, filter, metersPerUnit, minClearanceMeters) {
  const areaId = String(area.id);
  const rawCandidates = (Array.isArray(hotspots) ? hotspots : [])
    .filter((hotspot) => String(hotspot?.areaId) === areaId)
    .filter((hotspot) => Object.hasOwn(ROLE_PENALTY, hotspot?.presentationRole))
    .map((hotspot) => ({
      id: String(hotspot.id || `${areaId}-${hotspot.presentationRole}`),
      label: String(hotspot.label || area.label || areaId),
      role: hotspot.presentationRole,
      rawPoint: finitePoint(hotspot.position),
      clearanceMeters: Number(hotspot.clearanceMeters),
      score: Number(hotspot.score) || 0,
    }))
    .filter((candidate) => candidate.rawPoint
      && Number.isFinite(candidate.clearanceMeters)
      && candidate.clearanceMeters >= minClearanceMeters);

  // Never manufacture a clearance=0 fallback from area.center. The normal
  // compiler emits a matching room-center hotspot with measured clearance.
  // If it is absent, we fail this zone explicitly instead of sending the
  // camera to an unmeasured point near a wall.
  const candidates = [];
  const halfExtents = {
    x: 0.36 * metersPerUnit,
    y: 1.05 * metersPerUnit,
    z: 0.36 * metersPerUnit,
  };

  for (const candidate of rawCandidates) {
    let snapped;
    try {
      snapped = query.findClosestPoint(candidate.rawPoint, { halfExtents, filter });
    } catch {
      snapped = null;
    }
    if (!snapped?.success || snapped.isPointOverPoly === false || !finitePoint(snapped.point)) continue;

    const point = finitePoint(snapped.point);
    const snapDistance = distance3D(candidate.rawPoint, point) / metersPerUnit;
    if (snapDistance > 0.22) continue;
    // Snapping can move a hotspot toward a nearby boundary. Subtract the full
    // snap displacement from its authored clearance so the final stop remains
    // conservative even when the compiler's hotspot was slightly off-surface.
    const effectiveClearance = candidate.clearanceMeters - snapDistance;
    if (effectiveClearance < minClearanceMeters) continue;
    const prepared = {
      ...candidate,
      point,
      clearanceMeters: effectiveClearance,
      snapDistanceMeters: snapDistance,
      qualityPenalty: 0,
    };
    prepared.qualityPenalty = candidateQualityPenalty(prepared);
    candidates.push(prepared);
  }

  // Entrance hotspots are traversal hints, not presentation stops. Use one
  // only when the zone has no validated interior center/viewpoint; otherwise
  // a high-clearance doorway must not replace an actual room-interior stop.
  const hasInteriorCandidate = candidates.some((candidate) => candidate.role !== 'room-entrance');
  const presentationCandidates = hasInteriorCandidate
    ? candidates.filter((candidate) => candidate.role !== 'room-entrance')
    : candidates;

  // Deduplicate nearby anchors, retaining the one with the best measured
  // clearance/role quality. Stable ID ordering makes the result reproducible.
  presentationCandidates.sort((a, b) => (
    a.qualityPenalty - b.qualityPenalty
    || b.clearanceMeters - a.clearanceMeters
    || a.id.localeCompare(b.id)
  ));
  const unique = [];
  for (const candidate of presentationCandidates) {
    if (unique.some((entry) => distanceXZ(entry.point, candidate.point) < 0.24 * metersPerUnit)) continue;
    unique.push(candidate);
    if (unique.length >= 3) break;
  }
  return unique;
}

function validatePolylineAgainstNavMesh(points, query, filter, metersPerUnit) {
  if (!Array.isArray(points) || points.length < 2) return true;
  const sampleSpacing = 0.40 * metersPerUnit;
  for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex += 1) {
    const a = points[segmentIndex - 1];
    const b = points[segmentIndex];
    const segmentLength = distance3D(a, b);
    const sampleCount = Math.max(1, Math.ceil(segmentLength / sampleSpacing));
    for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
      const t = sampleIndex / sampleCount;
      const sample = {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      };
      let nearest;
      try {
        nearest = query.findClosestPoint(sample, {
          halfExtents: { x: 0.22 * metersPerUnit, y: 0.45 * metersPerUnit, z: 0.22 * metersPerUnit },
          filter,
        });
      } catch {
        return false;
      }
      const projected = finitePoint(nearest?.point);
      if (!nearest?.success || !projected) return false;
      // Recast reports isPointOverPoly when the sample's XZ coordinate is
      // actually over the returned walkable polygon. A nearby floor projection
      // alone is not enough: it could be across a wall or furniture footprint.
      if (nearest.isPointOverPoly === false) return false;
      if (distanceXZ(sample, projected) > 0.18 * metersPerUnit
        || Math.abs(sample.y - projected.y) > 0.20 * metersPerUnit) return false;
    }
  }
  return true;
}

function computeCompleteLeg(query, filter, from, candidate, metersPerUnit) {
  let result;
  try {
    result = query.computePath(from, candidate.point, {
      filter,
      maxStraightPathPoints: 512,
      maxPathPolys: 512,
    });
  } catch {
    return null;
  }
  if (!result?.success) return null;
  const route = cleanPath(result.path, from, candidate.point, metersPerUnit);
  if (!route || !validatePolylineAgainstNavMesh(route.points, query, filter, metersPerUnit)) return null;
  return {
    ...route,
    objectiveCost: route.lengthMeters + candidate.qualityPenalty,
    candidate,
  };
}

/**
 * Exact deterministic dynamic-programming route optimization for the small
 * (normally <= 10) number of curated presentation zones. It selects both the
 * visiting order and a safe camera candidate in each zone. Paths are computed
 * between candidate anchors and cached for the duration of this plan.
 */
function optimizeZoneTour({ zones, origin, query, filter, metersPerUnit }) {
  const count = zones.length;
  const fullMask = (1 << count) - 1;
  const legCache = new Map();
  const cacheKey = (fromId, toId) => `${fromId}>>${toId}`;
  const getLeg = (from, fromKey, candidate) => {
    const key = cacheKey(fromKey, candidate.id);
    if (!legCache.has(key)) {
      legCache.set(key, computeCompleteLeg(query, filter, from, candidate, metersPerUnit));
    }
    return legCache.get(key);
  };

  const states = new Map();
  const byMask = Array.from({ length: fullMask + 1 }, () => []);

  for (let zoneIndex = 0; zoneIndex < count; zoneIndex += 1) {
    const zone = zones[zoneIndex];
    for (const candidate of zone.candidates) {
      const leg = getLeg(origin, '__origin__', candidate);
      if (!leg) continue;
      const mask = 1 << zoneIndex;
      const key = `${mask}:${zoneIndex}:${candidate.id}`;
      const state = {
        key,
        mask,
        lastZoneIndex: zoneIndex,
        lastCandidate: candidate,
        cost: leg.objectiveCost,
        distanceMeters: leg.lengthMeters,
        previousKey: null,
        leg,
      };
      states.set(key, state);
      byMask[mask].push(state);
    }
  }

  for (let mask = 1; mask <= fullMask; mask += 1) {
    const currentStates = byMask[mask];
    for (let stateIndex = 0; stateIndex < currentStates.length; stateIndex += 1) {
      const state = currentStates[stateIndex];
      for (let nextZoneIndex = 0; nextZoneIndex < count; nextZoneIndex += 1) {
        const bit = 1 << nextZoneIndex;
        if (mask & bit) continue;
        const nextZone = zones[nextZoneIndex];
        for (const candidate of nextZone.candidates) {
          const leg = getLeg(
            state.lastCandidate.point,
            state.lastCandidate.id,
            candidate,
          );
          if (!leg) continue;

          const nextMask = mask | bit;
          const key = `${nextMask}:${nextZoneIndex}:${candidate.id}`;
          const cost = state.cost + leg.objectiveCost;
          const existing = states.get(key);
          if (existing && existing.cost <= cost + 1e-9) continue;

          const nextState = {
            key,
            mask: nextMask,
            lastZoneIndex: nextZoneIndex,
            lastCandidate: candidate,
            cost,
            distanceMeters: state.distanceMeters + leg.lengthMeters,
            previousKey: state.key,
            leg,
          };
          states.set(key, nextState);
          if (!existing) byMask[nextMask].push(nextState);
          else {
            const bucket = byMask[nextMask];
            const position = bucket.findIndex((entry) => entry.key === key);
            if (position >= 0) bucket[position] = nextState;
          }
        }
      }
    }
  }

  const finals = byMask[fullMask];
  if (!finals.length) {
    const bestPartial = [...states.values()]
      .sort((a, b) => b.mask.toString(2).replace(/0/g, '').length - a.mask.toString(2).replace(/0/g, '').length
        || a.cost - b.cost)[0];
    const visitedMask = bestPartial?.mask || 0;
    const unreachableAreas = zones
      .filter((zone, index) => !(visitedMask & (1 << index)))
      .map((zone) => zone.id);
    return {
      ok: false,
      code: 'INCOMPLETE_HOME_ROUTE',
      error: 'A complete NavMesh route could not visit every validated navigation zone. No area was skipped or teleported into.',
      unreachableAreas,
      reachableStops: zones
        .filter((zone, index) => Boolean(visitedMask & (1 << index)))
        .map((zone) => ({ areaId: zone.id, label: zone.label })),
    };
  }

  finals.sort((a, b) => a.cost - b.cost || a.key.localeCompare(b.key));
  let cursor = finals[0];
  const orderedStates = [];
  while (cursor) {
    orderedStates.push(cursor);
    cursor = cursor.previousKey ? states.get(cursor.previousKey) : null;
  }
  orderedStates.reverse();

  const stops = orderedStates.map((state, index) => {
    const zone = zones[state.lastZoneIndex];
    const candidate = state.lastCandidate;
    return {
      index,
      areaId: zone.id,
      label: zone.label,
      point: candidate.point,
      role: candidate.role,
      hotspotId: candidate.id,
      clearanceMeters: candidate.clearanceMeters,
      route: state.leg.points,
      routeLengthMeters: Number(state.leg.lengthMeters.toFixed(3)),
    };
  });

  return {
    ok: true,
    stops,
    totalDistanceMeters: Number(orderedStates.reduce((sum, state) => sum + state.distanceMeters - (state.previousKey ? states.get(state.previousKey).distanceMeters : 0), 0).toFixed(3)),
    objectiveCost: Number(finals[0].cost.toFixed(3)),
  };
}

/** Build one continuous, optimized route through every authored navigation zone. */
export function planHomeTourRoute({
  areas,
  hotspots,
  origin,
  metersPerUnit = 1,
  query,
  filter,
  minClearanceMeters = HOME_TOUR_MIN_CLEARANCE_METERS,
}) {
  const unit = Number(metersPerUnit);
  const start = finitePoint(origin);
  const minClearance = Math.max(0, Number(minClearanceMeters));
  if (!Array.isArray(areas) || !areas.length) {
    return { ok: false, code: 'NO_AREAS', error: 'No compiler-authored navigation zones are available for Home Tour.' };
  }
  if (!start || !Number.isFinite(unit) || unit <= 0 || !query?.findClosestPoint || !query?.computePath) {
    return { ok: false, code: 'INVALID_INPUT', error: 'The Home Tour planner is missing a valid start point, scene scale, or NavMesh query.' };
  }

  let startSnap;
  try {
    startSnap = query.findClosestPoint(start, {
      halfExtents: { x: 0.65 * unit, y: 1.2 * unit, z: 0.65 * unit },
      filter,
    });
  } catch {
    startSnap = null;
  }
  const snappedOrigin = startSnap?.success ? finitePoint(startSnap.point) : null;
  if (!snappedOrigin || distance3D(start, snappedOrigin) / unit > 0.60) {
    return {
      ok: false,
      code: 'START_NOT_ON_NAVMESH',
      error: 'The current walkthrough camera is not close enough to a safe walkable floor position. Re-enter the 3D walkthrough and start Home Tour again.',
    };
  }

  const seenIds = new Set();
  const normalizedAreas = [];
  for (const area of areas) {
    if (!area?.id || seenIds.has(String(area.id))) continue;
    const center = finitePoint(area.center);
    if (!center) continue;
    const normalized = {
      id: String(area.id),
      label: String(area.label || `Area ${normalizedAreas.length + 1}`),
      center,
    };
    const candidates = buildAreaCandidates(
      normalized,
      hotspots,
      query,
      filter,
      unit,
      minClearance,
    );
    if (!candidates.length) {
      return {
        ok: false,
        code: 'AREA_HAS_NO_SAFE_VIEWPOINT',
        error: `No camera viewpoint with at least ${minClearance.toFixed(2)} m clearance could be validated for ${normalized.label}.`,
        unreachableAreas: [normalized.id],
        candidateDiagnostics: { areaId: normalized.id, minClearanceMeters: minClearance },
      };
    }
    normalizedAreas.push({ ...normalized, candidates });
    seenIds.add(normalized.id);
  }

  if (!normalizedAreas.length) {
    return { ok: false, code: 'NO_VALID_AREAS', error: 'No valid navigation zones with walkable centers were found.' };
  }
  if (normalizedAreas.length > 10) {
    return { ok: false, code: 'TOO_MANY_AREAS', error: 'Home Tour currently supports up to 10 curated navigation zones per walkthrough.' };
  }

  const optimized = optimizeZoneTour({
    zones: normalizedAreas,
    origin: snappedOrigin,
    query,
    filter,
    metersPerUnit: unit,
  });
  if (!optimized.ok) return optimized;

  const expectedIds = new Set(normalizedAreas.map((area) => area.id));
  const actualIds = new Set(optimized.stops.map((stop) => stop.areaId));
  const completeCoverage = optimized.stops.length === normalizedAreas.length
    && expectedIds.size === actualIds.size
    && [...expectedIds].every((id) => actualIds.has(id));
  if (!completeCoverage) {
    return {
      ok: false,
      code: 'INCOMPLETE_HOME_ROUTE',
      error: 'The optimized route did not cover every navigation zone. Playback was not started.',
      unreachableAreas: normalizedAreas.filter((area) => !actualIds.has(area.id)).map((area) => area.id),
    };
  }

  return {
    ok: true,
    plannerVersion: HOME_TOUR_PLANNER_VERSION,
    origin: snappedOrigin,
    stops: optimized.stops,
    totalDistanceMeters: optimized.totalDistanceMeters,
    metersPerUnit: unit,
    areaCount: optimized.stops.length,
    waypointCount: optimized.stops.reduce((sum, stop) => sum + stop.route.length, 0),
    diagnostics: {
      zoneCount: normalizedAreas.length,
      visitedZoneCount: optimized.stops.length,
      minClearanceMeters: Math.min(...optimized.stops.map((stop) => stop.clearanceMeters)),
      routeObjectiveCost: optimized.objectiveCost,
      routeOrder: optimized.stops.map((stop) => stop.areaId),
    },
  };
}

export { finitePoint, distance3D, distanceXZ };
