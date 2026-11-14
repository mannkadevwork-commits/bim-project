import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  HOME_TOUR_MIN_CLEARANCE_METERS,
  HOME_TOUR_PLANNER_VERSION,
  planHomeTourRoute,
  finitePoint,
  distance3D,
  distanceXZ,
} from './HomeTourPlanner.mjs';

let recastReadyPromise = null;

async function getRecastModule() {
  if (!recastReadyPromise) {
    recastReadyPromise = (async () => {
      const recast = await import('recast-navigation');
      await recast.init();
      return recast;
    })();
  }
  try {
    return await recastReadyPromise;
  } catch (error) {
    recastReadyPromise = null;
    throw error;
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw Object.assign(new Error(`Home Tour cannot read ${label}: ${error.message}`), { statusCode: 409 });
  }
}

function atomicWriteJson(filePath, payload) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function sourceSignature(navmeshBytes, hotspotsBytes, surfaceBytes, origin, expectedAreaIds) {
  return crypto.createHash('sha256')
    .update(HOME_TOUR_PLANNER_VERSION)
    .update(`|clearance:${HOME_TOUR_MIN_CLEARANCE_METERS.toFixed(3)}|`)
    .update(navmeshBytes)
    .update(hotspotsBytes)
    .update(surfaceBytes)
    .update(JSON.stringify(expectedAreaIds))
    .update(JSON.stringify({ x: Number(origin.x.toFixed(2)), y: Number(origin.y.toFixed(2)), z: Number(origin.z.toFixed(2)) }))
    .digest('hex');
}

export function isHomeTourCachedRouteComplete(route, expectedAreaIds, metersPerUnit) {
  if (!route || Number(route.schemaVersion) !== 2
    || route.plannerVersion !== HOME_TOUR_PLANNER_VERSION
    || route.routeContract !== 'hci.home-tour.navigation-zones.v2') return false;
  if (!Array.isArray(route.stops) || route.stops.length !== expectedAreaIds.length) return false;
  if (Number(route.areaCount) !== expectedAreaIds.length) return false;
  if (Math.abs(Number(route.metersPerUnit) - metersPerUnit) > 1e-8) return false;
  if (!finitePoint(route.origin)) return false;

  const expected = new Set(expectedAreaIds);
  const seen = new Set();
  let previousStopPoint = finitePoint(route.origin);
  for (const stop of route.stops) {
    if (!stop?.areaId || !expected.has(String(stop.areaId)) || seen.has(String(stop.areaId))) return false;
    const stopPoint = finitePoint(stop.point);
    const routePoints = Array.isArray(stop.route) ? stop.route.map(finitePoint) : [];
    if (!stopPoint || !routePoints.length || routePoints.some((point) => !point)) return false;
    if (!Number.isFinite(Number(stop.clearanceMeters))
      || Number(stop.clearanceMeters) < HOME_TOUR_MIN_CLEARANCE_METERS) return false;
    if (distance3D(routePoints[0], previousStopPoint) > 0.24 * metersPerUnit) return false;
    if (distanceXZ(routePoints[routePoints.length - 1], stopPoint) > 0.22 * metersPerUnit
      || Math.abs(routePoints[routePoints.length - 1].y - stopPoint.y) > 0.18 * metersPerUnit) return false;
    previousStopPoint = stopPoint;
    seen.add(String(stop.areaId));
  }
  return seen.size === expected.size && [...expected].every((id) => seen.has(id));
}

