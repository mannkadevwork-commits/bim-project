import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const componentPath = new URL('../src/components/TransformModeTooltip.jsx', import.meta.url);
const source = fs.readFileSync(componentPath, 'utf8');

test('transform controls stay in a stable dock instead of following the last click', () => {
  assert.match(source, /fixed bottom-\[108px\] left-1\/2/);
  assert.doesNotMatch(source, /anchorX|anchorY/);
  assert.match(source, /overflow-x-auto/);
});

test('Focus item is a primary toolbar action before More and is not hidden inside its popover', () => {
  const focusIndex = source.indexOf('aria-label="Focus selected item"');
  const moreIndex = source.indexOf('title="More options"');
  const morePanelIndex = source.indexOf('id="transform-more-panel"');
  assert.ok(focusIndex >= 0, 'Focus item action should exist');
  assert.ok(moreIndex > focusIndex, 'Focus item should appear before the More control');
  assert.ok(morePanelIndex > moreIndex, 'More panel should be declared after the More control');
  const portalStartIndex = source.lastIndexOf('createPortal(', morePanelIndex);
  const portalEndIndex = source.indexOf('document.body', morePanelIndex);
  assert.ok(portalStartIndex > moreIndex, 'More panel should be rendered through a portal');
  assert.ok(portalEndIndex > morePanelIndex, 'More portal should mount under document.body');
  assert.equal(source.slice(morePanelIndex).includes('Focus selected item'), false);
});
