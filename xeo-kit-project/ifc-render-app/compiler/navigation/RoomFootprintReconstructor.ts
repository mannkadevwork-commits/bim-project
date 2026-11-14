/**
 * Shared floor-grid geometry primitives and semantic-anchor resolver used by
 * the canonical room-topology reconstruction pipeline. IFC space placements
 * are hints, not boundaries: anchors are snapped conservatively to walkable
 * floor cells and then partitioned only inside wall-constrained components.
 */

export interface RoomPlanPoint {
  x: number;
  y: number;
}

export interface RoomFootprintAnchor {
  key: string;
  label: string;
  x: number;
  y: number;
  globalId?: string | null;
  expressId?: number;
  elevationY?: number;
  description?: string;
  /** Source used for the requested plan point; useful for reproducible diagnostics. */
  positionSource?: "ifc-description-safe-camera-center" | "ifc-object-placement";
  hasGeometryRepresentation?: boolean;
  /** IFC source plan coordinates, already converted to metres. */
  sourceX?: number;
  sourceY?: number;
  explicitPolygon?: RoomPlanPoint[] | null;
  /** True for geometry-derived labels such as "Room 1"; not an IFC semantic identity. */
  synthetic?: boolean;
}

export interface RoomFloorGrid {
  minX: number;
  minY: number;
  cellSize: number;
  width: number;
  height: number;
  floor: Uint8Array;
  blocked: Uint8Array;
  room: Int32Array;
}

export interface ReconstructedRoomFootprint {
  anchor: RoomFootprintAnchor & {
    snappedX: number;
    snappedY: number;
    snapDistanceMeters: number;
  };
  polygon: RoomPlanPoint[];
  holes: RoomPlanPoint[][];
  cells: number[];
  areaM2: number;
  source:
    | "ifc-space-solid-v1"
    | "ifc-space-wall-constrained-geodesic-v2"
    | "ifc-wall-topology-face-v1"
    | "ifc-open-plan-semantic-zone-v1";
  physicalComponentId?: number;
  regionKind?: "physical-room" | "semantic-zone";
  confidence: number;
  wallBoundaryRatio: number;
}

export interface RoomFootprintReconstructionResult {
  regions: ReconstructedRoomFootprint[];
  resolvedAnchors: Array<RoomFootprintAnchor & {
    snappedX: number;
    snappedY: number;
    snapDistanceMeters: number;
  }>;
  mappingId: string;
  warnings: string[];
  floorAreaM2: number;
  coverageRatio: number;
  method:
    | "ifc-space-solid-v1"
    | "ifc-space-wall-constrained-geodesic-v2"
    | "ifc-wall-topology-components-and-open-zones-v1"
    | "none";
  totalWalkableCells: number;
  assignedWalkableCells: number;
  anchorDiagnostics?: RoomAnchorResolutionDiagnostic[];
}

export interface RoomAnchorResolutionDiagnostic {
  key: string;
  label: string;
  resolved: boolean;
  positionSource?: RoomFootprintAnchor["positionSource"];
  requestedPoint: RoomPlanPoint | null;
  snappedPoint: RoomPlanPoint | null;
  snapDistanceMeters: number | null;
  maxSnapRadiusMeters?: number | null;
  outsideFloorDistanceMeters?: number | null;
  confidence?: number;
  failureReason?: "missing-placement" | "outside-floor-domain" | "no-walkable-cell-within-tolerance" | null;
}

const EPSILON = 1e-8;
const MIN_REGION_AREA_M2 = 0.35;
const DEFAULT_ANCHOR_SNAP_METERS = 1.5;
const MAX_ORIGIN_CORRECTION_METERS = 0.5;

