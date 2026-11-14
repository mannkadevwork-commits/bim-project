import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME_TOUR_MIN_CLEARANCE_METERS,
  HOME_TOUR_PLANNER_VERSION,
  planHomeTourRoute,
} from './HomeTourPlanner.mjs';

function makeQuery({ blockedPairs = [], partialPairs = [] } = {}) {
  const key = (point) => `${Number(point.x).toFixed(3)},${Number(point.z).toFixed(3)}`;
  const isPair = (pairs, from, to) => pairs.some(([a, b]) => (
    (key(from) === key(a) && key(to) === key(b))
    || (key(from) === key(b) && key(to) === key(a))
  ));
  return {
    findClosestPoint(point) {
      return { success: true, point: { x: point.x, y: point.y, z: point.z } };
    },
    computePath(from, to) {
      if (isPair(blockedPairs, from, to)) return { success: false, path: [] };
      if (isPair(partialPairs, from, to)) {
        return { success: true, path: [from, { x: from.x + (to.x - from.x) * 0.35, y: from.y, z: from.z + (to.z - from.z) * 0.35 }] };
      }
      return { success: true, path: [from, to] };
    },
  };
}

const area = (id, x, z = 0, index = 0) => ({
  id,
  label: `Space ${id}`,
  center: [x, 0, z],
  displayOrder: index + 1,
});
const hotspot = (areaId, id, x, z = 0, role = 'room-center', clearanceMeters = 0.6) => ({
  id,
  areaId,
  label: `Space ${areaId} · ${role}`,
  position: [x, 0, z],
  presentationRole: role,
  clearanceMeters,
  score: 12,
});

function plan(areas, hotspots, query = makeQuery(), origin = { x: 0, y: 0, z: 0 }) {
  return planHomeTourRoute({
    areas,
    hotspots,
    origin,
    metersPerUnit: 1,
    query,
    filter: {},
  });
}

