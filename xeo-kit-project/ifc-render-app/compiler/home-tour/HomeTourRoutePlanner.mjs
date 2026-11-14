import { resolveHomeTourConfig } from './HomeTourConfig.mjs';
import { finitePoint, distance3, polylineLength } from './HomeTourGeometry.mjs';
import { buildTourZones, selectZoneCandidates } from './HomeTourWaypointSelector.mjs';
import { validateLeg, validateChain } from './HomeTourPathValidator.mjs';
import { optimizeVisitOrder } from './HomeTourRouteOptimizer.mjs';
import { serializeRoute } from './HomeTourRouteSerializer.mjs';

export { finitePoint };

/**
 * Plan a complete, validated tour through EVERY navigation zone.
 *
 * Zone identity/count comes only from `areas` (walk_hotspots.json). Reconstructed
 * rooms/portals never decide how many stops exist.
 *
 * Returns { ok:true, route } or { ok:false, code, error, diagnostics }.
 */
export function planHomeTourRoute({
  areas, hotspots, origin, metersPerUnit, nav, collision = null, roomLabels = null,
  agentRadiusMeters = 0.15, jobId = null, config: overrides = {},
}) {
  const config = resolveHomeTourConfig(overrides);
  const unit = Math.max(Number(metersPerUnit) || 1, 1e-9);
  const cameraRadiusMeters = config.cameraRadiusMeters ?? Math.max(0.08, 0.9 * agentRadiusMeters);
  const diagnostics = { zones: [], unreachableZones: [], blockedLegs: [], rounds: 0 };

  const originPoint = finitePoint(origin);
  if (!originPoint) return fail('INVALID_START', 'A valid camera start position is required.', diagnostics);
  const startSnap = nav.snap(originPoint, { horizontalMeters: 1.5, verticalMeters: 1.0 });
  if (!startSnap) return fail('START_NOT_ON_NAVMESH', 'The camera start position is not on the walkable NavMesh.', diagnostics);

  const zones = buildTourZones({ areas, roomLabels });
  if (!zones.length) return fail('NO_TOUR_ZONES', 'walk_hotspots.json contains no usable navigation areas.', diagnostics);

  const byZone = selectZoneCandidates({ zones, hotspots, nav, metersPerUnit: unit, config });
  for (const z of zones) {
    const b = byZone.get(z.id);
    diagnostics.zones.push({ id: z.id, label: z.label, candidates: b.candidates.map(slimCandidate), rejected: b.rejected, entrances: b.entrances.length });
    if (!b.candidates.length) {
      diagnostics.unreachableZones.push({ id: z.id, label: z.label, reason: 'NO_SAFE_CANDIDATE', rejected: b.rejected });
    }
  }
  if (diagnostics.unreachableZones.length) {
    return fail('ZONE_HAS_NO_SAFE_STOP', `No safe presentation viewpoint for: ${diagnostics.unreachableZones.map((z) => z.id).join(', ')}.`, diagnostics);
  }

  // ---- candidate retry / optimisation loop -------------------------------------
  const ids = zones.map((z) => z.id);
  const candIdx = new Map(ids.map((id) => [id, 0]));
  const failCount = new Map(ids.map((id) => [id, 0]));
  const pathMemo = new Map();
  const blocked = new Set();
  const cand = (id) => byZone.get(id).candidates[candIdx.get(id)];
  const pathBetween = (aKey, aPos, bKey, bPos) => {
    const key = `${aKey}->${bKey}`;
    if (!pathMemo.has(key)) pathMemo.set(key, nav.computePath(aPos, bPos, { maxEndGapMeters: config.maxPathEndGapMeters }));
    return pathMemo.get(key);
  };
  const lengthM = (r) => (r.ok ? polylineLength(r.points) * unit : Infinity);

  let result = null;
  for (let round = 0; round < config.maxRepairRounds && !result; round += 1) {
    diagnostics.rounds = round + 1;
    const startKey = 'start';
    const startToZone = ids.map((id) => {
      const k = `${startKey}->${cand(id).id}`;
      if (blocked.has(k)) return Infinity;
      return lengthM(pathBetween(startKey, startSnap.point, cand(id).id, cand(id).position));
    });
    const zoneToZone = ids.map((a) => ids.map((b) => {
      if (a === b) return Infinity;
      const k = `${cand(a).id}->${cand(b).id}`;
      if (blocked.has(k)) return Infinity;
      return lengthM(pathBetween(cand(a).id, cand(a).position, cand(b).id, cand(b).position));
    }));

    const opt = optimizeVisitOrder({ startToZone, zoneToZone, ids, maxExact: config.maxExactZones });
    if (!opt.order) {
      // Find zones with no finite inbound edge and move them to their next candidate.
      const stuck = ids.filter((id, i) => !Number.isFinite(startToZone[i]) && ids.every((_, j) => j === i || !Number.isFinite(zoneToZone[j][i])));
      const toAdvance = stuck.length ? stuck : [mostFailed(ids, failCount)];
      for (const id of toAdvance) {
        if (!advance(id)) return fail('ZONE_UNREACHABLE', `No complete NavMesh path reaches "${id}" from any safe viewpoint.`, diagnostics);
      }
      continue;
    }

    // Build + validate the actual legs in visit order.
    const order = opt.order.map((i) => ids[i]);
    const legs = []; let prevKey = startKey; let prevPos = startSnap.point; let prevId = 'start';
    let badLeg = null;
    for (const zid of order) {
      const c = cand(zid);
      const r = pathBetween(prevKey, prevPos, c.id, c.position);
      const points = r.points.map((p) => ({ ...p }));
      points[0] = { ...prevPos }; points[points.length - 1] = { ...c.position }; // exact chaining
      const validation = validateLeg({ points, nav, collision, config, cameraRadiusMeters, unit });
      if (!validation.ok) { badLeg = { fromId: prevId, toId: zid, fromKey: prevKey, toKey: c.id, validation }; break; }
      legs.push({ fromZoneId: prevId, toZoneId: zid, points, validation: validation.stats });
      prevKey = c.id; prevPos = c.position; prevId = zid;
    }
    if (badLeg) {
      diagnostics.blockedLegs.push({ from: badLeg.fromId, to: badLeg.toId, issues: badLeg.validation.issues.slice(0, 3), round });
      blocked.add(`${badLeg.fromKey}->${badLeg.toKey}`);
      failCount.set(badLeg.toId, failCount.get(badLeg.toId) + 1);
      // If every inbound edge of the destination is now blocked, retry another viewpoint there.
      const i = ids.indexOf(badLeg.toId);
      const inboundOpen = Number.isFinite(startToZone[i]) && !blocked.has(`start->${badLeg.toKey}`)
        || ids.some((a, j) => j !== i && !blocked.has(`${cand(a).id}->${badLeg.toKey}`) && Number.isFinite(zoneToZone[j][i]));
      if (!inboundOpen && !advance(badLeg.toId)) {
        return fail('ZONE_UNREACHABLE', `Every route into "${badLeg.toId}" failed collision or NavMesh validation.`, diagnostics);
      }
      continue;
    }
    result = { order, legs, optimisation: opt };
  }
  if (!result) return fail('ROUTE_NOT_VALIDATED', 'No fully validated itinerary was found within the retry budget.', diagnostics);

  const chainIssues = validateChain(result.legs, unit);
  if (chainIssues.length) { diagnostics.chainIssues = chainIssues; return fail('ROUTE_DISCONTINUITY', 'Consecutive legs do not join.', diagnostics); }

  const stops = result.order.map((zid) => ({
    zoneId: zid,
    label: zones.find((z) => z.id === zid).label,
    labelSource: zones.find((z) => z.id === zid).labelSource,
    candidate: cand(zid),
    entrances: byZone.get(zid).entrances,
  }));
  const visited = new Set(stops.map((s) => s.zoneId));
  if (visited.size !== zones.length || stops.length !== zones.length) {
    return fail('ROUTE_INCOMPLETE', 'The validated route does not visit every zone exactly once.', diagnostics);
  }
  const route = serializeRoute({
    jobId, metersPerUnit: unit, origin: originPoint, startSnap: startSnap.point, stops,
    legs: result.legs.map((l) => ({ ...l, validation: l.validation })), zones, collisionChecked: Boolean(collision), config,
  });
  diagnostics.optimisation = { method: result.optimisation.method, totalMeters: Number(result.optimisation.total.toFixed(3)) };
  return { ok: true, route, diagnostics, metersPerUnit: unit };

  function advance(id) {
    const next = candIdx.get(id) + 1;
    if (next >= byZone.get(id).candidates.length) {
      diagnostics.unreachableZones.push({ id, reason: 'ALL_CANDIDATES_FAILED', candidatesTried: next });
      return false;
    }
    candIdx.set(id, next);
    return true;
  }
}

function mostFailed(ids, failCount) {
  return [...ids].sort((a, b) => failCount.get(b) - failCount.get(a) || a.localeCompare(b))[0];
}
function slimCandidate(c) {
  return { id: c.id, role: c.role, clearanceMeters: c.clearanceMeters, opennessMeters: c.opennessMeters, score: c.score };
}
function fail(code, error, diagnostics) { return { ok: false, code, error, diagnostics }; }
export { distance3 };
