import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('selection controls use a stable dock rather than following the last click', async () => {
  const source = await read('../src/components/TransformModeTooltip.jsx');
  assert.match(source, /fixed bottom-\[108px\] left-1\/2/);
  assert.doesNotMatch(source, /left:\s*anchorX|top:\s*anchorY/);
  assert.match(source, /Move · W/);
  assert.match(source, /Rotate · E/);
  assert.match(source, /Resize · R/);
});

test('primary actions stay visible and More opens a viewport-level finish panel', async () => {
  const source = await read('../src/components/TransformModeTooltip.jsx');
  assert.match(source, /aria-label="Focus selected item"/);
  assert.match(source, /aria-label="Replace selected item"/);
  assert.match(source, /aria-label="Customize appearance"/);
  assert.match(source, /aria-label="Open 360 degree walkthrough"/);
  assert.match(source, /title="More options"/);
  assert.match(source, /id="transform-more-panel"/);
  assert.match(source, /Surface finish/);
  assert.match(source, /createPortal\([\s\S]*id="transform-more-panel"[\s\S]*document\.body/);
  const morePanelIndex = source.indexOf('id="transform-more-panel"');
  assert.equal(source.slice(morePanelIndex).includes('aria-label="Focus selected item"'), false);
});

test('world coordinates are opt-in and hidden during active editing gestures', async () => {
  const source = await read('../src/BIMViewer.jsx');
  assert.match(source, /updateCursorTooltip\(e\.clientX, e\.clientY, e\.nativeEvent\.offsetX, e\.nativeEvent\.offsetY, e\.altKey\)/);
  assert.match(source, /!showCoordinates \|\| engineState\.isStretching \|\| engineState\.placementMode \|\| engineState\.isMeasuring/);
  assert.match(source, /3D Coordinates · Alt/);
});

test('stretch feedback is pinned away from the active pointer', async () => {
  const source = await read('../src/components/StretchTooltipOverlay.jsx');
  assert.match(source, /right: `\$\{Math\.max\(12, Number\(rightOffset\) \|\| 16\)\}px`, top: '82px'/);
  assert.doesNotMatch(source, /left: `\$\{x \+ 20\}px`/);
});

test('ceiling controls appear only when a ceiling source exists and use plain-language labels', async () => {
  const source = await read('../src/components/LeftPanel.jsx');
  assert.match(source, /\(hasDesignedCeilings \|\| hasIfcCeilings\) &&/);
  assert.match(source, /Hide created ceiling/);
  assert.match(source, /Show created ceiling/);
  assert.match(source, /Hide original ceiling/);
  assert.match(source, /Show original ceiling/);
  assert.doesNotMatch(source, /Show IFC|Hide IFC/);
});

test('original ceiling visibility toggles all detected elements consistently', async () => {
  const source = await read('../src/BIMViewer.jsx');
  assert.match(source, /const anyHidden = ids\.some\(\(id\) => currentHidden\.has\(String\(id\)\)\)/);
  assert.match(source, /const showCeiling = anyHidden/);
  assert.match(source, /hasIfcCeilings=\{ifcCeilingEntityIds\.length > 0\}/);
});


test('viewport tools have human-readable labels and measurement is not duplicated in the bottom dock', async () => {
  const toolbar = await read('../src/components/ViewportToolbar.jsx');
  const dock = await read('../src/components/BottomDock.jsx');
  assert.match(toolbar, /Floor plan/);
  assert.match(toolbar, />Views<\/span>/);
  assert.match(toolbar, />Measure<\/span>/);
  assert.match(toolbar, />Cutaway<\/span>/);
  assert.doesNotMatch(dock, /Measure|toggleMeasurementMode|Ruler/);
});
