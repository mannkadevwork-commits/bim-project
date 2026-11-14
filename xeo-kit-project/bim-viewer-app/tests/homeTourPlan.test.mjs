import test from 'node:test';
import assert from 'node:assert/strict';
import { homeTourDirectorMethods } from '../src/hooks/walkthrough/homeTourDirector.js';
import {
  HOME_TOUR_ROUTE_REQUEST_TIMEOUT_MS,
  HOME_TOUR_CRUISE_SPEED_MPS,
  HOME_TOUR_FIXED_FOV_DEGREES,
  HOME_TOUR_HERO_REVEAL_MS,
  HOME_TOUR_MIN_SWEEP_AMPLITUDE_DEGREES,
  HOME_TOUR_MAX_SWEEP_AMPLITUDE_DEGREES,
  HOME_TOUR_SWEEP_DEGREES_PER_SECOND,
  HOME_TOUR_TOP_REVEAL_PITCH,
  homeTourCameraTurnRate,
  homeTourRevealPose,
  homeTourRoomSweepPose,
  buildHomeTourPresentationShot,
  homeTourYawFromDirection,
  homeTourAngleLerp,
  homeTourLookAheadDirection,
  advanceHomeTourPolyline,
  buildLocalHomeTourRoute,
} from '../src/hooks/walkthrough/homeTourPlan.js';

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const localOrigin = { x: 0, y: 0, z: 0 };

test('room reveal starts with a gentle downward room view, then tilts further down to the hero', () => {
  assert.equal(HOME_TOUR_HERO_REVEAL_MS, 2_400);
  assert.equal(HOME_TOUR_ROUTE_REQUEST_TIMEOUT_MS, 8_000);
  assert.equal(HOME_TOUR_FIXED_FOV_DEGREES, 70);
  const shot = buildHomeTourPresentationShot({
    origin: localOrigin,
    eyeHeightMeters: 1.6,
    metersPerUnit: 1,
    currentYaw: 0,
    hero: { id: 'sofa', name: 'Fur Sofa', center: { x: 2, y: 0.8, z: -2 } },
    subjects: [{ id: 'sofa', center: { x: 2, y: 0.8, z: -2 } }],
  });
  assert.ok(shot);
  assert.equal(shot.hero.name, 'Fur Sofa');
  assert.ok(shot.heroYaw < 0, 'camera should turn toward the hero in the +X/-Z quadrant');
  assert.ok(shot.heroPitch < 0, 'camera should tilt down toward the hero');
  close(shot.topPitch, HOME_TOUR_TOP_REVEAL_PITCH);
  assert.ok(shot.topPitch < 0, 'the opening view must not tilt upward toward the ceiling');

  const start = homeTourRevealPose(0, { fromYaw: 0.4, toYaw: shot.heroYaw, heroPitch: shot.heroPitch });
  const end = homeTourRevealPose(1, { fromYaw: 0.4, toYaw: shot.heroYaw, heroPitch: shot.heroPitch });
  close(start.pitch, HOME_TOUR_TOP_REVEAL_PITCH);
  close(end.pitch, shot.heroPitch);
  close(end.yaw, shot.heroYaw);
  assert.ok(start.pitch > end.pitch, 'the reveal must move from top to bottom');
});

test('single-hero rooms get a short adaptive sweep and do not wait for a fixed 12 seconds', () => {
  const shot = buildHomeTourPresentationShot({
    origin: localOrigin,
    eyeHeightMeters: 1.65,
    metersPerUnit: 1,
    hero: { id: 'bed', name: 'Professional Bed', center: { x: 0, y: 0.7, z: -3 } },
    subjects: [{ id: 'bed', center: { x: 0, y: 0.7, z: -3 } }],
  });
  const sweepSeconds = shot.sweepDurationMs / 1000;
  assert.ok(shot.sweepAmplitude >= (HOME_TOUR_MIN_SWEEP_AMPLITUDE_DEGREES * Math.PI) / 180);
  assert.ok(shot.sweepAmplitude <= (HOME_TOUR_MAX_SWEEP_AMPLITUDE_DEGREES * Math.PI) / 180);
  close(shot.sweepMinOffset, -(HOME_TOUR_MIN_SWEEP_AMPLITUDE_DEGREES * Math.PI) / 180);
  close(shot.sweepMaxOffset, (HOME_TOUR_MIN_SWEEP_AMPLITUDE_DEGREES * Math.PI) / 180);
  assert.ok(HOME_TOUR_HERO_REVEAL_MS / 1000 + sweepSeconds < 10);
  assert.equal(shot.relevantSubjectCount, 1);
});

