/**
 * Geometry-first room reconstruction from IFC wall footprints.
 *
 * The detector does not use IfcSpace placement points to create regions. It
 * derives wall centre-lines, nodes their intersections into a planar graph,
 * extracts bounded faces, then associates IFC space identities with those
 * already-existing faces. A placement point can therefore be wrong without
 * making the physical room disappear.
 */

export interface PlanarPoint {
  x: number;
  y: number;
}

export interface WallFootprint {
  id: string;
  points: PlanarPoint[];
}

export interface SemanticRoomPoint {
  key: string;
  label: string;
  x: number;
  y: number;
  globalId?: string | null;
  expressId?: number;
  description?: string;
  elevationY?: number;
  hasGeometryRepresentation?: boolean;
  explicitPolygon?: PlanarPoint[] | null;
  explicitPolygonSource?: "ifc-space-step-profile" | "ifc-space-body-envelope";
  sourceX?: number;
  sourceY?: number;
}

export interface PlanarRoomFace {
  polygon: PlanarPoint[];
  areaM2: number;
  perimeterM: number;
  center: PlanarPoint;
  boundaryWallIds: string[];
  confidence: number;
  geometrySource?: "wall-face-reconstruction" | "ifc-space-body-envelope" | "ifc-space-step-profile";
  semanticSpaces: Array<SemanticRoomPoint & { associationDistanceMeters: number; associationMethod: "inside-room-polygon" | "nearest-room-polygon" }>;
}

export interface PlanarRoomReconstruction {
  faces: PlanarRoomFace[];
  wallAxisCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  wallGraphFaceCount: number;
  unmatchedSemanticSpaces: string[];
  warnings: string[];
}

interface WallAxis {
  a: PlanarPoint;
  b: PlanarPoint;
  wallId: string;
  thickness: number;
  splits: number[];
}

interface GraphNode {
  id: number;
  point: PlanarPoint;
  neighbours: number[];
}

interface GraphEdge {
  a: number;
  b: number;
  wallIds: Set<string>;
  thickness: number;
}

interface DirectedBoundaryEdge {
  from: number;
  to: number;
  wallIds: string[];
  thickness: number;
}

const EPS = 1e-8;
const NODE_PRECISION = 1000;
const MIN_WALL_LENGTH = 0.35;
const DEFAULT_MIN_FACE_AREA = 0.35;
const MAX_SEMANTIC_ASSOCIATION_DISTANCE = 3.25;

function cross(a: PlanarPoint, b: PlanarPoint): number {
  return a.x * b.y - a.y * b.x;
}

function subtract(a: PlanarPoint, b: PlanarPoint): PlanarPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function distance(a: PlanarPoint, b: PlanarPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function signedArea(polygon: PlanarPoint[]): number {
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return twiceArea / 2;
}

export function polygonArea(polygon: PlanarPoint[]): number {
  return Math.abs(signedArea(polygon));
}

function polygonCentroid(polygon: PlanarPoint[]): PlanarPoint {
  const area = signedArea(polygon);
  if (Math.abs(area) < EPS) {
    const count = Math.max(1, polygon.length);
    return polygon.reduce((sum, p) => ({ x: sum.x + p.x / count, y: sum.y + p.y / count }), { x: 0, y: 0 });
  }
  let x = 0;
  let y = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const factor = a.x * b.y - b.x * a.y;
    x += (a.x + b.x) * factor;
    y += (a.y + b.y) * factor;
  }
  return { x: x / (6 * area), y: y / (6 * area) };
}

function normalizeRing(points: PlanarPoint[]): PlanarPoint[] {
  const result: PlanarPoint[] = [];
  for (const point of points || []) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    const previous = result[result.length - 1];
    if (!previous || distance(previous, point) > 1e-5) result.push({ x: point.x, y: point.y });
  }
  if (result.length > 1 && distance(result[0], result[result.length - 1]) <= 1e-5) result.pop();
  return result.length >= 3 ? result : [];
}

