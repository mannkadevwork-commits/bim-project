import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME_TOUR_MIN_CLEARANCE_METERS,
  HOME_TOUR_PLANNER_VERSION,
  HOME_TOUR_ROUTE_CONTRACT,
  HOME_TOUR_SWEEP_DEGREES_PER_SECOND,
  HOME_TOUR_PAUSE_DRIFT_CYCLE_MS,
  HOME_TOUR_PRESENTATION_BASE_PITCH,
  HOME_TOUR_TOP_REVEAL_PITCH,
  buildHomeTourPresentationShot,
  homeTourRoomSweepPose,
  homeTourPausedCameraPose,
  homeTourRevealPose,
  selectHomeTourCompositionHeading,
  selectHomeTourViewingArc,
  resolveHomeTourSubjectZone,
  buildLocalHomeTourRoute,
  getHomeTourExpectedAreas,
  isHomeTourRouteComplete,
} from './homeTourPlan.js';

const area = (id, x, z = 0) => ({ id, label: `Space ${id}`, center: [x, 0, z] });
const hotspot = (areaId, id, x, z = 0, role = 'room-center', clearanceMeters = 0.65) => ({
  id, areaId, label: `${areaId} ${role}`, position: [x, 0, z],
  presentationRole: role, clearanceMeters,
});

function mockQuery() {
  return {
    findClosestPoint(point) {
      return { success: true, point: { x: point.x, y: point.y, z: point.z } };
    },
    computePath(from, to) {
      return { success: true, path: [from, to] };
    },
  };
}

const sixAreas = [
  area('space-1', 12, -9.8),
  area('space-2', 5.7, -8.9),
  area('space-3', 1.2, -5.3),
  area('space-4', 10.2, -5.3),
  area('space-5', 6.6, -1.7),
  area('space-6', 12.9, -0.8),
];
const sixHotspots = [
  hotspot('space-1', 'h1', 12, -9.8, 'room-center', 0.388),
  hotspot('space-1', 'h1e', 11.1, -8, 'room-entrance', 0.714),
  hotspot('space-2', 'h2', 5.7, -8.9, 'room-center', 0.714),
  hotspot('space-2', 'h2v', 8.4, -9.8, 'viewpoint', 0.669),
  hotspot('space-3', 'h3', 1.2, -5.3, 'room-center', 0.714),
  hotspot('space-3', 'h3v', 1.2, -3.5, 'viewpoint', 0.714),
  hotspot('space-4', 'h4', 10.2, -5.3, 'room-center', 0.714),
  hotspot('space-4', 'h4v', 10.2, -3.5, 'viewpoint', 0.714),
  hotspot('space-5', 'h5', 6.6, -1.7, 'room-center', 0.714),
  hotspot('space-5', 'h5v', 3, -1.7, 'viewpoint', 0.714),
  hotspot('space-6', 'h6', 12.9, -0.8, 'room-center', 0.371),
  hotspot('space-6', 'h6v', 10.2, -1.7, 'viewpoint', 0.714),
];