test('room sweep eases across the actual subject bounds and settles back on the hero', () => {
  const leftOffset = (-24 * Math.PI) / 180;
  const rightOffset = (38 * Math.PI) / 180;
  const bounds = { leftOffset, rightOffset };
  close(homeTourRoomSweepPose(0, bounds).yawOffset, 0);
  close(homeTourRoomSweepPose(1 / 3, bounds).yawOffset, rightOffset);
  close(homeTourRoomSweepPose(2 / 3, bounds).yawOffset, leftOffset);
  close(homeTourRoomSweepPose(1, bounds).yawOffset, 0);
});

test('Home Tour selects a hero from the current navigation area before a nearby room hero', () => {
  const runtime = {
    position: { x: 0, y: 0, z: 0 },
    metersPerUnit: 1,
    eyeHeight: 1.6,
    heightOffset: 0,
    currentYaw: 0,
    targetYaw: 0,
    _isHomeTourSubjectVisible: homeTourDirectorMethods._isHomeTourSubjectVisible,
    homeTourAreaSource: [{ id: 'living', center: [0, 0, -2] }],
    presentationSubjects: [
      { id: 'bed', name: 'Professional Bed', areaId: 'bedroom', role: 'furniture', heroPriority: 9.6, center: { x: 1, y: 0.7, z: -2 } },
      { id: 'sofa', name: 'Fur Sofa', areaId: 'living', role: 'furniture', heroPriority: 9.6, center: { x: -1, y: 0.75, z: -2 } },
    ],
  };
  const shot = homeTourDirectorMethods._resolveHomeTourPresentation.call(runtime, {
    areaId: 'living',
    point: { x: 0, y: 0, z: 0 },
  });
  assert.equal(shot.hero.name, 'Fur Sofa');
  assert.equal(shot.hero.areaId, 'living');
});

test('room without a semantic hero aims at its array-form room center', () => {
  const runtime = {
    position: { x: 0, y: 0, z: 0 },
    metersPerUnit: 1,
    eyeHeight: 1.6,
    heightOffset: 0,
    currentYaw: 0,
    targetYaw: 0,
    _isHomeTourSubjectVisible: homeTourDirectorMethods._isHomeTourSubjectVisible,
    homeTourAreaSource: [{ id: 'hall', center: [2, 0.05, -2] }],
    presentationSubjects: [],
  };
  const shot = homeTourDirectorMethods._resolveHomeTourPresentation.call(runtime, {
    areaId: 'hall',
    point: { x: 0, y: 0, z: 0 },
  });
  assert.ok(shot, 'a room-center fallback shot should always be available when area metadata exists');
  assert.equal(shot.hero, null);
  close(shot.heroYaw, homeTourYawFromDirection(2, -2));
  assert.ok(shot.heroPitch < 0, 'the fallback shot should look down into the room, not up at the ceiling');
});

test('Home Tour does not aim at furniture assigned to a neighbouring room', () => {
  const runtime = {
    position: { x: 0, y: 0, z: 0 },
    metersPerUnit: 1,
    eyeHeight: 1.6,
    heightOffset: 0,
    currentYaw: 0,
    targetYaw: 0,
    _isHomeTourSubjectVisible: homeTourDirectorMethods._isHomeTourSubjectVisible,
    homeTourAreaSource: [{ id: 'living', center: [0, 0.05, -2] }],
    presentationSubjects: [
      { id: 'bed', name: 'Professional Bed', areaId: 'bedroom', role: 'furniture', heroPriority: 9.6, center: { x: 0, y: 0.7, z: -2 } },
    ],
  };
  const shot = homeTourDirectorMethods._resolveHomeTourPresentation.call(runtime, {
    areaId: 'living',
    point: { x: 0, y: 0, z: 0 },
  });
  assert.ok(shot);
  assert.equal(shot.hero, null);
  assert.ok(shot.heroPitch < 0, 'the camera should compose toward this room rather than the neighbouring bed');
});

