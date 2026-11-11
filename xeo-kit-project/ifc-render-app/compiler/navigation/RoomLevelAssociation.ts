/**
 * Associates semantic IfcSpace anchors with a physical floor level.
 *
 * IFC space placements are not guaranteed to share the elevation datum of the
 * walking surface. Some source models place all spaces at the building/storey
 * origin while the slab geometry is offset by slab thickness or project datum.
 * Spatial containment (IfcRelAggregates / IfcRelContainedInSpatialStructure)
 * therefore takes precedence over a raw placement-elevation comparison.
 */

export interface RoomLevelPoint {
  x: number;
  y: number;
}

export interface RoomLevelAnchor {
  key: string;
  label: string;
  x: number;
  y: number;
  elevationY?: number;
  storeyExpressId?: number | null;
  storeyName?: string | null;
  storeyElevation?: number | null;
}

export interface RoomLevelStorey {
  expressId: number;
  name: string;
  elevation: number | null;
}

export interface RoomLevelCandidate {
  elevationY: number;
}

export type RoomLevelAssociationMethod =
  | "ifc-spatial-storey-single-level"
  | "ifc-spatial-storey-ordinal"
  | "ifc-spatial-storey-elevation"
  | "single-level-plan-containment"
  | "anchor-elevation-fallback"
  | "none";

export interface RoomLevelAssociationResult<T extends RoomLevelAnchor> {
  anchors: T[];
  method: RoomLevelAssociationMethod;
  selectedStoreyExpressIds: number[];
  excludedCount: number;
  medianDatumOffsetMeters: number | null;
  warning: string | null;
}

const EPSILON = 1e-8;

