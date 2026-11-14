import { toArray, horizontalDistance } from './HomeTourGeometry.mjs';

/**
 * Thin adapter over recast-navigation's NavMeshQuery. It is the ONLY place the
 * planner touches Recast, so the planner stays unit-testable and there is a
 * single navigation system (the project's compiled NavMesh).
 *
 * All inputs/outputs are SCENE units; thresholds are converted from metres here.
 */
export function createRecastNavAdapter({ query, filter, metersPerUnit }) {
  const unit = Math.max(Number(metersPerUnit) || 1, 1e-9);
  const toScene = (m) => m / unit;
  const toMeters = (s) => s * unit;
  const FAR = 1e30; // dtRaycastHit.t === FLT_MAX when the ray reaches its end unobstructed

  function snap(point, { horizontalMeters = 0.75, verticalMeters = 0.35 } = {}) {
    const h = toScene(horizontalMeters);
    const v = toScene(verticalMeters);
    const r = query.findClosestPoint(point, { filter, halfExtents: { x: h, y: v, z: h } });
    if (!r?.success || !r.polyRef || !r.point) return null;
    const horizontalM = toMeters(horizontalDistance(point, r.point));
    const verticalM = toMeters(Math.abs(point.y - r.point.y));
    if (horizontalM > horizontalMeters + 1e-6 || verticalM > verticalMeters + 1e-6) return null;
    return { point: { x: r.point.x, y: r.point.y, z: r.point.z }, polyRef: r.polyRef, horizontalMeters: horizontalM, verticalMeters: verticalM };
  }

  /** Straight NavMesh segment test: true when a->b never leaves the walkable polygons. */
  function segmentWalkable(a, polyRefA, b) {
    const r = query.raycast(polyRefA, a, b, { filter });
    return Boolean(r?.success) && r.t >= FAR;
  }

  /** Radial free-distance profile on the NavMesh (metres). min ~ wall clearance. */
  function clearanceProfile(point, polyRef, { rays = 16, lengthMeters = 6 } = {}) {
    const len = toScene(lengthMeters);
    let min = lengthMeters;
    let sum = 0;
    for (let i = 0; i < rays; i += 1) {
      const angle = (i / rays) * Math.PI * 2;
      const end = { x: point.x + Math.cos(angle) * len, y: point.y, z: point.z + Math.sin(angle) * len };
      const r = query.raycast(polyRef, point, end, { filter });
      let free = lengthMeters;
      if (r?.success && r.t < FAR) free = Math.min(1, Math.max(0, r.t)) * lengthMeters;
      else if (!r?.success) free = 0;
      min = Math.min(min, free);
      sum += free;
    }
    return { minMeters: min, meanMeters: sum / rays };
  }

  /**
   * Full Detour path (corridor + funnel/string-pulling happen inside computePath).
   * Detour returns a SUCCESS status even for partial paths to a disconnected
   * polygon, so completeness is verified explicitly by end-gap.
   */
  function computePath(a, b, { maxEndGapMeters = 0.08 } = {}) {
    const sa = snap(a, { horizontalMeters: 0.2, verticalMeters: 0.35 });
    const sb = snap(b, { horizontalMeters: 0.2, verticalMeters: 0.35 });
    if (!sa || !sb) return { ok: false, reason: !sa ? 'START_OFF_NAVMESH' : 'END_OFF_NAVMESH', points: [] };
    const r = query.computePath(sa.point, sb.point, { filter, maxPathPolys: 1024, maxStraightPathPoints: 1024 });
    const points = Array.isArray(r?.path) ? r.path.map((p) => ({ x: p.x, y: p.y, z: p.z })) : [];
    if (!r?.success || points.length < 1) return { ok: false, reason: 'NO_PATH', points: [] };
    const end = points[points.length - 1];
    const gap = toMeters(Math.hypot(end.x - sb.point.x, end.y - sb.point.y, end.z - sb.point.z));
    if (gap > maxEndGapMeters) return { ok: false, reason: 'PARTIAL_PATH', endGapMeters: gap, points };
    // Pin exact snapped endpoints so consecutive legs join with zero gap.
    points[0] = { ...sa.point };
    points[points.length - 1] = { ...sb.point };
    return { ok: true, points, start: sa, end: sb };
  }

  return { snap, segmentWalkable, clearanceProfile, computePath, toArray, toScene, toMeters, unit };
}