test('Home Tour moves directly from hero reveal to adaptive sweep, then advances immediately', () => {
  const events = [];
  let advanced = 0;
  const runtime = {
    homeTourActive: true,
    homeTourPhase: 'revealing',
    homeTourRevealStartedAt: 1_000,
    homeTourRevealFromYaw: 0,
    homeTourShot: {
      hero: { name: 'Fur Sofa' },
      heroYaw: -0.4,
      heroPitch: -0.22,
      sweepAmplitude: 0.45,
      sweepDurationMs: 4_000,
    },
    homeTourHeroName: 'Fur Sofa',
    homeTourLastUiAt: 0,
    homeTourRemainingMs: 6_400,
    homeTourSweepStartedAt: 0,
    homeTourStopIndex: 0,
    _emitHomeTourState(extra) { events.push(extra); },
    _startHomeTourNextLeg() { advanced += 1; this.homeTourPhase = 'traveling'; },
  };

  homeTourDirectorMethods._updateHomeTour.call(runtime, 3_400, 0.016);
  assert.equal(runtime.homeTourPhase, 'sweeping');
  close(runtime.targetYaw, -0.4);
  close(runtime.targetPitch, -0.22);
  assert.equal(runtime.homeTourSweepStartedAt, 3_400);

  homeTourDirectorMethods._updateHomeTour.call(runtime, 7_400, 0.016);
  assert.equal(advanced, 1);
  assert.equal(runtime.homeTourPhase, 'traveling');
  assert.ok(events.some((event) => event.phase === 'sweeping'));
});

test('additional room subjects widen the sweep only up to its safety cap', () => {
  const hero = { id: 'sofa', name: 'Sofa', center: { x: 0, y: 0.7, z: -3 } };
  const oneSubject = buildHomeTourPresentationShot({
    origin: localOrigin, eyeHeightMeters: 1.6, hero, subjects: [hero],
  });
  const widerRoom = buildHomeTourPresentationShot({
    origin: localOrigin,
    eyeHeightMeters: 1.6,
    hero,
    subjects: [hero, { id: 'table', center: { x: 2.6, y: 0.7, z: -2.2 } }, { id: 'chair', center: { x: -2.6, y: 0.7, z: -2.2 } }],
  });
  assert.ok(widerRoom.sweepAmplitude > oneSubject.sweepAmplitude);
  assert.ok(widerRoom.sweepAmplitude <= (HOME_TOUR_MAX_SWEEP_AMPLITUDE_DEGREES * Math.PI) / 180);
  assert.ok(widerRoom.sweepDurationMs > oneSubject.sweepDurationMs);
  assert.equal(HOME_TOUR_SWEEP_DEGREES_PER_SECOND, 16);
});

test('room sweep spends more time toward the side containing additional design subjects', () => {
  const shot = buildHomeTourPresentationShot({
    origin: localOrigin,
    eyeHeightMeters: 1.6,
    metersPerUnit: 1,
    hero: { id: 'sofa', name: 'Fur Sofa', center: { x: 0, y: 0.7, z: -3 } },
    subjects: [
      { id: 'sofa', center: { x: 0, y: 0.7, z: -3 } },
      { id: 'dining-table', center: { x: -2.2, y: 0.7, z: -2.2 } },
    ],
  });
  assert.ok(shot.sweepMaxOffset > Math.abs(shot.sweepMinOffset), 'the sweep should extend toward the actual additional subject');
  assert.ok(shot.sweepMaxOffset <= (HOME_TOUR_MAX_SWEEP_AMPLITUDE_DEGREES * Math.PI) / 180);
  assert.ok(shot.sweepMinOffset >= -(HOME_TOUR_MAX_SWEEP_AMPLITUDE_DEGREES * Math.PI) / 180);
});

test('camera yaw follows world-space route direction', () => {
  close(homeTourYawFromDirection(1, 0), -Math.PI / 2);
  close(homeTourYawFromDirection(-1, 0), Math.PI / 2);
  close(homeTourYawFromDirection(0, -1), 0);
  close(Math.abs(homeTourYawFromDirection(0, 1)), Math.PI);
  assert.equal(homeTourYawFromDirection(0, 0), null);
});

test('camera yaw interpolation crosses the PI seam using the short arc', () => {
  const halfway = homeTourAngleLerp(Math.PI - 0.05, -Math.PI + 0.05, 0.5);
  close(Math.abs(halfway), Math.PI);
});

