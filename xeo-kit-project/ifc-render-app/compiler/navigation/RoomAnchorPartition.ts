export interface RoomAnchorSeed {
  key: string;
  label: string;
  x: number;
  y: number;
  globalId?: string | null;
  expressId?: number;
  elevationY?: number;
  description?: string;
  hasGeometryRepresentation?: boolean;
}

export interface RoomAnchorGrid {
  minX: number;
  minY: number;
  cellSize: number;
  width: number;
  height: number;
  floor: Uint8Array;
  blocked: Uint8Array;
  room: Int32Array;
}

export interface RoomAnchorComponent {
  id: number;
  cells: number[];
  area: number;
  minI: number;
  maxI: number;
  minJ: number;
  maxJ: number;
  touchesBoundary: boolean;
}

export interface ResolvedRoomAnchor extends RoomAnchorSeed {
  snappedX: number;
  snappedY: number;
  snapDistanceMeters: number;
}

export interface RoomAnchorPartitionResult {
  components: RoomAnchorComponent[];
  anchorByComponent: Map<number, ResolvedRoomAnchor>;
  resolvedAnchors: ResolvedRoomAnchor[];
  warnings: string[];
  coverageRatio: number;
}

const MAX_DISTANCE = 0x7fffffff;

function nearestWalkableCell(
  grid: RoomAnchorGrid,
  anchor: RoomAnchorSeed,
  maxSnapDistance: number,
): { index: number; x: number; y: number; distance: number } | null {
  const ci = Math.floor((anchor.x - grid.minX) / grid.cellSize);
  const cj = Math.floor((anchor.y - grid.minY) / grid.cellSize);
  const radius = Math.ceil(maxSnapDistance / grid.cellSize);
  let best: { index: number; x: number; y: number; distance: number } | null = null;

  for (let j = Math.max(0, cj - radius); j <= Math.min(grid.height - 1, cj + radius); j++) {
    for (let i = Math.max(0, ci - radius); i <= Math.min(grid.width - 1, ci + radius); i++) {
      const index = j * grid.width + i;
      if (grid.floor[index] === 0 || grid.blocked[index] !== 0) continue;
      const x = grid.minX + (i + 0.5) * grid.cellSize;
      const y = grid.minY + (j + 0.5) * grid.cellSize;
      const distance = Math.hypot(x - anchor.x, y - anchor.y);
      if (distance > maxSnapDistance) continue;
      if (!best || distance < best.distance) best = { index, x, y, distance };
    }
  }
  return best;
}

/**
 * Split a connected floor raster into room regions using semantic IfcSpace
 * placement anchors. Walls remain hard barriers; open doorways are traversable,
 * so the equal-cost boundary falls through the doorway rather than merging the
 * entire apartment into one room.
 *
 * This is an inferred boundary, not a replacement for explicit IfcSpace solids
 * or IfcRelSpaceBoundary geometry. Callers must surface its confidence and
 * ask for visual review before authoring a permanent ceiling.
 */
