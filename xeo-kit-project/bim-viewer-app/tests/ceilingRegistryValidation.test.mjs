import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRenderableCeilingDesigns, validateCeilingAgainstRoomRegistry } from '../src/engine/assets/ceilingRegistryValidation.mjs';

const registry = {
  sourceFingerprint: 'sha256:current',
  rooms: [{
    id: 'room-bedroom-1',
    navigationRoomId: 'nav-room-1',
    boundary: { outer: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }] },
    validation: { selfIntersection: false, overlapsOtherRooms: false },
  }],
};
const design = {
  id: 'ceiling-bedroom-1',
  roomId: 'room-bedroom-1',
  sourceModelFingerprint: 'sha256:current',
  boundary: { outer: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }] },
  analysis: { validation: { selfIntersection: false, overlapsOtherRooms: false } },
};

test('keeps a ceiling that matches the current room registry', () => {
  assert.equal(validateCeilingAgainstRoomRegistry(design, registry).valid, true);
});

test('rejects a ceiling created from an older room-analysis fingerprint', () => {
  const result = validateCeilingAgainstRoomRegistry({ ...design, sourceModelFingerprint: 'sha256:old' }, registry);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'stale-room-boundary-fingerprint');
});

test('rejects a saved ceiling whose room no longer exists', () => {
  const result = validateCeilingAgainstRoomRegistry({ ...design, roomId: 'deleted-room' }, registry);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'room-not-in-current-registry');
});

test('rejects self-intersecting or overlapping room boundaries', () => {
  const selfIntersecting = { ...registry, rooms: [{ ...registry.rooms[0], validation: { selfIntersection: true } }] };
  assert.equal(validateCeilingAgainstRoomRegistry(design, selfIntersecting).reason, 'self-intersecting-boundary');
  const overlapping = { ...registry, rooms: [{ ...registry.rooms[0], validation: { overlapsOtherRooms: true } }] };
  assert.equal(validateCeilingAgainstRoomRegistry(design, overlapping).reason, 'overlapping-room-boundary');
});

test('allows legacy committed ceilings before canonical room analysis has loaded', () => {
  assert.deepEqual(validateCeilingAgainstRoomRegistry(design, null), { valid: true, reason: 'room-registry-not-loaded' });
});

test('visibility controls only count ceilings that match the current room registry', () => {
  const current = { ...design, sourceModelFingerprint: registry.sourceFingerprint };
  const stale = { ...design, id: 'stale-ceiling', sourceModelFingerprint: 'sha256:old' };
  assert.deepEqual(filterRenderableCeilingDesigns([current, stale], registry), [current]);
});

test('keeps saved designs available while the room registry has not loaded', () => {
  const items = [design];
  assert.deepEqual(filterRenderableCeilingDesigns(items, null), items);
});
