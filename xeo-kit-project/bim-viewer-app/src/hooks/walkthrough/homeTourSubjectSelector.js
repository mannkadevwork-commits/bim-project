// Decide which furniture/subjects the camera may showcase for ONE tour zone.
// A subject is accepted only with valid spatial AND visibility association.
// Pure logic: line-of-sight is injected (the runtime passes a raycast against output.glb).

/**
 * @param subjects   [{ id, position:[x,y,z] }]
 * @param zones      [{ id, anchors:[[x,y,z],...] }]  anchors = validated stop + zone centre + hotspots
 * @param zoneId     the zone being presented
 * @param eye        [x,y,z] camera position at the stop (eye height applied)
 * @param hasLineOfSight (eye, subjectPosition) => boolean
 */
export function selectZoneSubjects({ subjects, zones, zoneId, eye, hasLineOfSight, metersPerUnit = 1, maxRadiusMeters = 6.5, ownershipMarginMeters = 0.5 }) {
  const unit = Math.max(metersPerUnit, 1e-9);
  const accepted = []; const rejected = [];
  const rank = (pos) => zones
    .map((z) => ({ id: z.id, d: Math.min(...z.anchors.map((a) => Math.hypot(a[0] - pos[0], a[2] - pos[2]))) * unit }))
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id));
  for (const s of subjects || []) {
    if (!s?.id || !Array.isArray(s.position) || s.position.length < 3) { rejected.push({ id: s?.id ?? null, reason: 'INVALID_SUBJECT' }); continue; }
    const ranked = rank(s.position);
    const own = ranked.find((r) => r.id === zoneId);
    if (!own) { rejected.push({ id: s.id, reason: 'UNKNOWN_ZONE' }); continue; }
    if (own.d > maxRadiusMeters) { rejected.push({ id: s.id, reason: 'TOO_FAR_FROM_ZONE' }); continue; }
    if (ranked[0].id !== zoneId) { rejected.push({ id: s.id, reason: 'BELONGS_TO_NEIGHBOUR_ZONE', owner: ranked[0].id }); continue; }
    const second = ranked[1];
    const contested = Boolean(second && second.d - own.d < ownershipMarginMeters);
    const visible = typeof hasLineOfSight === 'function' ? Boolean(hasLineOfSight(eye, s.position)) : false;
    if (!visible) { rejected.push({ id: s.id, reason: contested ? 'CONTESTED_AND_NOT_VISIBLE' : 'NO_LINE_OF_SIGHT' }); continue; }
    accepted.push({ id: s.id, distanceMeters: Number(own.d.toFixed(3)), contested });
  }
  accepted.sort((a, b) => a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id));
  return { accepted, rejected };
}
