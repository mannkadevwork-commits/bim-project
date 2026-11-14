import { samplePolyline, polylineLength, distance3 } from './HomeTourGeometry.mjs';

/**
 * Validate a complete leg by sampling the WHOLE movement corridor.
 *
 * Checks, per sample (spacing = config.sampleStepMeters):
 *  - NavMesh polygon validity (sample within a few cm of the walkable surface)
 *  - straight-segment NavMesh continuity (raycast between samples never exits the mesh)
 *  - floor elevation continuity (no cliff/teleport between samples)
 *  - body capsule vs real collision geometry (output.glb triangles), incl. eye-height headroom
 *
 * `collision` is a CollisionIndex or null. When null the leg is still NavMesh-validated
 * but the result states collisionChecked:false so callers can surface the limitation.
 */
export function validateLeg({ points, nav, collision, config, cameraRadiusMeters, unit }) {
  const issues = [];
  if (!Array.isArray(points) || points.length < 2) {
    return { ok: false, issues: [{ code: 'LEG_TOO_SHORT' }], stats: {} };
  }
  const toScene = (m) => m / unit;
  const toMeters = (s) => s * unit;
  const samples = samplePolyline(points, toScene(config.sampleStepMeters));
  const radius = toScene(cameraRadiusMeters);
  const heights = [];
  for (let h = config.bodyBottomMeters; h < config.eyeHeightMeters + config.headroomMeters; h += 0.2) heights.push(h);
  heights.push(config.eyeHeightMeters + config.headroomMeters);

  let prevSample = null; let prevSnap = null;
  let maxStep = 0; let maxOff = 0; let collisionHits = 0; let minBodyClearance = Infinity;

  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (![s.x, s.y, s.z].every(Number.isFinite)) { issues.push({ code: 'NON_FINITE_SAMPLE', index: i }); break; }
    const snap = nav.snap(s, { horizontalMeters: config.maxOffMeshHorizontalMeters, verticalMeters: config.maxFloorStepMeters + 0.1 });
    if (!snap) { issues.push({ code: 'SAMPLE_OFF_NAVMESH', index: i, at: [s.x, s.y, s.z] }); break; }
    maxOff = Math.max(maxOff, snap.horizontalMeters);
    if (prevSample) {
      const step = toMeters(Math.abs(snap.point.y - prevSnap.point.y));
      maxStep = Math.max(maxStep, step);
      if (step > config.maxFloorStepMeters) { issues.push({ code: 'FLOOR_DISCONTINUITY', index: i, stepMeters: Number(step.toFixed(3)) }); break; }
      if (!nav.segmentWalkable(prevSnap.point, prevSnap.polyRef, snap.point)) {
        issues.push({ code: 'SEGMENT_LEAVES_NAVMESH', index: i, at: [s.x, s.y, s.z] }); break;
      }
    }
    if (collision) {
      for (const h of heights) {
        const body = { x: snap.point.x, y: snap.point.y + toScene(h), z: snap.point.z };
        const d = collision.nearestWithin(body, radius);
        if (d !== null) {
          collisionHits += 1;
          minBodyClearance = Math.min(minBodyClearance, toMeters(d));
          issues.push({ code: 'COLLISION_ENVELOPE_HIT', index: i, heightMeters: Number(h.toFixed(2)), distanceMeters: Number(toMeters(d).toFixed(3)), at: [s.x, s.y, s.z] });
          break;
        }
      }
      if (collisionHits) break;
    }
    prevSample = s; prevSnap = snap;
  }

  // Long single hops with no intermediate vertex are fine for Detour straight paths
  // (they are funnel output) but must still have passed segmentWalkable above.
  return {
    ok: issues.length === 0,
    issues,
    stats: {
      sampleCount: samples.length,
      lengthMeters: Number(toMeters(polylineLength(points)).toFixed(3)),
      maxFloorStepMeters: Number(maxStep.toFixed(3)),
      maxOffMeshMeters: Number(maxOff.toFixed(4)),
      collisionChecked: Boolean(collision),
      cameraRadiusMeters,
    },
  };
}

/** A straight Euclidean hop between two stops, used only to PROVE shortcuts are rejected. */
export function validateDirectHop({ from, to, nav, collision, config, cameraRadiusMeters, unit }) {
  return validateLeg({ points: [from, to], nav, collision, config, cameraRadiusMeters, unit });
}

/** Legs must chain exactly: no teleport between consecutive legs. */
export function validateChain(legs, unit, toleranceMeters = 0.005) {
  const issues = [];
  for (let i = 1; i < legs.length; i += 1) {
    const a = legs[i - 1].points[legs[i - 1].points.length - 1];
    const b = legs[i].points[0];
    const gap = distance3(a, b) * unit;
    if (gap > toleranceMeters) issues.push({ code: 'LEG_GAP', between: [legs[i - 1].toZoneId, legs[i].toZoneId], gapMeters: Number(gap.toFixed(4)) });
  }
  return issues;
}
