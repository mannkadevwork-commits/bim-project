import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { preflightHomeTourRoute, createHomeTourPathFollower } from './homeTourRouteContract.js';
import { selectZoneSubjects } from './homeTourSubjectSelector.js';

const stop = (id, path, clearance = 1.2) => ({ id, areaId: id, position: path.at(-1), clearanceMeters: clearance, path });
const route = () => ({
  schemaVersion: 2, validation: { status: 'validated' }, startPosition: [0, 0, 0],
  stops: [stop('a', [[0, 0, 0], [2, 0, 0]]), stop('b', [[2, 0, 0], [2, 0, 3], [5, 0, 3]])],
});

test('preflight accepts a complete continuous route and rejects a one-stop route for two zones', () => {
  assert.equal(preflightHomeTourRoute(route(), { expectedZoneIds: ['a', 'b'] }).ok, true);
  const one = { ...route(), stops: [route().stops[0]] };
  const r = preflightHomeTourRoute(one, { expectedZoneIds: ['a', 'b'] });
  assert.equal(r.ok, false); assert.ok(r.issues.some((i) => i.code === 'ZONE_MISSING' && i.zoneId === 'b'));
});

test('preflight rejects zero-clearance stops, teleports and old schema (T3,T9)', () => {
  const zero = route(); zero.stops[1].clearanceMeters = 0;
  assert.ok(preflightHomeTourRoute(zero).issues.some((i) => i.code === 'STOP_CLEARANCE_TOO_LOW'));
  const tele = route(); tele.stops[1].path[0] = [9, 0, 9];
  assert.ok(preflightHomeTourRoute(tele).issues.some((i) => i.code === 'LEG_NOT_CONTINUOUS'));
  assert.ok(preflightHomeTourRoute({ ...route(), schemaVersion: 1 }).issues.some((i) => i.code === 'SCHEMA_MISMATCH'));
});

test('follower stays on the approved polyline and never cuts the corner or jumps stops (T9)', () => {
  const f = createHomeTourPathFollower(route());
  f.advance(2); assert.equal(f.atStop, true); assert.deepEqual(f.position, [2, 0, 0]);
  f.advance(100); assert.deepEqual(f.position, [2, 0, 0], 'cannot run into the next leg without beginNextLeg');
  assert.equal(f.beginNextLeg(), true);
  f.advance(1.5); assert.deepEqual(f.position, [2, 0, 1.5]);
  f.advance(1.5); f.advance(1); // corner at [2,0,3] then along x
  assert.deepEqual(f.position, [3, 0, 3]);
  for (let i = 0; i < 40; i += 1) { const [x, , z] = f.advance(0.1).position; assert.ok(x === 2 || z === 3 || z === 0, 'never on the diagonal shortcut'); }
  assert.equal(f.atStop, true); assert.equal(f.beginNextLeg(), false); assert.equal(f.finished, true);
});

test('furniture of another zone is never a camera target without spatial + visibility association (T13)', () => {
  const zones = [{ id: 'bed2', anchors: [[0, 0, 0]] }, { id: 'bed3', anchors: [[4, 0, 0]] }];
  const subjects = [{ id: 'bed2-bed', position: [1, 0, 0] }, { id: 'bed3-wardrobe', position: [3.2, 0, 0] }, { id: 'hidden-lamp', position: [0.5, 0, 1] }];
  const los = (_eye, p) => p[0] < 2; // wall at x=2 blocks everything beyond
  const r = selectZoneSubjects({ subjects, zones, zoneId: 'bed2', eye: [0, 1.5, 0], hasLineOfSight: (e, p) => (p[2] === 1 ? false : los(e, p)) });
  assert.deepEqual(r.accepted.map((s) => s.id), ['bed2-bed']);
  assert.equal(r.rejected.find((s) => s.id === 'bed3-wardrobe').reason, 'BELONGS_TO_NEIGHBOUR_ZONE');
  assert.equal(r.rejected.find((s) => s.id === 'hidden-lamp').reason, 'NO_LINE_OF_SIGHT');
  // even when geometrically nearby, a visible neighbour-zone item is still refused
  const near = selectZoneSubjects({ subjects: [{ id: 'x', position: [2.1, 0, 0] }], zones, zoneId: 'bed2', eye: [0, 1.5, 0], hasLineOfSight: () => true });
  assert.equal(near.accepted.length, 0);
});

test('Explore/Guided untouched: engine no longer lets rooms define Home Tour areas, walkAreas unchanged (T12)', () => {
  const src = fs.readFileSync(new URL('../useWalkthroughEngine.js', import.meta.url), 'utf8');
  assert.match(src, /this\.homeTourAreaSource = semanticAreas;/);
  assert.doesNotMatch(src, /homeTourAreaSource = this\.presentationRooms/);
  assert.match(src, /this\.walkAreas = semanticAreas;/);
  assert.match(src, /this\.walkAreas = semanticAreas\.filter\(\(area\) => activeAreaIds\.has\(area\.id\)\);/);
});
