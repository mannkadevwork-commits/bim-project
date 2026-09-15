const fs = require('node:fs');
const path = require('node:path');

const DEBUG_ARTIFACTS = [
  'walk_nav_input_debug.obj',
  'rooms_debug.json',
  'navigation_meta.json',
  '360_viewer.html',
  'output.raw.glb',
];

function readManifest(jobDir) {
  const file = path.join(jobDir, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function fileAgeMs(filePath, now) {
  try { return Math.max(0, now - fs.statSync(filePath).mtimeMs); } catch { return 0; }
}

function isReferencedSavedSnapshot(jobsDir, jobId) {
  const registry = path.join(jobsDir, 'saved_layouts_registry');
  if (!fs.existsSync(registry)) return false;
  for (const entry of fs.readdirSync(registry, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(registry, entry.name), 'utf8'));
      if (record?.renderJobId === jobId || record?.id === jobId) return true;
    } catch {}
  }
  return false;
}

function cleanupJobDirectory(jobDir, { now, retentionMs, orphanRetentionMs, removeDebugArtifacts }) {
  const jobId = path.basename(jobDir);
  const manifest = readManifest(jobDir);
  const actions = [];

  if (removeDebugArtifacts) {
    for (const fileName of DEBUG_ARTIFACTS) {
      const target = path.join(jobDir, fileName);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        actions.push(`deleted ${fileName}`);
      }
    }
  }

  if (jobId === 'saved_layouts_registry') return actions;
  if (manifest?.type === 'saved_layout') return actions;
  if (isReferencedSavedSnapshot(path.dirname(jobDir), jobId)) return actions;

  const ageMs = fileAgeMs(jobDir, now);
  const expired = manifest?.status === 'archived'
    ? ageMs >= retentionMs
    : !manifest && ageMs >= orphanRetentionMs;

  if (expired) {
    fs.rmSync(jobDir, { recursive: true, force: true });
    actions.push('deleted expired job directory');
  }
  return actions;
}

function cleanupJobs({
  jobsDir,
  retentionDays = 30,
  orphanRetentionDays = 7,
  removeDebugArtifacts = true,
  dryRun = false,
} = {}) {
  if (!jobsDir || !fs.existsSync(jobsDir)) return { scanned: 0, changed: 0, actions: [] };

  const actions = [];
  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const orphanRetentionMs = orphanRetentionDays * 24 * 60 * 60 * 1000;
  let scanned = 0;
  let changed = 0;

  for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'saved_layouts_registry') continue;
    scanned += 1;
    const jobDir = path.join(jobsDir, entry.name);
    const before = fs.existsSync(jobDir);
    if (dryRun) {
      const manifest = readManifest(jobDir);
      const ageMs = fileAgeMs(jobDir, now);
      const expired = manifest?.status === 'archived'
        ? ageMs >= retentionMs
        : !manifest && ageMs >= orphanRetentionMs;
      const debugFiles = removeDebugArtifacts ? DEBUG_ARTIFACTS.filter(f => fs.existsSync(path.join(jobDir, f))) : [];
      if (debugFiles.length || expired) actions.push({ jobId: entry.name, debugFiles, expired });
      continue;
    }
    const result = cleanupJobDirectory(jobDir, { now, retentionMs, orphanRetentionMs, removeDebugArtifacts });
    if (result.length) { changed += 1; actions.push({ jobId: entry.name, result }); }
    if (before && !fs.existsSync(jobDir)) changed += 1;
  }

  return { scanned, changed, actions };
}

module.exports = { cleanupJobs };
