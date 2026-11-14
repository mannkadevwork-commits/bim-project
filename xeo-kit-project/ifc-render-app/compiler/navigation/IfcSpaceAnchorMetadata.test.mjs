import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIfcSpaceSafeCameraCenter } from './IfcSpaceAnchorMetadata.ts';

test('parses all nine unit-qualified anchors in the supplied 3BHK IFC', () => {
  const inputs = [
    ['Living Room', 'Named room anchor; safe camera center (3.90, 4.85) m', 3.9, 4.85],
    ['Dining Area', 'Named room anchor; safe camera center (8.18, 2.35) m', 8.18, 2.35],
    ['Bedroom 2', 'Named room anchor; safe camera center (3.38, 7.95) m', 3.38, 7.95],
    ['Kitchen', 'Named room anchor; safe camera center (6.25, 8.55) m', 6.25, 8.55],
    ['Master Bedroom', 'Named room anchor; safe camera center (12.35, 7.45) m', 12.35, 7.45],
    ['Bedroom 3', 'Named room anchor; safe camera center (12.75, 3.75) m', 12.75, 3.75],
    ['Common Bathroom', 'Named room anchor; safe camera center (6.90, 5.95) m', 6.9, 5.95],
    ['Master Ensuite', 'Named room anchor; safe camera center (12.40, 6.08) m', 12.4, 6.08],
    ['Main Circulation', 'Named room anchor; safe camera center (8.68, 4.05) m', 8.68, 4.05],
  ];

  assert.equal(inputs.length, 9);
  for (const [label, description, expectedX, expectedY] of inputs) {
    assert.deepEqual(
      parseIfcSpaceSafeCameraCenter(description),
      { sourceX: expectedX, sourceY: expectedY, sourceUnit: 'm' },
      label,
    );
  }
});

test('rejects descriptions without the exact unit-qualified safe-camera marker', () => {
  assert.equal(parseIfcSpaceSafeCameraCenter('Living room near the window'), null);
  assert.equal(parseIfcSpaceSafeCameraCenter('safe camera center (3.9, 4.85)'), null);
  assert.equal(parseIfcSpaceSafeCameraCenter(null), null);
});

test('accepts negative coordinates and metre spelling variants', () => {
  assert.deepEqual(
    parseIfcSpaceSafeCameraCenter('Safe Camera Center (-1.25, 2.5) meters'),
    { sourceX: -1.25, sourceY: 2.5, sourceUnit: 'm' },
  );
  assert.deepEqual(
    parseIfcSpaceSafeCameraCenter('safe camera center (0, 0) metres'),
    { sourceX: 0, sourceY: 0, sourceUnit: 'm' },
  );
});

test('rejects non-finite and implausibly large coordinates', () => {
  assert.equal(parseIfcSpaceSafeCameraCenter('safe camera center (NaN, 2) m'), null);
  assert.equal(parseIfcSpaceSafeCameraCenter('safe camera center (10001, 2) m'), null);
});
