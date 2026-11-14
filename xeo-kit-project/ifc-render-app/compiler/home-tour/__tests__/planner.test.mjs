import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixture, wallCollision, areas, hotspots, origin } from './fixture.mjs';
import { planHomeTourRoute } from '../HomeTourRoutePlanner.mjs';
import { selectZoneCandidates, buildTourZones } from '../HomeTourWaypointSelector.mjs';
import { validateLeg, validateDirectHop } from '../HomeTourPathValidator.mjs';
import { optimizeVisitOrder } from '../HomeTourRouteOptimizer.mjs';
import { resolveHomeTourConfig } from '../HomeTourConfig.mjs';
import { isCachedRouteUsable } from '../HomeTourRouteSerializer.mjs';
import { buildHomeTourRoute } from '../HomeTourRouteService.mjs';
import { assessRoomEvidence } from '../HomeTourRoomEvidence.mjs';

const P = (a) => ({ x: a[0], y: a[1], z: a[2] });
const plan = (fx, extra = {}) => planHomeTourRoute({
  areas, hotspots, origin: P(origin), metersPerUnit: 1, nav: fx.nav, collision: wallCollision(), jobId: 'fixture', ...extra,
});

test('six navigation areas produce six stops with complete, continuous, collision-free legs (T5,T6)', async () => {
  const fx = await buildFixture();
  const r = plan(fx);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.route.stops.length, 6);
  assert.deepEqual([...new Set(r.route.stops.map((s) => s.areaId))].sort(), areas.map((a) => a.id));
  assert.equal(r.route.validation.zonesVisitedExactlyOnce, true);
  assert.equal(r.route.validation.collisionChecked, true);
  let prev = r.route.startPosition;
  for (const stop of r.route.stops) {
    assert.deepEqual(stop.path[0], prev, 'leg starts exactly where the previous leg ended (no teleport)');
    assert.deepEqual(stop.path.at(-1), stop.position);
    assert.ok(stop.clearanceMeters >= 0.35);
    prev = stop.position;
  }
  fx.destroy();
});

test('planner is deterministic (T7)', async () => {
  const fx = await buildFixture();
  const a = plan(fx); const b = plan(fx);
  assert.deepEqual(a.route.stops.map((s) => s.areaId), b.route.stops.map((s) => s.areaId));
  assert.equal(a.route.totalDistanceMeters, b.route.totalDistanceMeters);
  fx.destroy();
});

test('optimizer: exact order, tie-break stable (T7)', () => {
  const ids = ['a', 'b', 'c'];
  const s = [1, 5, 9];
  const z = [[Infinity, 1, 5], [1, Infinity, 1], [5, 1, Infinity]];
  const r1 = optimizeVisitOrder({ startToZone: s, zoneToZone: z, ids });
  const r2 = optimizeVisitOrder({ startToZone: s, zoneToZone: z, ids });
  assert.deepEqual(r1.order, [0, 1, 2]); assert.deepEqual(r1.order, r2.order); assert.equal(r1.total, 3);
  const unreachable = optimizeVisitOrder({ startToZone: [Infinity, 1], zoneToZone: [[Infinity, Infinity], [Infinity, Infinity]], ids: ['a', 'b'] });
  assert.equal(unreachable.order, null);
});

test('zero-clearance centre is rejected; higher-clearance viewpoint preferred (T3,T4)', async () => {
  const fx = await buildFixture();
  const config = resolveHomeTourConfig();
  const zones = buildTourZones({ areas: [{ id: 'z', center: [3.58, 0, 3.0] }] });
  const m = selectZoneCandidates({
    zones, nav: fx.nav, metersPerUnit: 1, config,
    hotspots: [{ id: 'roomy', areaId: 'z', role: 'viewpoint', position: [2, 0, 2] }, { id: 'tight', areaId: 'z', role: 'viewpoint', position: [3.3, 0, 1] }],
  }).get('z');
  const centre = m.rejected.find((r) => r.id === 'z:center');
  assert.ok(centre, 'wall-hugging centre rejected'); assert.equal(centre.reason, 'INSUFFICIENT_WALL_CLEARANCE');
  assert.equal(m.candidates[0].id, 'roomy');
  assert.ok(m.candidates[0].clearanceMeters > (m.candidates[1]?.clearanceMeters ?? 0));
  fx.destroy();
});

