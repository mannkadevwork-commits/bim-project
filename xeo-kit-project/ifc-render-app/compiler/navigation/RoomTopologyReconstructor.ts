/**
 * Architectural room-topology reconstruction.
 *
 * Strategy:
 *  1. Extract walkable floor cells and structural wall masks from the IFC.
 *  2. Seal known door openings only for room-face segmentation (not navigation).
 *  3. Find physically disconnected floor faces using 4-neighbour connectivity.
 *  4. Associate IfcSpace anchors with those physical faces.
 *  5. Where several semantic spaces share one genuinely open-plan face,
 *     subdivide only that face using a constrained geodesic partition.
 *  6. Never assign a disconnected/unanchored floor island to the nearest room.
 *
 * This intentionally separates architectural room identity from navigation
 * connectivity: a doorway joins walkable rooms, but it must not merge their
 * room identities.
 */

import {
  gridCellCenter,
  pointInPlanPolygon,
  polygonArea,
  resolveRoomSeeds,
  traceRegionLoops,
  wallBoundaryRatio,
  type ResolvedRoomSeed,
  type RoomFloorGrid,
  type RoomFootprintAnchor,
  type RoomPlanPoint,
  type ReconstructedRoomFootprint,
  type RoomFootprintReconstructionResult,
} from "./RoomFootprintReconstructor";

interface FloorComponent {
  id: number;
  cells: number[];
}

interface HeapEntry {
  index: number;
  owner: number;
  distance: number;
}

class MinHeap {
  private entries: HeapEntry[] = [];

  get length(): number { return this.entries.length; }

  push(entry: HeapEntry): void {
    const entries = this.entries;
    entries.push(entry);
    let index = entries.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (entries[parent].distance <= entry.distance) break;
      entries[index] = entries[parent];
      index = parent;
    }
    entries[index] = entry;
  }

  pop(): HeapEntry | null {
    const entries = this.entries;
    if (!entries.length) return null;
    const root = entries[0];
    const last = entries.pop()!;
    if (entries.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= entries.length) break;
        const child = right < entries.length && entries[right].distance < entries[left].distance ? right : left;
        if (entries[child].distance >= last.distance) break;
        entries[index] = entries[child];
        index = child;
      }
      entries[index] = last;
    }
    return root;
  }
}

function collectPhysicalFloorComponents(grid: RoomFloorGrid): {
  components: FloorComponent[];
  componentByCell: Int32Array;
  totalWalkableCells: number;
} {
  const cellCount = grid.width * grid.height;
  const componentByCell = new Int32Array(cellCount);
  componentByCell.fill(-1);
  const queue = new Int32Array(cellCount);
  const components: FloorComponent[] = [];
  let totalWalkableCells = 0;

  const isWalkable = (index: number) => grid.floor[index] !== 0 && grid.blocked[index] === 0;
  for (let index = 0; index < cellCount; index++) {
    if (!isWalkable(index)) continue;
    totalWalkableCells++;
    if (componentByCell[index] >= 0) continue;

    const componentId = components.length;
    const cells: number[] = [];
    let head = 0;
    let tail = 0;
    queue[tail++] = index;
    componentByCell[index] = componentId;

    while (head < tail) {
      const current = queue[head++];
      cells.push(current);
      const i = current % grid.width;
      const j = Math.floor(current / grid.width);
      const neighbours = [
        i > 0 ? current - 1 : -1,
        i + 1 < grid.width ? current + 1 : -1,
        j > 0 ? current - grid.width : -1,
        j + 1 < grid.height ? current + grid.width : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || componentByCell[next] >= 0 || !isWalkable(next)) continue;
        componentByCell[next] = componentId;
        queue[tail++] = next;
      }
    }

    components.push({ id: componentId, cells });
  }

  return { components, componentByCell, totalWalkableCells };
}