function pointInPolygon(point: PlanarPoint, polygon: PlanarPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const edge = subtract(a, b);
    const toPoint = subtract(point, b);
    const area = Math.abs(cross(edge, toPoint));
    if (area < 1e-7 && point.x >= Math.min(a.x, b.x) - 1e-7 && point.x <= Math.max(a.x, b.x) + 1e-7
      && point.y >= Math.min(a.y, b.y) - 1e-7 && point.y <= Math.max(a.y, b.y) + 1e-7) return true;
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || EPS) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(point: PlanarPoint, a: PlanarPoint, b: PlanarPoint): number {
  const ab = subtract(b, a);
  const lengthSquared = ab.x * ab.x + ab.y * ab.y;
  if (lengthSquared <= EPS) return distance(point, a);
  const ap = subtract(point, a);
  const t = clamp((ap.x * ab.x + ap.y * ab.y) / lengthSquared, 0, 1);
  return distance(point, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

function pointToPolygonDistance(point: PlanarPoint, polygon: PlanarPoint[]): number {
  if (pointInPolygon(point, polygon)) return 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i++) {
    nearest = Math.min(nearest, pointSegmentDistance(point, polygon[i], polygon[(i + 1) % polygon.length]));
  }
  return nearest;
}

function principalWallAxis(wall: WallFootprint): WallAxis | null {
  const points = normalizeRing(wall.points);
  if (points.length < 3) return null;
  const mean = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }), { x: 0, y: 0 });
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const point of points) {
    const dx = point.x - mean.x;
    const dy = point.y - mean.y;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -direction.y, y: direction.x };
  const along = points.map((p) => p.x * direction.x + p.y * direction.y);
  const across = points.map((p) => p.x * normal.x + p.y * normal.y);
  const minAlong = Math.min(...along);
  const maxAlong = Math.max(...along);
  const minAcross = Math.min(...across);
  const maxAcross = Math.max(...across);
  const length = maxAlong - minAlong;
  const thickness = maxAcross - minAcross;
  if (!Number.isFinite(length) || !Number.isFinite(thickness) || length < MIN_WALL_LENGTH || thickness < 0.015) return null;
  if (length / thickness < 1.18) return null; // columns and bulky fixtures are not room separators

  const acrossCenter = (minAcross + maxAcross) * 0.5;
  const pointAt = (alongValue: number): PlanarPoint => ({
    x: direction.x * alongValue + normal.x * acrossCenter,
    y: direction.y * alongValue + normal.y * acrossCenter,
  });
  return {
    // Keep the axis endpoints at the real wall ends. Extending every axis
    // through every junction turns L/T joins into artificial four-way
    // crossings, which destroys concave faces. Nearby endpoints are joined
    // deliberately in snapWallEndpoints() instead.
    a: pointAt(minAlong),
    b: pointAt(maxAlong),
    wallId: wall.id,
    thickness: clamp(thickness, 0.04, 1.0),
    splits: [0, 1],
  };
}

/**
 * Creates a short, synthetic wall segment across a hosted door opening.
 * The segment intentionally overlaps the host wall on both sides so a door
 * aperture does not disconnect the planar graph and merge two adjacent rooms.
 */
export function createDoorGapClosureFootprint(
  hostWall: WallFootprint,
  openingCenter: PlanarPoint,
  openingWidthM: number,
  id: string,
): WallFootprint | null {
  const axis = principalWallAxis(hostWall);
  if (!axis || !Number.isFinite(openingCenter?.x) || !Number.isFinite(openingCenter?.y)) return null;
  const direction = subtract(axis.b, axis.a);
  const length = Math.hypot(direction.x, direction.y);
  if (length <= EPS) return null;
  const along = { x: direction.x / length, y: direction.y / length };
  const normal = { x: -along.y, y: along.x };
  const offset = subtract(openingCenter, axis.a);
  const centerAlong = offset.x * along.x + offset.y * along.y;
  const center = {
    x: axis.a.x + along.x * centerAlong,
    y: axis.a.y + along.y * centerAlong,
  };
  const halfLength = Math.max(0.6, Number(openingWidthM) || 0.9) * 0.5
    + Math.max(0.15, axis.thickness * 0.75);
  const halfThickness = clamp(axis.thickness * 0.5, 0.04, 0.35);
  const point = (alongOffset: number, normalOffset: number): PlanarPoint => ({
    x: center.x + along.x * alongOffset + normal.x * normalOffset,
    y: center.y + along.y * alongOffset + normal.y * normalOffset,
  });
  return {
    id,
    points: [
      point(-halfLength, -halfThickness),
      point(halfLength, -halfThickness),
      point(halfLength, halfThickness),
      point(-halfLength, halfThickness),
    ],
  };
}

