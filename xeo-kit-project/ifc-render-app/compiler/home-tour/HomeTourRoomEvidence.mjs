/**
 * Decide whether reconstructed architectural rooms are trustworthy enough to supply
 * LABELS. They never supply zone identity or count. Fails closed.
 */
export function assessRoomEvidence(rooms, zoneIds) {
  const list = Array.isArray(rooms) ? rooms.filter((r) => r?.id) : [];
  const reasons = [];
  const minRooms = Math.max(2, Math.ceil(zoneIds.length / 2));
  if (list.length < minRooms) reasons.push(`ONLY_${list.length}_ROOMS_FOR_${zoneIds.length}_ZONES`);
  const areas = list.map((r) => Number(r.areaSquareMeters ?? r.areaM2 ?? r.area)).filter(Number.isFinite);
  const total = areas.reduce((s, a) => s + a, 0);
  if (areas.length && total > 0 && Math.max(...areas) / total > 0.6 && list.length > 1) reasons.push('ONE_ROOM_DOMINATES_FOOTPRINT');
  if (areas.length === 1 && zoneIds.length > 1) reasons.push('SINGLE_ROOM_COVERS_MULTIPLE_ZONES');
  const trusted = reasons.length === 0;
  const labels = new Map();
  if (trusted) {
    const ids = new Set(zoneIds);
    for (const r of list) if (ids.has(String(r.id)) && (r.label || r.name)) labels.set(String(r.id), String(r.label || r.name));
  }
  return { trusted, reasons, labels };
}