function partitionOpenComponent(
  grid: RoomFloorGrid,
  component: FloorComponent,
  seeds: Array<{ seedIndex: number; seedOwner: number }>,
  componentByCell: Int32Array,
): Map<number, number[]> {
  const owner = new Int32Array(grid.floor.length);
  owner.fill(-1);
  const distances = new Float64Array(grid.floor.length);
  distances.fill(Number.POSITIVE_INFINITY);
  const heap = new MinHeap();

  for (const seed of seeds) {
    if (componentByCell[seed.seedIndex] !== component.id) continue;
    owner[seed.seedIndex] = seed.seedOwner;
    distances[seed.seedIndex] = 0;
    heap.push({ index: seed.seedIndex, owner: seed.seedOwner, distance: 0 });
  }

  // Eight-neighbour distance is less axis-biased than Manhattan distance.
  // Diagonal transitions are allowed only when both orthogonal side cells
  // are walkable and belong to the same physical component.
  const neighbours = [
    { dx: 0, dy: -1, cost: 1 },
    { dx: 1, dy: 0, cost: 1 },
    { dx: 0, dy: 1, cost: 1 },
    { dx: -1, dy: 0, cost: 1 },
    { dx: 1, dy: -1, cost: Math.SQRT2 },
    { dx: 1, dy: 1, cost: Math.SQRT2 },
    { dx: -1, dy: 1, cost: Math.SQRT2 },
    { dx: -1, dy: -1, cost: Math.SQRT2 },
  ];

  while (heap.length) {
    const current = heap.pop();
    if (!current) break;
    if (current.distance > distances[current.index] + 1e-9) continue;
    if (owner[current.index] !== current.owner) continue;

    const i = current.index % grid.width;
    const j = Math.floor(current.index / grid.width);
    for (const direction of neighbours) {
      const ni = i + direction.dx;
      const nj = j + direction.dy;
      if (ni < 0 || nj < 0 || ni >= grid.width || nj >= grid.height) continue;
      const next = nj * grid.width + ni;
      if (componentByCell[next] !== component.id) continue;

      if (direction.dx !== 0 && direction.dy !== 0) {
        const horizontal = j * grid.width + ni;
        const vertical = nj * grid.width + i;
        if (
          componentByCell[horizontal] !== component.id ||
          componentByCell[vertical] !== component.id
        ) continue;
      }

      const nextDistance = current.distance + direction.cost * grid.cellSize;
      if (nextDistance + 1e-9 >= distances[next]) continue;
      distances[next] = nextDistance;
      owner[next] = current.owner;
      heap.push({ index: next, owner: current.owner, distance: nextDistance });
    }
  }

  const cellsBySeed = new Map<number, number[]>();
  for (const seed of seeds) cellsBySeed.set(seed.seedOwner, []);
  for (const cell of component.cells) {
    const seedOwner = owner[cell];
    if (seedOwner < 0) continue;
    cellsBySeed.get(seedOwner)?.push(cell);
  }
  return cellsBySeed;
}

function polygonCentroid(polygon: RoomPlanPoint[]): RoomPlanPoint {
  if (!polygon.length) return { x: 0, y: 0 };
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  if (Math.abs(twiceArea) < 1e-8) {
    return polygon.reduce((sum, point) => ({
      x: sum.x + point.x / polygon.length,
      y: sum.y + point.y / polygon.length,
    }), { x: 0, y: 0 });
  }
  return { x: x / (3 * twiceArea), y: y / (3 * twiceArea) };
}

export interface WallTopologyReconstructionOptions {
  floorPolygon: RoomPlanPoint[];
  anchors: RoomFootprintAnchor[];
  grid: RoomFloorGrid;
  explicitSpacePolygons?: Record<string, RoomPlanPoint[]>;
  maxAnchorSnapMeters?: number;
}

export interface WallTopologyReconstructionResult extends RoomFootprintReconstructionResult {
  physicalComponentCount: number;
  openPlanComponentCount: number;
  unanchoredComponentCount: number;
}