function addSplit(segment: WallAxis, t: number): void {
  if (t >= -1e-7 && t <= 1 + 1e-7 && Number.isFinite(t)) segment.splits.push(clamp(t, 0, 1));
}

function projectToSegment(point: PlanarPoint, axis: WallAxis): { point: PlanarPoint; t: number; distance: number } {
  const direction = subtract(axis.b, axis.a);
  const lengthSquared = direction.x * direction.x + direction.y * direction.y;
  if (lengthSquared <= EPS) return { point: axis.a, t: 0, distance: distance(point, axis.a) };
  const offset = subtract(point, axis.a);
  const t = clamp((offset.x * direction.x + offset.y * direction.y) / lengthSquared, 0, 1);
  const projected = { x: axis.a.x + direction.x * t, y: axis.a.y + direction.y * t };
  return { point: projected, t, distance: distance(point, projected) };
}

function setAxisEndpoint(axis: WallAxis, endpoint: "a" | "b", point: PlanarPoint): void {
  axis[endpoint] = { x: point.x, y: point.y };
}

/**
 * Connect wall ends that stop at the face/centreline of a perpendicular wall.
 * This is intentionally endpoint-aware: an L join stays an L, a T join stays
 * a T, and only a genuine interior/interior crossing becomes a four-way node.
 */
function snapWallEndpoints(axes: WallAxis[]): void {
  for (let i = 0; i < axes.length; i++) {
    for (let j = i + 1; j < axes.length; j++) {
      const first = axes[i];
      const second = axes[j];
      const firstDirection = subtract(first.b, first.a);
      const secondDirection = subtract(second.b, second.a);
      const firstLength = Math.hypot(firstDirection.x, firstDirection.y);
      const secondLength = Math.hypot(secondDirection.x, secondDirection.y);
      if (firstLength <= EPS || secondLength <= EPS) continue;
      // Parallel/collinear wall runs are handled as overlaps by the ordinary
      // intersection pass. Endpoint snapping is for actual junctions only.
      const normalizedCross = Math.abs(cross(firstDirection, secondDirection)) / (firstLength * secondLength);
      if (normalizedCross < 0.08) continue;

      const tolerance = clamp((first.thickness + second.thickness) * 0.5 + 0.02, 0.075, 0.30);
      const endpoints: Array<{ owner: WallAxis; key: "a" | "b"; target: WallAxis }> = [
        { owner: first, key: "a", target: second },
        { owner: first, key: "b", target: second },
        { owner: second, key: "a", target: first },
        { owner: second, key: "b", target: first },
      ];

      for (const item of endpoints) {
        const sourcePoint = item.owner[item.key];
        const projected = projectToSegment(sourcePoint, item.target);
        if (projected.distance > tolerance) continue;

        const targetIsEndpoint = projected.t <= 1e-5 || projected.t >= 1 - 1e-5;
        if (targetIsEndpoint) {
          const targetKey = projected.t <= 1e-5 ? "a" : "b";
          const targetPoint = item.target[targetKey];
          const joined = {
            x: (sourcePoint.x + targetPoint.x) * 0.5,
            y: (sourcePoint.y + targetPoint.y) * 0.5,
          };
          setAxisEndpoint(item.owner, item.key, joined);
          setAxisEndpoint(item.target, targetKey, joined);
        } else {
          setAxisEndpoint(item.owner, item.key, projected.point);
          addSplit(item.target, projected.t);
        }
      }
    }
  }
}