/** Build a server-owned, complete route through every authored navigation zone. */
export async function buildHomeTourRoute({ jobDirectory, jobId, origin }) {
  const navmeshPath = path.join(jobDirectory, 'navigation_navmesh.bin');
  const hotspotsPath = path.join(jobDirectory, 'walk_hotspots.json');
  const surfacePath = path.join(jobDirectory, 'navigation_surface.json');
  for (const [filePath, label] of [
    [navmeshPath, 'navigation_navmesh.bin'],
    [hotspotsPath, 'walk_hotspots.json'],
    [surfacePath, 'navigation_surface.json'],
  ]) {
    if (!fs.existsSync(filePath)) {
      throw Object.assign(new Error(`Home Tour requires ${label}. Re-render this project so its navigation data is generated.`), { statusCode: 409 });
    }
  }

  const navmeshBytes = fs.readFileSync(navmeshPath);
  const hotspotsBytes = fs.readFileSync(hotspotsPath);
  const surfaceBytes = fs.readFileSync(surfacePath);
  const hotspotsPayload = readJson(hotspotsPath, 'walk_hotspots.json');
  const surfacePayload = readJson(surfacePath, 'navigation_surface.json');
  const originPoint = finitePoint(origin);
  if (!originPoint) throw Object.assign(new Error('A valid camera start position is required.'), { statusCode: 400 });

  const metersPerUnit = Number(surfacePayload?.metadata?.physicalMetersPerUnit);
  if (!Number.isFinite(metersPerUnit) || metersPerUnit <= 0) {
    throw Object.assign(new Error('The compiled navigation surface has no valid physical scene scale. Re-render this project before starting Home Tour.'), { statusCode: 409 });
  }

  const areas = Array.isArray(hotspotsPayload?.areas) ? hotspotsPayload.areas : [];
  const expectedAreaIds = areas
    .filter((area) => area?.id && finitePoint(area.center))
    .map((area) => String(area.id));
  if (!expectedAreaIds.length) {
    throw Object.assign(new Error('This walkthrough has no valid curated navigation zones for Home Tour.'), { statusCode: 409, code: 'NO_AREAS' });
  }

  const signature = sourceSignature(navmeshBytes, hotspotsBytes, surfaceBytes, originPoint, expectedAreaIds);
  const routeArtifactPath = path.join(jobDirectory, 'home_tour_route.json');
  if (fs.existsSync(routeArtifactPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(routeArtifactPath, 'utf8'));
      if (cached?.sourceSignature === signature
        && isHomeTourCachedRouteComplete(cached?.route, expectedAreaIds, metersPerUnit)) {
        return { success: true, route: cached.route, cacheHit: true };
      }
    } catch {
      // An incomplete, stale or old-planner artifact is ignored and rebuilt.
    }
  }

  const recast = await getRecastModule();
  const imported = recast.importNavMesh(new Uint8Array(navmeshBytes));
  const navMesh = imported?.navMesh;
  if (!navMesh) throw Object.assign(new Error('The compiled Recast NavMesh could not be loaded for Home Tour.'), { statusCode: 409 });

  let query;
  try {
    query = new recast.NavMeshQuery(navMesh);
    const filter = new recast.QueryFilter();
    const planned = planHomeTourRoute({
      areas,
      hotspots: hotspotsPayload?.hotspots,
      origin: originPoint,
      metersPerUnit,
      query,
      filter,
    });

    if (!planned.ok) {
      throw Object.assign(new Error(planned.error), {
        statusCode: planned.code === 'START_NOT_ON_NAVMESH' ? 422 : 409,
        code: planned.code,
        unreachableAreas: planned.unreachableAreas || [],
        reachableStops: planned.reachableStops || [],
        diagnostics: planned.candidateDiagnostics || null,
      });
    }

    const route = {
      schemaVersion: 2,
      plannerVersion: HOME_TOUR_PLANNER_VERSION,
      routeContract: 'hci.home-tour.navigation-zones.v2',
      jobId,
      generatedAt: new Date().toISOString(),
      source: 'server-recast-optimized-navigation-zones',
      targetSource: 'walk-hotspots-areas',
      metersPerUnit: planned.metersPerUnit,
      origin: planned.origin,
      totalDistanceMeters: planned.totalDistanceMeters,
      areaCount: planned.areaCount,
      waypointCount: planned.waypointCount,
      diagnostics: planned.diagnostics,
      stops: planned.stops,
    };

    if (!isHomeTourCachedRouteComplete(route, expectedAreaIds, metersPerUnit)) {
      throw Object.assign(new Error('The route planner returned a route that did not cover every required navigation zone. Playback was not started.'), {
        statusCode: 409,
        code: 'INCOMPLETE_ROUTE_CONTRACT',
      });
    }

    atomicWriteJson(routeArtifactPath, { sourceSignature: signature, route });
    return { success: true, route, cacheHit: false };
  } finally {
    query?.destroy?.();
    navMesh.destroy?.();
  }
}
