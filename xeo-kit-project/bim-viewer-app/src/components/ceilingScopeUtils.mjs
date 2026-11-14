/**
 * Immutable helpers for applying generated ceilings at room/floor scope.
 * Each target is built independently from its own room boundary and identity.
 */
export function roomIdentityKeys(room) {
  return new Set([room?.id, room?.navigationRoomId].filter(Boolean).map(String));
}

function ceilingMatchesAnyRoom(ceiling, rooms) {
  const ceilingKeys = new Set([ceiling?.roomId, ceiling?.navigationRoomId].filter(Boolean).map(String));
  if (!ceilingKeys.size) return false;
  return rooms.some((room) => {
    const keys = roomIdentityKeys(room);
    return [...keys].some((key) => ceilingKeys.has(key));
  });
}

export function mergeRoomScopedCeilings(existingCeilings, targetRooms, buildDesign) {
  const existing = Array.isArray(existingCeilings) ? existingCeilings : [];
  const rooms = Array.isArray(targetRooms) ? targetRooms.filter(Boolean) : [];
  if (!rooms.length) throw new Error('Choose at least one room before applying a ceiling.');
  if (typeof buildDesign !== 'function') throw new TypeError('A room-specific ceiling builder is required.');

  const targetIds = new Set();
  for (const room of rooms) {
    const key = String(room.id || room.navigationRoomId || '');
    if (!key) throw new Error('A target room is missing its stable identity.');
    if (targetIds.has(key)) throw new Error(`Duplicate ceiling target detected for ${key}.`);
    targetIds.add(key);
  }

  // Build every target before returning any update. If one boundary is invalid,
  // the caller receives an error and the existing project state remains intact.
  const created = rooms.map((room) => {
    const design = buildDesign(room);
    if (!design?.id || !design?.roomId) {
      throw new Error(`The ceiling builder returned an invalid design for ${room.label || room.id}.`);
    }
    return { ...design, visible: true };
  });

  const designIds = created.map((design) => String(design.id));
  if (new Set(designIds).size !== designIds.length) {
    throw new Error('The generated ceilings do not have unique IDs. No changes were applied.');
  }

  const retained = existing.filter((ceiling) => !ceilingMatchesAnyRoom(ceiling, rooms));
  return {
    ceilings: [...retained, ...created],
    created,
  };
}