function splitAtIntersection(first: WallAxis, second: WallAxis): void {
  const p = first.a;
  const r = subtract(first.b, first.a);
  const q = second.a;
  const s = subtract(second.b, second.a);
  const denominator = cross(r, s);
  const qMinusP = subtract(q, p);
  if (Math.abs(denominator) > 1e-9) {
    const t = cross(qMinusP, s) / denominator;
    const u = cross(qMinusP, r) / denominator;
    if (t >= -1e-7 && t <= 1 + 1e-7 && u >= -1e-7 && u <= 1 + 1e-7) {
      addSplit(first, t);
      addSplit(second, u);
    }
    return;
  }
  if (Math.abs(cross(qMinusP, r)) > 1e-7) return; // parallel, not collinear
  const rLengthSquared = r.x * r.x + r.y * r.y;
  const sLengthSquared = s.x * s.x + s.y * s.y;
  if (rLengthSquared <= EPS || sLengthSquared <= EPS) return;
  addSplit(first, ((second.a.x - p.x) * r.x + (second.a.y - p.y) * r.y) / rLengthSquared);
  addSplit(first, ((second.b.x - p.x) * r.x + (second.b.y - p.y) * r.y) / rLengthSquared);
  addSplit(second, ((first.a.x - q.x) * s.x + (first.a.y - q.y) * s.y) / sLengthSquared);
  addSplit(second, ((first.b.x - q.x) * s.x + (first.b.y - q.y) * s.y) / sLengthSquared);
}

function nodeKey(point: PlanarPoint): string {
  return `${Math.round(point.x * NODE_PRECISION)}:${Math.round(point.y * NODE_PRECISION)}`;
}

function intersectInfiniteLines(a: PlanarPoint, b: PlanarPoint, c: PlanarPoint, d: PlanarPoint): PlanarPoint | null {
  const r = subtract(b, a);
  const s = subtract(d, c);
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-8) return null;
  const t = cross(subtract(c, a), s) / denominator;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

function insetFace(points: PlanarPoint[], edges: DirectedBoundaryEdge[]): PlanarPoint[] {
  const shifted = edges.map((edge, index) => {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.max(EPS, Math.hypot(dx, dy));
    // Faces are traversed counter-clockwise; their interior is on each edge's left.
    const inset = clamp(edge.thickness * 0.5, 0.012, 0.32);
    const nx = -dy / length;
    const ny = dx / length;
    return {
      a: { x: a.x + nx * inset, y: a.y + ny * inset },
      b: { x: b.x + nx * inset, y: b.y + ny * inset },
    };
  });
  const result: PlanarPoint[] = [];
  for (let i = 0; i < shifted.length; i++) {
    const previous = shifted[(i - 1 + shifted.length) % shifted.length];
    const current = shifted[i];
    const intersection = intersectInfiniteLines(previous.a, previous.b, current.a, current.b);
    result.push(intersection || {
      x: (previous.b.x + current.a.x) * 0.5,
      y: (previous.b.y + current.a.y) * 0.5,
    });
  }
  return normalizeRing(result);
}

function canonicalRingKey(points: PlanarPoint[]): string {
  const keys = points.map((point) => `${Math.round(point.x * 100)}:${Math.round(point.y * 100)}`);
  if (!keys.length) return "";
  const rotations = keys.map((_, index) => keys.slice(index).concat(keys.slice(0, index)).join("|"));
  return rotations.sort()[0];
}

