const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  REQUIRED_SAVED_LAYOUT_RENDER_ARTIFACTS,
  getMissingSavedLayoutRenderArtifacts,
  copySavedLayoutRenderArtifacts,
} = require('../saved-layout-artifacts');

function makeSourceJob() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hci-layout-source-'));
  for (const fileName of REQUIRED_SAVED_LAYOUT_RENDER_ARTIFACTS) {
    fs.writeFileSync(path.join(directory, fileName), fileName === 'walk_hotspots.json'
      ? JSON.stringify({ version: 4, areas: [{ id: 'space-1', label: 'Living Room', center: [1, 0, 2] }], hotspots: [] })
      : `fixture:${fileName}`);
  }
  fs.writeFileSync(path.join(directory, 'presentation_manifest.json'), JSON.stringify({ schemaVersion: 2 }));
  return directory;
}

test('modern renderer contract does not require legacy walk_areas.json', () => {
  assert.ok(REQUIRED_SAVED_LAYOUT_RENDER_ARTIFACTS.includes('walk_hotspots.json'));
  assert.ok(!REQUIRED_SAVED_LAYOUT_RENDER_ARTIFACTS.includes('walk_areas.json'));
});

test('saved layout snapshot copies canonical artifacts and derives walk_areas compatibility alias', () => {
  const source = makeSourceJob();
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'hci-layout-snapshot-'));
  try {
    assert.deepEqual(getMissingSavedLayoutRenderArtifacts(source), []);
    const result = copySavedLayoutRenderArtifacts(source, destination);
    assert.ok(result.copiedFiles.includes('walk_hotspots.json'));
    assert.ok(fs.existsSync(path.join(destination, 'presentation_manifest.json')));
    const legacy = JSON.parse(fs.readFileSync(path.join(destination, 'walk_areas.json'), 'utf8'));
    assert.equal(legacy.version, 1);
    assert.equal(legacy.areas.length, 1);
    assert.equal(legacy.areas[0].id, 'space-1');
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('incomplete canonical render artifacts are reported before snapshot creation', () => {
  const source = makeSourceJob();
  try {
    fs.unlinkSync(path.join(source, 'walk_hotspots.json'));
    assert.deepEqual(getMissingSavedLayoutRenderArtifacts(source), ['walk_hotspots.json']);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});
