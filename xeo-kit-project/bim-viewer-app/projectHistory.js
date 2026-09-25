/**
 * HCI Project History helpers.
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