test('candidates outside the navigable surface are rejected; entrances stay separate (T3)', async () => {
  const fx = await buildFixture();
  const zones = buildTourZones({ areas: [{ id: 'z', center: [4, 0, 3] }] }); // inside the wall
  const m = selectZoneCandidates({ zones, nav: fx.nav, metersPerUnit: 1, config: resolveHomeTourConfig(),
    hotspots: [{ id: 'door', areaId: 'z', role: 'room-entrance', position: [3.7, 0, 2] }, { id: 'ok', areaId: 'z', role: 'viewpoint', position: [2, 0, 2] }] }).get('z');
  assert.ok(['OUTSIDE_NAVIGABLE_SURFACE', 'INSUFFICIENT_WALL_CLEARANCE'].includes(m.rejected[0].reason));
  const far = selectZoneCandidates({ zones: buildTourZones({ areas: [{ id: 'q', center: [30, 0, 30] }] }), nav: fx.nav, metersPerUnit: 1, config: resolveHomeTourConfig(), hotspots: [] }).get('q');
  assert.equal(far.rejected[0].reason, 'OUTSIDE_NAVIGABLE_SURFACE');
  assert.equal(m.entrances.length, 1); assert.ok(m.candidates.every((c) => c.role !== 'room-entrance'));
  fx.destroy();
});

test('path sampling rejects wall intersections and direct hops (T8,T9)', async () => {
  const fx = await buildFixture();
  const config = resolveHomeTourConfig(); const base = { nav: fx.nav, config, cameraRadiusMeters: 0.135, unit: 1 };
  const a = fx.nav.snap(P([2, 0, 3.5])).point; const b = fx.nav.snap(P([6, 0, 3.5])).point; // wall x=4 between
  const direct = validateDirectHop({ from: a, to: b, collision: wallCollision(), ...base });
  assert.equal(direct.ok, false);
  const navOnly = validateDirectHop({ from: a, to: b, collision: null, ...base });
  assert.equal(navOnly.ok, false); assert.ok(navOnly.issues.some((i) => ['SEGMENT_LEAVES_NAVMESH', 'SAMPLE_OFF_NAVMESH'].includes(i.code)));
  // collision geometry alone also flags a path that hugs a wall the NavMesh would allow
  const grazing = validateLeg({ points: [P([3.2, 0.2, 3]), P([3.2, 0.2, 3.4])], collision: wallCollision(), ...base, cameraRadiusMeters: 0.7 });
  assert.equal(grazing.ok, false); assert.ok(grazing.issues.some((i) => i.code === 'COLLISION_ENVELOPE_HIT'));
  // the planned route never uses a direct hop across rooms
  const r = plan(fx);
  const nonTrivial = r.route.stops.filter((s) => s.path.length > 2).length;
  assert.ok(nonTrivial >= 1, 'cross-room legs bend through doorways');
  fx.destroy();
});

