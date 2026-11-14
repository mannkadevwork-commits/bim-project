/**
 * Home Tour planner configuration.
 *
 * All distances are PHYSICAL METRES. Scene units are converted with
 * `metersPerUnit` (navigation_surface.json -> metadata.physicalMetersPerUnit).
 * HCI is Y-up; X/Z is the horizontal plane.
 */
export const HOME_TOUR_PLANNER_VERSION = 'home-tour-planner/2.0.0';
export const HOME_TOUR_ROUTE_SCHEMA_VERSION = 2;

export const DEFAULT_HOME_TOUR_CONFIG = Object.freeze({
  // --- destination selection -------------------------------------------------
  /** Hard floor: a camera stop closer than this to a NavMesh boundary is rejected. */
  minStopClearanceMeters: 0.35,
  /** Clearance beyond this earns no extra score (we want "roomy", not "absurd"). */
  preferredStopClearanceMeters: 1.2,
  /** Max horizontal distance a candidate may be snapped onto the NavMesh. */
  maxSnapHorizontalMeters: 0.75,
  /** Max vertical distance a candidate may be snapped onto the NavMesh. */
  maxSnapVerticalMeters: 0.35,
  /** Hotspot without areaId is attached to the nearest zone within this radius. */
  maxHotspotToZoneMeters: 7.0,
  /** Radial rays used to estimate clearance and openness (even number). */
  clearanceRayCount: 16,
  clearanceRayLengthMeters: 6.0,
  /** Score weights. */
  weights: Object.freeze({ clearance: 3.0, openness: 1.2, role: 1.0, centrality: 0.6 }),

  // --- path validation -------------------------------------------------------
  /** Spacing of validation samples along every leg. */
  sampleStepMeters: 0.1,
  /** A sample may be at most this far (horizontal) from the NavMesh surface. */
  maxOffMeshHorizontalMeters: 0.06,
  /** Max floor-height change between consecutive samples (stairs/ramps ok, cliffs not). */
  maxFloorStepMeters: 0.25,
  /** Terminal point of a computed path must reach the snapped target within this. */
  maxPathEndGapMeters: 0.08,
  /** Camera/body collision capsule. `null` radius => 0.9 * agent radius (min 0.08). */
  cameraRadiusMeters: null,
  /** Body capsule bottom (ignores kerbs/thresholds below this height). */
  bodyBottomMeters: 0.3,
  /** Eye height used for headroom + collision checks (visual camera height). */
  eyeHeightMeters: 1.55,
  /** Extra clearance above the eye for the head. */
  headroomMeters: 0.12,
  /** Collision-geometry nodes whose names match are ignored (doors are hidden during tour). */
  ignoredCollisionNodePattern: '(^|[^a-z])door([^a-z]|$)',

  // --- optimisation ------------------------------------------------------------
  /** Exact Held-Karp is used up to this many zones; above it a deterministic heuristic is used. */
  maxExactZones: 12,
  /** Candidate retries per zone before the zone is declared unreachable. */
  maxCandidatesPerZone: 6,
  maxRepairRounds: 24,
});

export function resolveHomeTourConfig(overrides = {}) {
  const merged = { ...DEFAULT_HOME_TOUR_CONFIG, ...overrides };
  merged.weights = { ...DEFAULT_HOME_TOUR_CONFIG.weights, ...(overrides.weights || {}) };
  return Object.freeze(merged);
}