test('look-ahead tangent anticipates the next segment without oscillating at a corner', () => {
  const path = [
    { x: 0, y: 0, z: 0 },
    { x: 0.08, y: 0, z: -0.02 },
    { x: 0.16, y: 0, z: -0.04 },
    { x: 0.34, y: 0, z: -0.22 },
    { x: 0.58, y: 0, z: -0.45 },
  ];
  const direction = homeTourLookAheadDirection(path, 1, { x: 0, z: 0 }, 0.72);
  assert.ok(direction);
  assert.ok(direction.x > 0.5);
  assert.ok(direction.z < -0.5);
});

test('polyline playback advances by distance and reports its exact completion state', () => {
  const path = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 1, y: 0, z: 1 },
  ];
  const halfway = advanceHomeTourPolyline({ position: path[0], path, index: 1, distance: 1.5 });
  close(halfway.position.x, 1);
  close(halfway.position.z, 0.5);
  assert.equal(halfway.index, 2);
  assert.equal(halfway.finished, false);

  const complete = advanceHomeTourPolyline({ position: halfway.position, path, index: halfway.index, distance: 0.5 });
  close(complete.position.z, 1);
  assert.equal(complete.finished, true);
});

test('travel remains steady while the room sweep uses slower camera tracking', () => {
  assert.equal(HOME_TOUR_CRUISE_SPEED_MPS, 0.82);
  assert.ok(homeTourCameraTurnRate('sweeping') < homeTourCameraTurnRate('traveling'));
  assert.ok(homeTourCameraTurnRate('revealing') < homeTourCameraTurnRate('traveling'));
});


function makeLocalNavQuery(blockedPairs = []) {
  const blocked = (from, to) => blockedPairs.some(([a, b]) =>
    (Math.abs(from.x - a) < 1e-6 && Math.abs(to.x - b) < 1e-6)
    || (Math.abs(from.x - b) < 1e-6 && Math.abs(to.x - a) < 1e-6));
  return {
    findClosestPoint(point) {
      return { success: true, point: { x: point.x, y: point.y, z: point.z } };
    },
    computePath(from, to) {
      if (blocked(from, to)) return { success: false, path: [] };
      return { success: true, path: [from, to] };
    },
  };
}