export function signedPolygonArea(polygon: RoomPlanPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

export function polygonArea(polygon: RoomPlanPoint[]): number {
  return Math.abs(signedPolygonArea(polygon));
}

function normalizePolygon(points: RoomPlanPoint[]): RoomPlanPoint[] {
  const result: RoomPlanPoint[] = [];
  for (const point of points || []) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    const last = result[result.length - 1];
    if (last && Math.hypot(last.x - point.x, last.y - point.y) <= EPSILON) continue;
    result.push({ x: point.x, y: point.y });
  }
  if (result.length > 1 && Math.hypot(
    result[0].x - result[result.length - 1].x,
    result[0].y - result[result.length - 1].y,
  ) <= EPSILON) result.pop();
  return result.length >= 3 ? result : [];
}

export function pointInPlanPolygon(point: RoomPlanPoint, polygon: RoomPlanPoint[]): boolean {
  if (polygon.length < 3) return false;
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

function distanceToSegment(point: RoomPlanPoint, a: RoomPlanPoint, b: RoomPlanPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared <= EPSILON ? 0 : Math.max(0, Math.min(1,
    ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
  ));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function distanceToPolygon(point: RoomPlanPoint, polygon: RoomPlanPoint[]): number {
  if (pointInPlanPolygon(point, polygon)) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index++) {
    best = Math.min(best, distanceToSegment(point, polygon[index], polygon[(index + 1) % polygon.length]));
  }
  return best;
}

function centroid(points: RoomPlanPoint[]): RoomPlanPoint {
  if (!points.length) return { x: 0, y: 0 };
  return points.reduce((sum, point) => ({
    x: sum.x + point.x / points.length,
    y: sum.y + point.y / points.length,
  }), { x: 0, y: 0 });
}

function candidateMappings(anchors: RoomFootprintAnchor[]): Array<{ id: string; map: (x: number, y: number) => RoomPlanPoint }> {
  const hasViewerCoordinates = anchors.length > 0 && anchors.every((anchor) =>
    Number.isFinite(anchor.x) && Number.isFinite(anchor.y),
  );
  // RoomDetector already converts IfcSpace placements into the viewer X/Z
  // plane. Those coordinates are authoritative; source IFC coordinates are
  // retained only for diagnostics and must not override the converted point.
  if (hasViewerCoordinates) return [{ id: "viewer-world-xz", map: (x, y) => ({ x, y }) }];

  const hasSourceCoordinates = anchors.length > 0 && anchors.every((anchor) =>
    Number.isFinite(anchor.sourceX) && Number.isFinite(anchor.sourceY),
  );
  if (!hasSourceCoordinates) return [{ id: "viewer-world-xz", map: (x, y) => ({ x, y }) }];
  return [
    { id: "ifc-z-up-to-viewer-xz", map: (x, y) => ({ x, y: -y }) },
    { id: "ifc-source-xy", map: (x, y) => ({ x, y }) },
    { id: "ifc-mirror-x", map: (x, y) => ({ x: -x, y: -y }) },
    { id: "ifc-mirror-y", map: (x, y) => ({ x: -x, y }) },
    { id: "ifc-swap-xy", map: (x, y) => ({ x: y, y: x }) },
    { id: "ifc-swap-x-mirror", map: (x, y) => ({ x: y, y: -x }) },
    { id: "ifc-swap-y-mirror", map: (x, y) => ({ x: -y, y: x }) },
    { id: "ifc-swap-xy-mirror", map: (x, y) => ({ x: -y, y: -x }) },
  ];
}

export function gridCellCenter(grid: RoomFloorGrid, index: number): RoomPlanPoint {
  const i = index % grid.width;
  const j = Math.floor(index / grid.width);
  return {
    x: grid.minX + (i + 0.5) * grid.cellSize,
    y: grid.minY + (j + 0.5) * grid.cellSize,
  };
}

function nearestWalkableCell(
  grid: RoomFloorGrid,
  point: RoomPlanPoint,
  maxDistance: number,
  occupied: Set<number>,
): { index: number; point: RoomPlanPoint; distance: number } | null {
  const ci = Math.floor((point.x - grid.minX) / grid.cellSize);
  const cj = Math.floor((point.y - grid.minY) / grid.cellSize);
  const radius = Math.ceil(maxDistance / grid.cellSize);
  let best: { index: number; point: RoomPlanPoint; distance: number } | null = null;
  for (let j = Math.max(0, cj - radius); j <= Math.min(grid.height - 1, cj + radius); j++) {
    for (let i = Math.max(0, ci - radius); i <= Math.min(grid.width - 1, ci + radius); i++) {
      const index = j * grid.width + i;
      if (grid.floor[index] === 0 || grid.blocked[index] !== 0 || occupied.has(index)) continue;
      const center = gridCellCenter(grid, index);
      const distance = Math.hypot(center.x - point.x, center.y - point.y);
      if (distance > maxDistance) continue;
      if (!best || distance < best.distance) best = { index, point: center, distance };
    }
  }
  return best;
}

export interface ResolvedRoomSeed {
  anchor: RoomFootprintAnchor;
  point: RoomPlanPoint;
  seedIndex: number;
  snapDistance: number;
  snapRadiusMeters: number;
  outsideFloorDistanceMeters: number;
}

type ResolvedSeed = ResolvedRoomSeed;

interface MappingCandidate {
  id: string;
  seeds: ResolvedSeed[];
  score: number;
  mappedPoints: Map<string, RoomPlanPoint>;
  failures: Map<string, { point: RoomPlanPoint; outsideFloorDistanceMeters: number; reason: "outside-floor-domain" | "no-walkable-cell-within-tolerance" }>;
}

function resolveSeeds(
  anchors: RoomFootprintAnchor[],
  floorPolygon: RoomPlanPoint[],
  grid: RoomFloorGrid,
  maxSnapDistance: number,
): {
  seeds: ResolvedSeed[];
  mappingId: string;
  warnings: string[];
  mappedPoints: Map<string, RoomPlanPoint>;
  failures: Map<string, { point: RoomPlanPoint; outsideFloorDistanceMeters: number; reason: "outside-floor-domain" | "no-walkable-cell-within-tolerance" }>;
} {
  const warnings: string[] = [];
  const valid = anchors.filter((anchor) => anchor && String(anchor.label || "").trim() &&
    (Number.isFinite(anchor.x) && Number.isFinite(anchor.y) ||
      Number.isFinite(anchor.sourceX) && Number.isFinite(anchor.sourceY)));
  if (!valid.length) return {
    seeds: [], mappingId: "none", warnings: ["No usable IfcSpace placement anchors were found."],
    mappedPoints: new Map(), failures: new Map(),
  };

  const cappedMaxSnap = Math.min(1.5, Math.max(0.25, Number(maxSnapDistance) || DEFAULT_ANCHOR_SNAP_METERS));
  const snapRadii = Array.from(new Set([0.25, 0.45, 0.75, 1.0, cappedMaxSnap]
    .map((radius) => Math.min(cappedMaxSnap, radius)))).sort((a, b) => a - b);
  const candidates: MappingCandidate[] = [];
  for (const mapping of candidateMappings(valid)) {
    const mapped = valid.map((anchor) => {
      const hasViewerPoint = mapping.id === "viewer-world-xz"
        && Number.isFinite(anchor.x) && Number.isFinite(anchor.y);
      const sourceX = hasViewerPoint ? anchor.x : (Number.isFinite(anchor.sourceX) ? Number(anchor.sourceX) : anchor.x);
      const sourceY = hasViewerPoint ? anchor.y : (Number.isFinite(anchor.sourceY) ? Number(anchor.sourceY) : anchor.y);
      return { anchor, point: mapping.map(sourceX, sourceY) };
    });
    const occupied = new Set<number>();
    const seeds: ResolvedSeed[] = [];
    const mappedPoints = new Map<string, RoomPlanPoint>();
    const failures = new Map<string, { point: RoomPlanPoint; outsideFloorDistanceMeters: number; reason: "outside-floor-domain" | "no-walkable-cell-within-tolerance" }>();
    let totalSnapDistance = 0;
    let outsideFloor = 0;

    for (const item of mapped) {
      mappedPoints.set(item.anchor.key, item.point);
      const outsideDistance = distanceToPolygon(item.point, floorPolygon);
      if (outsideDistance > 0.20) {
        outsideFloor++;
        failures.set(item.anchor.key, {
          point: item.point,
          outsideFloorDistanceMeters: outsideDistance,
          reason: "outside-floor-domain",
        });
        continue;
      }

      let snapped: ReturnType<typeof nearestWalkableCell> = null;
      let snapRadiusMeters = cappedMaxSnap;
      for (const radius of snapRadii) {
        snapped = nearestWalkableCell(grid, item.point, radius, occupied);
        if (snapped) {
          snapRadiusMeters = radius;
          break;
        }
      }
      if (!snapped) {
        failures.set(item.anchor.key, {
          point: item.point,
          outsideFloorDistanceMeters: outsideDistance,
          reason: "no-walkable-cell-within-tolerance",
        });
        continue;
      }

      occupied.add(snapped.index);
      totalSnapDistance += snapped.distance;
      seeds.push({
        anchor: item.anchor,
        point: item.point,
        seedIndex: snapped.index,
        snapDistance: snapped.distance,
        snapRadiusMeters,
        outsideFloorDistanceMeters: outsideDistance,
      });
    }
    const mappingPreference = mapping.id === "ifc-z-up-to-viewer-xz" ? 0.01 : 0;
    candidates.push({
      id: mapping.id,
      seeds,
      mappedPoints,
      failures,
      score: seeds.length * 10000 - totalSnapDistance * 100 - outsideFloor * 25 + mappingPreference,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best?.seeds.length) {
    return {
      seeds: [], mappingId: best?.id || "none",
      warnings: [`None of the ${valid.length} IFC space anchors could be aligned to walkable floor cells within ${cappedMaxSnap.toFixed(2)} m. No generic whole-floor room was created.`],
      mappedPoints: best?.mappedPoints || new Map(),
      failures: best?.failures || new Map(),
    };
  }

  if (best.seeds.length < valid.length) {
    const resolved = new Set(best.seeds.map((seed) => seed.anchor.key));
    const missing = valid.filter((anchor) => !resolved.has(anchor.key)).map((anchor) => anchor.label);
    warnings.push(`${best.seeds.length} of ${valid.length} IFC room anchors aligned to the floor. Unresolved spaces: ${missing.join(", ")}. Check the placement, floor-level assignment and wall mask.`);
  }
  if (best.id !== "ifc-z-up-to-viewer-xz" && best.id !== "viewer-world-xz") {
    warnings.push(`IFC room placements required the alternate plan mapping "${best.id}". Review room overlays before making structural changes.`);
  }
  const farSeeds = best.seeds.filter((seed) => seed.snapDistance > 0.35);
  if (farSeeds.length) {
    warnings.push(`${farSeeds.length} IFC space anchor(s) needed an adaptive snap greater than 0.35 m (maximum ${cappedMaxSnap.toFixed(2)} m). Their identity was retained with reduced boundary confidence; review their room regions before structural edits.`);
  }
  return { seeds: best.seeds, mappingId: best.id, warnings, mappedPoints: best.mappedPoints, failures: best.failures };
}

/**
 * Resolve semantic IfcSpace placements to distinct walkable floor cells.
 * Unlike the legacy footprint routine, this resolver never assigns an
 * unanchored disconnected island to the nearest room.
 */
export function resolveRoomSeeds(
  anchors: RoomFootprintAnchor[],
  floorPolygon: RoomPlanPoint[],
  grid: RoomFloorGrid,
  maxSnapDistance: number,
): {
  seeds: ResolvedRoomSeed[];
  mappingId: string;
  warnings: string[];
  anchorDiagnostics: RoomAnchorResolutionDiagnostic[];
} {
  const resolved = resolveSeeds(anchors, floorPolygon, grid, maxSnapDistance);
  const byKey = new Map(resolved.seeds.map((seed) => [seed.anchor.key, seed]));
  const anchorDiagnostics = (anchors || []).map((anchor) => {
    const seed = byKey.get(anchor.key);
    const failure = resolved.failures.get(anchor.key);
    const requestedPoint = resolved.mappedPoints.get(anchor.key) || (
      Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
        ? { x: anchor.x, y: anchor.y }
        : Number.isFinite(anchor.sourceX) && Number.isFinite(anchor.sourceY)
          ? { x: Number(anchor.sourceX), y: Number(anchor.sourceY) }
          : null
    );
    const distance = seed?.snapDistance ?? null;
    const confidence = distance == null
      ? 0
      : distance <= 0.35 ? 0.98
        : distance <= 0.75 ? 0.82
          : distance <= 1.0 ? 0.68
            : 0.5;
    return {
      key: anchor.key,
      label: anchor.label,
      resolved: Boolean(seed),
      positionSource: anchor.positionSource,
      requestedPoint,
      snappedPoint: seed ? { x: gridCellCenter(grid, seed.seedIndex).x, y: gridCellCenter(grid, seed.seedIndex).y } : null,
      snapDistanceMeters: seed ? Number(seed.snapDistance.toFixed(4)) : null,
      maxSnapRadiusMeters: seed ? seed.snapRadiusMeters : Math.min(1.5, Math.max(0.25, Number(maxSnapDistance) || DEFAULT_ANCHOR_SNAP_METERS)),
      outsideFloorDistanceMeters: Number((seed?.outsideFloorDistanceMeters ?? failure?.outsideFloorDistanceMeters ?? 0).toFixed(4)),
      confidence,
      failureReason: seed ? null : (failure?.reason || "missing-placement") as RoomAnchorResolutionDiagnostic["failureReason"],
    };
  });
  return { ...resolved, anchorDiagnostics };
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

export function traceRegionLoops(grid: RoomFloorGrid, cells: number[]): RoomPlanPoint[][] {
  const cellSet = new Set(cells);
  const edges = new Map<string, { a: [number, number]; b: [number, number] }>();
  const has = (i: number, j: number) => i >= 0 && j >= 0 && i < grid.width && j < grid.height && cellSet.has(j * grid.width + i);
  const addEdge = (a: [number, number], b: [number, number]) => {
    const key = `${a[0]},${a[1]}|${b[0]},${b[1]}`;
    const reverse = `${b[0]},${b[1]}|${a[0]},${a[1]}`;
    if (edges.has(reverse)) edges.delete(reverse);
    else edges.set(key, { a, b });
  };
  for (const index of cells) {
    const i = index % grid.width;
    const j = Math.floor(index / grid.width);
    if (!has(i, j - 1)) addEdge([i, j], [i + 1, j]);
    if (!has(i + 1, j)) addEdge([i + 1, j], [i + 1, j + 1]);
    if (!has(i, j + 1)) addEdge([i + 1, j + 1], [i, j + 1]);
    if (!has(i - 1, j)) addEdge([i, j + 1], [i, j]);
  }

  const outgoing = new Map<string, [number, number][]>();
  for (const edge of edges.values()) {
    const key = `${edge.a[0]},${edge.a[1]}`;
    const list = outgoing.get(key) || [];
    list.push(edge.b);
    outgoing.set(key, list);
  }
  const used = new Set<string>();
  const loops: RoomPlanPoint[][] = [];
  const keyFor = (a: [number, number], b: [number, number]) => `${a[0]},${a[1]}|${b[0]},${b[1]}`;
  const toWorld = (point: [number, number]) => ({
    x: grid.minX + point[0] * grid.cellSize,
    y: grid.minY + point[1] * grid.cellSize,
  });

  for (const edge of edges.values()) {
    const firstKey = keyFor(edge.a, edge.b);
    if (used.has(firstKey)) continue;
    const loop: RoomPlanPoint[] = [toWorld(edge.a)];
    let start = edge.a;
    let previous = edge.a;
    let current = edge.b;
    used.add(firstKey);
    for (let guard = 0; guard < edges.size + 8; guard++) {
      loop.push(toWorld(current));
      if (current[0] === start[0] && current[1] === start[1]) break;
      const candidates = outgoing.get(`${current[0]},${current[1]}`) || [];
      const next = candidates.find((candidate) => !used.has(keyFor(current, candidate)));
      if (!next) break;
      used.add(keyFor(current, next));
      previous = current;
      current = next;
      void previous;
    }
    if (loop.length < 4) continue;
    // The contours are raster-native; collapse collinear vertices so the
    // frontend receives a compact polygon instead of thousands of grid points.
    const compact: RoomPlanPoint[] = [];
    for (let index = 0; index < loop.length; index++) {
      const prev = loop[(index - 1 + loop.length) % loop.length];
      const currentPoint = loop[index];
      const next = loop[(index + 1) % loop.length];
      const ax = currentPoint.x - prev.x;
      const ay = currentPoint.y - prev.y;
      const bx = next.x - currentPoint.x;
      const by = next.y - currentPoint.y;
      if (Math.abs(ax * by - ay * bx) > 1e-9) compact.push(currentPoint);
    }
    if (compact.length >= 3) loops.push(compact);
  }
  return loops.sort((a, b) => polygonArea(b) - polygonArea(a));
}

export function wallBoundaryRatio(grid: RoomFloorGrid, cells: number[], owner: Int32Array, regionId: number): number {
  let boundaryEdges = 0;
  let wallEdges = 0;
  const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
  for (const index of cells) {
    const i = index % grid.width;
    const j = Math.floor(index / grid.width);
    for (const [dx, dy] of directions) {
      const ni = i + dx;
      const nj = j + dy;
      if (ni < 0 || nj < 0 || ni >= grid.width || nj >= grid.height) {
        boundaryEdges++;
        continue;
      }
      const neighbour = nj * grid.width + ni;
      if (grid.blocked[neighbour] !== 0) {
        boundaryEdges++;
        wallEdges++;
      } else if (owner[neighbour] !== regionId) {
        boundaryEdges++;
      }
    }
  }
  return boundaryEdges ? wallEdges / boundaryEdges : 0;
}

function centroidOfPolygon(polygon: RoomPlanPoint[]): RoomPlanPoint {
  const area = signedPolygonArea(polygon);
  if (Math.abs(area) < EPSILON) return centroid(polygon);
  let x = 0;
  let y = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  return { x: x / (6 * area), y: y / (6 * area) };
}

export function reconstructIfcSpaceFootprints(options: {
  floorPolygon: RoomPlanPoint[];
  anchors: RoomFootprintAnchor[];
  grid: RoomFloorGrid;
  explicitSpacePolygons?: Record<string, RoomPlanPoint[]>;
  maxAnchorSnapMeters?: number;
}): RoomFootprintReconstructionResult {
  const floorPolygon = normalizePolygon(options.floorPolygon || []);
  const grid = options.grid;
  const floorAreaM2 = polygonArea(floorPolygon);
  const totalWalkableCells = grid.floor.reduce((sum, value, index) => sum + (value && !grid.blocked[index] ? 1 : 0), 0);
  const emptyResult = (mappingId: string, warnings: string[]): RoomFootprintReconstructionResult => ({
    regions: [],
    resolvedAnchors: [],
    mappingId,
    warnings,
    floorAreaM2,
    coverageRatio: 0,
    method: "none",
    totalWalkableCells,
    assignedWalkableCells: 0,
  });

  if (floorPolygon.length < 3 || floorAreaM2 < MIN_REGION_AREA_M2) {
    return emptyResult("none", ["A valid floor footprint could not be reconstructed from the IFC slab geometry."]);
  }
  if (!grid || grid.floor.length !== grid.width * grid.height || grid.blocked.length !== grid.floor.length) {
    return emptyResult("none", ["The floor analysis grid is incomplete; semantic room reconstruction was stopped rather than returning a generic room."]);
  }
  if (totalWalkableCells < 20) {
    return emptyResult("none", ["The floor grid contains too few walkable cells for room reconstruction."]);
  }

  const resolved = resolveSeeds(
    options.anchors || [],
    floorPolygon,
    grid,
    Math.max(0.25, Number(options.maxAnchorSnapMeters) || DEFAULT_ANCHOR_SNAP_METERS),
  );
  const warnings = [...resolved.warnings];
  if (resolved.seeds.length < 1) {
    return emptyResult(resolved.mappingId, [
      ...warnings,
      "No semantic room anchor could be aligned; no generic whole-floor fallback was created.",
    ]);
  }

  const owner = new Int32Array(grid.floor.length);
  owner.fill(-1);
  const distances = new Float64Array(grid.floor.length);
  distances.fill(Number.POSITIVE_INFINITY);
  const heap = new MinHeap();
  resolved.seeds.forEach((seed, seedIndex) => {
    owner[seed.seedIndex] = seedIndex;
    distances[seed.seedIndex] = 0;
    heap.push({ index: seed.seedIndex, owner: seedIndex, distance: 0 });
  });

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
    if (current.distance > distances[current.index] + 1e-9 || current.owner !== owner[current.index]) continue;
    const i = current.index % grid.width;
    const j = Math.floor(current.index / grid.width);
    for (const direction of neighbours) {
      const ni = i + direction.dx;
      const nj = j + direction.dy;
      if (ni < 0 || nj < 0 || ni >= grid.width || nj >= grid.height) continue;
      const next = nj * grid.width + ni;
      if (grid.floor[next] === 0 || grid.blocked[next] !== 0) continue;
      if (direction.dx !== 0 && direction.dy !== 0) {
        const horizontal = j * grid.width + ni;
        const vertical = nj * grid.width + i;
        // Prevent diagonal corner cutting through a wall or wall junction.
        if (grid.blocked[horizontal] !== 0 || grid.blocked[vertical] !== 0) continue;
      }
      const nextDistance = current.distance + direction.cost * grid.cellSize;
      if (nextDistance + 1e-9 >= distances[next]) continue;
      distances[next] = nextDistance;
      owner[next] = current.owner;
      heap.push({ index: next, owner: current.owner, distance: nextDistance });
    }
  }

  let assignedWalkableCells = 0;
  const cellsBySeed = resolved.seeds.map(() => [] as number[]);
  const orphanCells: number[] = [];
  for (let index = 0; index < owner.length; index++) {
    if (grid.floor[index] === 0 || grid.blocked[index] !== 0) continue;
    const regionId = owner[index];
    if (regionId < 0) {
      orphanCells.push(index);
      continue;
    }
    cellsBySeed[regionId].push(index);
    assignedWalkableCells++;
  }

  // Disconnected floor islands without a seed are assigned to the closest
  // semantic room only for display/coverage; they never create a fake room.
  if (orphanCells.length) {
    for (const index of orphanCells) {
      const point = gridCellCenter(grid, index);
      let nearestSeed = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      resolved.seeds.forEach((seed, seedIndex) => {
        const distance = Math.hypot(point.x - seed.point.x, point.y - seed.point.y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestSeed = seedIndex;
        }
      });
      cellsBySeed[nearestSeed].push(index);
      owner[index] = nearestSeed;
      assignedWalkableCells++;
    }
    warnings.push(`${orphanCells.length} disconnected walkable floor cell(s) were assigned to the nearest semantic room for display. Review these isolated areas before structural edits.`);
  }

  const regions: ReconstructedRoomFootprint[] = [];
  const resolvedAnchors: ReconstructedRoomFootprint["anchor"][] = [];
  for (let seedIndex = 0; seedIndex < resolved.seeds.length; seedIndex++) {
    const seed = resolved.seeds[seedIndex];
    const cells = cellsBySeed[seedIndex];
    const areaM2 = cells.length * grid.cellSize * grid.cellSize;
    if (areaM2 < MIN_REGION_AREA_M2) {
      warnings.push(`IfcSpace "${seed.anchor.label}" resolved to ${areaM2.toFixed(2)} m² of walkable floor, below the ${MIN_REGION_AREA_M2.toFixed(2)} m² display threshold.`);
      continue;
    }
    const loops = traceRegionLoops(grid, cells);
    const outer = loops[0] || [];
    if (outer.length < 3) {
      warnings.push(`IfcSpace "${seed.anchor.label}" has walkable cells but its room boundary could not be vectorized.`);
      continue;
    }
    const holes = loops.slice(1).filter((loop) => pointInPlanPolygon(centroidOfPolygon(loop), outer));
    const explicitPolygon = normalizePolygon(options.explicitSpacePolygons?.[seed.anchor.key] || seed.anchor.explicitPolygon || []);
    const polygon = explicitPolygon.length >= 3 ? explicitPolygon : outer;
    const source: ReconstructedRoomFootprint["source"] = explicitPolygon.length >= 3
      ? "ifc-space-solid-v1"
      : "ifc-space-wall-constrained-geodesic-v2";
    const wallRatio = wallBoundaryRatio(grid, cells, owner, seedIndex);
    const confidence = explicitPolygon.length >= 3
      ? 0.96
      : Math.max(0.38, Math.min(0.82, 0.43 + wallRatio * 0.42 - Math.min(0.12, seed.snapDistance * 0.025)));
    const anchor = {
      ...seed.anchor,
      snappedX: gridCellCenter(grid, seed.seedIndex).x,
      snappedY: gridCellCenter(grid, seed.seedIndex).y,
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
      wallBoundaryRatio: wallRatio,
    });
    resolvedAnchors.push(anchor);
  }

  grid.room.fill(-1);
  regions.forEach((region, regionIndex) => {
    for (const index of region.cells) grid.room[index] = regionIndex;
  });

  const visibleAssignedCells = regions.reduce((sum, region) => sum + region.cells.length, 0);
  assignedWalkableCells = visibleAssignedCells;
  const coverageRatio = totalWalkableCells > 0 ? visibleAssignedCells / totalWalkableCells : 0;
  if (regions.length < resolved.seeds.length) {
    warnings.push(`Only ${regions.length} of ${resolved.seeds.length} aligned IFC spaces produced a valid room footprint. Missing rooms were not replaced with a generic whole-floor room.`);
  }
  if (regions.length > 1) {
    warnings.push(`Generated ${regions.length} room regions from semantic IfcSpace anchors using wall-constrained geodesic partitioning. This IFC has no explicit IfcSpace solids/space boundaries, so inferred footprints must be reviewed before structural editing.`);
  }
  if (coverageRatio < 0.98) {
    warnings.push(`Semantic room regions cover ${(coverageRatio * 100).toFixed(1)}% of walkable floor cells. Unassigned or disconnected areas need review.`);
  }
  return {
    regions,
    resolvedAnchors,
    mappingId: resolved.mappingId,
    warnings,
    floorAreaM2,
    coverageRatio,
    method: regions.length ? regions.some((region) => region.source === "ifc-space-wall-constrained-geodesic-v2")
      ? "ifc-space-wall-constrained-geodesic-v2"
      : "ifc-space-solid-v1" : "none",
    totalWalkableCells,
    assignedWalkableCells,
  };
}
