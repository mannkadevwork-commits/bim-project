export interface PlanPoint {
  x: number;
  y: number;
}

export interface DoorGeometrySeed {
  sourceFile: string;
  expressId: number;
  globalId: string | null;
  name: string;
  /** IFC ObjectPlacement origin. For IfcDoor this is commonly the opening's width-axis origin. */
  placementOrigin: PlanPoint;
  /** Horizontal projection of the IfcDoor local X/overall-width axis. */
  widthAxis: PlanPoint;
  widthMeters: number | null;
  heightMeters: number | null;
}

export interface WallGeometryCandidate {
  key: string;
  sourceFile: string;
  expressId: number;
  globalId: string | null;
  name: string;
  points: PlanPoint[];
  center: PlanPoint;
  minY: number;
  maxY: number;
  sizeX: number;
  sizeY: number;
}

export interface DoorWallMatch {
  door: DoorGeometrySeed;
  wall: WallGeometryCandidate;
  center: PlanPoint;
  tangent: PlanPoint;
  normal: PlanPoint;
  widthMeters: number;
  heightMeters: number | null;
  wallThickness: number;
  alignment: number;
  lineDistance: number;
  segmentGap: number;
  score: number;
  sealPolygon: PlanPoint[];
}

export type DoorWallInferenceFailure =
  | "door-width-unavailable"
  | "door-width-axis-invalid"
  | "no-wall-parallel-to-door-width"
  | "door-not-aligned-with-wall"
  | "door-outside-wall-segment-span";

export interface DoorWallInferenceResult {
  match: DoorWallMatch | null;
  failureReason: DoorWallInferenceFailure | null;
}

function normalize(point: PlanPoint): PlanPoint | null {
  const length = Math.hypot(point.x, point.y);
  if (!Number.isFinite(length) || length < 1e-6) return null;
  return { x: point.x / length, y: point.y / length };
}

function dot(a: PlanPoint, b: PlanPoint): number {
  return a.x * b.x + a.y * b.y;
}

function principalAxis(points: PlanPoint[]): PlanPoint | null {
  if (points.length < 3) return null;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }), { x: 0, y: 0 });
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const point of points) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  return normalize({ x: Math.cos(theta), y: Math.sin(theta) });
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Infer a door opening from its IFC placement and a nearby wall footprint.
 * This deliberately requires strong orientation and distance agreement; it
 * never chooses an arbitrary nearest wall when the geometry is ambiguous.
 */
export function inferDoorWallMatch(
  door: DoorGeometrySeed,
  walls: WallGeometryCandidate[],
  options: { floorElevation: number; maxLineDistanceMeters?: number } ,
): DoorWallInferenceResult {
  const width = Number(door.widthMeters);
  if (!Number.isFinite(width) || width < 0.55 || width > 2.5) {
    return { match: null, failureReason: "door-width-unavailable" };
  }
  const tangent = normalize(door.widthAxis);
  if (!tangent) return { match: null, failureReason: "door-width-axis-invalid" };

  // IFC IfcDoor ObjectPlacement is the local origin. The swept rectangle
  // profile is centered at OverallWidth / 2 in the door's local X axis.
  const center = {
    x: door.placementOrigin.x + tangent.x * width * 0.5,
    y: door.placementOrigin.y + tangent.y * width * 0.5,
  };
  const normal = { x: -tangent.y, y: tangent.x };
  const candidates: Array<{ wall: WallGeometryCandidate; match: DoorWallMatch }> = [];

  for (const wall of walls) {
    if (wall.minY > options.floorElevation + 0.45 || wall.maxY < options.floorElevation + 1.5) continue;
    const wallTangent = principalAxis(wall.points);
    if (!wallTangent) continue;
    const wallNormal = { x: -wallTangent.y, y: wallTangent.x };
    const alignment = Math.abs(dot(tangent, wallTangent));
    if (alignment < 0.90) continue;

    let minAlong = Number.POSITIVE_INFINITY;
    let maxAlong = Number.NEGATIVE_INFINITY;
    let minAcross = Number.POSITIVE_INFINITY;
    let maxAcross = Number.NEGATIVE_INFINITY;
    for (const point of wall.points) {
      const dx = point.x - wall.center.x;
      const dy = point.y - wall.center.y;
      const along = dx * wallTangent.x + dy * wallTangent.y;
      const across = dx * wallNormal.x + dy * wallNormal.y;
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
      minAcross = Math.min(minAcross, across);
      maxAcross = Math.max(maxAcross, across);
    }
    const offsetX = center.x - wall.center.x;
    const offsetY = center.y - wall.center.y;
    const centerAlong = offsetX * wallTangent.x + offsetY * wallTangent.y;
    const centerAcross = offsetX * wallNormal.x + offsetY * wallNormal.y;
    const lineDistance = Math.abs(centerAcross);
    const segmentGap = centerAlong < minAlong
      ? minAlong - centerAlong
      : centerAlong > maxAlong
        ? centerAlong - maxAlong
        : 0;
    const wallThickness = clamp(maxAcross - minAcross, 0.06, 0.65);
    const lineTolerance = Math.max(
      Number(options.maxLineDistanceMeters) || 0,
      Math.min(0.30, wallThickness * 0.75 + 0.06),
    );
    const maxSegmentGap = width * 0.5 + Math.max(0.18, wallThickness);
    if (lineDistance > lineTolerance) continue;
    if (segmentGap > maxSegmentGap) continue;

    const sealHalfWidth = width * 0.5 + 0.06;
    const sealHalfDepth = wallThickness * 0.5 + 0.035;
    const point = (along: number, across: number): PlanPoint => ({
      x: center.x + tangent.x * along + normal.x * across,
      y: center.y + tangent.y * along + normal.y * across,
    });
    const sealPolygon = [
      point(-sealHalfWidth, -sealHalfDepth),
      point(sealHalfWidth, -sealHalfDepth),
      point(sealHalfWidth, sealHalfDepth),
      point(-sealHalfWidth, sealHalfDepth),
    ];
    const score = lineDistance * 5 + segmentGap * 1.5 + (1 - alignment) * 2;
    candidates.push({
      wall,
      match: {
        door,
        wall,
        center,
        tangent,
        normal,
        widthMeters: width,
        heightMeters: Number.isFinite(door.heightMeters) ? Number(door.heightMeters) : null,
        wallThickness,
        alignment,
        lineDistance,
        segmentGap,
        score,
        sealPolygon,
      },
    });
  }

  candidates.sort((a, b) => a.match.score - b.match.score);
  if (!candidates.length) {
    const anyParallelWall = walls.some((wall) => {
      const axis = principalAxis(wall.points);
      return Boolean(axis && Math.abs(dot(tangent, axis)) >= 0.90);
    });
    return {
      match: null,
      failureReason: anyParallelWall ? "door-not-aligned-with-wall" : "no-wall-parallel-to-door-width",
    };
  }

  const best = candidates[0].match;
  return { match: best, failureReason: null };
}


