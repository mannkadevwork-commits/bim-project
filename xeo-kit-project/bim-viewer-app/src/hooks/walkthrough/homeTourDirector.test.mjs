import test from 'node:test';
import assert from 'node:assert/strict';
import { homeTourDirectorMethods } from './homeTourDirector.js';

function makeRuntime(overrides = {}) {
  const events = [];
  const runtime = Object.assign(Object.create(homeTourDirectorMethods), {
    homeTourActive: true,
    homeTourPhase: 'sweeping',
    homeTourPaused: false,
    homeTourPausedAt: 0,
    homeTourAdvanceAfterArrival: false,
    homeTourStopIndex: 0,
    homeTourTotalStops: 3,
    homeTourStops: [],
    homeTourVisitedAreaIds: new Set(),
    homeTourMotion: null,
    homeTourCurrentStop: null,
    homeTourShot: null,
    homeTourHeroName: null,
    homeTourRemainingMs: 0,
    homeTourRevealStartedAt: 100,
    homeTourSweepStartedAt: 200,
    metersPerUnit: 1,
    position: { x: 0, y: 0.05, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    velocity: { set() {} },
    onState: (event) => events.push(event),
    _emitHomeTourState(extra = {}) { events.push({ type: 'home-tour', ...extra }); },
    _startHomeTourNextLeg() { this.nextLegCalls = (this.nextLegCalls || 0) + 1; return true; },
    ...overrides,
  });
  runtime.events = events;
  return runtime;
}

test('pause freezes the current room phase and resume preserves elapsed presentation time', () => {
  const runtime = makeRuntime({
    homeTourPhase: 'sweeping',
    homeTourSweepStartedAt: 200,
    currentYaw: 1.15,
    currentPitch: -0.38,
  });
  const paused = homeTourDirectorMethods.toggleHomeTourPause.call(runtime);
  assert.equal(paused, true);
  assert.equal(runtime.homeTourPaused, true);
  assert.equal(runtime.homeTourPausedBaseYaw, 1.15);
  assert.equal(runtime.homeTourPausedBasePitch, -0.38);
  runtime.homeTourPausedAt = 1_000;
  runtime._resumeHomeTourForCommand(5_000);
  assert.equal(runtime.homeTourPaused, false);
  assert.equal(runtime.homeTourSweepStartedAt, 4_200);
});

test('pause is unavailable while the initial route is being planned', () => {
  const runtime = makeRuntime({ homeTourPhase: 'planning' });
  assert.equal(homeTourDirectorMethods.toggleHomeTourPause.call(runtime), false);
  assert.equal(runtime.homeTourPaused, false);
});

test('next during panorama advances to the next prevalidated route leg', () => {
  const runtime = makeRuntime({ homeTourPhase: 'sweeping', homeTourStopIndex: 0 });
  assert.equal(homeTourDirectorMethods.nextHomeTourRoom.call(runtime), true);
  assert.equal(runtime.homeTourStopIndex, 1);
  assert.equal(runtime.nextLegCalls, 1);
});

test('next during travel skips the current presentation only after safe arrival', () => {
  const runtime = makeRuntime({ homeTourPhase: 'traveling', homeTourStopIndex: 0 });
  assert.equal(homeTourDirectorMethods.nextHomeTourRoom.call(runtime), true);
  assert.equal(runtime.homeTourAdvanceAfterArrival, true);
  assert.equal(runtime.homeTourStopIndex, 0);
});

test('a skipped stop continues from its validated endpoint without marking it presented', () => {
  const runtime = makeRuntime({
    homeTourPhase: 'traveling',
    homeTourStopIndex: 0,
    homeTourCurrentStop: { areaId: 'room-a', point: { x: 2, y: 0.05, z: 0 } },
    homeTourAdvanceAfterArrival: true,
  });
  const result = homeTourDirectorMethods._arriveHomeTourStop.call(runtime, 9_000);
  assert.equal(result, true);
  assert.equal(runtime.position.x, 2);
  assert.equal(runtime.homeTourStopIndex, 1);
  assert.equal(runtime.homeTourVisitedAreaIds.size, 0);
  assert.equal(runtime.nextLegCalls, 1);
});

test('previous room reverses the already validated current room corridor', () => {
  const previous = { areaId: 'room-a', label: 'Living Room', point: { x: 0, y: 0.05, z: 0 }, routeLengthMeters: 2 };
  const current = { areaId: 'room-b', label: 'Bedroom', point: { x: 2, y: 0.05, z: 0 }, path: [{ x: 0, y: 0.05, z: 0 }, { x: 1, y: 0.05, z: 0 }, { x: 2, y: 0.05, z: 0 }] };
  const runtime = makeRuntime({
    homeTourPhase: 'sweeping',
    homeTourStopIndex: 1,
    homeTourStops: [previous, current],
    position: { x: 2, y: 0.05, z: 0 },
  });
  assert.equal(homeTourDirectorMethods.previousHomeTourRoom.call(runtime), true);
  assert.equal(runtime.homeTourStopIndex, 0);
  assert.equal(runtime.homeTourCurrentStop, previous);
  assert.deepEqual(runtime.homeTourMotion.path.map((point) => point.x), [2, 1, 0]);
  assert.equal(runtime.homeTourPhase, 'traveling');
});

test('previous during travel reverses only the already traversed corridor section', () => {
  const previous = { areaId: 'room-a', label: 'Living Room', point: { x: 0, y: 0.05, z: 0 }, routeLengthMeters: 2 };
  const runtime = makeRuntime({
    homeTourPhase: 'traveling',
    homeTourStopIndex: 1,
    homeTourStops: [previous, { areaId: 'room-b', point: { x: 3, y: 0.05, z: 0 } }],
    homeTourMotion: { path: [{ x: 0, y: 0.05, z: 0 }, { x: 1, y: 0.05, z: 0 }, { x: 2, y: 0.05, z: 0 }, { x: 3, y: 0.05, z: 0 }], index: 3 },
    position: { x: 2.5, y: 0.05, z: 0 },
  });
  assert.equal(homeTourDirectorMethods.previousHomeTourRoom.call(runtime), true);
  assert.deepEqual(runtime.homeTourMotion.path.map((point) => point.x), [2.5, 2, 1, 0]);
  assert.equal(runtime.homeTourStopIndex, 0);
});

test('previous is unavailable at the first destination', () => {
  const runtime = makeRuntime({ homeTourPhase: 'sweeping', homeTourStopIndex: 0 });
  assert.equal(homeTourDirectorMethods.previousHomeTourRoom.call(runtime), false);
});

test('paused Home Tour does not advance movement or camera presentation phase', () => {
  let advanced = false;
  const runtime = makeRuntime({
    homeTourPaused: true,
    homeTourPausedAt: 9_000,
    homeTourPausedBaseYaw: 0.4,
    homeTourPausedBasePitch: -0.42,
    homeTourPhase: 'traveling',
    targetYaw: 0,
    targetPitch: 0,
    _advanceHomeTourMotion() { advanced = true; },
  });
  assert.equal(homeTourDirectorMethods._updateHomeTour.call(runtime, 10_000, 0.016), true);
  assert.equal(advanced, false);
  assert.notEqual(runtime.targetYaw, 0, 'paused ambient drift still updates the look direction');
  assert.ok(runtime.targetPitch < -0.42, 'paused ambient drift retains a gentle downward look');
});

test('tour state exposes previous and next availability for the active stop', () => {
  const runtime = makeRuntime({ homeTourPhase: 'sweeping', homeTourStopIndex: 1, homeTourTotalStops: 3 });
  homeTourDirectorMethods._emitHomeTourState.call(runtime);
  const event = runtime.events.at(-1);
  assert.equal(event.canPreviousRoom, true);
  assert.equal(event.canNextRoom, true);
  assert.equal(event.paused, false);
});

test('tour state disables next while a skip-after-arrival is already queued', () => {
  const runtime = makeRuntime({ homeTourPhase: 'traveling', homeTourStopIndex: 0, homeTourTotalStops: 3, homeTourAdvanceAfterArrival: true });
  homeTourDirectorMethods._emitHomeTourState.call(runtime);
  assert.equal(runtime.events.at(-1).canNextRoom, false);
});
