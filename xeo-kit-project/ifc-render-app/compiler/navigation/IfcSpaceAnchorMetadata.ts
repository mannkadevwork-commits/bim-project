/**
 * Parses explicitly authored IfcSpace safe-camera-centre metadata.
 *
 * Some IFC producers serialize IfcSpace ObjectPlacement at the project origin
 * while retaining the intended plan-space anchor in Description. We only use
 * this fallback when the description contains the exact, unit-qualified
 * `safe camera center (x, y) m` marker. Values are already metres in source
 * IFC X/Y; the caller is responsible for the single IFC Z-up -> viewer X/-Z
 * conversion.
 */
export interface IfcSpaceSafeCameraCenter {
  sourceX: number;
  sourceY: number;
  sourceUnit: "m";
}

const SAFE_CAMERA_CENTER_RE = /\bsafe\s+camera\s+center\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*(m|metres?|meters?)\b/i;

export function parseIfcSpaceSafeCameraCenter(description: unknown): IfcSpaceSafeCameraCenter | null {
  if (typeof description !== "string" || !description.trim()) return null;
  const match = description.match(SAFE_CAMERA_CENTER_RE);
  if (!match) return null;
  const sourceX = Number(match[1]);
  const sourceY = Number(match[2]);
  if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY)) return null;
  // Reject clearly corrupt metadata rather than snapping an unbounded point
  // across the floor. The job-level floor footprint is normally much smaller.
  if (Math.abs(sourceX) > 10000 || Math.abs(sourceY) > 10000) return null;
  return { sourceX, sourceY, sourceUnit: "m" };
}
