import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWallHost,
  createWallHostPlacement,
  isVerticalWallNormal,
  readAabb,
  resolveWallPlacementIntent,
  sanitizeWallHostRecord,
} from './wallHostPlacement.mjs';

test('accepts only approximately vertical wall normals', () => {
  assert.equal(isVerticalWallNormal([1, 0, 0]), true);
  assert.equal(isVerticalWallNormal([0.98, 0.12, 0]), true);
  assert.equal(isVerticalWallNormal([0, 1, 0]), false);
  assert.equal(isVerticalWallNormal([0, 0.5, 0.5]), false);
});

test('reads a world AABB into wall dimensions', () => {
  const bounds = readAabb([-0.1, 0, -2, 0.1, 2.8, 2]);
  assert.deepEqual(bounds.size, [0.2, 2.8, 4]);
  assert.equal(bounds.horizontalSpan, 4);
  assert.equal(bounds.horizontalThickness, 0.2);
  assert.equal(bounds.height, 2.8);
});

test('IFC wall class is authoritative even without a geometric AABB', () => {
  const result = classifyWallHost({ entityId: '2f-wall', entityType: 'IfcWallStandardCase' });
  assert.equal(result.accepted, true);
  assert.equal(result.hostType, 'ifc');
  assert.equal(result.confidence, 0.99);
});

test('GLB wall node name is accepted as a semantic host', () => {
  const result = classifyWallHost({
    entityId: 'Wall_Interior_01',
    entityName: 'Interior Wall 01',
    modelMeta: { fileType: 'glb', assetCategory: 'structural' },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.hostType, 'glb');
  assert.equal(result.reason, 'wall-node-name');
});

test('GLB geometry fallback accepts a tall, thin wall-like node', () => {
  const result = classifyWallHost({
    entityId: 'node_17',
    modelMeta: { fileType: 'glb' },
    aabb: [-0.08, 0, -2.5, 0.08, 2.9, 2.5],
  });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'glb-wall-geometry-signature');
});

test('GLB geometric fallback rejects likely furniture hosts', () => {
  const result = classifyWallHost({
    entityId: 'Wardrobe_01',
    entityName: 'Wardrobe',
    modelMeta: { fileType: 'glb', assetCategory: 'furniture' },
    aabb: [-0.2, 0, -1, 0.2, 2.4, 1],
  });
  assert.equal(result.accepted, false);
});

test('creates a centre-anchored IFC wall placement frame facing the room', () => {
  const result = createWallHostPlacement({
    position: [2, 1.2, 3],
    normal: [1, 0, 0],
    entityId: 'ifc-wall-guid',
    modelId: 'main-model',
    globalId: 'ifc-wall-guid',
    hostType: 'ifc',
    bounds: readAabb([1.8, 0, -2, 2.2, 3, 4]),
    confidence: 0.99,
    forwardAxis: '+Z',
    standoff: 0.08,
  });
  assert.deepEqual(result.position, [2.08, 1.2, 3]);
  assert.deepEqual(result.rotation, [0, 90, 0]);
  assert.equal(result.wallHost.anchorMode, 'center');
  assert.equal(result.wallHost.hostGlobalId, 'ifc-wall-guid');
  assert.equal(result.wallHost.standoff, 0.08);
});

test('uses GLB local -Z forward convention when requested', () => {
  const result = createWallHostPlacement({
    position: [0, 1, 0], normal: [1, 0, 0], entityId: 'wall-node', hostType: 'glb', forwardAxis: '-Z',
  });
  assert.equal(result.rotation[1], -90);
});

test('sanitizes and preserves serializable host identity and local frame', () => {
  const created = createWallHostPlacement({
    position: [1, 2, 3], normal: [0, 0, -1], entityId: 'wall-1', modelId: 'glb-building', hostType: 'glb',
  });
  const restored = sanitizeWallHostRecord(created.wallHost);
  assert.equal(restored.hostEntityId, 'wall-1');
  assert.equal(restored.hostModelId, 'glb-building');
  assert.equal(restored.anchorMode, 'center');
  assert.deepEqual(restored.normal, [0, 0, -1]);
  assert.equal(sanitizeWallHostRecord({ schemaVersion: 999 }), null);
});

test('infers windows as wall openings, not surface-mounted objects', () => {
  assert.deepEqual(resolveWallPlacementIntent({ name: 'Aluminium Sliding Window' }), {
    placementSurface: 'wall', wallPlacementKind: 'opening', label: 'Window',
  });
});

test('recognises IFC window classes and does not classify window accessories as openings', () => {
  assert.equal(resolveWallPlacementIntent({ type: 'IfcWindow', name: 'Window 01' })?.wallPlacementKind, 'opening');
  assert.equal(resolveWallPlacementIntent({ name: 'Window Blind' }), null);
});

test('infers wall lamps and mirrors as wall surface objects', () => {
  assert.equal(resolveWallPlacementIntent({ name: 'Modern Wall Lamp', category: 'Lighting' })?.wallPlacementKind, 'surface');
  assert.equal(resolveWallPlacementIntent({ name: 'Adjustable Wall Mounted Light' })?.wallPlacementKind, 'surface');
  assert.equal(resolveWallPlacementIntent({ name: 'Full Length Mirror' })?.placementSurface, 'wall');
});

test('does not hijack ceiling fixtures or the legacy door workflow', () => {
  assert.equal(resolveWallPlacementIntent({ name: 'Recessed Downlight', placementSurface: 'surface' }), null);
  assert.equal(resolveWallPlacementIntent({ name: 'Modern Wooden Door', type: 'door' }), null);
  assert.equal(resolveWallPlacementIntent({ name: 'Existing IFC Door', type: 'IfcDoor' }), null);
});
