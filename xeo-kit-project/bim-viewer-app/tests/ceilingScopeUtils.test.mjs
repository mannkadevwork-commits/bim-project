import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeRoomScopedCeilings } from '../src/components/ceilingScopeUtils.mjs';

const design = (room, patch = {}) => ({
  id: `ceiling_${room.id}`,
  roomId: room.id,
  navigationRoomId: room.navigationRoomId || null,
  levelId: room.levelId || 'level_1',
  boundary: { outer: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }] },
  visible: true,
  ...patch,
});

test('replacing one room preserves every other room ceiling and does not mutate inputs', () => {
  const existing = [
    { id: 'ceiling_living', roomId: 'living', navigationRoomId: 'nav-living', finish: 'old' },
    { id: 'ceiling_bed', roomId: 'bed', navigationRoomId: 'nav-bed', finish: 'keep' },
    { id: 'ceiling_upstairs', roomId: 'upstairs', levelId: 'level_2', finish: 'keep-2' },
  ];
  const snapshot = structuredClone(existing);
  const result = mergeRoomScopedCeilings(existing, [{ id: 'living', navigationRoomId: 'nav-living' }], (room) => design(room, { finish: 'new' }));
  assert.equal(result.ceilings.length, 3);
  assert.equal(result.ceilings.find((item) => item.roomId === 'living').finish, 'new');
  assert.equal(result.ceilings.find((item) => item.roomId === 'bed').finish, 'keep');
  assert.equal(result.ceilings.find((item) => item.roomId === 'upstairs').finish, 'keep-2');
  assert.deepEqual(existing, snapshot);
});

test('applying to a floor creates independent IDs and boundaries for each room', () => {
  const rooms = [
    { id: 'living', navigationRoomId: 'nav-living', levelId: 'level_1' },
    { id: 'bed', navigationRoomId: 'nav-bed', levelId: 'level_1' },
  ];
  const result = mergeRoomScopedCeilings([], rooms, (room) => design(room, {
    boundary: { outer: [{ x: room.id === 'living' ? 0 : 2, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }] },
  }));
  assert.equal(result.created.length, 2);
  assert.deepEqual(result.created.map((item) => item.id), ['ceiling_living', 'ceiling_bed']);
  assert.notEqual(result.created[0].boundary, result.created[1].boundary);
  assert.equal(result.ceilings.length, 2);
});

test('invalid room builder rejects the entire batch without mutating existing ceilings', () => {
  const existing = [{ id: 'ceiling_old', roomId: 'old' }];
  assert.throws(
    () => mergeRoomScopedCeilings(existing, [{ id: 'living' }, { id: 'bed' }], (room) => room.id === 'bed' ? null : design(room)),
    /invalid design/,
  );
  assert.equal(existing.length, 1);
  assert.equal(existing[0].id, 'ceiling_old');
});
