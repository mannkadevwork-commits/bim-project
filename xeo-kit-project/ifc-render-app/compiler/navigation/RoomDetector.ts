import * as fs from "fs";
import * as path from "path";
import {
  IfcAPI,
  IFCDOOR,
  IFCOPENINGELEMENT,
  IFCRELVOIDSELEMENT,
  IFCRELFILLSELEMENT,
  IFCSLAB,
  IFCWALL,
  IFCWALLSTANDARDCASE,
} from "web-ifc";
import type { DetectedRoom, RoomDebugArtifact, RoomPortal, RoomPolygonPoint } from "./RoomTypes";
import { makeComponentDiagnostics, makeDoorDiagnostic, makeRoomBoundaryCandidateDiagnostics } from "./RoomDiagnostics";

interface Point2 {
  x: number;
  y: number;
}

interface Point3 {
  x: number;
  y: number;
  z: number;
}

interface ElementFootprint {
  key: string;
  sourceFile: string;
  expressId: number;
  globalId: string | null;
  name: string;
  points: Point2[];
  center: Point2;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  sizeX: number;
  sizeY: number;
}

interface SemanticOpening {
  sourceFile: string;
  openingExpressId: number;
  openingGlobalId: string | null;
  hostWallExpressId: number | null;
  hostWallGlobalId: string | null;
  doorExpressId: number | null;
  doorGlobalId: string | null;
}

interface SemanticDoor {
  sourceFile: string;
  expressId: number;
  globalId: string | null;
  objectPlacementExpressId: number | null;
  width: number | null;
  height: number | null;
}

interface SourceModel {
  label: string;
  filePath: string;
  modelId: number;
  hiddenWallGlobalIds: Set<string>;
}

interface Grid {
  minX: number;
  minY: number;
  cellSize: number;
  width: number;
  height: number;
  floor: Uint8Array;
  blocked: Uint8Array;
  room: Int32Array;
}

interface Component {
  id: number;
  cells: number[];
  area: number;
  minI: number;
  maxI: number;
  minJ: number;
  maxJ: number;
  touchesBoundary: boolean;
}

const CELL_SIZE = 0.05;
const GRID_MAX_CELLS = 1_200_000;
const MIN_COMPONENT_AREA = 0.10;
const ROOM_SEAL_PADDING = 0.025;
const DOOR_MATCH_NAME = /door|sliding|opening\s*\(/i;

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeNumber(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getWrappedValue(value: any): any {
  let current = value;
  const seen = new Set<any>();
  for (let i = 0; i < 8; i++) {
    if (current == null || (typeof current !== "object" && typeof current !== "function")) return current;
    if (seen.has(current)) return current;
    seen.add(current);
    if (Object.prototype.hasOwnProperty.call(current, "value")) {
      current = current.value;
      continue;
    }
    return current;
  }
  return current;
}

function numericVector3(value: any): [number, number, number] | null {
  const unwrapped = getWrappedValue(value);
  if (unwrapped == null) return null;

  let values: any[] | null = null;
  if (Array.isArray(unwrapped)) {
    values = unwrapped;
  } else if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(unwrapped)) {
    values = Array.from(unwrapped as any);
  } else if (typeof unwrapped === "object") {
    const candidate = (unwrapped as any).value;
    if (Array.isArray(candidate) || (candidate && typeof candidate.length === "number")) {
      values = Array.from(candidate);
    } else {
      const ordered = [unwrapped[0], unwrapped[1], unwrapped[2]];
      if (ordered.some((v) => v !== undefined)) values = ordered;
    }
  }

  if (!values || values.length < 3) return null;
  const nums = values.slice(0, 3).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2]];
}

function ifcZUpToViewer(p: Point3): Point3 {
  // IFC placement coordinates are authored in the source IFC's Z-up frame.
  // The room detector's geometry is already in the viewer's Y-up frame, so
  // placement positions must receive the same one-time mapping: [x, z, -y].
  return { x: p.x, y: p.z, z: -p.y };
}

function asExpressId(value: any): number | null {
  const unwrapped = getWrappedValue(value);
  if (typeof unwrapped === "number" && Number.isFinite(unwrapped)) return Number(unwrapped);
  if (typeof unwrapped === "string" && /^\d+$/.test(unwrapped)) return Number(unwrapped);
  return null;
}

function lineRefId(line: any, field: string): number | null {
  return asExpressId(line?.[field]);
}

function numberField(line: any, field: string): number | null {
  const value = getWrappedValue(line?.[field]);
  const n = Number(getWrappedValue(value));
  return Number.isFinite(n) ? n : null;
}

function extractPlacementPointRaw(ifc: IfcAPI, modelId: number, placementExpressId: number | null, depth = 0): Point3 | null {
  if (!placementExpressId || depth > 24) return null;
  const placement: any = ifc.GetLine(modelId, placementExpressId);
  if (!placement) return null;

  const relativePlacementId = lineRefId(placement, "RelativePlacement");
  const parentPlacementId = lineRefId(placement, "PlacementRelTo");
  const rel: any = relativePlacementId ? ifc.GetLine(modelId, relativePlacementId) : null;
  const locationId = lineRefId(rel, "Location");
  const location: any = locationId ? ifc.GetLine(modelId, locationId) : null;
  const coords = numericVector3(location?.Coordinates) ?? [0, 0, 0];
  const local: Point3 = { x: coords[0], y: coords[1], z: coords[2] };

  const parent = parentPlacementId ? extractPlacementPointRaw(ifc, modelId, parentPlacementId, depth + 1) : null;
  return parent
    ? { x: parent.x + local.x, y: parent.y + local.y, z: parent.z + local.z }
    : local;
}

function extractPlacementPoint(ifc: IfcAPI, modelId: number, placementExpressId: number | null): Point3 | null {
  const raw = extractPlacementPointRaw(ifc, modelId, placementExpressId);
  return raw ? ifcZUpToViewer(raw) : null;
}