test('builds a complete continuous route through all six navigation zones even without physical room data', () => {
  const areas = [
    area('space-1', 12, -9.8),
    area('space-2', 5.7, -8.9),
    area('space-3', 1.2, -5.3),
    area('space-4', 10.2, -5.3),
    area('space-5', 6.6, -1.7),
    area('space-6', 12.9, -0.8),
  ];
  const hotspots = [
    hotspot('space-1', 'hotspot-1', 12, -9.8, 'room-center', 0.388),
    hotspot('space-1', 'hotspot-12', 11.1, -8, 'room-entrance', 0.714),
    hotspot('space-2', 'hotspot-2', 5.7, -8.9, 'room-center', 0.714),
    hotspot('space-2', 'hotspot-7', 8.4, -9.8, 'viewpoint', 0.669),
    hotspot('space-2', 'hotspot-13', 3, -8, 'room-entrance', 0.427),
    hotspot('space-3', 'hotspot-3', 1.2, -5.3, 'room-center', 0.714),
    hotspot('space-3', 'hotspot-8', 1.2, -3.5, 'viewpoint', 0.714),
    hotspot('space-4', 'hotspot-4', 10.2, -5.3, 'room-center', 0.714),
    hotspot('space-4', 'hotspot-9', 10.2, -3.5, 'viewpoint', 0.714),
    hotspot('space-5', 'hotspot-5', 6.6, -1.7, 'room-center', 0.714),
    hotspot('space-5', 'hotspot-10', 3, -1.7, 'viewpoint', 0.714),
    hotspot('space-6', 'hotspot-6', 12.9, -0.8, 'room-center', 0.371),
    hotspot('space-6', 'hotspot-11', 10.2, -1.7, 'viewpoint', 0.714),
  ];

  const result = plan(areas, hotspots, makeQuery(), { x: 6.6, y: 0.05, z: -1.7 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.plannerVersion, HOME_TOUR_PLANNER_VERSION);
  assert.equal(result.areaCount, 6);
  assert.equal(result.stops.length, 6);
  assert.deepEqual(new Set(result.stops.map((stop) => stop.areaId)), new Set(areas.map((entry) => entry.id)));
  assert.equal(new Set(result.stops.map((stop) => stop.areaId)).size, 6);
  assert.ok(result.stops.every((stop) => stop.clearanceMeters >= HOME_TOUR_MIN_CLEARANCE_METERS));
  assert.ok(result.stops.every((stop) => stop.route.length >= 1));
  assert.equal(result.stops[0].route[0].x, result.origin.x);
  for (let index = 1; index < result.stops.length; index += 1) {
    const previousStop = result.stops[index - 1];
    const currentLeg = result.stops[index].route;
    assert.ok(Math.hypot(
      previousStop.point.x - currentLeg[0].x,
      previousStop.point.y - currentLeg[0].y,
      previousStop.point.z - currentLeg[0].z,
    ) < 1e-6, `Leg ${index} must begin at the previous stop`);
  }
});

test('treats navigation areas as the Home Tour source even if physical room reconstruction yields one room', () => {
  const areas = [area('a', 2), area('b', 4), area('c', 6), area('d', 8), area('e', 10), area('f', 12)];
  const hotspots = areas.map((entry, index) => hotspot(entry.id, `center-${index}`, entry.center[0]));
  const result = plan(areas, hotspots);
  assert.equal(result.ok, true);
  assert.equal(result.stops.length, 6);
});

test('does not require or infer portal edges when all navigation areas have complete NavMesh paths', () => {
  const areas = [area('a', 2), area('b', 4), area('c', 6)];
  const hotspots = areas.map((entry, index) => hotspot(entry.id, `center-${index}`, entry.center[0]));
  const result = plan(areas, hotspots);
  assert.equal(result.ok, true);
  assert.equal(result.areaCount, 3);
});

test('rejects a zero-clearance reconstructed room center rather than sending the camera into a wall', () => {
  const result = plan(
    [area('unsafe', 4)],
    [hotspot('unsafe', 'unsafe-center', 4, 0, 'room-center', 0)],
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AREA_HAS_NO_SAFE_VIEWPOINT');
  assert.deepEqual(result.unreachableAreas, ['unsafe']);
});

test('keeps a validated room-center stop instead of presenting from a doorway hotspot', () => {
  const result = plan(
    [area('a', 4)],
    [
      hotspot('a', 'center', 4, 0, 'room-center', 0.388),
      hotspot('a', 'entrance', 3.8, 0.8, 'room-entrance', 0.714),
    ],
  );
  assert.equal(result.ok, true);
  assert.equal(result.stops[0].hotspotId, 'center');
  assert.equal(result.stops[0].clearanceMeters, 0.388);
});

test('uses an entrance only when a zone has no validated interior viewpoint', () => {
  const result = plan(
    [area('a', 4)],
    [hotspot('a', 'entrance', 3.8, 0.8, 'room-entrance', 0.714)],
  );
  assert.equal(result.ok, true);
  assert.equal(result.stops[0].hotspotId, 'entrance');
});

test('prefers an interior viewpoint when its clearance and route cost are comparable', () => {
  const result = plan(
    [area('a', 4)],
    [
      hotspot('a', 'center', 4, 0, 'room-center', 0.8),
      hotspot('a', 'viewpoint', 4.2, 0, 'viewpoint', 0.8),
    ],
  );
  assert.equal(result.ok, true);
  assert.equal(result.stops[0].role, 'viewpoint');
});

test('rejects the tour instead of silently skipping an unreachable area', () => {
  const areas = [area('a', 2), area('blocked', 10)];
  const hotspots = [hotspot('a', 'a-center', 2), hotspot('blocked', 'blocked-center', 10)];
  const result = plan(areas, hotspots, makeQuery({ blockedPairs: [[{ x: 0, z: 0 }, { x: 2, z: 0 }], [{ x: 0, z: 0 }, { x: 10, z: 0 }], [{ x: 2, z: 0 }, { x: 10, z: 0 }]] }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INCOMPLETE_HOME_ROUTE');
  assert.ok(result.unreachableAreas.includes('blocked'));
});

test('rejects a start camera position that cannot be snapped near walkable floor', () => {
  const query = makeQuery();
  query.findClosestPoint = () => ({ success: true, point: { x: 5, y: 0, z: 5 } });
  const result = plan([area('a', 1)], [hotspot('a', 'a-center', 1)], query);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'START_NOT_ON_NAVMESH');
});

test('does not accept a successful partial path whose endpoint misses the requested stop', () => {
  const result = plan(
    [area('a', 4)],
    [hotspot('a', 'a-center', 4)],
    makeQuery({ partialPairs: [[{ x: 0, z: 0 }, { x: 4, z: 0 }]] }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INCOMPLETE_HOME_ROUTE');
});

test('rejects a straight path sample that falls outside the walkable NavMesh polygon', () => {
  const query = {
    findClosestPoint(point) {
      const inBlockedStrip = point.x > 1.45 && point.x < 2.55;
      return {
        success: true,
        point: { x: point.x, y: point.y, z: point.z },
        isPointOverPoly: !inBlockedStrip,
      };
    },
    computePath(from, to) {
      return { success: true, path: [from, to] };
    },
  };
  const result = plan([area('a', 4)], [hotspot('a', 'a-center', 4)], query);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INCOMPLETE_HOME_ROUTE');
});

test('route order and chosen viewpoints are deterministic', () => {
  const areas = [area('c', 7), area('a', 2), area('b', 5)];
  const hotspots = [
    hotspot('a', 'a-center', 2),
    hotspot('b', 'b-center', 5),
    hotspot('c', 'c-center', 7),
  ];
  const first = plan(areas, hotspots);
  const second = plan(areas, hotspots);
  assert.equal(first.ok, true);
  assert.deepEqual(first.stops.map((stop) => [stop.areaId, stop.hotspotId]), second.stops.map((stop) => [stop.areaId, stop.hotspotId]));
});

test('requires a measured safe hotspot instead of fabricating an unmeasured area-center fallback', () => {
  const result = plan([area('a', 4)], []);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AREA_HAS_NO_SAFE_VIEWPOINT');
});


test('rejects a hotspot whose snapped position no longer has the required wall clearance', () => {
  const query = makeQuery();
  query.findClosestPoint = (point) => ({
    success: true,
    point: { x: point.x + 0.12, y: point.y, z: point.z },
    isPointOverPoly: true,
  });
  const result = plan(
    [area('a', 4)],
    [hotspot('a', 'center', 4, 0, 'room-center', 0.388)],
    query,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AREA_HAS_NO_SAFE_VIEWPOINT');
});