function buildGraph(axes: WallAxis[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeByKey = new Map<string, GraphNode>();
  const edgesByKey = new Map<string, GraphEdge>();
  const getNode = (point: PlanarPoint): GraphNode => {
    const key = nodeKey(point);
    let node = nodeByKey.get(key);
    if (!node) {
      node = { id: nodeByKey.size, point: { x: Math.round(point.x * NODE_PRECISION) / NODE_PRECISION, y: Math.round(point.y * NODE_PRECISION) / NODE_PRECISION }, neighbours: [] };
      nodeByKey.set(key, node);
    }
    return node;
  };

  for (const axis of axes) {
    const sorted = axis.splits.sort((a, b) => a - b).filter((value, index, values) => index === 0 || Math.abs(value - values[index - 1]) > 1e-7);
    const direction = subtract(axis.b, axis.a);
    for (let i = 0; i < sorted.length - 1; i++) {
      const t0 = sorted[i];
      const t1 = sorted[i + 1];
      if (t1 - t0 < 1e-7) continue;
      const start = { x: axis.a.x + direction.x * t0, y: axis.a.y + direction.y * t0 };
      const end = { x: axis.a.x + direction.x * t1, y: axis.a.y + direction.y * t1 };
      if (distance(start, end) < 0.025) continue;
      const startNode = getNode(start);
      const endNode = getNode(end);
      if (startNode.id === endNode.id) continue;
      const a = Math.min(startNode.id, endNode.id);
      const b = Math.max(startNode.id, endNode.id);
      const key = `${a}:${b}`;
      const existing = edgesByKey.get(key);
      if (existing) {
        existing.wallIds.add(axis.wallId);
        existing.thickness = Math.max(existing.thickness, axis.thickness);
      } else {
        edgesByKey.set(key, { a, b, wallIds: new Set([axis.wallId]), thickness: axis.thickness });
      }
    }
  }

  const nodes = Array.from(nodeByKey.values());
  const edges = Array.from(edgesByKey.values());
  for (const edge of edges) {
    nodes[edge.a].neighbours.push(edge.b);
    nodes[edge.b].neighbours.push(edge.a);
  }
  for (const node of nodes) {
    node.neighbours.sort((a, b) => {
      const pa = nodes[a].point;
      const pb = nodes[b].point;
      return Math.atan2(pa.y - node.point.y, pa.x - node.point.x) - Math.atan2(pb.y - node.point.y, pb.x - node.point.x);
    });
  }
  return { nodes, edges };
}

function extractFaces(nodes: GraphNode[], edges: GraphEdge[], minFaceAreaM2: number): PlanarRoomFace[] {
  const edgeLookup = new Map<string, GraphEdge>();
  for (const edge of edges) edgeLookup.set(`${Math.min(edge.a, edge.b)}:${Math.max(edge.a, edge.b)}`, edge);
  const visited = new Set<string>();
  const faces: PlanarRoomFace[] = [];
  const faceKeys = new Set<string>();

  const getDirectedEdge = (from: number, to: number): DirectedBoundaryEdge | null => {
    const edge = edgeLookup.get(`${Math.min(from, to)}:${Math.max(from, to)}`);
    return edge ? { from, to, wallIds: Array.from(edge.wallIds), thickness: edge.thickness } : null;
  };

  for (const edge of edges) {
    for (const [startFrom, startTo] of [[edge.a, edge.b], [edge.b, edge.a]] as const) {
      const startKey = `${startFrom}>${startTo}`;
      if (visited.has(startKey)) continue;
      let from = startFrom;
      let to = startTo;
      const points: PlanarPoint[] = [];
      const boundaryEdges: DirectedBoundaryEdge[] = [];
      let closed = false;
      const safetyLimit = Math.max(16, edges.length * 2 + 4);

      for (let step = 0; step < safetyLimit; step++) {
        const directedKey = `${from}>${to}`;
        if (visited.has(directedKey)) {
          closed = from === startFrom && to === startTo;
          break;
        }
        visited.add(directedKey);
        points.push(nodes[from].point);
        const directed = getDirectedEdge(from, to);
        if (directed) boundaryEdges.push(directed);

        const outgoing = nodes[to]?.neighbours || [];
        const reverseIndex = outgoing.indexOf(from);
        if (reverseIndex < 0 || outgoing.length < 2) break;
        // The previous CCW neighbour from the reverse edge keeps the walked
        // face on the left. Positive-area cycles are bounded interior faces.
        const next = outgoing[(reverseIndex - 1 + outgoing.length) % outgoing.length];
        from = to;
        to = next;
        if (from === startFrom && to === startTo) {
          closed = true;
          break;
        }
      }
      if (!closed || points.length < 3 || boundaryEdges.length !== points.length) continue;
      const centerlineArea = signedArea(points);
      if (centerlineArea <= 1e-5) continue; // ignore the unbounded exterior cycle
      const key = canonicalRingKey(points);
      if (!key || faceKeys.has(key)) continue;
      faceKeys.add(key);

      const inset = insetFace(points, boundaryEdges);
      const usable = inset.length >= 3 && polygonArea(inset) >= minFaceAreaM2 ? inset : points;
      const areaM2 = polygonArea(usable);
      if (areaM2 < minFaceAreaM2) continue;
      const center = polygonCentroid(usable);

      const boundaryWallIds = Array.from(new Set(boundaryEdges.flatMap((item) => item.wallIds))).sort();
      const confidence = clamp(0.72 + Math.min(0.18, boundaryWallIds.length * 0.018), 0.72, 0.94);
      const perimeterM = usable.reduce((sum, point, index) => sum + distance(point, usable[(index + 1) % usable.length]), 0);
      faces.push({
        polygon: usable,
        areaM2: Number(areaM2.toFixed(4)),
        perimeterM: Number(perimeterM.toFixed(4)),
        center,
        boundaryWallIds,
        confidence,
        geometrySource: "wall-face-reconstruction",
        semanticSpaces: [],
      });
    }
  }
  return faces.sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x || b.areaM2 - a.areaM2);
}

