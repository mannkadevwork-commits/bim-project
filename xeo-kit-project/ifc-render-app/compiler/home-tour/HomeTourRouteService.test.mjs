import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME_TOUR_PLANNER_VERSION } from './HomeTourPlanner.mjs';
import { isHomeTourCachedRouteComplete } from './HomeTourRouteService.mjs';

const point = (x, y = 0, z = 0) => ({ x, y, z });

function makeRoute(ids) {
  const stops = ids.map((id, index) => {
    const start = index === 0 ? point(0) : point(index);
    const end = point(index + 1);
    return {
      index,
      areaId: id,
      label: id,
      point: end,
      role: 'viewpoint',
      clearanceMeters: 0.7,
      route: [start, end],
      routeLengthMeters: 1,
    };
  });
  return {
    schemaVersion: 2,
    plannerVersion: HOME_TOUR_PLANNER_VERSION,
    routeContract: 'hci.home-tour.navigation-zones.v2',
    metersPerUnit: 1,
    origin: point(0),
    areaCount: stops.length,
    stops,
  };
}

test('rejects the stale one-room cache from the previous presentation-room planner', () => {
  const staleRoute = {
    schemaVersion: 1,
    source: 'server-recast-complete-paths',
    targetSource: 'presentation-rooms',
    targetRoomCount: 1,
    areaCount: 1,
    metersPerUnit: 1,
    origin: point(6.6, 0.05, -1.7),
    stops: [{
      areaId: 'room-001',
      point: point(0.3, 0.05, -0.225),
      role: 'room-center',
      clearanceMeters: 0,
      route: [point(6.6, 0.05, -1.7), point(0.3, 0.05, -0.225)],
    }],
  };
  assert.equal(
    isHomeTourCachedRouteComplete(staleRoute, ['space-1', 'space-2', 'space-3', 'space-4', 'space-5', 'space-6'], 1),
    false,
  );
});

test('accepts only a versioned route that contains every expected zone exactly once', () => {
  const ids = ['space-1', 'space-2', 'space-3', 'space-4', 'space-5', 'space-6'];
  assert.equal(isHomeTourCachedRouteComplete(makeRoute(ids), ids, 1), true);
  assert.equal(isHomeTourCachedRouteComplete(makeRoute(ids.slice(0, 5)), ids, 1), false);
  assert.equal(isHomeTourCachedRouteComplete(makeRoute([...ids.slice(0, 5), 'space-5']), ids, 1), false);
});

test('rejects a route containing an unsafe or unmeasured stop', () => {
  const ids = ['space-1', 'space-2'];
  const route = makeRoute(ids);
  route.stops[1].clearanceMeters = 0;
  assert.equal(isHomeTourCachedRouteComplete(route, ids, 1), false);
});

test('rejects a complete-looking route whose next leg does not start at the previous stop', () => {
  const ids = ['space-1', 'space-2'];
  const route = makeRoute(ids);
  route.stops[1].route[0] = point(20);
  assert.equal(isHomeTourCachedRouteComplete(route, ids, 1), false);
});

test('rejects routes compiled for another physical scene scale', () => {
  const ids = ['space-1'];
  assert.equal(isHomeTourCachedRouteComplete(makeRoute(ids), ids, 0.01), false);
});

test('rejects a route with the current planner version but an obsolete route contract', () => {
  const route = makeRoute(['space-1']);
  route.routeContract = 'hci.home-tour.presentation-rooms.v1';
  assert.equal(isHomeTourCachedRouteComplete(route, ['space-1'], 1), false);
});