export function reconstructRoomsFromWallTopology(
  options: WallTopologyReconstructionOptions,
): WallTopologyReconstructionResult {
  const floorPolygon = options.floorPolygon || [];
  const grid = options.grid;
  const floorAreaM2 = polygonArea(floorPolygon);
  const empty = (mappingId: string, warnings: string[]): WallTopologyReconstructionResult => ({
    regions: [],
    resolvedAnchors: [],
    anchorDiagnostics: [],
    mappingId,
    warnings,
    floorAreaM2,
    coverageRatio: 0,
    method: "none",
    totalWalkableCells: 0,
    assignedWalkableCells: 0,
    physicalComponentCount: 0,
    openPlanComponentCount: 0,
    unanchoredComponentCount: 0,
  });

  if (floorPolygon.length < 3 || floorAreaM2 < 0.35) {
    return empty("none", ["A valid floor footprint could not be reconstructed from the IFC slab geometry."]);
  }
  if (!grid || grid.floor.length !== grid.width * grid.height || grid.blocked.length !== grid.floor.length) {
    return empty("none", ["The floor topology grid is incomplete; no generic room was fabricated."]);
  }

  const topology = collectPhysicalFloorComponents(grid);
  if (!topology.totalWalkableCells || !topology.components.length) {
    return empty("none", ["No walkable floor faces remain after applying the structural wall mask."]);
  }

  const maxSnap = Math.max(0.1, Number(options.maxAnchorSnapMeters) || 0.35);
  const resolved = resolveRoomSeeds(options.anchors || [], floorPolygon, grid, maxSnap);
  const warnings = [...resolved.warnings];
  if (!resolved.seeds.length) {
    return {
      ...empty(resolved.mappingId, [...warnings, "No IFC room anchor could be associated with a physical floor face."]),
      totalWalkableCells: topology.totalWalkableCells,
      anchorDiagnostics: resolved.anchorDiagnostics,
      physicalComponentCount: topology.components.length,
      unanchoredComponentCount: topology.components.length,
    };
  }

  const seedsByComponent = new Map<number, Array<{ seed: ResolvedRoomSeed; seedOwner: number }>>();
  const invalidSeeds: ResolvedRoomSeed[] = [];
  resolved.seeds.forEach((seed, seedOwner) => {
    const componentId = topology.componentByCell[seed.seedIndex];
    if (componentId < 0) {
      invalidSeeds.push(seed);
      return;
    }
    const list = seedsByComponent.get(componentId) || [];
    list.push({ seed, seedOwner });
    seedsByComponent.set(componentId, list);
  });
  if (invalidSeeds.length) {
    warnings.push(`${invalidSeeds.length} aligned room anchor(s) did not land in a connected floor face and were excluded.`);
  }

  const regionCellsBySeed = new Map<number, number[]>();
  let openPlanComponentCount = 0;
  let unanchoredComponentCount = 0;
  for (const component of topology.components) {
    const componentSeeds = seedsByComponent.get(component.id) || [];
    if (!componentSeeds.length) {
      // A disconnected, unlabelled floor island remains explicitly unassigned.
      // It must never be silently attached to the nearest room across a wall.
      unanchoredComponentCount++;
      continue;
    }

    if (componentSeeds.length === 1) {
      regionCellsBySeed.set(componentSeeds[0].seedOwner, component.cells);
      continue;
    }

    openPlanComponentCount++;
    warnings.push(
      `Connected floor face ${component.id + 1} contains ${componentSeeds.length} IFC semantic spaces (${componentSeeds.map(({ seed }) => seed.anchor.label).join(", ")}). It was divided into inferred design zones; these internal boundaries are not physical walls.`,
    );
    const split = partitionOpenComponent(
      grid,
      component,
      componentSeeds.map(({ seed, seedOwner }) => ({ seedIndex: seed.seedIndex, seedOwner })),
      topology.componentByCell,
    );
    for (const [seedOwner, cells] of split) regionCellsBySeed.set(seedOwner, cells);
  }

  if (unanchoredComponentCount) {
    warnings.push(
      `${unanchoredComponentCount} disconnected floor component(s) had no matching IFC space anchor and were left unassigned instead of being merged into another room.`,
    );
  }

  const owner = new Int32Array(grid.floor.length);
  owner.fill(-1);
  for (const [seedOwner, cells] of regionCellsBySeed) {
    for (const cell of cells) owner[cell] = seedOwner;
  }

  const regions: ReconstructedRoomFootprint[] = [];
  const resolvedAnchors: ReconstructedRoomFootprint["anchor"][] = [];
  const minRoomArea = 0.35;
  for (let seedOwner = 0; seedOwner < resolved.seeds.length; seedOwner++) {
    const seed = resolved.seeds[seedOwner];
    const cells = regionCellsBySeed.get(seedOwner) || [];
    const areaM2 = cells.length * grid.cellSize * grid.cellSize;
    if (areaM2 < minRoomArea) {
      warnings.push(`IfcSpace "${seed.anchor.label}" maps to only ${areaM2.toFixed(2)} m² of walkable floor; its footprint was not published.`);
      continue;
    }

    const loops = traceRegionLoops(grid, cells);
    const outer = loops[0] || [];
    if (outer.length < 3) {
      warnings.push(`IfcSpace "${seed.anchor.label}" has walkable floor cells but its boundary could not be vectorized.`);
      continue;
    }
    const holes = loops.slice(1).filter((loop) => pointInPlanPolygon(polygonCentroid(loop), outer));
    const explicitPolygon = (options.explicitSpacePolygons?.[seed.anchor.key] || seed.anchor.explicitPolygon || []) as RoomPlanPoint[];
    const polygon = explicitPolygon.length >= 3 ? explicitPolygon : outer;
    const componentId = topology.componentByCell[seed.seedIndex];
    const componentSeedCount = seedsByComponent.get(componentId)?.length || 0;
    const source: ReconstructedRoomFootprint["source"] = explicitPolygon.length >= 3
      ? "ifc-space-solid-v1"
      : componentSeedCount > 1
        ? "ifc-open-plan-semantic-zone-v1"
        : "ifc-wall-topology-face-v1";
    const boundaryRatio = wallBoundaryRatio(grid, cells, owner, seedOwner);
    const confidence = explicitPolygon.length >= 3
      ? 0.96
      : componentSeedCount > 1
        ? Math.max(0.46, Math.min(0.72, 0.54 + boundaryRatio * 0.16 - seed.snapDistance * 0.02))
        : Math.max(0.68, Math.min(0.94, 0.76 + boundaryRatio * 0.18 - seed.snapDistance * 0.015));
    const snapped = gridCellCenter(grid, seed.seedIndex);
    const anchor = {
      ...seed.anchor,
      snappedX: snapped.x,
      snappedY: snapped.y,
      snapDistanceMeters: seed.snapDistance,
    };
    regions.push({
      anchor,
      polygon,
      holes: explicitPolygon.length >= 3 ? [] : holes,
      cells,
      areaM2: explicitPolygon.length >= 3 ? polygonArea(explicitPolygon) : areaM2,
      source,
      confidence,
      wallBoundaryRatio: boundaryRatio,
    });
    resolvedAnchors.push(anchor);
  }

  grid.room.fill(-1);
  regions.forEach((region, regionIndex) => {
    for (const index of region.cells) grid.room[index] = regionIndex;
  });

  const assignedWalkableCells = regions.reduce((sum, region) => sum + region.cells.length, 0);
  const coverageRatio = topology.totalWalkableCells
    ? assignedWalkableCells / topology.totalWalkableCells
    : 0;
  if (regions.length < resolved.seeds.length) {
    warnings.push(`Only ${regions.length} of ${resolved.seeds.length} aligned IFC spaces produced a valid room footprint.`);
  }
  if (coverageRatio < 0.98) {
    warnings.push(`Published room footprints cover ${(coverageRatio * 100).toFixed(1)}% of walkable floor cells. Unassigned faces or geometry gaps require review.`);
  }

  return {
    regions,
    resolvedAnchors,
    anchorDiagnostics: resolved.anchorDiagnostics,
    mappingId: resolved.mappingId,
    warnings,
    floorAreaM2,
    coverageRatio,
    method: regions.length ? "ifc-wall-topology-components-and-open-zones-v1" : "none",
    totalWalkableCells: topology.totalWalkableCells,
    assignedWalkableCells,
    physicalComponentCount: topology.components.length,
    openPlanComponentCount,
    unanchoredComponentCount,
  };
}
