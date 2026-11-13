import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCinematicTourOrder,
  routePolylineLength,
  inferHomeTourRoomKind,
  resolveHomeTourRoomLabel,
  sortRoomStopCandidates,
  HOME_TOUR_ROOM_HOLD_MS,
  HOME_TOUR_CRUISE_SPEED_MPS,
  HOME_TOUR_APPROACH_SPEED_MPS,
  HOME_TOUR_MAX_STEP_METERS,
  HOME_TOUR_TRAVEL_FOV_DEGREES,
  HOME_TOUR_SHOWCASE_FOV_DEGREES,
  homeTourYawFromDirection,
  homeTourCameraDirection,
  homeTourAngleLerp,
  homeTourSpeedForDistance,
} from '../src/hooks/walkthrough/homeTourPlan.js';

const stop = (areaId, x, z) => ({ areaId, id: `tour-${areaId}`, label: areaId, point: { x, y: 0, z } });
const origin = { x: 0, y: 0, z: 0 };

function euclideanRoute(from, to) {
  const length = Math.hypot(to.point.x - from.x, to.point.z - from.z);
  return { complete: true, length, path: [from, to.point] };
}

test('Home Tour preflight orders every room by complete route length', () => {
  const stops = [stop('living', 4, 0), stop('bedroom', 9, 0), stop('kitchen', 0, 2)];
  const result = buildCinematicTourOrder({ stops, origin, routeBetween: euclideanRoute });
  assert.equal(result.ok, true);
  assert.equal(result.totalStops, 3);
  assert.deepEqual(new Set(result.ordered.map((item) => item.areaId)), new Set(['living', 'bedroom', 'kitchen']));
  assert.equal(result.ordered[0].areaId, 'kitchen');
  assert.equal(result.ordered.every((item) => !item.transitionRequired), true);
});

test('Home Tour never drops an unreachable room; it marks a fade-through transition', () => {
  const stops = [stop('living', 1, 0), stop('blocked-bedroom', 8, 0), stop('kitchen', 2, 0)];
  const result = buildCinematicTourOrder({
    stops,
    origin,
    routeBetween: (from, to) => to.areaId === 'blocked-bedroom' ? null : euclideanRoute(from, to),
  });
  assert.equal(result.ok, true);
  assert.equal(result.totalStops, 3);
  const blocked = result.ordered.find((item) => item.areaId === 'blocked-bedroom');
  assert.ok(blocked);
  assert.equal(blocked.transitionRequired, true);
  assert.deepEqual(result.ordered.map((item) => item.areaId).sort(), ['blocked-bedroom', 'kitchen', 'living']);
});

test('Home Tour retains all rooms as transition stops if no pair has a complete route', () => {
  const stops = [stop('a', 1, 0), stop('b', 2, 0), stop('c', 3, 0)];
  const result = buildCinematicTourOrder({ stops, origin, routeBetween: () => null });
  assert.equal(result.ok, true);
  assert.equal(result.totalStops, 3);
  assert.equal(result.ordered.every((item) => item.transitionRequired), true);
});

test('A malformed or missing tour cannot report success', () => {
  assert.equal(buildCinematicTourOrder({ stops: [], origin, routeBetween: euclideanRoute }).ok, false);
  assert.equal(buildCinematicTourOrder({ stops: [stop('a', 1, 0)], origin: null, routeBetween: euclideanRoute }).ok, false);
});

test('Route length rejects malformed vectors and measures horizontal distance', () => {
  assert.equal(routePolylineLength([{ x: 3, y: 8, z: 4 }], origin), 5);
  assert.equal(routePolylineLength([{ x: NaN, y: 0, z: 1 }], origin), Infinity);
});

test('Room labels are derived from hero metadata with neutral fallbacks', () => {
  assert.equal(inferHomeTourRoomKind('Fur Sofa'), 'living');
  assert.equal(inferHomeTourRoomKind('Dinning Set'), 'dining');
  assert.equal(resolveHomeTourRoomLabel({ areaId: 'a', fallbackLabel: 'Space 2', heroName: 'Bed (GLB)' }), 'Bedroom');
  assert.equal(resolveHomeTourRoomLabel({ areaId: 'a', fallbackLabel: 'Space 4', heroName: '' }), 'Room 4');
});

test('Home Tour prefers interior viewpoints over entrance markers, then clearance', () => {
  const candidates = [
    { id: 'center', clearanceMeters: 0.7, presentationRole: 'room-center', displayOrder: 2 },
    { id: 'view', clearanceMeters: 0.7, presentationRole: 'viewpoint', displayOrder: 1 },
    { id: 'entrance', clearanceMeters: 0.9, presentationRole: 'room-entrance', displayOrder: 9 },
  ];
  assert.equal(sortRoomStopCandidates(candidates)[0].id, 'view');
});


test('Home Tour keeps a full 15-second presentation hold per room', () => {
  assert.equal(HOME_TOUR_ROOM_HOLD_MS, 15_000);
});

test('Home Tour uses a tighter showcase lens than its travel lens', () => {
  assert.ok(HOME_TOUR_SHOWCASE_FOV_DEGREES < HOME_TOUR_TRAVEL_FOV_DEGREES);
  assert.ok(HOME_TOUR_SHOWCASE_FOV_DEGREES <= 68);
  assert.ok(HOME_TOUR_TRAVEL_FOV_DEGREES <= 75);
});

test('camera yaw follows the actual world travel direction', () => {
  assert.ok(Math.abs(homeTourYawFromDirection(1, 0) - (-Math.PI / 2)) < 1e-9);
  assert.ok(Math.abs(homeTourYawFromDirection(-1, 0) - (Math.PI / 2)) < 1e-9);
  assert.ok(Math.abs(homeTourYawFromDirection(0, -1)) < 1e-9);
  assert.ok(Math.abs(Math.abs(homeTourYawFromDirection(0, 1)) - Math.PI) < 1e-9);
  assert.equal(homeTourYawFromDirection(0, 0), null);
});

test('accepted NavMesh movement overrides a contradictory route heading', () => {
  const east = homeTourCameraDirection(-1, 0, 1, 0, true);
  assert.ok(east.x > 0.999);
  assert.ok(Math.abs(east.z) < 1e-9);

  const aligned = homeTourCameraDirection(1, 0, 1, 0, true);
  assert.ok(aligned.x > 0.999);
  assert.ok(Math.abs(aligned.z) < 1e-9);

  const stale = homeTourCameraDirection(-1, 0, 1, 0, false);
  assert.ok(stale.x < -0.999);
});

test('camera yaw interpolation crosses the +/- PI seam using the short turn', () => {
  const from = Math.PI - 0.05;
  const to = -Math.PI + 0.05;
  const halfway = homeTourAngleLerp(from, to, 0.5);
  assert.ok(Math.abs(Math.abs(halfway) - Math.PI) < 1e-9);
  assert.ok(Math.abs(Math.atan2(Math.sin(to - halfway), Math.cos(to - halfway)) - 0.05) < 1e-9);
});

test('cinematic travel stays slower than the prior brisk follower and eases near arrival', () => {
  assert.ok(HOME_TOUR_CRUISE_SPEED_MPS <= 0.4);
  assert.ok(HOME_TOUR_APPROACH_SPEED_MPS < HOME_TOUR_CRUISE_SPEED_MPS);
  assert.ok(HOME_TOUR_MAX_STEP_METERS <= 0.03);
  assert.ok(homeTourSpeedForDistance(0.1) < homeTourSpeedForDistance(8));
  assert.equal(homeTourSpeedForDistance(8), HOME_TOUR_CRUISE_SPEED_MPS);
});
