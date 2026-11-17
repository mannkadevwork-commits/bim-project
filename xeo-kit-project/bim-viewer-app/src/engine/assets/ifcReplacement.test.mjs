import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNativeIfcReplacement,
  normalizeNativeReplacementInfo,
  isCompatibleCatalogReplacement,
  computeFitScale,
} from './ifcReplacement.mjs';

test('classifies IFC furniture, windows and walls without enabling doors', () => {
  assert.equal(classifyNativeIfcReplacement('IfcFurnishingElement', 'Bed_01'), 'furniture');
  assert.equal(classifyNativeIfcReplacement('IfcWindow', 'Window_01'), 'window');
  assert.equal(classifyNativeIfcReplacement('IfcWallStandardCase', 'Wall_01'), 'wall');
  assert.equal(classifyNativeIfcReplacement('IfcDoor', 'Door_01'), null);
  assert.equal(classifyNativeIfcReplacement('IfcSlab', 'Floor_01'), null);
});

test('validates a measured IFC replacement frame', () => {
  const frame = normalizeNativeReplacementInfo({
    replacement: {
      kind: 'furniture',
      frameAvailable: true,
      frame: {
        position: [1, 0, 2],
        rotation: [0, 90, 0],
        dimensions: [2, 1, 0.5],
        coordinateSystem: 'hci-y-up',
        unit: 'm',
      },
    },
  }, 'furniture');
  assert.deepEqual(frame.frame.position, [1, 0, 2]);
  assert.deepEqual(frame.frame.dimensions, [2, 1, 0.5]);
});

test('rejects missing/invalid native frame rather than falling back to origin', () => {
  assert.throws(() => normalizeNativeReplacementInfo({ replacement: { kind: 'furniture', frameAvailable: false } }, 'furniture'));
  assert.throws(() => normalizeNativeReplacementInfo({
    replacement: { kind: 'furniture', frameAvailable: true, frame: {
      position: [0, 0, 0], rotation: [0, 0, 0], dimensions: [1, 0, 1], coordinateSystem: 'hci-y-up', unit: 'm',
    } },
  }, 'furniture'));
});

test('filters catalogue replacements by native IFC element kind', () => {
  assert.equal(isCompatibleCatalogReplacement({ name: 'Modern King Bed', _categoryPath: 'Furniture / Bedroom', _fileType: 'glb' }, 'furniture'), true);
  assert.equal(isCompatibleCatalogReplacement({ name: 'Frosted Bathroom Window', _categoryPath: 'Windows', _fileType: 'glb' }, 'window'), true);
  assert.equal(isCompatibleCatalogReplacement({ name: 'Brick Partition Wall', _categoryPath: 'Walls', _fileType: 'glb' }, 'wall'), true);
  assert.equal(isCompatibleCatalogReplacement({ name: 'Wall Lamp', _categoryPath: 'Lighting' }, 'wall'), false);
  assert.equal(isCompatibleCatalogReplacement({ name: 'Sliding Door' }, 'window'), false);
  assert.equal(isCompatibleCatalogReplacement({ name: 'Bathroom Window' }, 'furniture'), false);
});

test('fits all three local axes to native IFC dimensions', () => {
  assert.deepEqual(computeFitScale([1, 2, 0.5], [2, 1, 0.25]), [2, 0.5, 0.5]);
});