test('local NavMesh fallback plans a continuous route through every authored area', () => {
  const areas = [
    { id: 'living', label: 'Living Room', center: [4, 0, 0] },
    { id: 'kitchen', label: 'Kitchen', center: [8, 0, 0] },
    { id: 'bedroom', label: 'Bedroom', center: [2, 0, 2] },
  ];
  const hotspots = [
    { id: 'living-view', areaId: 'living', label: 'Living Room', position: [4, 0, 0], presentationRole: 'viewpoint', clearanceMeters: 0.8 },
    { id: 'kitchen-center', areaId: 'kitchen', label: 'Kitchen', position: [8, 0, 0], presentationRole: 'room-center', clearanceMeters: 0.7 },
    { id: 'bedroom-center', areaId: 'bedroom', label: 'Bedroom', position: [2, 0, 2], presentationRole: 'room-center', clearanceMeters: 0.7 },
  ];
  const result = buildLocalHomeTourRoute({
    areas, hotspots, origin: { x: 0, y: 0, z: 0 }, metersPerUnit: 1,
    query: makeLocalNavQuery(), filter: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.route.stops.length, 3);
  assert.deepEqual(new Set(result.route.stops.map((stop) => stop.areaId)), new Set(['living', 'kitchen', 'bedroom']));
  assert.deepEqual(result.route.stops[0].route[0], result.route.origin);
});

test('local NavMesh fallback derives areas from hotspot metadata for older walkthroughs', () => {
  const hotspots = [
    { id: 'a1', areaId: 'area-a', areaLabel: 'Area A', position: [2, 0, 0], presentationRole: 'room-center' },
    { id: 'a2', areaId: 'area-a', areaLabel: 'Area A', position: [3, 0, 0], presentationRole: 'viewpoint' },
    { id: 'b1', areaId: 'area-b', areaLabel: 'Area B', position: [6, 0, 0], presentationRole: 'room-center' },
  ];
  const result = buildLocalHomeTourRoute({
    areas: [], hotspots, origin: localOrigin, metersPerUnit: 1,
    query: makeLocalNavQuery(), filter: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.route.stops.length, 2);
  assert.deepEqual(new Set(result.route.stops.map((stop) => stop.areaId)), new Set(['area-a', 'area-b']));
});

test('local NavMesh fallback refuses to skip a room without a complete route', () => {
  const result = buildLocalHomeTourRoute({
    areas: [
      { id: 'near', label: 'Near', center: [2, 0, 0] },
      { id: 'blocked', label: 'Blocked', center: [8, 0, 0] },
    ],
    hotspots: [],
    origin: localOrigin,
    metersPerUnit: 1,
    query: makeLocalNavQuery([[0, 8], [2, 8]]),
    filter: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCAL_INCOMPLETE_HOME_ROUTE');
  assert.deepEqual(result.unreachableAreas, ['blocked']);
});


test('Home Tour starts from the loaded NavMesh when the route API throws Failed to fetch', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const runtime = {
    jobId: 'job_test',
    apiBaseUrl: 'https://api.example.test',
    viewMode: 'walk',
    walkMode: 'guided',
    position: {
      x: 0, y: 0, z: 0,
      set(x, y, z) { this.x = x; this.y = y; this.z = z; },
    },
    homeTourAreaSource: [
      { id: 'living', label: 'Living Room', center: [2, 0, 0] },
      { id: 'bedroom', label: 'Bedroom', center: [5, 0, 0] },
    ],
    hotspots: [],
    metersPerUnit: 1,
    query: makeLocalNavQuery(),
    filter: {},
    homeTourDoorOff: false,
    onState() {},
    _emitHomeTourState() {},
    _applyHomeTourDoorVisibility() {},
    _startHomeTourNextLeg() { this.startedWithStops = this.homeTourStops.length; this.homeTourPhase = 'traveling'; },
    setWalkMode() {},
    cancelSmart720Tour() {},
    exitImmersivePresentation() {},
  };
  try {
    const started = await homeTourDirectorMethods.startHomeTour.call(runtime);
    assert.equal(started, true);
    assert.equal(runtime.homeTourActive, true);
    assert.equal(runtime.startedWithStops, 2);
    assert.equal(runtime.homeTourStops.length, 2);
    assert.equal(runtime.homeTourPhase, 'traveling');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Home Tour continues with the loaded NavMesh when the route API times out', async () => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new DOMException('The request was aborted by the test timeout.', 'AbortError');
  };
  const runtime = {
    jobId: 'job_timeout_test',
    apiBaseUrl: 'https://api.example.test',
    viewMode: 'walk',
    walkMode: 'guided',
    position: {
      x: 0, y: 0, z: 0,
      set(x, y, z) { this.x = x; this.y = y; this.z = z; },
    },
    homeTourAreaSource: [
      { id: 'living', label: 'Living Room', center: [2, 0, 0] },
      { id: 'bedroom', label: 'Bedroom', center: [5, 0, 0] },
    ],
    hotspots: [],
    metersPerUnit: 1,
    query: makeLocalNavQuery(),
    filter: {},
    homeTourDoorOff: false,
    onState() {},
    _emitHomeTourState() {},
    _applyHomeTourDoorVisibility() {},
    _startHomeTourNextLeg() { this.startedWithStops = this.homeTourStops.length; this.homeTourPhase = 'traveling'; },
    setWalkMode() {},
    cancelSmart720Tour() {},
    exitImmersivePresentation() {},
  };
  try {
    const started = await homeTourDirectorMethods.startHomeTour.call(runtime);
    assert.equal(started, true);
    assert.equal(runtime.startedWithStops, 2);
    assert.equal(runtime.homeTourPhase, 'traveling');
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
});


test('local fallback uses generated floor viewpoints when semantic area metadata is absent', () => {
  const hotspots = [
    { id: 'floor-view-1', label: 'Additional view 1', position: [2, 0, 0], presentationRole: 'viewpoint', clearanceMeters: 0.8 },
    { id: 'floor-view-2', label: 'Additional view 2', position: [6, 0, 0], presentationRole: 'room-center', clearanceMeters: 0.7 },
  ];
  const result = buildLocalHomeTourRoute({
    areas: [], hotspots, origin: localOrigin, metersPerUnit: 1,
    query: makeLocalNavQuery(), filter: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.route.stops.length, 2);
  assert.deepEqual(result.route.stops.map((stop) => stop.areaId), ['floor-view-1', 'floor-view-2']);
});