function associateSemanticSpaces(
  faces: PlanarRoomFace[],
  semanticSpaces: SemanticRoomPoint[],
  maxDistance = MAX_SEMANTIC_ASSOCIATION_DISTANCE,
  alreadyAssigned = new Set<string>(),
): string[] {
  const unmatched: string[] = [];
  for (const space of semanticSpaces) {
    const key = space.globalId || space.key;
    if (alreadyAssigned.has(key)) continue;
    if (!Number.isFinite(space.x) || !Number.isFinite(space.y)) {
      unmatched.push(space.label || space.key);
      continue;
    }
    const ranked = faces.map((face, index) => ({
      face,
      index,
      distance: pointToPolygonDistance({ x: space.x, y: space.y }, face.polygon),
      centerDistance: distance({ x: space.x, y: space.y }, face.center),
    })).sort((a, b) => a.distance - b.distance || a.centerDistance - b.centerDistance);
    const match = ranked[0];
    if (!match || match.distance > maxDistance) {
      unmatched.push(space.label || space.key);
      continue;
    }
    match.face.semanticSpaces.push({
      ...space,
      associationDistanceMeters: Number(match.distance.toFixed(3)),
      associationMethod: match.distance <= 0.01 ? "inside-room-polygon" : "nearest-room-polygon",
    });
  }
  for (const face of faces) {
    face.semanticSpaces.sort((a, b) => a.associationDistanceMeters - b.associationDistanceMeters || a.label.localeCompare(b.label));
  }
  return unmatched;
}

function perimeter(polygon: PlanarPoint[]): number {
  return polygon.reduce((sum, point, index) => sum + distance(point, polygon[(index + 1) % polygon.length]), 0);
}

function pointInPolygonInterior(point: PlanarPoint, polygon: PlanarPoint[]): boolean {
  for (let i = 0; i < polygon.length; i++) {
    if (pointSegmentDistance(point, polygon[i], polygon[(i + 1) % polygon.length]) <= 1e-7) return false;
  }
  return pointInPolygon(point, polygon);
}

function polygonsOverlap(first: PlanarPoint[], second: PlanarPoint[]): boolean {
  if (first.some((point) => pointInPolygonInterior(point, second)) || second.some((point) => pointInPolygonInterior(point, first))) return true;
  const orientation = (a: PlanarPoint, b: PlanarPoint, c: PlanarPoint) => cross(subtract(b, a), subtract(c, a));
  for (let i = 0; i < first.length; i++) {
    const a = first[i];
    const b = first[(i + 1) % first.length];
    for (let j = 0; j < second.length; j++) {
      const c = second[j];
      const d = second[(j + 1) % second.length];
      const o1 = orientation(a, b, c);
      const o2 = orientation(a, b, d);
      const o3 = orientation(c, d, a);
      const o4 = orientation(c, d, b);
      if (o1 * o2 < -1e-9 && o3 * o4 < -1e-9) return true;
    }
  }
  return false;
}

/**
 * Valid IfcSpace body geometry is the strongest boundary source. The wall
 * graph remains the fallback and also provides physical-room grouping: a
 * smaller semantic space polygon inside a larger wall face labels that face
 * instead of manufacturing an imaginary partition.
 */