export function partitionFloorByRoomAnchors(
  grid: RoomAnchorGrid,
  sourceAnchors: RoomAnchorSeed[],
  options: { maxSnapDistance?: number; minRoomArea?: number } = {},
): RoomAnchorPartitionResult | null {
  const maxSnapDistance = Math.max(0.25, Math.min(5, Number(options.maxSnapDistance) || 1.5));
  const minRoomArea = Math.max(0.1, Number(options.minRoomArea) || 0.75);
  const warnings: string[] = [];

  const anchors = [...sourceAnchors]
    .filter((anchor) =>
      anchor &&
      Number.isFinite(anchor.x) &&
      Number.isFinite(anchor.y) &&
      String(anchor.label || "").trim().length > 0,
    )
    .sort((a, b) => (Number(a.expressId) || 0) - (Number(b.expressId) || 0) || String(a.key).localeCompare(String(b.key)));

  if (anchors.length < 2) return null;

  const resolved: ResolvedRoomAnchor[] = [];
  const occupiedSeeds = new Set<number>();
  for (const anchor of anchors) {
    const snapped = nearestWalkableCell(grid, anchor, maxSnapDistance);
    if (!snapped) {
      warnings.push(`IFC space "${anchor.label}" could not be placed inside the floor walkable area within ${maxSnapDistance.toFixed(2)} m and was not used for room segmentation.`);
      continue;
    }
    if (occupiedSeeds.has(snapped.index)) {
      warnings.push(`IFC spaces near "${anchor.label}" resolve to the same floor cell. The duplicate anchor was skipped to avoid overlapping room identities.`);
      continue;
    }
    occupiedSeeds.add(snapped.index);
    resolved.push({
      ...anchor,
      snappedX: snapped.x,
      snappedY: snapped.y,
      snapDistanceMeters: snapped.distance,
    });
  }

  if (resolved.length < 2) {
    warnings.push("Fewer than two usable IFC space anchors were found on this floor; the wall-topology room detector was used instead.");
    return null;
  }

  const cellCount = grid.floor.length;
  const owner = new Int32Array(cellCount);
  owner.fill(-1);
  const distance = new Int32Array(cellCount);
  distance.fill(MAX_DISTANCE);
  const queue = new Int32Array(cellCount);
  let head = 0;
  let tail = 0;

  // All source seeds enter the queue before expansion. Sorted semantic keys
  // make equal-distance tie-breaking deterministic across runs.
  resolved.forEach((anchor, anchorIndex) => {
    const i = Math.floor((anchor.snappedX - grid.minX) / grid.cellSize);
    const j = Math.floor((anchor.snappedY - grid.minY) / grid.cellSize);
    const index = j * grid.width + i;
    owner[index] = anchorIndex;
    distance[index] = 0;
    queue[tail++] = index;
  });

  let totalWalkableCells = 0;
  for (let index = 0; index < cellCount; index++) {
    if (grid.floor[index] !== 0 && grid.blocked[index] === 0) totalWalkableCells++;
  }

  while (head < tail) {
    const index = queue[head++];
    const currentDistance = distance[index] + 1;
    const i = index % grid.width;
    const j = Math.floor(index / grid.width);
    const neighbours = [
      i > 0 ? index - 1 : -1,
      i + 1 < grid.width ? index + 1 : -1,
      j > 0 ? index - grid.width : -1,
      j + 1 < grid.height ? index + grid.width : -1,
    ];
    for (const next of neighbours) {
      if (next < 0 || grid.floor[next] === 0 || grid.blocked[next] !== 0) continue;
      if (distance[next] <= currentDistance) continue;
      distance[next] = currentDistance;
      owner[next] = owner[index];
      queue[tail++] = next;
    }
  }

  const cellsByAnchor = resolved.map(() => [] as number[]);
  let assignedCells = 0;
  for (let index = 0; index < owner.length; index++) {
    const anchorIndex = owner[index];
    if (anchorIndex < 0) continue;
    cellsByAnchor[anchorIndex].push(index);
    assignedCells++;
  }

  const components: RoomAnchorComponent[] = [];
  const anchorByComponent = new Map<number, ResolvedRoomAnchor>();

  for (let anchorIndex = 0; anchorIndex < resolved.length; anchorIndex++) {
    const cells = cellsByAnchor[anchorIndex];
    const area = cells.length * grid.cellSize * grid.cellSize;
    if (area < minRoomArea) {
      warnings.push(`IFC space "${resolved[anchorIndex].label}" produced only ${area.toFixed(2)} m² of walkable floor and was omitted from the ceiling room list.`);
      continue;
    }

    const id = components.length;
    let minI = grid.width;
    let maxI = 0;
    let minJ = grid.height;
    let maxJ = 0;
    let touchesBoundary = false;
    for (const index of cells) {
      const i = index % grid.width;
      const j = Math.floor(index / grid.width);
      minI = Math.min(minI, i);
      maxI = Math.max(maxI, i);
      minJ = Math.min(minJ, j);
      maxJ = Math.max(maxJ, j);
      touchesBoundary ||= i === 0 || j === 0 || i === grid.width - 1 || j === grid.height - 1;
    }

    components.push({ id, cells, area, minI, maxI, minJ, maxJ, touchesBoundary });
    anchorByComponent.set(id, resolved[anchorIndex]);
  }

  // Only mutate the caller's component labels after confirming that a meaningful
  // multi-room partition exists. A failed partition must leave the legacy
  // wall-topology grid untouched for its fallback path.
  if (components.length < 2) return null;
  grid.room.fill(-1);
  for (const component of components) {
    for (const index of component.cells) grid.room[index] = component.id;
  }

  const coverageRatio = totalWalkableCells > 0 ? assignedCells / totalWalkableCells : 0;
  if (coverageRatio < 0.95) {
    warnings.push(`IFC space anchors cover ${(coverageRatio * 100).toFixed(1)}% of walkable floor cells. Unassigned floor islands will be reported separately where large enough.`);
  }
  warnings.push(`Room boundaries were inferred from ${components.length} IFC space placement anchor(s) using wall-constrained geodesic partitioning. These are approximate boundaries because this IFC does not provide explicit IfcSpace geometry; review each room preview before applying ceilings.`);

  return { components, anchorByComponent, resolvedAnchors: resolved, warnings, coverageRatio };
}
