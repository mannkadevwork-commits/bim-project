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
  scene_calibration: { scaleFactor: { x: 1, y: 1, z: 1 } },
});