test('local fallback keeps all six navigation zones even when physical rooms are missing', () => {
  const result = buildLocalHomeTourRoute({
    areas: sixAreas,
    hotspots: sixHotspots,
    origin: { x: 6.6, y: 0.05, z: -1.7 },
    metersPerUnit: 1,
    query: mockQuery(),
    filter: {},
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.route.areaCount, 6);
  assert.equal(result.route.plannerVersion, HOME_TOUR_PLANNER_VERSION);
  assert.equal(result.route.routeContract, HOME_TOUR_ROUTE_CONTRACT);
  assert.deepEqual(new Set(result.route.stops.map((stop) => stop.areaId)), new Set(sixAreas.map((entry) => entry.id)));
  assert.ok(result.route.stops.every((stop) => stop.clearanceMeters >= HOME_TOUR_MIN_CLEARANCE_METERS));
  assert.equal(isHomeTourRouteComplete(result.route, sixAreas), true);
});

test('recovers expected navigation zones from hotspot area IDs for older walkthroughs', () => {
  const resolved = getHomeTourExpectedAreas([], sixHotspots);
  assert.equal(resolved.length, 6);
  assert.deepEqual(new Set(resolved.map((entry) => entry.id)), new Set(sixAreas.map((entry) => entry.id)));
});

test('rejects a stale successful API response that contains only one of six zones', () => {
  const staleRoute = {
    areaCount: 1,
    metersPerUnit: 1,
    origin: { x: 0, y: 0, z: 0 },
    stops: [{
      areaId: 'room-001',
      point: { x: 1, y: 0, z: 0 },
      clearanceMeters: 0,
      route: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
    }],
  };
  assert.equal(isHomeTourRouteComplete(staleRoute, sixAreas), false);
});

test('rejects a route that skips one zone, duplicates another, or breaks leg continuity', () => {
  const result = buildLocalHomeTourRoute({
    areas: sixAreas,
    hotspots: sixHotspots,
    origin: { x: 6.6, y: 0.05, z: -1.7 },
    metersPerUnit: 1,
    query: mockQuery(),
    filter: {},
  });
  assert.equal(result.ok, true);
  const skipped = { ...result.route, stops: result.route.stops.slice(0, 5), areaCount: 5 };
  assert.equal(isHomeTourRouteComplete(skipped, sixAreas), false);
  const duplicated = { ...result.route, stops: [...result.route.stops.slice(0, 5), { ...result.route.stops[0] }] };
  assert.equal(isHomeTourRouteComplete(duplicated, sixAreas), false);
  const broken = structuredClone(result.route);
  broken.stops[2].route[0].x += 1;
  assert.equal(isHomeTourRouteComplete(broken, sixAreas), false);
});

test('rejects zero-clearance stop candidates in the local fallback', () => {
  const result = buildLocalHomeTourRoute({
    areas: [area('unsafe', 4)],
    hotspots: [hotspot('unsafe', 'unsafe-center', 4, 0, 'room-center', 0)],
    origin: { x: 0, y: 0, z: 0 },
    metersPerUnit: 1,
    query: mockQuery(),
    filter: {},
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unreachableAreas, ['unsafe']);
});

test('local fallback returns a deterministic visit order', () => {
  const first = buildLocalHomeTourRoute({
    areas: sixAreas, hotspots: sixHotspots, origin: { x: 6.6, y: 0.05, z: -1.7 }, metersPerUnit: 1, query: mockQuery(), filter: {},
  });
  const second = buildLocalHomeTourRoute({
    areas: sixAreas, hotspots: sixHotspots, origin: { x: 6.6, y: 0.05, z: -1.7 }, metersPerUnit: 1, query: mockQuery(), filter: {},
  });
  assert.equal(first.ok, true);
  assert.deepEqual(first.route.stops.map((stop) => stop.areaId), second.route.stops.map((stop) => stop.areaId));
});


function openHeadingSamples(openPredicate = () => true, count = 48) {
  return Array.from({ length: count }, (_, index) => {
    const yaw = -Math.PI + (Math.PI * 2 * index) / count;
    return { yaw, openness: openPredicate(yaw) ? 0.9 : -2.2 };
  });
}

test('composes a slow visibility-aware room sweep with a deliberate downward reveal', () => {
  const shot = buildHomeTourPresentationShot({
    origin: { x: 0, y: 0.05, z: 0 },
    eyeHeightMeters: 1.68,
    metersPerUnit: 1,
    currentYaw: 0,
    hero: { id: 'sofa', name: 'Sofa', center: { x: 0, y: 0.65, z: -2 } },
    subjects: [
      { id: 'sofa', name: 'Sofa', priority: 9, center: { x: 0, y: 0.65, z: -2 } },
      { id: 'table', name: 'Table', priority: 8, center: { x: 2, y: 0.7, z: 0 } },
    ],
    headingSamples: openHeadingSamples(),
    opennessReliable: true,
  });
  assert.ok(shot.sweepRotationRadians > Math.PI / 2);
  assert.ok(shot.sweepRotationRadians <= (220 * Math.PI) / 180);
  assert.equal(shot.sweepFullCircle, false, 'two nearby subjects do not justify a full revolution');
  assert.ok(shot.panoramaTargets.length >= 1);
  assert.equal(HOME_TOUR_SWEEP_DEGREES_PER_SECOND, 6);
  assert.ok(shot.sweepDurationMs >= 20_000 && shot.sweepDurationMs <= 37_000);
  assert.ok(shot.heroPitch <= (-18 * Math.PI) / 180, 'the reveal must not settle back to a flat wall-facing angle');

  const revealStart = homeTourRevealPose(0, { fromYaw: 0, toYaw: 0, heroPitch: shot.heroPitch });
  const revealEnd = homeTourRevealPose(1, { fromYaw: 0, toYaw: 0, heroPitch: shot.heroPitch });
  assert.ok(Math.abs(revealStart.pitch - HOME_TOUR_TOP_REVEAL_PITCH) < 1e-9);
  assert.ok(revealEnd.pitch < revealStart.pitch, 'the camera must tilt down during the arrival reveal');

  const halfway = homeTourRoomSweepPose(0.5, {
    rotationRadians: shot.sweepRotationRadians,
    direction: shot.sweepDirection,
    targets: shot.panoramaTargets,
    basePitch: shot.sweepBasePitch,
  });
  assert.ok(Math.abs(Math.abs(halfway.yawOffset) - shot.sweepRotationRadians / 2) < 1e-9);
  assert.ok(halfway.pitch <= (-18 * Math.PI) / 180, 'the sweep must retain a downward architectural angle');
  const atSubject = homeTourRoomSweepPose(shot.panoramaTargets[0].yawOffset / shot.sweepRotationRadians, {
    rotationRadians: shot.sweepRotationRadians,
    targets: shot.panoramaTargets,
    basePitch: shot.sweepBasePitch,
  });
  assert.ok(Number.isFinite(atSubject.pitch));
  assert.ok(atSubject.pitch <= (-18 * Math.PI) / 180);
});

test('selects the best continuous visible sector instead of sweeping into a blocked rear wall', () => {
  const samples = openHeadingSamples((yaw) => {
    const degrees = yaw * 180 / Math.PI;
    return degrees >= -20 && degrees <= 150;
  });
  const result = selectHomeTourViewingArc({
    headingSamples: samples,
    preferredYaw: 0,
    subjects: [
      { id: 'sofa', yaw: 0.1, priority: 1.2 },
      { id: 'window', yaw: 1.1, priority: 1 },
    ],
  });
  assert.equal(result.fullCircle, false);
  assert.ok(result.rotationRadians > (90 * Math.PI) / 180);
  assert.ok(result.rotationRadians < Math.PI * 2);
  assert.ok(Math.abs(homeTourAngleDeltaForTest(result.startYaw, 0)) < (20 * Math.PI) / 180);
  assert.equal(result.direction, 1, 'the longer clear sector is on the positive yaw side');
});

test('uses a full 360 only when every heading is clear and subjects surround the room', () => {
  const result = selectHomeTourViewingArc({
    headingSamples: openHeadingSamples(),
    preferredYaw: 0,
    opennessReliable: true,
    subjects: [
      { id: 'north', yaw: 0, priority: 1 },
      { id: 'east', yaw: Math.PI / 2, priority: 1 },
      { id: 'south', yaw: Math.PI, priority: 1 },
      { id: 'west', yaw: -Math.PI / 2, priority: 1 },
    ],
  });
  assert.equal(result.fullCircle, true);
  assert.ok(Math.abs(result.rotationRadians - Math.PI * 2) < 1e-9);
});

test('does not trust a full 360 when structural visibility measurements are unavailable', () => {
  const result = selectHomeTourViewingArc({
    headingSamples: openHeadingSamples(),
    preferredYaw: 0,
    opennessReliable: false,
    subjects: [
      { id: 'north', yaw: 0, priority: 1 },
      { id: 'east', yaw: Math.PI / 2, priority: 1 },
      { id: 'south', yaw: Math.PI, priority: 1 },
      { id: 'west', yaw: -Math.PI / 2, priority: 1 },
    ],
  });
  assert.equal(result.fullCircle, false);
  assert.ok(result.rotationRadians < Math.PI * 2);
});

function homeTourAngleDeltaForTest(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

test('uses the most open wall-ray heading when no trusted local hero is available', () => {
  const desiredYaw = -Math.PI / 2;
  const result = selectHomeTourCompositionHeading({
    origin: { x: 0, z: 0 },
    currentYaw: 0,
    subjects: [],
    sampleCount: 36,
    opennessScore: (yaw) => 2 - Math.abs(Math.atan2(Math.sin(yaw - desiredYaw), Math.cos(yaw - desiredYaw))) * 4,
  });
  assert.ok(Math.abs(Math.atan2(Math.sin(result.yaw - desiredYaw), Math.cos(result.yaw - desiredYaw))) < (6 * Math.PI) / 180);
  assert.equal(result.subjectId, null);
});

test('starts its composition on a visible local subject instead of the previous route tangent', () => {
  const result = selectHomeTourCompositionHeading({
    origin: { x: 0, z: 0 },
    currentYaw: Math.PI,
    subjects: [{ id: 'sofa', center: { x: 0, y: 0.7, z: -2 }, priority: 9 }],
    opennessScore: () => 0,
  });
  assert.equal(result.subjectId, 'sofa');
  assert.ok(Math.abs(result.yaw) < (2 * Math.PI) / 180);
});

test('uses slow eased yaw movement instead of a constant-speed snap at the start and end', () => {
  const start = homeTourRoomSweepPose(0, { rotationRadians: Math.PI * 2 });
  const quarter = homeTourRoomSweepPose(0.25, { rotationRadians: Math.PI * 2 });
  const middle = homeTourRoomSweepPose(0.5, { rotationRadians: Math.PI * 2 });
  const end = homeTourRoomSweepPose(1, { rotationRadians: Math.PI * 2 });
  assert.equal(start.yawOffset, 0);
  assert.ok(quarter.yawOffset < Math.PI / 2, 'ease-in should reduce early camera speed');
  assert.ok(Math.abs(middle.yawOffset - Math.PI) < 1e-9);
  assert.ok(Math.abs(end.yawOffset - Math.PI * 2) < 1e-9);
  assert.ok(Math.abs(start.pitch - HOME_TOUR_PRESENTATION_BASE_PITCH) < 1e-9);
});

test('tracks room subjects correctly when the visibility-aware arc pans in negative yaw', () => {
  const shot = homeTourRoomSweepPose(0.5, {
    rotationRadians: Math.PI / 2,
    direction: -1,
    basePitch: -0.4,
    targets: [{ yawOffset: Math.PI / 4, pitch: -0.55 }],
  });
  assert.ok(shot.yawOffset < 0, 'negative direction remains intact');
  assert.ok(shot.pitch < -0.4, 'the camera pitches toward the subject in the negative-yaw arc');
});

test('pause mode performs a very slow shallow V-shaped camera drift without advancing the tour', () => {
  const start = homeTourPausedCameraPose(0, { baseYaw: 0.4, basePitch: -0.42 });
  const quarter = homeTourPausedCameraPose(HOME_TOUR_PAUSE_DRIFT_CYCLE_MS / 4, { baseYaw: 0.4, basePitch: -0.42 });
  const midpoint = homeTourPausedCameraPose(HOME_TOUR_PAUSE_DRIFT_CYCLE_MS / 2, { baseYaw: 0.4, basePitch: -0.42 });
  const end = homeTourPausedCameraPose(HOME_TOUR_PAUSE_DRIFT_CYCLE_MS, { baseYaw: 0.4, basePitch: -0.42 });
  assert.ok(start.yaw < 0.4);
  assert.ok(midpoint.yaw > 0.4);
  assert.ok(Math.abs(end.yaw - start.yaw) < 1e-9, 'the ambient path loops without a yaw jump');
  assert.ok(quarter.pitch < start.pitch, 'the camera gently dips at the bottom of the V');
  assert.ok(Math.abs(end.pitch - start.pitch) < 1e-9);
  assert.ok(Math.abs(start.yaw - 0.4) < (4 * Math.PI / 180));
  assert.ok(Math.abs(midpoint.yaw - 0.4) < (4 * Math.PI / 180));
  const travelPose = homeTourPausedCameraPose(0, { baseYaw: 0, basePitch: -0.15 });
  assert.ok(Math.abs(travelPose.pitch - (-0.15)) < (1 * Math.PI / 180), 'pausing during travel must not snap to the room presentation pitch');
});

test('does not assign a subject to an ambiguous neighboring navigation zone', () => {
  const zones = [area('left', 0), area('right', 5)];
  assert.equal(resolveHomeTourSubjectZone({ x: 2.35, y: 0, z: 0 }, zones), null);
  assert.equal(resolveHomeTourSubjectZone({ x: 4, y: 0, z: 0 }, zones), 'right');
});

test('rejects a complete-looking route generated with an obsolete planner contract', () => {
  const result = buildLocalHomeTourRoute({
    areas: sixAreas,
    hotspots: sixHotspots,
    origin: { x: 6.6, y: 0.05, z: -1.7 },
    metersPerUnit: 1,
    query: mockQuery(),
    filter: {},
  });
  assert.equal(result.ok, true);
  const stale = { ...result.route, plannerVersion: 'navmesh-zone-tour-v2.1' };
  assert.equal(isHomeTourRouteComplete(stale, sixAreas), false);
});


test('uses room entrance as a last-resort stop only when no interior candidate exists', () => {
  const withCenter = buildLocalHomeTourRoute({
    areas: [area('a', 4)],
    hotspots: [
      hotspot('a', 'center', 4, 0, 'room-center', 0.388),
      hotspot('a', 'entrance', 3.8, 0.8, 'room-entrance', 0.714),
    ],
    origin: { x: 0, y: 0, z: 0 },
    metersPerUnit: 1,
    query: mockQuery(),
    filter: {},
  });
  assert.equal(withCenter.ok, true);
  assert.equal(withCenter.route.stops[0].hotspotId, 'center');

  const entranceOnly = buildLocalHomeTourRoute({
    areas: [area('a', 4)],
    hotspots: [hotspot('a', 'entrance', 3.8, 0.8, 'room-entrance', 0.714)],
    origin: { x: 0, y: 0, z: 0 },
    metersPerUnit: 1,
    query: mockQuery(),
    filter: {},
  });
  assert.equal(entranceOnly.ok, true);
  assert.equal(entranceOnly.route.stops[0].hotspotId, 'entrance');
});


test('rechecks the clearance after snapping a candidate to the NavMesh', () => {
  const query = mockQuery();
  query.findClosestPoint = (point) => ({
    success: true,
    point: { x: point.x + 0.12, y: point.y, z: point.z },
    isPointOverPoly: true,
  });
  const result = buildLocalHomeTourRoute({
    areas: [area('a', 4)],
    hotspots: [hotspot('a', 'center', 4, 0, 'room-center', 0.388)],
    origin: { x: 0, y: 0, z: 0 },
    metersPerUnit: 1,
    query,
    filter: {},
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unreachableAreas, ['a']);
});
