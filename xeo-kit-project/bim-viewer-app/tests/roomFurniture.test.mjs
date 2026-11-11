import test from 'node:test';
import assert from 'node:assert/strict';
import { getFurnitureInRoom, isPositionInsideRoom, pointInRoomRing } from '../src/utils/roomFurniture.js';

const room = {
  id: 'bedroom-01',
  navigationRoomId: 'nav-bedroom-01',
  floorY: 0,
  recommendedCeilingY: 2.8,
  boundary: {
    outer: [
      { x: 0, z: 0 },
      { x: 5, z: 0 },
      { x: 5, z: 4 },
      { x: 0, z: 4 },
    ],
    holes: [[
      { x: 2, z: 1 },
      { x: 3, z: 1 },
      { x: 3, z: 2 },
      { x: 2, z: 2 },
    ]],
  },
};

test('pointInRoomRing includes points on the boundary', () => {
  assert.equal(pointInRoomRing({ x: 0, z: 2 }, room.boundary.outer), true);
  assert.equal(pointInRoomRing({ x: 6, z: 2 }, room.boundary.outer), false);
});

test('isPositionInsideRoom includes interior points and rejects points outside', () => {
  assert.equal(isPositionInsideRoom(room, [1, 0.4, 1]), true);
  assert.equal(isPositionInsideRoom(room, [6, 0.4, 1]), false);
});

test('isPositionInsideRoom excludes footprint holes', () => {
  assert.equal(isPositionInsideRoom(room, [2.5, 0.4, 1.5]), false);
});

test('explicit room metadata does not override a position in another room', () => {
  assert.equal(isPositionInsideRoom(room, [8, 0.4, 8], ['bedroom-01']), false);
});

test('matching room metadata tolerates vertical pivot offsets when XZ is inside', () => {
  assert.equal(isPositionInsideRoom(room, [1, 5.5, 1], ['bedroom-01']), true);
  assert.equal(isPositionInsideRoom(room, [1, 5.5, 1], []), false);
});

test('getFurnitureInRoom groups by current spatial position, not stale room metadata', () => {
  const furniture = [
    { instanceId: 'bed-in-room', name: 'Bed', position: [1, 0.3, 1], roomId: 'bedroom-01' },
    { instanceId: 'moved-sofa', name: 'Sofa', position: [8, 0.3, 8], roomId: 'bedroom-01' },
    { instanceId: 'no-position', name: 'Wardrobe', roomId: 'bedroom-01' },
  ];

  assert.deepEqual(getFurnitureInRoom(room, furniture).map((item) => item.instanceId), ['bed-in-room', 'no-position']);
});