test('a zone whose best viewpoint is disconnected retries other candidates before failing (T11)', async () => {
  const fx = await buildFixture({ island: true });
  const withIsland = areas.map((a) => (a.id === 'zone-c' ? { ...a, center: [15.5, 0, 1.5] } : a));
  const ok = planHomeTourRoute({ areas: withIsland, hotspots: [...hotspots, { id: 'c-view', areaId: 'zone-c', role: 'viewpoint', position: [10, 0, 2] }],
    origin: P(origin), metersPerUnit: 1, nav: fx.nav, collision: wallCollision(), jobId: 'x' });
  assert.equal(ok.ok, true, JSON.stringify(ok.diagnostics));
  assert.equal(ok.route.stops.find((s) => s.areaId === 'zone-c').candidateId, 'c-view');
  const bad = planHomeTourRoute({ areas: withIsland, hotspots, origin: P(origin), metersPerUnit: 1, nav: fx.nav, collision: wallCollision(), jobId: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ZONE_UNREACHABLE');
  assert.ok(bad.diagnostics.unreachableZones.some((z) => z.id === 'zone-c'));
  fx.destroy();
});

test('zone with no safe candidate yields structured diagnostics, never a fabricated route (T11)', async () => {
  const fx = await buildFixture();
  const broken = areas.map((a) => (a.id === 'zone-d' ? { ...a, center: [4, 0, 3] } : a));
  const r = planHomeTourRoute({ areas: broken, hotspots: [], origin: P(origin), metersPerUnit: 1, nav: fx.nav, collision: null, jobId: 'x' });
  assert.equal(r.ok, false); assert.equal(r.code, 'ZONE_HAS_NO_SAFE_STOP'); assert.equal(r.route, undefined);
  assert.equal(r.diagnostics.unreachableZones[0].id, 'zone-d');
  assert.ok(['OUTSIDE_NAVIGABLE_SURFACE', 'INSUFFICIENT_WALL_CLEARANCE'].includes(r.diagnostics.unreachableZones[0].rejected[0].reason));
  fx.destroy();
});

test('cache contract rejects stale one-room artifacts (T10)', () => {
  const stale = { sourceSignature: 's', route: { schemaVersion: 1, targetSource: 'presentation-rooms', stops: [{}] } };
  assert.equal(isCachedRouteUsable(stale, { signature: 's', expectedZoneCount: 6 }), false);
  assert.equal(isCachedRouteUsable(null, { signature: 's', expectedZoneCount: 6 }), false);
});

test('room evidence gate: one dominant room cannot label or reduce zones', () => {
  const ev = assessRoomEvidence([{ id: 'room-1', label: 'Living Room', areaSquareMeters: 142.18 }], areas.map((a) => a.id));
  assert.equal(ev.trusted, false); assert.equal(ev.labels.size, 0);
});

// ---- end-to-end through the service, using a real exported NavMesh (T1,T2,T10) ----
async function makeJob(fx, { rooms = [{ id: 'room-1', label: 'Living Room', center: [6, 0, 4], areaSquareMeters: 142.18 }] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hometour-'));
  const exp = fx.exportBytes();
  fs.writeFileSync(path.join(dir, 'navigation_navmesh.bin'), Buffer.from(exp.navMeshExport ?? exp));
  fs.writeFileSync(path.join(dir, 'walk_hotspots.json'), JSON.stringify({ areas, hotspots }));
  fs.writeFileSync(path.join(dir, 'navigation_surface.json'), JSON.stringify({ metadata: { physicalMetersPerUnit: 1, agentRadiusMeters: 0.2 }, positions: [], indices: [] }));
  fs.writeFileSync(path.join(dir, 'presentation_rooms.json'), JSON.stringify({ rooms }));
  fs.writeFileSync(path.join(dir, 'presentation_portals.json'), JSON.stringify({ rooms, portals: [] }));
  fs.writeFileSync(path.join(dir, 'home_tour_route.json'), JSON.stringify({ sourceSignature: 'old', route: { schemaVersion: 1, targetSource: 'presentation-rooms', targetRoomCount: 1, areaCount: 1, stops: [{ id: 'room-1' }] } }));
  return dir;
}

test('service: one reconstructed room + zero portals still yields six stops; stale artifact replaced (T1,T2,T10)', async () => {
  const fx = await buildFixture(); const dir = await makeJob(fx);
  const first = await buildHomeTourRoute({ jobDirectory: dir, jobId: 'job', origin: P(origin) });
  assert.equal(first.cacheHit, false); assert.equal(first.route.stops.length, 6);
  assert.equal(first.route.targetSource, 'navigation-zones'); assert.equal(first.route.targetRoomCount, 0);
  assert.ok(first.route.stops.every((s) => s.labelSource === 'navigation-zone'));
  assert.ok(first.route.stops.every((s) => s.clearanceMeters > 0));
  const second = await buildHomeTourRoute({ jobDirectory: dir, jobId: 'job', origin: P(origin) });
  assert.equal(second.cacheHit, true);
  // each cache input invalidates
  const hs = JSON.parse(fs.readFileSync(path.join(dir, 'walk_hotspots.json'), 'utf8')); hs.hotspots.push({ id: 'extra', areaId: 'zone-f', role: 'viewpoint', position: [10, 0, 6] });
  fs.writeFileSync(path.join(dir, 'walk_hotspots.json'), JSON.stringify(hs));
  assert.equal((await buildHomeTourRoute({ jobDirectory: dir, jobId: 'job', origin: P(origin) })).cacheHit, false);
  assert.equal((await buildHomeTourRoute({ jobDirectory: dir, jobId: 'job', origin: P([1.5, 0, 1]) })).cacheHit, false);
  assert.equal((await buildHomeTourRoute({ jobDirectory: dir, jobId: 'job', origin: P([1.5, 0, 1]), config: { minStopClearanceMeters: 0.4 } })).cacheHit, false);
  fx.destroy();
});

test('service: failure carries structured diagnostics and writes a diagnostics artifact (T11)', async () => {
  const fx = await buildFixture(); const dir = await makeJob(fx);
  const hs = { areas: areas.map((a) => (a.id === 'zone-d' ? { ...a, center: [4, 0, 3] } : a)), hotspots: [] };
  fs.writeFileSync(path.join(dir, 'walk_hotspots.json'), JSON.stringify(hs));
  await assert.rejects(() => buildHomeTourRoute({ jobDirectory: dir, jobId: 'job', origin: P(origin) }), (e) => {
    assert.equal(e.code, 'ZONE_HAS_NO_SAFE_STOP'); assert.equal(e.statusCode, 409);
    assert.equal(e.diagnostics.unreachableZones[0].id, 'zone-d'); assert.deepEqual(e.reachableStops, []);
    return true;
  });
  assert.ok(fs.existsSync(path.join(dir, 'home_tour_diagnostics.json')));
  fx.destroy();
});