export interface SemanticRoomAnchor {
  key: string;
  x: number;
  y: number;
}

export interface DoorSemanticSideResolution {
  sideAKey: string | null;
  sideBKey: string | null;
  distinct: boolean;
}

/**
 * Resolve the IFC semantic-space anchors on opposite sides of a proposed door.
 * Exterior doors and ambiguous placements are rejected when both sides cannot
 * be tied to two different semantic spaces. The anchor must also be close to
 * its walkable side sample, preventing a distant neighbouring room from being
 * used merely because it lies in the same half-plane.
 */
export function resolveDistinctSemanticAnchorSides(
  center: PlanPoint,
  normal: PlanPoint,
  sampleA: PlanPoint,
  sampleB: PlanPoint,
  anchors: SemanticRoomAnchor[],
  maxDistanceMeters = 4,
): DoorSemanticSideResolution {
  const nearestOnSide = (sample: PlanPoint, side: 1 | -1): string | null => {
    let nearestKey: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const anchor of anchors) {
      const signedSideDistance = (anchor.x - center.x) * normal.x
        + (anchor.y - center.y) * normal.y;
      if (signedSideDistance * side <= 0.12) continue;
      const distance = Math.hypot(sample.x - anchor.x, sample.y - anchor.y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestKey = anchor.key;
      }
    }
    return nearestDistance <= maxDistanceMeters ? nearestKey : null;
  };

  const sideAKey = nearestOnSide(sampleA, 1);
  const sideBKey = nearestOnSide(sampleB, -1);
  return { sideAKey, sideBKey, distinct: Boolean(sideAKey && sideBKey && sideAKey !== sideBKey) };
}

/** Find an interior-side sample pair before a candidate door is sealed. */
export function findInteriorDoorSideSamples(
  center: PlanPoint,
  normal: PlanPoint,
  wallThickness: number,
  isWalkable: (point: PlanPoint) => boolean,
): { sampleA: PlanPoint; sampleB: PlanPoint; offset: number } | null {
  const offsets = [
    Math.max(0.20, wallThickness * 0.5 + 0.12),
    Math.max(0.32, wallThickness * 0.5 + 0.24),
    Math.max(0.48, wallThickness + 0.24),
    Math.max(0.72, wallThickness * 2 + 0.30),
  ];
  for (const offset of offsets) {
    const sampleA = { x: center.x + normal.x * offset, y: center.y + normal.y * offset };
    const sampleB = { x: center.x - normal.x * offset, y: center.y - normal.y * offset };
    if (isWalkable(sampleA) && isWalkable(sampleB)) return { sampleA, sampleB, offset };
  }
  return null;
}
