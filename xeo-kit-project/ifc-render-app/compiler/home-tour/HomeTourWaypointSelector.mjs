import { finitePoint, horizontalDistance } from './HomeTourGeometry.mjs';

const PRESENTATION_ROLES = new Set(['room-center', 'viewpoint']);
const FALLBACK_ROLES = new Set(['walkpoint', 'transition']);
const ROLE_SCORE = { 'room-center': 1.0, viewpoint: 0.85, walkpoint: 0.3, transition: 0.1, 'area-center': 0.9 };

function roleOf(h) {
  const explicit = String(h?.presentationRole || h?.role || '').trim();
  if (explicit === 'room-entrance' || /entr(y|ance)/i.test(String(h?.label || '')) && !explicit) return 'room-entrance';
  if (PRESENTATION_ROLES.has(explicit) || FALLBACK_ROLES.has(explicit)) return explicit;
  return 'walkpoint';
}

/**
 * Normalise the tour zones. Navigation areas from walk_hotspots.json are the
 * ONLY source of zone identity/count. Architectural rooms are optional labels.
 */
export function buildTourZones({ areas, roomLabels = null }) {
  const zones = [];
  const seen = new Set();
  for (const area of Array.isArray(areas) ? areas : []) {
    const center = finitePoint(area?.center);
    const id = area?.id == null ? null : String(area.id);
    if (!id || !center || seen.has(id)) continue;
    seen.add(id);
    const roomLabel = roomLabels?.get?.(id) || null;
    zones.push({
      id,
      label: String(roomLabel || area.label || area.name || id),
      // A label is only "semantic" when trustworthy room evidence supplied it.
      labelSource: roomLabel ? 'architectural-room' : 'navigation-zone',
      center,
    });
  }
  return zones.sort((a, b) => a.id.localeCompare(b.id)); // deterministic
}

/**
 * Select ranked, validated presentation candidates for each zone.
 * Never trusts a centre/hotspot until it is snapped to the NavMesh, has clearance
 * above the safety threshold, and sits inside the zone's catchment.
 */
export function selectZoneCandidates({ zones, hotspots, nav, metersPerUnit, config }) {
  const unit = Math.max(Number(metersPerUnit) || 1, 1e-9);
  const byZone = new Map(zones.map((z) => [z.id, { candidates: [], entrances: [], rejected: [] }]));
  const zoneIds = new Set(zones.map((z) => z.id));

  const attach = (hotspot, pos) => {
    if (hotspot.areaId != null && zoneIds.has(String(hotspot.areaId))) return String(hotspot.areaId);
    let best = null; let bestD = Infinity;
    for (const z of zones) {
      const d = horizontalDistance(z.center, pos) * unit;
      if (d < bestD) { bestD = d; best = z; }
    }
    return best && bestD <= config.maxHotspotToZoneMeters ? best.id : null;
  };

  const raw = [];
  for (const z of zones) raw.push({ zoneId: z.id, id: `${z.id}:center`, source: 'area-center', role: 'area-center', raw: z.center, label: z.label });
  for (const [i, h] of (Array.isArray(hotspots) ? hotspots : []).entries()) {
    const pos = finitePoint(h?.position);
    const id = String(h?.id ?? `hotspot-${i + 1}`);
    if (!pos) continue;
    const zoneId = attach(h, pos);
    if (!zoneId) continue;
    raw.push({ zoneId, id, source: 'hotspot', role: roleOf(h), raw: pos, label: h?.label || id });
  }

  for (const c of raw) {
    const bucket = byZone.get(c.zoneId);
    const zone = zones.find((z) => z.id === c.zoneId);
    if (c.role === 'room-entrance') { // keep entrances strictly separate from presentation stops
      const s = nav.snap(c.raw, { horizontalMeters: config.maxSnapHorizontalMeters, verticalMeters: config.maxSnapVerticalMeters });
      bucket.entrances.push({ id: c.id, label: c.label, position: s ? s.point : c.raw, onNavMesh: Boolean(s) });
      continue;
    }
    const snapped = nav.snap(c.raw, { horizontalMeters: config.maxSnapHorizontalMeters, verticalMeters: config.maxSnapVerticalMeters });
    if (!snapped) { bucket.rejected.push({ id: c.id, source: c.source, reason: 'OUTSIDE_NAVIGABLE_SURFACE' }); continue; }
    const profile = nav.clearanceProfile(snapped.point, snapped.polyRef, { rays: config.clearanceRayCount, lengthMeters: config.clearanceRayLengthMeters });
    if (profile.minMeters < config.minStopClearanceMeters) {
      bucket.rejected.push({ id: c.id, source: c.source, reason: 'INSUFFICIENT_WALL_CLEARANCE', clearanceMeters: round(profile.minMeters) });
      continue;
    }
    const centrality = Math.max(0, 1 - (horizontalDistance(zone.center, snapped.point) * unit) / Math.max(config.maxHotspotToZoneMeters, 1e-6));
    const w = config.weights;
    const score = w.clearance * Math.min(profile.minMeters, config.preferredStopClearanceMeters)
      + w.openness * Math.min(profile.meanMeters, config.clearanceRayLengthMeters) / 2
      + w.role * (ROLE_SCORE[c.role] ?? 0)
      + w.centrality * centrality;
    bucket.candidates.push({
      id: c.id, zoneId: c.zoneId, source: c.source, role: c.role, label: c.label,
      position: snapped.point, polyRef: snapped.polyRef,
      clearanceMeters: round(profile.minMeters), opennessMeters: round(profile.meanMeters), score: Number(score.toFixed(6)),
    });
  }

  for (const bucket of byZone.values()) {
    // Higher score first; ties broken by id so ordering is fully deterministic.
    bucket.candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    // Collapse near-duplicates (same spot published twice) to keep retries meaningful.
    const kept = [];
    for (const c of bucket.candidates) {
      if (!kept.some((k) => horizontalDistance(k.position, c.position) * unit < 0.25)) kept.push(c);
    }
    bucket.candidates = kept.slice(0, config.maxCandidatesPerZone);
  }
  return byZone;
}

const round = (v) => Number(v.toFixed(3));