function collectSemanticRelationships(
  ifc: IfcAPI,
  modelId: number,
  sourceFile: string,
  wallByExpressId: Map<number, Pick<ElementFootprint, "globalId">>,
  openingIds: Set<number>,
  doorIds: Set<number>,
): { openings: SemanticOpening[]; doors: SemanticDoor[] } {
  const openingByExpressId = new Map<number, SemanticOpening>();
  for (const openingExpressId of openingIds) {
    const line: any = ifc.GetLine(modelId, openingExpressId);
    openingByExpressId.set(openingExpressId, {
      sourceFile,
      openingExpressId,
      openingGlobalId: lineGlobalId(line),
      hostWallExpressId: null,
      hostWallGlobalId: null,
      doorExpressId: null,
      doorGlobalId: null,
    });
  }

  for (const relId of idsWithType(ifc, modelId, IFCRELVOIDSELEMENT)) {
    const rel: any = ifc.GetLine(modelId, relId);
    const openingExpressId = lineRefId(rel, "RelatedOpeningElement");
    const wallExpressId = lineRefId(rel, "RelatingBuildingElement");
    const semantic = openingExpressId == null ? null : openingByExpressId.get(openingExpressId);
    if (!semantic) continue;
    semantic.hostWallExpressId = wallExpressId;
    const wall = wallExpressId == null ? null : wallByExpressId.get(wallExpressId);
    semantic.hostWallGlobalId = wall?.globalId ?? null;
  }

  const doorMeta: SemanticDoor[] = [];
  for (const doorExpressId of doorIds) {
    const line: any = ifc.GetLine(modelId, doorExpressId);
    doorMeta.push({
      sourceFile,
      expressId: doorExpressId,
      globalId: lineGlobalId(line),
      objectPlacementExpressId: lineRefId(line, "ObjectPlacement"),
      width: numberField(line, "OverallWidth"),
      height: numberField(line, "OverallHeight"),
    });
  }

  const doorByExpressId = new Map(doorMeta.map((door) => [door.expressId, door]));
  for (const relId of idsWithType(ifc, modelId, IFCRELFILLSELEMENT)) {
    const rel: any = ifc.GetLine(modelId, relId);
    const openingExpressId = lineRefId(rel, "RelatingOpeningElement");
    const doorExpressId = lineRefId(rel, "RelatedBuildingElement");
    const semantic = openingExpressId == null ? null : openingByExpressId.get(openingExpressId);
    if (!semantic || doorExpressId == null || !doorByExpressId.has(doorExpressId)) continue;
    const door = doorByExpressId.get(doorExpressId)!;
    semantic.doorExpressId = door.expressId;
    semantic.doorGlobalId = door.globalId;
  }

  return { openings: Array.from(openingByExpressId.values()), doors: doorMeta };
}

function lineGlobalId(line: any): string | null {
  const value = getWrappedValue(line?.GlobalId);
  return typeof value === "string" && value ? value : null;
}

function lineName(line: any): string {
  const value = getWrappedValue(line?.Name);
  return typeof value === "string" ? value : "";
}

function applyIfcMatrix(x: number, y: number, z: number, matrix: number[]): Point3 {
  return {
    x: x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12],
    y: x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13],
    z: x * matrix[2] + y * matrix[6] + z * matrix[10] + matrix[14],
  };
}