function applyExplicitSpaceGeometry(
  faces: PlanarRoomFace[],
  semanticSpaces: SemanticRoomPoint[],
  minFaceAreaM2: number,
): Set<string> {
  const assigned = new Set<string>();
  for (const space of semanticSpaces) {
    const explicit = normalizeRing(space.explicitPolygon || []);
    if (explicit.length < 3 || polygonArea(explicit) < minFaceAreaM2) continue;
    const explicitArea = polygonArea(explicit);
    const explicitCenter = polygonCentroid(explicit);
    const overlappingFaces = faces
      .map((face, index) => ({
        face,
        index,
        centerDistance: distance(explicitCenter, face.center),
        overlaps: polygonsOverlap(explicit, face.polygon),
      }))
      .filter((item) => item.overlaps)
      .sort((a, b) => a.centerDistance - b.centerDistance);
    const candidate = overlappingFaces[0]?.face;

    if (candidate) {
      const areaRatio = explicitArea / Math.max(0.001, candidate.areaM2);
      // When the explicit polygon represents essentially the same enclosed
      // footprint, prefer it. Small polygons inside a larger wall-bounded face
      // are semantic zones and are deliberately not used to split that room.
      // collectElements() currently exposes a convex envelope of the IfcSpace
      // body mesh, not its exact non-convex boundary. Never let that envelope
      // replace a wall-derived outline: doing so would erase L-shaped corners
      // and voids. It remains useful for semantic association only.
      const anchor = Number.isFinite(space.x) && Number.isFinite(space.y)
        ? { x: space.x, y: space.y }
        : explicitCenter;
      const associationDistanceMeters = pointToPolygonDistance(anchor, candidate.polygon);
      candidate.semanticSpaces.push({
        ...space,
        associationDistanceMeters: Number(associationDistanceMeters.toFixed(3)),
        associationMethod: associationDistanceMeters <= 0.01 ? "inside-room-polygon" : "nearest-room-polygon",
      });
    } else {
      const anchor = Number.isFinite(space.x) && Number.isFinite(space.y)
        ? { x: space.x, y: space.y }
        : explicitCenter;
      const associationDistanceMeters = pointToPolygonDistance(anchor, explicit);
      faces.push({
        polygon: explicit,
        areaM2: Number(explicitArea.toFixed(4)),
        perimeterM: Number(perimeter(explicit).toFixed(4)),
        center: explicitCenter,
        boundaryWallIds: [],
        confidence: space.explicitPolygonSource === "ifc-space-step-profile" ? 0.82 : 0.56,
        // Preserve the actual source: an explicit STEP profile is materially
        // stronger than a convex envelope derived from streamed mesh vertices.
        geometrySource: space.explicitPolygonSource || "ifc-space-body-envelope",
        semanticSpaces: [{
          ...space,
          associationDistanceMeters: Number(associationDistanceMeters.toFixed(3)),
          associationMethod: associationDistanceMeters <= 0.01 ? "inside-room-polygon" : "nearest-room-polygon",
        }],
      });
    }
    assigned.add(space.globalId || space.key);
  }
  return assigned;
}