function pointInPolygon(point: RoomLevelPoint, polygon: RoomLevelPoint[]): boolean {
  if (polygon.length < 3) return true;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const crosses = ((a.y > point.y) !== (b.y > point.y)) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point: RoomLevelPoint, a: RoomLevelPoint, b: RoomLevelPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared <= EPSILON ? 0 : Math.max(0, Math.min(1,
    ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
  ));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function distanceToPolygon(point: RoomLevelPoint, polygon: RoomLevelPoint[]): number {
  if (polygon.length < 3 || pointInPolygon(point, polygon)) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index++) {
    best = Math.min(best, distanceToSegment(point, polygon[index], polygon[(index + 1) % polygon.length]));
  }
  return best;
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function uniqueStoreyIds<T extends RoomLevelAnchor>(anchors: T[]): number[] {
  return Array.from(new Set(anchors
    .map((anchor) => Number(anchor.storeyExpressId))
    .filter((id) => Number.isSafeInteger(id) && id > 0)));
}

function compareStoreys(a: RoomLevelStorey, b: RoomLevelStorey): number {
  const ae = Number.isFinite(a.elevation) ? Number(a.elevation) : Number.POSITIVE_INFINITY;
  const be = Number.isFinite(b.elevation) ? Number(b.elevation) : Number.POSITIVE_INFINITY;
  return ae - be || a.expressId - b.expressId;
}

/**
 * Returns the semantic spaces that belong to one analysed floor level.
 *
 * - If the file has one analysed floor, its spatially-contained IfcSpaces are
 *   accepted even when their placement Z differs from the slab walking surface.
 * - If multiple levels exist and storey count matches level count, the ordered
 *   storey/level relationship is used (storey elevation datums may be offset).
 * - Otherwise, the closest storey elevation is used, with a conservative
 *   placement-elevation fallback for spaces lacking spatial relationships.
 */
export function associateRoomAnchorsWithFloorLevel<T extends RoomLevelAnchor>(options: {
  anchors: T[];
  storeys: RoomLevelStorey[];
  levels: RoomLevelCandidate[];
  selectedLevelIndex?: number;
  floorPolygon: RoomLevelPoint[];
  maxPlanDistanceMeters?: number;
}): RoomLevelAssociationResult<T> {
  const anchors = Array.isArray(options.anchors) ? options.anchors : [];
  const storeys = Array.isArray(options.storeys) ? options.storeys : [];
  const levels = Array.isArray(options.levels) ? options.levels : [];
  const selectedLevelIndex = Math.max(0, Math.min(levels.length - 1, Number(options.selectedLevelIndex) || 0));
  const level = levels[selectedLevelIndex];
  const floorPolygon = Array.isArray(options.floorPolygon) ? options.floorPolygon : [];
  const maxPlanDistance = Math.max(0, Number(options.maxPlanDistanceMeters ?? 0.75));
  const withinPlan = anchors.filter((anchor) =>
    Number.isFinite(anchor.x) && Number.isFinite(anchor.y) &&
    distanceToPolygon({ x: anchor.x, y: anchor.y }, floorPolygon) <= maxPlanDistance,
  );
  const idsOnPlan = uniqueStoreyIds(withinPlan);
  const storeyById = new Map(storeys.map((storey) => [storey.expressId, storey]));
  let selectedStoreyExpressIds: number[] = [];
  let method: RoomLevelAssociationMethod = "none";
  let selected: T[] = [];

  if (levels.length === 1) {
    if (idsOnPlan.length === 1) {
      selectedStoreyExpressIds = idsOnPlan;
      selected = withinPlan.filter((anchor) => (
        anchor.storeyExpressId == null || Number(anchor.storeyExpressId) === idsOnPlan[0]
      ));
      method = "ifc-spatial-storey-single-level";
    } else if (idsOnPlan.length > 1 && level) {
      const candidates = idsOnPlan
        .map((id) => storeyById.get(id))
        .filter((storey): storey is RoomLevelStorey => Boolean(storey));
      candidates.sort((a, b) => {
        const distanceA = Number.isFinite(a.elevation) ? Math.abs(Number(a.elevation) - level.elevationY) : Number.POSITIVE_INFINITY;
        const distanceB = Number.isFinite(b.elevation) ? Math.abs(Number(b.elevation) - level.elevationY) : Number.POSITIVE_INFINITY;
        return distanceA - distanceB || compareStoreys(a, b);
      });
      if (candidates.length) {
        selectedStoreyExpressIds = [candidates[0].expressId];
        selected = withinPlan.filter((anchor) => (
          Number(anchor.storeyExpressId) === candidates[0].expressId
          || (anchor.storeyExpressId == null && Number.isFinite(anchor.elevationY)
            && Number.isFinite(candidates[0].elevation)
            && Math.abs(Number(anchor.elevationY) - Number(candidates[0].elevation)) <= 0.45)
        ));
        method = "ifc-spatial-storey-elevation";
      }
    } else if (idsOnPlan.length === 0) {
      // No usable spatial relationship exists. A single floor is unambiguous;
      // plan containment is safer than discarding anchors on a different datum.
      selected = withinPlan;
      method = "single-level-plan-containment";
    }
  } else if (idsOnPlan.length && levels.length === storeys.length && storeys.length > 1) {
    const orderedStoreys = [...storeys].sort(compareStoreys);
    const targetStorey = orderedStoreys[selectedLevelIndex];
    if (targetStorey) {
      selectedStoreyExpressIds = [targetStorey.expressId];
      selected = withinPlan.filter((anchor) => (
        Number(anchor.storeyExpressId) === targetStorey.expressId
        || (anchor.storeyExpressId == null && Number.isFinite(anchor.elevationY)
          && Number.isFinite(targetStorey.elevation)
          && Math.abs(Number(anchor.elevationY) - Number(targetStorey.elevation)) <= 0.45)
      ));
      method = "ifc-spatial-storey-ordinal";
    }
  } else if (idsOnPlan.length && level) {
    const candidates = idsOnPlan
      .map((id) => storeyById.get(id))
      .filter((storey): storey is RoomLevelStorey => Boolean(storey));
    candidates.sort((a, b) => {
      const distanceA = Number.isFinite(a.elevation) ? Math.abs(Number(a.elevation) - level.elevationY) : Number.POSITIVE_INFINITY;
      const distanceB = Number.isFinite(b.elevation) ? Math.abs(Number(b.elevation) - level.elevationY) : Number.POSITIVE_INFINITY;
      return distanceA - distanceB || compareStoreys(a, b);
    });
    if (candidates.length) {
      selectedStoreyExpressIds = [candidates[0].expressId];
      selected = withinPlan.filter((anchor) => (
        Number(anchor.storeyExpressId) === candidates[0].expressId
        || (anchor.storeyExpressId == null && Number.isFinite(anchor.elevationY)
          && Number.isFinite(candidates[0].elevation)
          && Math.abs(Number(anchor.elevationY) - Number(candidates[0].elevation)) <= 0.45)
      ));
      method = "ifc-spatial-storey-elevation";
    }
  }

  if (!selected.length && levels.length > 1 && level) {
    // Only use placement elevation for spaces that could not be associated via
    // IFC spatial containment. Avoid using this branch when a relationship was
    // successfully resolved for the current floor.
    const tolerance = 0.45;
    selected = withinPlan.filter((anchor) =>
      Number.isFinite(anchor.elevationY) && Math.abs(Number(anchor.elevationY) - level.elevationY) <= tolerance,
    );
    if (selected.length) method = "anchor-elevation-fallback";
  }

  const offsets = selected
    .map((anchor) => Number.isFinite(anchor.elevationY) && level
      ? level.elevationY - Number(anchor.elevationY)
      : Number.NaN)
    .filter(Number.isFinite);
  const medianDatumOffsetMeters = median(offsets);
  const excludedCount = Math.max(0, anchors.length - selected.length);
  let warning: string | null = null;
  if (!selected.length) {
    warning = `No IfcSpace anchors could be associated with floor level ${selectedLevelIndex + 1}. Checked ${anchors.length} semantic spaces, ${idsOnPlan.length} storey associations and ${withinPlan.length} plan-contained anchors.`;
  } else if (medianDatumOffsetMeters != null && Math.abs(medianDatumOffsetMeters) > 0.45 && method.startsWith("ifc-spatial-storey")) {
    warning = `IfcSpace placements use a different vertical datum from the slab walking surface (${medianDatumOffsetMeters.toFixed(3)} m offset). ${selected.length} room anchors were correctly associated through IFC storey relationships.`;
  }

  return {
    anchors: selected,
    method,
    selectedStoreyExpressIds,
    excludedCount,
    medianDatumOffsetMeters,
    warning,
  };
}
