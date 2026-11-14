/**
 * Decide whether a persisted room ceiling still belongs to the current
 * canonical Room Registry. Saved designs are retained in project state, but
 * geometry generated from an older room-analysis fingerprint must not be
 * rendered over a newly reconstructed floor plan.
 */
export function validateCeilingAgainstRoomRegistry(design, registry) {
  if (!design?.id) return { valid: false, reason: 'missing-design-id' };
  if (!registry) return { valid: true, reason: 'room-registry-not-loaded' };
  if (!registry.sourceFingerprint || !Array.isArray(registry.rooms)) {
    return { valid: false, reason: 'invalid-room-registry' };
  }

  const designRoomIds = new Set(
    [design.roomId, design.navigationRoomId].filter(Boolean).map(String),
  );
  const room = registry.rooms.find((candidate) => (
    [candidate?.id, candidate?.navigationRoomId].some((id) => id && designRoomIds.has(String(id)))
  ));
  if (!room) return { valid: false, reason: 'room-not-in-current-registry' };

  if (!design.sourceModelFingerprint || design.sourceModelFingerprint !== registry.sourceFingerprint) {
    return { valid: false, reason: 'stale-room-boundary-fingerprint', roomId: room.id };
  }

  const roomValidation = room.validation || {};
  const designValidation = design.analysis?.validation || {};
  if (roomValidation.selfIntersection === true || designValidation.selfIntersection === true) {
    return { valid: false, reason: 'self-intersecting-boundary', roomId: room.id };
  }
  if (roomValidation.overlapsOtherRooms === true || designValidation.overlapsOtherRooms === true) {
    return { valid: false, reason: 'overlapping-room-boundary', roomId: room.id };
  }

  const boundary = design.boundary?.outer || design.polygon;
  const canonicalBoundary = room.geometry?.boundary?.outer || room.boundary?.outer;
  if (!Array.isArray(boundary) || boundary.length < 3 || !Array.isArray(canonicalBoundary) || canonicalBoundary.length < 3) {
    return { valid: false, reason: 'missing-room-boundary', roomId: room.id };
  }

  return { valid: true, reason: 'current-room-boundary', roomId: room.id };
}

/**
 * Return only ceiling designs that still correspond to the current room
 * registry. When analysis has not loaded yet, preserve legacy designs until
 * the canonical registry can make a safe decision.
 */
export function filterRenderableCeilingDesigns(designs, registry) {
  const items = Array.isArray(designs) ? designs : [];
  if (!registry) return items;
  return items.filter((design) => validateCeilingAgainstRoomRegistry(design, registry).valid);
}