export function reconstructRoomsFromWallFootprints(options: {
  walls: WallFootprint[];
  semanticSpaces?: SemanticRoomPoint[];
  minFaceAreaM2?: number;
  maxSemanticAssociationDistanceM?: number;
}): PlanarRoomReconstruction {
  const warnings: string[] = [];
  const minFaceAreaM2 = Math.max(0.05, Number(options.minFaceAreaM2) || DEFAULT_MIN_FACE_AREA);
  const axes = (options.walls || [])
    .map(principalWallAxis)
    .filter((axis): axis is WallAxis => Boolean(axis));

  if (axes.length < 3) {
    warnings.push(`Only ${axes.length} usable wall axes were extracted. At least three are required to construct enclosed room faces.`);
    const faces: PlanarRoomFace[] = [];
    const explicitGeometryAssignments = applyExplicitSpaceGeometry(faces, options.semanticSpaces || [], minFaceAreaM2);
    const unmatchedSemanticSpaces = associateSemanticSpaces(
      faces,
      options.semanticSpaces || [],
      Math.max(0.5, Number(options.maxSemanticAssociationDistanceM) || MAX_SEMANTIC_ASSOCIATION_DISTANCE),
      explicitGeometryAssignments,
    );
    if (faces.some((face) => face.geometrySource === "ifc-space-step-profile")) {
      warnings.push("Room geometry was recovered from explicit IFC STEP IfcSpace profiles because there were too few usable wall axes. Verify their alignment with room-bounding walls before editing.");
    } else if (faces.some((face) => face.geometrySource === "ifc-space-body-envelope")) {
      warnings.push("Room geometry was recovered from convex envelopes of IfcSpace body meshes because there were too few usable wall axes. Treat these fallback outlines as low-confidence and review them before editing.");
    }
    return {
      faces, wallAxisCount: axes.length, graphNodeCount: 0, graphEdgeCount: 0, wallGraphFaceCount: 0,
      unmatchedSemanticSpaces, warnings,
    };
  }

  // Join endpoints to real wall junctions before splitting interior crossings.
  // This preserves concave outlines instead of turning every corner into an
  // artificial cross-shaped junction.
  snapWallEndpoints(axes);
  for (let i = 0; i < axes.length; i++) {
    for (let j = i + 1; j < axes.length; j++) splitAtIntersection(axes[i], axes[j]);
  }

  const { nodes, edges } = buildGraph(axes);
  // Do not clip faces against a convex hull of slab mesh points. A hull fills
  // concavities and voids; wall topology is the authoritative room boundary.
  const faces = extractFaces(nodes, edges, minFaceAreaM2);
  const wallGraphFaceCount = faces.length;

  const explicitGeometryAssignments = applyExplicitSpaceGeometry(faces, options.semanticSpaces || [], minFaceAreaM2);
  if (!wallGraphFaceCount && !faces.length) warnings.push("The wall planar graph did not contain any closed interior faces, and no valid explicit IfcSpace geometry could recover a room. Inspect disconnected wall ends, missing partitions and floor-level assignment.");
  else if (!wallGraphFaceCount && faces.some((face) => face.geometrySource === "ifc-space-step-profile")) warnings.push("No closed wall-graph faces were found; explicit IFC STEP IfcSpace profiles supplied the room footprints. Verify alignment with room-bounding walls before editing.");
  else if (!wallGraphFaceCount && faces.some((face) => face.geometrySource === "ifc-space-body-envelope")) warnings.push("No closed wall-graph faces were found; room geometry was recovered from convex envelopes of IfcSpace body meshes. Treat these fallback outlines as low-confidence and review them before editing.");
  faces.sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x || b.areaM2 - a.areaM2);
  const unmatchedSemanticSpaces = associateSemanticSpaces(
    faces,
    options.semanticSpaces || [],
    Math.max(0.5, Number(options.maxSemanticAssociationDistanceM) || MAX_SEMANTIC_ASSOCIATION_DISTANCE),
    explicitGeometryAssignments,
  );
  if (unmatchedSemanticSpaces.length) {
    warnings.push(`${unmatchedSemanticSpaces.length} IFC space label(s) could not be associated with a reconstructed physical room: ${unmatchedSemanticSpaces.join(", ")}. The physical wall-bounded faces were retained without inventing geometry.`);
  }
  if (faces.some((face) => face.geometrySource === "ifc-space-body-envelope")) {
    warnings.push("One or more rooms use a convex envelope of streamed IfcSpace body mesh geometry because no matching wall-bounded face was available. These outlines may overfill concavities or voids and require manual review.");
  }
  if (faces.some((face) => face.geometrySource === "ifc-space-step-profile")) {
    warnings.push("One or more room boundaries come from explicit IFC STEP IfcSpace profiles. Their geometry is directly authored in the IFC, but wall alignment and shared-boundary consistency still require validation.");
  }
  if (faces.some((face) => face.geometrySource === "wall-face-reconstruction")) {
    warnings.push("Room boundaries were reconstructed from wall-footprint centre-lines and a planar graph. Boundaries are geometric wall-face insets; review low-confidence or unusual intersections before structural edits.");
  }
  if ((options.semanticSpaces || []).length && faces.length < (options.semanticSpaces || []).length) {
    warnings.push("The number of physical wall-bounded rooms is lower than the number of IfcSpace entities. Multiple semantic spaces may describe zones inside one open-plan physical room; no virtual separator was invented.");
  }

  return {
    faces,
    wallAxisCount: axes.length,
    graphNodeCount: nodes.length,
    graphEdgeCount: edges.length,
    wallGraphFaceCount,
    unmatchedSemanticSpaces,
    warnings,
  };
}
