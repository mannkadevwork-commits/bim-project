import test from 'node:test';
import assert from 'node:assert/strict';
import { positionPopoverInViewport } from '../src/components/positionPopoverInViewport.mjs';

const viewport = { left: 0, top: 0, width: 1600, height: 900 };

test('opens above a trigger near the bottom of the editor and stays inside the viewport', () => {
  const result = positionPopoverInViewport({
    anchor: { left: 1200, right: 1260, top: 770, bottom: 810 },
    popover: { width: 360, height: 520 },
    viewport,
  });
  assert.equal(result.side, 'above');
  assert.ok(result.top >= 12);
  assert.ok(result.top + result.maxHeight <= 888);
  assert.ok(result.left >= 12);
  assert.ok(result.left + result.width <= 1588);
});

test('opens below a trigger near the top when there is room', () => {
  const result = positionPopoverInViewport({
    anchor: { left: 100, right: 160, top: 60, bottom: 100 },
    popover: { width: 320, height: 280 },
    viewport,
    preferredSide: 'above',
  });
  assert.equal(result.side, 'below');
  assert.ok(result.top >= 110);
});

test('clamps a wide menu to a narrow visual viewport', () => {
  const result = positionPopoverInViewport({
    anchor: { left: 300, right: 350, top: 380, bottom: 420 },
    popover: { width: 360, height: 500 },
    viewport: { left: 10, top: 0, width: 375, height: 600 },
  });
  assert.ok(result.width <= 351);
  assert.ok(result.left >= 22);
  assert.ok(result.left + result.width <= 373);
  assert.ok(result.maxHeight <= 576);
});

test('shrinks a tall popover to whichever side has more available space', () => {
  const result = positionPopoverInViewport({
    anchor: { left: 100, right: 150, top: 410, bottom: 450 },
    popover: { width: 300, height: 800 },
    viewport: { left: 0, top: 0, width: 800, height: 500 },
  });
  // Available space above the trigger is 388px (410 - 12 - 10).
  assert.ok(result.maxHeight <= 388);
  assert.ok(result.top >= 12);
  assert.ok(result.top + result.maxHeight <= 488);
});
