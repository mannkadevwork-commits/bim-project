#!/usr/bin/env node
/**
 * Home Tour CLI (developer tool, not part of the customer UI).
 *
 *   node homeTourCli.mjs diagnose <jobDir>
 *   node homeTourCli.mjs plan     <jobDir> <x> <y> <z>   # regenerates home_tour_route.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildHomeTourRoute } from './HomeTourRouteService.mjs';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const mtime = (p) => (fs.existsSync(p) ? fs.statSync(p).mtime.toISOString() : null);

async function diagnose(dir) {
  const f = (n) => path.join(dir, n);
  const surface = readJson(f('navigation_surface.json'));
  const meta = readJson(f('navigation_meta.json'));
  const hot = readJson(f('walk_hotspots.json'));
  const rooms = readJson(f('presentation_rooms.json'));
  const portals = readJson(f('presentation_portals.json'));
  const analysis = readJson(f('room_analysis.json'));
  const conn = readJson(f('room_connectivity.json'));
  const out = { jobDirectory: dir, findings: [] };
  const surfaceTriangles = Array.isArray(surface?.indices) ? surface.indices.length / 3 : null;
  let navmeshTriangles = null;
  if (fs.existsSync(f('navigation_navmesh.bin'))) {
    const recast = await import('recast-navigation'); await recast.init();
    const imported = recast.importNavMesh(new Uint8Array(fs.readFileSync(f('navigation_navmesh.bin'))));
    if (imported?.navMesh) { const [, idx] = recast.getNavMeshPositionsAndIndices(imported.navMesh); navmeshTriangles = idx.length / 3; imported.navMesh.destroy?.(); }
  }
  out.counts = {
    navigationAreas: hot?.areas?.length ?? null, hotspots: hot?.hotspots?.length ?? null,
    presentationRooms: rooms?.rooms?.length ?? null, portals: portals?.portals?.length ?? null,
    roomAnalysisRooms: Array.isArray(analysis?.rooms) ? analysis.rooms.length : null,
    surfaceTriangles, navmeshTriangles, metaKeptFloorTriangles: meta?.keptFloorTriangles ?? null,
  };
  out.timestamps = { room_analysis: mtime(f('room_analysis.json')), presentation_rooms: mtime(f('presentation_rooms.json')), navigation_surface: mtime(f('navigation_surface.json')), navigation_meta: mtime(f('navigation_meta.json')), navigation_navmesh: mtime(f('navigation_navmesh.bin')) };
  if (out.counts.roomAnalysisRooms !== null && out.counts.roomAnalysisRooms !== out.counts.presentationRooms) out.findings.push({ code: 'ROOM_COUNT_MISMATCH', detail: 'room_analysis.json and presentation_rooms.json describe different room sets', ...out.counts });
  if (out.timestamps.room_analysis && out.timestamps.presentation_rooms && out.timestamps.room_analysis < out.timestamps.presentation_rooms) out.findings.push({ code: 'ROOM_ANALYSIS_OLDER_THAN_PRESENTATION', detail: 'room_analysis.json predates presentation_rooms.json; treat it as a different build' });
  if (meta?.keptFloorTriangles != null && surfaceTriangles != null && meta.keptFloorTriangles !== surfaceTriangles) {
    out.findings.push({ code: 'KEPT_FLOOR_TRIANGLES_DIFFER_FROM_SURFACE', keptFloorTriangles: meta.keptFloorTriangles, surfaceTriangles, navmeshTriangles,
      detail: 'These counts are only comparable if they describe the same stage. Compare navigation_meta.json stage/signature fields with navigation_surface.json metadata; if the signatures differ they are different builds.' });
    out.navigationMetaKeys = Object.keys(meta);
    out.surfaceMetadata = surface?.metadata ?? null;
  }
  if (Array.isArray(conn?.reachablePairs)) out.counts.reportedReachablePairs = conn.reachablePairs.length;
  return out;
}

const [cmd, dir, ...rest] = process.argv.slice(2);
if (cmd === 'diagnose' && dir) {
  console.log(JSON.stringify(await diagnose(dir), null, 2));
} else if (cmd === 'plan' && dir && rest.length === 3) {
  const origin = rest.map(Number);
  try {
    const r = await buildHomeTourRoute({ jobDirectory: dir, jobId: path.basename(dir), origin });
    console.log(JSON.stringify({ cacheHit: r.cacheHit, stops: r.route.stops.map((s) => ({ id: s.id, label: s.label, clearanceMeters: s.clearanceMeters, legMeters: s.distanceFromPreviousMeters, waypoints: s.path.length })), totalDistanceMeters: r.route.totalDistanceMeters, collisionChecked: r.route.validation.collisionChecked }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ code: e.code, error: e.message, diagnostics: e.diagnostics }, null, 2)); process.exitCode = 1;
  }
} else {
  console.error('usage: homeTourCli.mjs diagnose <jobDir> | plan <jobDir> <x> <y> <z>'); process.exitCode = 2;
}