function hull(points: Point2[]): Point2[] {
  const unique = Array.from(
    new Map(points.map((p) => [`${p.x.toFixed(8)}:${p.y.toFixed(8)}`, p])).values(),
  ).sort((a, b) => a.x - b.x || a.y - b.y);
  if (unique.length <= 2) return unique;

  const cross = (o: Point2, a: Point2, b: Point2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point2[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }

  const upper: Point2[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonContains(point: Point2, polygon: Point2[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      ((a.y > point.y) !== (b.y > point.y)) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function bbox(points: Point2[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    sizeX: Math.max(0, maxX - minX),
    sizeY: Math.max(0, maxY - minY),
  };
}

function centroid(points: Point2[]): Point2 {
  if (!points.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function worldToGrid(grid: Grid, p: Point2): [number, number] {
  return [
    Math.floor((p.x - grid.minX) / grid.cellSize),
    Math.floor((p.y - grid.minY) / grid.cellSize),
  ];
}

function gridToWorld(grid: Grid, i: number, j: number): Point2 {
  return {
    x: grid.minX + (i + 0.5) * grid.cellSize,
    y: grid.minY + (j + 0.5) * grid.cellSize,
  };
}

function clampRange(min: number, max: number, lo: number, hi: number): [number, number] {
  return [Math.max(lo, Math.min(hi, min)), Math.max(lo, Math.min(hi, max))];
}

function rasterizePolygon(grid: Grid, polygon: Point2[], target: Uint8Array): void {
  if (polygon.length < 3) return;
  const b = bbox(polygon);
  let [minI, maxI] = clampRange(
    Math.floor((b.minX - grid.minX) / grid.cellSize),
    Math.floor((b.maxX - grid.minX) / grid.cellSize),
    0,
    grid.width - 1,
  );
  let [minJ, maxJ] = clampRange(
    Math.floor((b.minY - grid.minY) / grid.cellSize),
    Math.floor((b.maxY - grid.minY) / grid.cellSize),
    0,
    grid.height - 1,
  );

  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      const p = gridToWorld(grid, i, j);
      if (polygonContains(p, polygon)) target[j * grid.width + i] = 1;
    }
  }
}

function buildGrid(floorPoints: Point2[], cellSize: number): Grid {
  const b = bbox(floorPoints);
  const padding = cellSize * 2;
  const minX = b.minX - padding;
  const minY = b.minY - padding;
  const width = Math.max(1, Math.ceil((b.maxX - b.minX + padding * 2) / cellSize));
  const height = Math.max(1, Math.ceil((b.maxY - b.minY + padding * 2) / cellSize));

  if (width * height > GRID_MAX_CELLS) {
    throw new Error(
      `RoomDetector grid would contain ${(width * height).toLocaleString()} cells; increase CELL_SIZE before continuing.`,
    );
  }

  const size = width * height;
  return {
    minX,
    minY,
    cellSize,
    width,
    height,
    floor: new Uint8Array(size),
    blocked: new Uint8Array(size),
    room: new Int32Array(size).fill(-1),
  };
}

function floodComponents(grid: Grid): Component[] {
  const components: Component[] = [];
  const queue: number[] = [];
  let nextId = 0;

  const pushNeighbors = (idx: number, i: number, j: number, cells: number[]) => {
    const neighbors = [
      i > 0 ? idx - 1 : -1,
      i < grid.width - 1 ? idx + 1 : -1,
      j > 0 ? idx - grid.width : -1,
      j < grid.height - 1 ? idx + grid.width : -1,
    ];
    for (const n of neighbors) {
      if (n < 0) continue;
      if (grid.floor[n] === 0 || grid.blocked[n] !== 0 || grid.room[n] !== -1) continue;
      grid.room[n] = nextId;
      queue.push(n);
      cells.push(n);
    }
  };

  for (let j = 0; j < grid.height; j++) {
    for (let i = 0; i < grid.width; i++) {
      const start = j * grid.width + i;
      if (grid.floor[start] === 0 || grid.blocked[start] !== 0 || grid.room[start] !== -1) continue;

      queue.length = 0;
      const cells: number[] = [start];
      const component: Component = {
        id: nextId,
        cells,
        area: 0,
        minI: i,
        maxI: i,
        minJ: j,
        maxJ: j,
        touchesBoundary: i === 0 || j === 0 || i === grid.width - 1 || j === grid.height - 1,
      };
      grid.room[start] = nextId;
      queue.push(start);

      while (queue.length) {
        const idx = queue.pop()!;
        const ci = idx % grid.width;
        const cj = Math.floor(idx / grid.width);
        component.minI = Math.min(component.minI, ci);
        component.maxI = Math.max(component.maxI, ci);
        component.minJ = Math.min(component.minJ, cj);
        component.maxJ = Math.max(component.maxJ, cj);
        component.touchesBoundary ||= ci === 0 || cj === 0 || ci === grid.width - 1 || cj === grid.height - 1;
        pushNeighbors(idx, ci, cj, cells);
      }

      component.area = cells.length * grid.cellSize * grid.cellSize;
      components.push(component);
      nextId++;
    }
  }

  return components;
}

function boundaryLoops(grid: Grid, cells: number[]): Point2[][] {
  const cellSet = new Set(cells);
  const edges = new Map<string, { a: [number, number]; b: [number, number] }>();
  const has = (i: number, j: number) => cellSet.has(j * grid.width + i);
  const addEdge = (a: [number, number], b: [number, number]) => {
    const key = `${a[0]},${a[1]}|${b[0]},${b[1]}`;
    const reverse = `${b[0]},${b[1]}|${a[0]},${a[1]}`;
    if (edges.has(reverse)) edges.delete(reverse);
    else edges.set(key, { a, b });
  };

  for (const idx of cells) {
    const i = idx % grid.width;
    const j = Math.floor(idx / grid.width);
    if (!has(i, j - 1)) addEdge([i, j], [i + 1, j]);
    if (!has(i + 1, j)) addEdge([i + 1, j], [i + 1, j + 1]);
    if (!has(i, j + 1)) addEdge([i + 1, j + 1], [i, j + 1]);
    if (!has(i - 1, j)) addEdge([i, j + 1], [i, j]);
  }

  const outgoing = new Map<string, [number, number][]>();
  for (const edge of edges.values()) {
    const key = `${edge.a[0]},${edge.a[1]}`;
    const list = outgoing.get(key) ?? [];
    list.push(edge.b);
    outgoing.set(key, list);
  }

  const used = new Set<string>();
  const loops: Point2[][] = [];
  const edgeKey = (a: [number, number], b: [number, number]) => `${a[0]},${a[1]}|${b[0]},${b[1]}`;

  for (const edge of edges.values()) {
    const startKey = edgeKey(edge.a, edge.b);
    if (used.has(startKey)) continue;
    const loop: Point2[] = [];
    let a = edge.a;
    let b = edge.b;
    loop.push(gridVertexToWorld(grid, a));
    used.add(startKey);

    for (let guard = 0; guard < edges.size + 10; guard++) {
      loop.push(gridVertexToWorld(grid, b));
      if (b[0] === a[0] && b[1] === a[1]) break;
      const candidates = outgoing.get(`${b[0]},${b[1]}`) ?? [];
      const next = candidates.find((candidate) => !used.has(edgeKey(b, candidate)));
      if (!next) break;
      used.add(edgeKey(b, next));
      a = b;
      b = next;
    }

    if (loop.length >= 4) loops.push(simplifyCollinear(loop));
  }

  loops.sort((a, b) => Math.abs(polygonArea2D(b)) - Math.abs(polygonArea2D(a)));
  return loops;
}

function gridVertexToWorld(grid: Grid, point: [number, number]): Point2 {
  return {
    x: grid.minX + point[0] * grid.cellSize,
    y: grid.minY + point[1] * grid.cellSize,
  };
}

function simplifyCollinear(points: Point2[]): Point2[] {
  if (points.length <= 4) return points;
  const out: Point2[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    const ax = curr.x - prev.x;
    const ay = curr.y - prev.y;
    const bx = next.x - curr.x;
    const by = next.y - curr.y;
    if (Math.abs(ax * by - ay * bx) > 1e-9) out.push(curr);
  }
  return out;
}

function polygonArea2D(points: Point2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function ifcToFrontend(p: Point2, floorY: number): RoomPolygonPoint {
  // web-ifc flatTransformation is already the same Y-up scene frame consumed by
  // the existing compiler (see geometry.ts). Do not apply a second Z-up -> Y-up
  // conversion here. Horizontal IFC-domain geometry is represented by X/Z and
  // vertical elevation is Y.
  return { x: p.x, y: floorY, z: p.y };
}

function pointDistance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function elementFromLine(ifc: IfcAPI, modelId: number, expressId: number, sourceFile: string, prefix: string): ElementFootprint | null {
  const line: any = ifc.GetLine(modelId, expressId);
  const globalId = lineGlobalId(line);
  const name = lineName(line);
  const points: Point2[] = [];

  return {
    key: `${prefix}:${expressId}`,
    sourceFile,
    expressId,
    globalId,
    name,
    points,
    center: { x: 0, y: 0 },
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    sizeX: 0,
    sizeY: 0,
  };
}

function addPoint(element: ElementFootprint, p: Point3) {
  // Room topology lives in the horizontal X/Z plane of the web-ifc world frame.
  const point = { x: p.x, y: p.z };
  element.points.push(point);
  element.minX = Math.min(element.minX, p.x);
  element.maxX = Math.max(element.maxX, p.x);
  element.minY = Math.min(element.minY, p.y);
  element.maxY = Math.max(element.maxY, p.y);
}

function finalizeElement(element: ElementFootprint): ElementFootprint | null {
  const unique = hull(element.points);
  if (unique.length < 3) return null;
  element.points = unique;
  element.center = centroid(unique);
  element.sizeX = element.maxX - element.minX;
  element.sizeY = element.maxY - element.minY;
  return element;
}

async function bytesFor(filePath: string): Promise<Uint8Array> {
  const raw = fs.readFileSync(filePath);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function resolveJobRelativeSource(jobDirectory: string, src: string): string | null {
  try {
    const url = new URL(src);
    if (url.pathname.startsWith("/jobs/")) {
      const match = url.pathname.match(/^\/jobs\/([^/]+)\/(.+)$/);
      if (!match) return null;
      const jobId = match[1];
      const relative = match[2];
      const current = path.join(jobDirectory, relative);
      if (fs.existsSync(current)) return current;
      const sibling = path.join(path.dirname(jobDirectory), jobId, relative);
      return fs.existsSync(sibling) ? sibling : null;
    }
    if (url.pathname.startsWith("/assets/")) {
      const candidate = path.join(path.dirname(jobDirectory), "assets", path.basename(url.pathname));
      return fs.existsSync(candidate) ? candidate : null;
    }
  } catch {
    // Relative paths below are handled directly.
  }

  if (path.isAbsolute(src) && fs.existsSync(src)) return src;
  const candidate = path.join(jobDirectory, src.replace(/^\/+/, ""));
  return fs.existsSync(candidate) ? candidate : null;
}

async function collectElements(
  ifc: IfcAPI,
  modelId: number,
  sourceFile: string,
  prefix: string,
  targetIds: Set<number>,
  retainWithoutGeometry = false,
): Promise<Map<number, ElementFootprint>> {
  const elements = new Map<number, ElementFootprint>();
  for (const id of targetIds) {
    const element = elementFromLine(ifc, modelId, id, sourceFile, prefix);
    if (element) elements.set(id, element);
  }

  if (!elements.size) return elements;

  ifc.StreamAllMeshes(modelId, (flatMesh: any) => {
    const element = elements.get(Number(flatMesh.expressID));
    if (!element) return;

    const size = flatMesh.geometries.size();
    for (let g = 0; g < size; g++) {
      const placedGeometry = flatMesh.geometries.get(g);
      const geometry = ifc.GetGeometry(modelId, placedGeometry.geometryExpressID);
      const verticesWasm = ifc.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
      const matrix = Array.from(placedGeometry.flatTransformation) as number[];
      const vertexCount = verticesWasm.length / 6;

      for (let i = 0; i < vertexCount; i++) {
        const x = verticesWasm[i * 6];
        const y = verticesWasm[i * 6 + 1];
        const z = verticesWasm[i * 6 + 2];
        addPoint(element, applyIfcMatrix(x, y, z, matrix));
      }
    }
  });

  for (const [id, element] of elements) {
    const finalized = finalizeElement(element);
    if (!finalized && !retainWithoutGeometry) elements.delete(id);
  }
  return elements;
}

function idsWithType(ifc: IfcAPI, modelId: number, type: number): number[] {
  return Array.from(ifc.GetLineIDsWithType(modelId, type) as any).map(Number);
}

function createRoomObjects(
  components: Component[],
  grid: Grid,
  floorY: number,
  boundaryWallsByComponent: Map<number, string[]>,
): { rooms: DetectedRoom[]; componentToRoom: Map<number, string> } {
  const enclosed = components.filter((component) => !component.touchesBoundary && component.area >= MIN_COMPONENT_AREA);
  const candidates = enclosed.length
    ? enclosed
    : components.filter((component) => component.area >= MIN_COMPONENT_AREA)
        .sort((a, b) => b.area - a.area)
        .slice(0, 1);

  const rooms: DetectedRoom[] = [];
  const componentToRoom = new Map<number, string>();
  let roomIndex = 1;
  for (const component of candidates) {
    const loops = boundaryLoops(grid, component.cells);
    const outer = loops[0] ?? [];
    if (outer.length < 4) continue;

    let cx = 0;
    let cy = 0;
    for (const idx of component.cells) {
      const i = idx % grid.width;
      const j = Math.floor(idx / grid.width);
      const p = gridToWorld(grid, i, j);
      cx += p.x;
      cy += p.y;
    }
    cx /= component.cells.length;
    cy /= component.cells.length;

    const id = `room-${String(roomIndex).padStart(3, "0")}`;
    componentToRoom.set(component.id, id);
    rooms.push({
      id,
      label: `Room ${roomIndex}`,
      source: "wall-topology-grid-v2",
      area: Number(component.area.toFixed(4)),
      center: ifcToFrontend({ x: cx, y: cy }, floorY),
      polygon: outer.map((p) => ifcToFrontend(p, floorY)),
      boundaryWalls: boundaryWallsByComponent.get(component.id) ?? [],
      portals: [],
      touchesFloorBoundary: component.touchesBoundary,
      confidence: component.touchesBoundary ? 0.55 : 0.95,
    });
    roomIndex++;
  }
  return { rooms, componentToRoom };
}

function componentAtWorld(grid: Grid, components: Component[], p: Point2): number | null {
  const [i, j] = worldToGrid(grid, p);
  if (i < 0 || j < 0 || i >= grid.width || j >= grid.height) return null;
  const roomId = grid.room[j * grid.width + i];
  if (roomId < 0) return null;
  const component = components.find((c) => c.id === roomId);
  return component ? component.id : null;
}

function openingNormal(opening: ElementFootprint): Point2 {
  // PCA of the footprint. The long axis is treated as opening width; the perpendicular
  // axis is therefore the side-to-side direction needed to sample adjacent rooms.
  const c = opening.center;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const p of opening.points) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  const major = { x: Math.cos(theta), y: Math.sin(theta) };
  return { x: -major.y, y: major.x };
}

function portalBetweenRoomsWithNormal(
  center: Point2,
  normal: Point2,
  thickness: number,
  grid: Grid,
  components: Component[],
): { roomA: number | null; roomB: number | null } {
  const offset = Math.max(0.08, thickness * 0.65) + grid.cellSize * 3;
  const a = { x: center.x + normal.x * offset, y: center.y + normal.y * offset };
  const b = { x: center.x - normal.x * offset, y: center.y - normal.y * offset };

  return {
    roomA: componentAtWorld(grid, components, a),
    roomB: componentAtWorld(grid, components, b),
  };
}

function portalBetweenRooms(
  opening: ElementFootprint,
  grid: Grid,
  components: Component[],
): { roomA: number | null; roomB: number | null } {
  return portalBetweenRoomsWithNormal(
    opening.center,
    openingNormal(opening),
    Math.max(0.05, Math.min(opening.sizeX, opening.sizeY)),
    grid,
    components,
  );
}

function countNearbyComponentCells(grid: Grid, wall: ElementFootprint, componentId: number, paddingCells = 2): number {
  let [minI, minJ] = worldToGrid(grid, { x: wall.minX, y: wall.minY });
  let [maxI, maxJ] = worldToGrid(grid, { x: wall.maxX, y: wall.maxY });
  minI = Math.max(0, minI - paddingCells);
  minJ = Math.max(0, minJ - paddingCells);
  maxI = Math.min(grid.width - 1, maxI + paddingCells);
  maxJ = Math.min(grid.height - 1, maxJ + paddingCells);

  let count = 0;
  for (let j = minJ; j <= maxJ; j++) {
    const row = j * grid.width;
    for (let i = minI; i <= maxI; i++) {
      if (grid.room[row + i] === componentId) count++;
    }
  }
  return count;
}

function sampleDoorSides(
  center: Point2,
  normal: Point2,
  wallThickness: number,
  grid: Grid,
  components: Component[],
  componentToRoom: Map<number, string>,
): Array<{ offset: number; sampleA: Point2; sampleB: Point2; componentA: number | null; componentB: number | null; roomA: string | null; roomB: string | null }> {
  const base = Math.max(grid.cellSize * 3, wallThickness * 0.75, 0.08);
  const offsets = Array.from(new Set([
    base,
    Math.max(base, wallThickness * 1.5),
    Math.max(base, wallThickness * 2.5),
    Math.max(base, wallThickness * 4),
  ].map((value) => Number(value.toFixed(4)))));

  return offsets.map((offset) => {
    const sampleA = { x: center.x + normal.x * offset, y: center.y + normal.y * offset };
    const sampleB = { x: center.x - normal.x * offset, y: center.y - normal.y * offset };
    const componentA = componentAtWorld(grid, components, sampleA);
    const componentB = componentAtWorld(grid, components, sampleB);
    return {
      offset,
      sampleA,
      sampleB,
      componentA,
      componentB,
      roomA: componentA == null ? null : componentToRoom.get(componentA) ?? null,
      roomB: componentB == null ? null : componentToRoom.get(componentB) ?? null,
    };
  });
}

function point2ToRoomPoint(p: Point2, floorY: number): RoomPolygonPoint {
  return ifcToFrontend(p, floorY);
}

function wallNormal(wall: ElementFootprint): Point2 {
  const points = wall.points;
  if (points.length < 3) return { x: 1, y: 0 };
  let xx = 0;
  let yy = 0;
  let xy = 0;
  const c = wall.center;
  for (const p of points) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  return { x: -Math.sin(theta), y: Math.cos(theta) };
}

function findHostWall(
  activeWallElements: ElementFootprint[],
  allWallElements: ElementFootprint[],
  semanticOpening: SemanticOpening,
): { wall: ElementFootprint | null; source: "active" | "semantic-source" | null } {
  const direct = activeWallElements.find((candidate) =>
    candidate.sourceFile === semanticOpening.sourceFile &&
    candidate.expressId === semanticOpening.hostWallExpressId
  );
  if (direct) return { wall: direct, source: "active" };

  if (semanticOpening.hostWallGlobalId) {
    // For room topology, prefer the original source IFC wall geometry when available.
    // Replacement/isolated IFCs can intentionally carry the same GlobalId but a different
    // local placement/context; using those directly can move the semantic wall to a local
    // origin and corrupt portal sampling.
    const sourceWall = allWallElements.find((candidate) =>
      candidate.sourceFile === semanticOpening.sourceFile &&
      candidate.globalId === semanticOpening.hostWallGlobalId
    );
    if (sourceWall) return { wall: sourceWall, source: "semantic-source" };

    const activeByGlobalId = activeWallElements.find((candidate) =>
      candidate.globalId === semanticOpening.hostWallGlobalId
    );
    if (activeByGlobalId) return { wall: activeByGlobalId, source: "active" };

    const anyByGlobalId = allWallElements.find((candidate) =>
      candidate.globalId === semanticOpening.hostWallGlobalId
    );
    if (anyByGlobalId) return { wall: anyByGlobalId, source: "semantic-source" };
  }

  return { wall: null, source: null };
}

export interface RoomDetectorOptions {
  jobDirectory: string;
}

export class RoomDetector {
  static async run(options: RoomDetectorOptions): Promise<RoomDebugArtifact> {
    const { jobDirectory } = options;
    const inputIfcPath = path.join(jobDirectory, "input.ifc");
    const statePath = path.join(jobDirectory, "project_state.json");
    if (!fs.existsSync(inputIfcPath)) throw new Error(`RoomDetector: input.ifc not found at ${inputIfcPath}`);
    if (!fs.existsSync(statePath)) throw new Error(`RoomDetector: project_state.json not found at ${statePath}`);

    const projectState = readJson(statePath);
    const hiddenWallIds = new Set<string>(
      Object.entries(projectState?.structural_edits ?? {})
        .filter(([, value]: any) => value?.visible === false)
        .map(([id]) => id),
    );

    const replacementSources = new Map<string, string>();
    for (const item of Array.isArray(projectState?.furniture) ? projectState.furniture : []) {
      if (!(item?.isNativeIsolation || item?.nativeSourceId)) continue;
      if (String(item?.fileType ?? "").toLowerCase() !== "ifc") continue;
      const resolved = resolveJobRelativeSource(jobDirectory, String(item?.src ?? ""));
      if (!resolved) continue;
      replacementSources.set(resolved, String(item?.nativeSourceId ?? item?.id ?? "unknown"));
    }

    const ifc = new IfcAPI();
    await ifc.Init();
    const models: SourceModel[] = [];
    const openedModelIds: number[] = [];

    const warnings: string[] = [];
    const sourceFiles: string[] = [];
    const wallElements: ElementFootprint[] = [];
    const allWallElements: ElementFootprint[] = [];
    const openingElements: ElementFootprint[] = [];
    const doorElements: ElementFootprint[] = [];
    const slabElements: ElementFootprint[] = [];
  let semanticOpeningCount = 0;
  let semanticDoorCount = 0;
  const semanticBySource: Array<{ sourceFile: string; wallCount: number; openingCount: number; doorCount: number; slabCount: number }> = [];

    try {
      const baseId = ifc.OpenModel(await bytesFor(inputIfcPath), { COORDINATE_TO_ORIGIN: false });
      openedModelIds.push(baseId);
      models.push({ label: "input.ifc", filePath: inputIfcPath, modelId: baseId, hiddenWallGlobalIds: hiddenWallIds });

      for (const [replacementPath] of replacementSources) {
        const modelId = ifc.OpenModel(await bytesFor(replacementPath), { COORDINATE_TO_ORIGIN: false });
        openedModelIds.push(modelId);
        models.push({
          label: path.basename(replacementPath),
          filePath: replacementPath,
          modelId,
          hiddenWallGlobalIds: new Set(),
        });
      }

      for (const model of models) {
        sourceFiles.push(model.label);
        const wallIds = Array.from(new Set([
          ...idsWithType(ifc, model.modelId, IFCWALL),
          ...idsWithType(ifc, model.modelId, IFCWALLSTANDARDCASE),
        ]));
        const openingIds = idsWithType(ifc, model.modelId, IFCOPENINGELEMENT);
        const doorIds = idsWithType(ifc, model.modelId, IFCDOOR);
        semanticOpeningCount += openingIds.length;
        semanticDoorCount += doorIds.length;
        const slabIds = model === models[0] ? idsWithType(ifc, model.modelId, IFCSLAB) : [];
        semanticBySource.push({ sourceFile: model.label, wallCount: wallIds.length, openingCount: openingIds.length, doorCount: doorIds.length, slabCount: slabIds.length });

        const walls = await collectElements(ifc, model.modelId, model.filePath, model.label, new Set(wallIds));
        for (const element of walls.values()) {
          allWallElements.push(element);
          if (element.globalId && model.hiddenWallGlobalIds.has(element.globalId) && model === models[0]) continue;
          wallElements.push(element);
        }

        const openings = await collectElements(ifc, model.modelId, model.filePath, model.label, new Set(openingIds), true);
        openingElements.push(...openings.values());

        const doors = await collectElements(ifc, model.modelId, model.filePath, model.label, new Set(doorIds), true);
        doorElements.push(...doors.values());

        const slabs = await collectElements(ifc, model.modelId, model.filePath, model.label, new Set(slabIds));
        slabElements.push(...slabs.values());
      }

      const semanticOpenings: SemanticOpening[] = [];
      const semanticDoors: SemanticDoor[] = [];
      for (const model of models) {
        // Semantic relationships must resolve against the COMPLETE wall set in the
        // source IFC, including walls hidden/replaced in the active render scene.
        // The active wall geometry is resolved later by GlobalId.
        const allWallIds = Array.from(new Set([
          ...idsWithType(ifc, model.modelId, IFCWALL),
          ...idsWithType(ifc, model.modelId, IFCWALLSTANDARDCASE),
        ]));
        const semanticWallByExpressId = new Map<number, Pick<ElementFootprint, "globalId">>();
        for (const wallExpressId of allWallIds) {
          const wallLine = ifc.GetLine(model.modelId, wallExpressId);
          semanticWallByExpressId.set(wallExpressId, { globalId: lineGlobalId(wallLine) });
        }
        const modelOpeningIds = new Set(idsWithType(ifc, model.modelId, IFCOPENINGELEMENT));
        const modelDoorIds = new Set(idsWithType(ifc, model.modelId, IFCDOOR));
        const links = collectSemanticRelationships(
          ifc,
          model.modelId,
          model.label,
          semanticWallByExpressId,
          modelOpeningIds,
          modelDoorIds,
        );
        semanticOpenings.push(...links.openings);
        semanticDoors.push(...links.doors);
      }

      if (!slabElements.length) warnings.push("No IfcSlab geometry was found; room domain could not use a slab footprint.");
      if (!wallElements.length) throw new Error("RoomDetector: no wall geometry found.");
      if (!slabElements.length) throw new Error("RoomDetector: no slab geometry found.");
      if (semanticOpeningCount === 0) warnings.push("No IFCOPENINGELEMENT semantic entities were discovered in the active IFC sources.");
      if (semanticDoorCount === 0) warnings.push("No IFCDOOR semantic entities were discovered in the active IFC sources.");

      const floorPoints = slabElements.flatMap((s) => s.points);
      // We need the actual scene-frame vertical coordinate. Web-IFC's flatTransformation
      // already produces the Y-up coordinates consumed by the compiler.
      let actualFloorY = 0;
      const slabIds = Array.from(new Set(idsWithType(ifc, models[0].modelId, IFCSLAB)));
      if (slabIds.length) {
        const slabZs: number[] = [];
        ifc.StreamAllMeshes(models[0].modelId, (flatMesh: any) => {
          if (!slabIds.includes(Number(flatMesh.expressID))) return;
          const size = flatMesh.geometries.size();
          for (let g = 0; g < size; g++) {
            const placedGeometry = flatMesh.geometries.get(g);
            const geometry = ifc.GetGeometry(models[0].modelId, placedGeometry.geometryExpressID);
            const verticesWasm = ifc.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            const matrix = Array.from(placedGeometry.flatTransformation) as number[];
            for (let i = 0; i < verticesWasm.length / 6; i++) {
              const p = applyIfcMatrix(verticesWasm[i * 6], verticesWasm[i * 6 + 1], verticesWasm[i * 6 + 2], matrix);
              slabZs.push(p.y);
            }
          }
        });
        if (slabZs.length) actualFloorY = Math.min(...slabZs);
      }

      const grid = buildGrid(floorPoints, CELL_SIZE);
      const slabHull = hull(floorPoints);
      rasterizePolygon(grid, slabHull, grid.floor);

      // Walls define semantic room boundaries. For room partitioning, an actual door
      // is temporarily sealed so the two sides become distinct candidate rooms. The
      // corresponding opening/door relationship is then used as the portal between
      // those rooms. This keeps physical room semantics separate from walkability.
      for (const wall of wallElements) rasterizePolygon(grid, wall.points, grid.blocked);

      const sealableDoors = semanticOpenings
        .filter((opening) => opening.doorExpressId != null)
        .map((opening) => {
          const door = semanticDoors.find((d) => d.expressId === opening.doorExpressId && d.sourceFile === opening.sourceFile);
          if (!door) return null;
          const placement = extractPlacementPoint(ifc, models.find((m) => m.label === opening.sourceFile)?.modelId ?? 0, door.objectPlacementExpressId);
          return { opening, door, placement };
        })
        .filter((value): value is { opening: SemanticOpening; door: SemanticDoor; placement: Point3 } => Boolean(value?.placement));

      for (const sealed of sealableDoors) {
        const wall = sealed.opening.hostWallExpressId == null
          ? null
          : wallElements.find((candidate) => candidate.sourceFile === sealed.opening.sourceFile && candidate.expressId === sealed.opening.hostWallExpressId);
        if (!wall) continue;

        const wallWidth = Math.min(wall.sizeX || Infinity, wall.sizeY || Infinity);
        const width = Math.max(grid.cellSize * 2, sealed.door.width ?? grid.cellSize * 8);
        const depth = Number.isFinite(wallWidth) && wallWidth > 0 ? wallWidth + ROOM_SEAL_PADDING * 2 : grid.cellSize * 4;
        const center = { x: sealed.placement.x, y: sealed.placement.z };
        const horizontal = wall.sizeX >= wall.sizeY;
        const halfWidth = width * 0.5;
        const halfDepth = depth * 0.5;
        const rect: Point2[] = horizontal
          ? [
              { x: center.x - halfWidth, y: center.y - halfDepth },
              { x: center.x + halfWidth, y: center.y - halfDepth },
              { x: center.x + halfWidth, y: center.y + halfDepth },
              { x: center.x - halfWidth, y: center.y + halfDepth },
            ]
          : [
              { x: center.x - halfDepth, y: center.y - halfWidth },
              { x: center.x + halfDepth, y: center.y - halfWidth },
              { x: center.x + halfDepth, y: center.y + halfWidth },
              { x: center.x - halfDepth, y: center.y + halfWidth },
            ];
        rasterizePolygon(grid, rect, grid.blocked);
      }

      const components = floodComponents(grid);

      const boundaryWallsByComponent = new Map<number, string[]>();
      for (const wall of wallElements) {
        for (const component of components) {
          const center = wall.center;
          const [i, j] = worldToGrid(grid, center);
          const candidates = [
            [i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1],
          ];
          for (const [ci, cj] of candidates) {
            if (ci < 0 || cj < 0 || ci >= grid.width || cj >= grid.height) continue;
            const id = grid.room[cj * grid.width + ci];
            if (id === component.id) {
              const list = boundaryWallsByComponent.get(component.id) ?? [];
              const wallId = wall.globalId ?? `${wall.sourceFile}:${wall.expressId}`;
              if (!list.includes(wallId)) list.push(wallId);
              boundaryWallsByComponent.set(component.id, list);
            }
          }
        }
      }

      const { rooms, componentToRoom } = createRoomObjects(components, grid, actualFloorY, boundaryWallsByComponent);

      const portals: RoomPortal[] = [];
      for (const semanticOpening of semanticOpenings) {
        const model = models.find((m) => m.label === semanticOpening.sourceFile);
        if (!model || semanticOpening.hostWallExpressId == null) continue;

        const door = semanticOpening.doorExpressId == null
          ? null
          : semanticDoors.find((candidate) => candidate.sourceFile === semanticOpening.sourceFile && candidate.expressId === semanticOpening.doorExpressId) ?? null;
        const placement = door
          ? extractPlacementPoint(ifc, model.modelId, door.objectPlacementExpressId)
          : null;
        const center = placement
          ? { x: placement.x, y: placement.z }
          : (() => {
              const geom = openingElements.find((e) => e.sourceFile === semanticOpening.sourceFile && e.expressId === semanticOpening.openingExpressId);
              return geom?.center ?? null;
            })();
        if (!center) continue;

        const hostWallResolution = findHostWall(wallElements, allWallElements, semanticOpening);
        const hostWall = hostWallResolution.wall;
        if (!hostWall) continue;

        const normal = wallNormal(hostWall);
        const wallThickness = Math.max(0.05, Math.min(hostWall.sizeX, hostWall.sizeY));
        const { roomA: componentA, roomB: componentB } = portalBetweenRoomsWithNormal(
          center,
          normal,
          wallThickness,
          grid,
          components,
        );
        const roomA = componentA == null ? null : componentToRoom.get(componentA) ?? null;
        const roomB = componentB == null ? null : componentToRoom.get(componentB) ?? null;
        if (!roomA || !roomB || roomA === roomB) continue;

        const associationMethod: RoomPortal["associationMethod"] = door
          ? "ifc-rel-fills"
          : "ifc-rel-voids";
        const id = `portal-${semanticOpening.sourceFile}-${semanticOpening.openingExpressId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
        portals.push({
          id,
          type: door ? "door" : "opening",
          source: "ifc-opening",
          openingExpressId: semanticOpening.openingExpressId,
          sourceFile: semanticOpening.sourceFile,
          center: ifcToFrontend(center, actualFloorY),
          roomA,
          roomB,
          hostWallId: semanticOpening.hostWallGlobalId,
          doorExpressId: semanticOpening.doorExpressId,
          doorGlobalId: semanticOpening.doorGlobalId,
          associationMethod,
        });
      }

      const portalByRoom = new Map<string, string[]>();
      for (const portal of portals) {
        for (const roomId of [portal.roomA, portal.roomB]) {
          if (!roomId) continue;
          const list = portalByRoom.get(roomId) ?? [];
          list.push(portal.id);
          portalByRoom.set(roomId, list);
        }
      }
      for (const room of rooms) room.portals = portalByRoom.get(room.id) ?? [];

      const componentDiagnostics = makeComponentDiagnostics(components, componentToRoom);

      const boundaryWallDescriptors = wallElements.map((wall) => ({
        id: wall.globalId ?? `${wall.sourceFile}:${wall.expressId}`,
        center: wall.center,
        roomAdjacencyCount: Math.max(
          ...components.map((component) => countNearbyComponentCells(grid, wall, component.id)),
          0,
        ),
      }));
      const roomBoundaryCandidates = makeRoomBoundaryCandidateDiagnostics(rooms, boundaryWallDescriptors);

      const doorDiagnostics = semanticDoors.map((door) => {
        const opening = semanticOpenings.find(
          (candidate) => candidate.sourceFile === door.sourceFile && candidate.doorExpressId === door.expressId,
        ) ?? null;
        const model = models.find((candidate) => candidate.label === door.sourceFile);
        const placement = model ? extractPlacementPoint(ifc, model.modelId, door.objectPlacementExpressId) : null;
        const openingPlacement = opening && model
          ? extractPlacementPoint(ifc, model.modelId, lineRefId(ifc.GetLine(model.modelId, opening.openingExpressId), "ObjectPlacement"))
          : null;
        const effectivePlacement = openingPlacement ?? placement;
        const center = effectivePlacement ? { x: effectivePlacement.x, y: effectivePlacement.z } : null;
        const hostWallResolution = opening
          ? findHostWall(wallElements, allWallElements, opening)
          : { wall: null, source: null as "active" | "semantic-source" | null };
        const hostWall = hostWallResolution.wall;
        const normal = hostWall ? wallNormal(hostWall) : null;
        const thickness = hostWall ? Math.max(0.05, Math.min(hostWall.sizeX, hostWall.sizeY)) : 0.05;
        const sampleSweep = center && normal
          ? sampleDoorSides(center, normal, thickness, grid, components, componentToRoom).map((sample) => ({
              offset: sample.offset,
              sampleA: point2ToRoomPoint(sample.sampleA, actualFloorY),
              sampleB: point2ToRoomPoint(sample.sampleB, actualFloorY),
              componentA: sample.componentA,
              componentB: sample.componentB,
              roomA: sample.roomA,
              roomB: sample.roomB,
            }))
          : [];

        const candidate = sampleSweep.some((sample) => Boolean(sample.roomA && sample.roomB && sample.roomA !== sample.roomB));
        let failureReason: string | null = null;
        if (!opening) failureReason = "door-has-no-ifc-rel-fills-opening";
        else if (!hostWall) failureReason = "opening-host-wall-not-found-in-active-wall-set";
        else if (!center) failureReason = "door-object-placement-could-not-be-resolved";
        else if (!normal) failureReason = "host-wall-normal-could-not-be-derived";
        else if (!sampleSweep.length) failureReason = "no-side-samples-generated";
        else if (!candidate) {
          const hasTwoComponents = sampleSweep.some((sample) =>
            sample.componentA != null && sample.componentB != null && sample.componentA !== sample.componentB,
          );
          failureReason = hasTwoComponents
            ? "two-side-components-found-but-not-both-retained-as-rooms"
            : "door-side-samples-do-not-hit-two-distinct-components";
        }

        return makeDoorDiagnostic({
          sourceFile: door.sourceFile,
          doorExpressId: door.expressId,
          doorGlobalId: door.globalId,
          openingExpressId: opening?.openingExpressId ?? null,
          openingGlobalId: opening?.openingGlobalId ?? null,
          hostWallExpressId: opening?.hostWallExpressId ?? null,
          hostWallGlobalId: opening?.hostWallGlobalId ?? null,
          resolvedActiveHostWallGlobalId: hostWall?.globalId ?? null,
          resolvedActiveHostWallSourceFile: hostWall?.sourceFile ?? null,
          center: effectivePlacement ? { x: effectivePlacement.x, y: effectivePlacement.y, z: effectivePlacement.z } : null,
          wallNormal: normal,
          wallSize: hostWall ? { x: hostWall.sizeX, y: hostWall.sizeY } : null,
          doorWidth: door.width,
          sampleSweep,
          portalCandidate: candidate,
          failureReason,
        });
      });

      const blockedCellCount = grid.blocked.reduce((sum, value) => sum + (value ? 1 : 0), 0);
      const floorCellCount = grid.floor.reduce((sum, value) => sum + (value ? 1 : 0), 0);
      const artifact: RoomDebugArtifact = {
        version: 1,
        status: "diagnostic",
        coordinateSystem: "web-ifc-world-y-up",
        frontendMapping: "[x, y, z] — no second axis conversion",
        cellSize: CELL_SIZE,
        floorElevation: actualFloorY,
        sourceFiles,
        rooms,
        portals,
        stats: {
          wallElementCount: wallElements.length,
          openingElementCount: semanticOpeningCount,
          doorElementCount: semanticDoorCount,
          floorPointCount: floorPoints.length,
          floorCellCount,
          blockedCellCount,
          componentCount: components.length,
          retainedRoomCount: rooms.length,
          sealedDoorCount: semanticOpenings.filter((opening) => opening.doorExpressId != null).length,
          portalCount: portals.length,
        },
        warnings,
        semantic: {
          bySource: semanticBySource,
          openingGeometryCount: openingElements.filter((e) => e.points.length >= 3).length,
          doorGeometryCount: doorElements.filter((e) => e.points.length >= 3).length,
          voidRelationshipCount: semanticOpenings.filter((opening) => opening.hostWallExpressId != null).length,
          fillRelationshipCount: semanticOpenings.filter((opening) => opening.doorExpressId != null).length,
        },
        diagnostics: {
          components: componentDiagnostics,
          roomBoundaryCandidates,
          doors: doorDiagnostics,
        },
      };

      const debugPath = path.join(jobDirectory, "rooms_debug.json");
      fs.writeFileSync(debugPath, JSON.stringify(artifact, null, 2), "utf8");
      console.log(`[RoomDetector] Wrote ${debugPath} (${rooms.length} rooms, ${portals.length} portals)`);
      return artifact;
    } finally {
      for (const modelId of openedModelIds) {
        try { ifc.CloseModel(modelId); } catch { /* best effort */ }
      }
    }
  }
}
