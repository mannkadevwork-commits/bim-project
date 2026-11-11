/**
 * HCI Project History helpers.
 *
 * History is intentionally kept in-memory for the active editor session. The
 * authored project itself remains persisted through the existing project sync
 * pipeline, while history stays bounded so large BIM states never balloon
 * localStorage or the server payload.
 */
export const HISTORY_LIMIT = 60;
export const HISTORY_COALESCE_MS = 650;

export const cloneProjectState = (value) => {
  if (value == null) return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch {}
  }
  return JSON.parse(JSON.stringify(value));
};

export const projectStatesEqual = (a, b) => {
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
};

export const createInitialProjectState = () => ({
  materials: {},
  furniture: [],
  structural_edits: {},
  ceiling_hidden_entity_ids: [],
  ceilingDesigns: [],
  ceilings: [],
  roomProperties: {},
  // Versioned coordinate-frame metadata. Identity is the safe default;
  // legacy scene_calibration remains readable during migration.
  sceneFrame: {
    schemaVersion: 1,
    revision: 0,
    modelToScene: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    geometryScaleAppliedToIfc: false,
    sourceLengthUnit: 'unknown',
  },
  scene_calibration: { scaleFactor: { x: 1, y: 1, z: 1 } },
});
