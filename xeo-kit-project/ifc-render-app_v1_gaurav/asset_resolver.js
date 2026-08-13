// ==========================================
// ASSET REGISTRY RESOLVER
// ==========================================
// Maps a frontend-facing assetId (e.g. "sofa_01") to the backend high-res
// .blend file path Blender should actually load for the render.
//
// This is a flat JSON file for now. When this becomes a real table (Postgres/
// Mongo/whatever), only this file needs to change — resolveAssetPath() is
// already async and already returns null-vs-throws the same way a DB client
// would, so worker.js's call site does not need to change.
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, 'asset_registry.json');

let cache = null;
let cachedMtimeMs = 0;

// Re-reads the registry off disk only if it changed since last load, so you
// can edit asset_registry.json and see it picked up without restarting the
// worker, but hot paths don't pay a disk read on every single asset lookup.
function loadRegistry() {
  const stat = fs.statSync(REGISTRY_PATH);
  if (!cache || stat.mtimeMs !== cachedMtimeMs) {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    cache = JSON.parse(raw);
    cachedMtimeMs = stat.mtimeMs;
  }
  return cache;
}

// Resolves a single assetId to its high-res .blend path.
// Returns the path string, or null if the assetId has no registry entry
// (deliberately does not throw here — the caller decides whether a missing
// asset should fail the whole render job or just be skipped/flagged).
async function resolveAssetPath(assetId) {
  const registry = loadRegistry();
  return Object.prototype.hasOwnProperty.call(registry, assetId) ? registry[assetId] : null;
}

module.exports = { resolveAssetPath, loadRegistry, REGISTRY_PATH };
