const fs = require('fs');
const path = require('path');

// Keep this list aligned with compiler/navigation/WalkNavigationPipeline.ts and
// the runtime files loaded by src/hooks/useWalkthroughEngine.js.
// walk_areas.json is deliberately NOT required: it is a legacy v1 alias.
const REQUIRED_SAVED_LAYOUT_RENDER_ARTIFACTS = Object.freeze([
  'output.glb',
  'navigation_surface.json',
  'navigation_navmesh.bin',
  'walk_hotspots.json',
  'input.ifc',
  'original.ifc',
]);

// These files improve fidelity/reproducibility but older valid jobs may not have
// every optional diagnostic or presentation metadata artifact.
const OPTIONAL_SAVED_LAYOUT_RENDER_ARTIFACTS = Object.freeze([
  'navigation_meta.json',
  'presentation_rooms.json',
  'presentation_portals.json',
  'presentation_room_graph.json',
  'room_connectivity.json',
  'doorway_traversability.json',
  'hosted_door_portals.json',
  'presentation_manifest.json',
  'performance_report.json',
  'optimization_report.json',
  'render_cache_manifest.json',
  'scene_frame.json',
  'walk_areas.json',
]);

function getMissingSavedLayoutRenderArtifacts(sourceJobDir) {
  return REQUIRED_SAVED_LAYOUT_RENDER_ARTIFACTS.filter((fileName) => {
    const filePath = path.join(sourceJobDir, fileName);
    try {
      return !fs.existsSync(filePath) || !fs.statSync(filePath).isFile() || fs.statSync(filePath).size <= 0;
    } catch (_) {
      return true;
    }
  });
}

function writeLegacyWalkAreasAlias(snapshotDir) {
  const targetPath = path.join(snapshotDir, 'walk_areas.json');
  if (fs.existsSync(targetPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      if (Array.isArray(existing?.areas)) return { created: false, areaCount: existing.areas.length };
    } catch (_) {
      // Replace invalid legacy content with the canonical curated areas below.
    }
  }

  const hotspotsPath = path.join(snapshotDir, 'walk_hotspots.json');
  if (!fs.existsSync(hotspotsPath)) {
    throw new Error('Cannot create walk_areas.json compatibility alias: walk_hotspots.json is missing.');
  }

  const hotspots = JSON.parse(fs.readFileSync(hotspotsPath, 'utf8'));
  if (!Array.isArray(hotspots?.areas)) {
    throw new Error('Cannot create walk_areas.json compatibility alias: walk_hotspots.json has no areas array.');
  }

  const payload = { version: 1, areas: hotspots.areas };
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2), 'utf8');
  return { created: true, areaCount: payload.areas.length };
}

function copySavedLayoutRenderArtifacts(sourceJobDir, destinationJobDir) {
  const missingFiles = getMissingSavedLayoutRenderArtifacts(sourceJobDir);
  if (missingFiles.length) {
    const error = new Error(`Render snapshot is incomplete. Missing: ${missingFiles.join(', ')}`);
    error.code = 'SAVED_LAYOUT_RENDER_ARTIFACTS_MISSING';
    error.missingFiles = missingFiles;
    throw error;
  }

  fs.mkdirSync(destinationJobDir, { recursive: true });
  const copiedFiles = [];
  const fileNames = [
    ...REQUIRED_SAVED_LAYOUT_RENDER_ARTIFACTS,
    ...OPTIONAL_SAVED_LAYOUT_RENDER_ARTIFACTS,
  ];

  for (const fileName of fileNames) {
    const sourcePath = path.join(sourceJobDir, fileName);
    if (!fs.existsSync(sourcePath)) continue;
    const destinationPath = path.join(destinationJobDir, fileName);
    fs.copyFileSync(sourcePath, destinationPath);
    copiedFiles.push(fileName);
  }

  const legacyAlias = writeLegacyWalkAreasAlias(destinationJobDir);
  if (legacyAlias.created) copiedFiles.push('walk_areas.json');
  return { copiedFiles, legacyAlias };
}

module.exports = {
  REQUIRED_SAVED_LAYOUT_RENDER_ARTIFACTS,
  OPTIONAL_SAVED_LAYOUT_RENDER_ARTIFACTS,
  getMissingSavedLayoutRenderArtifacts,
  writeLegacyWalkAreasAlias,
  copySavedLayoutRenderArtifacts,
};
