import * as fs from "fs";
import { createHash } from "crypto";
import * as path from "path";
import {
  IfcAPI,
  IFCDOOR,
  IFCOPENINGELEMENT,
  IFCRELVOIDSELEMENT,
  IFCRELFILLSELEMENT,
  IFCSLAB,
  IFCFURNISHINGELEMENT,
  IFCROOF,
  IFCCOVERING,
  IFCWALL,
  IFCWALLSTANDARDCASE,
  IFCPROJECT,
  IFCSPACE,
} from "web-ifc";
import type { DetectedRoom, DetectedRoomElement, RoomDebugArtifact, RoomDoorDiagnostic, RoomPortal, RoomPolygonPoint } from "./RoomTypes";
import { makeComponentDiagnostics, makeDoorDiagnostic, makeRoomBoundaryCandidateDiagnostics } from "./RoomDiagnostics";
import type { RoomFootprintAnchor } from "./RoomFootprintReconstructor";
import { reconstructRoomsFromWallTopology, shouldUseTopologyRoomRegions } from "./RoomTopologyReconstructor";
import { createDoorGapClosureFootprint, reconstructRoomsFromWallFootprints, polygonArea as planarPolygonArea } from "./RoomPlanarGraph";
import { readIfcStepDoorPlacements, readIfcStepSpaceFootprints, type StepDoorPlacement } from "./IfcStepSpaceFootprints";
import { findInteriorDoorSideSamples, inferDoorWallMatch, type DoorWallMatch } from "./DoorGeometryInference";
import { parseIfcSpaceSafeCameraCenter } from "./IfcSpaceAnchorMetadata";

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
  predefinedType: string;
  ifcType: string;
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
  openingName: string;
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

interface ResolvedRoomAnchor extends RoomFootprintAnchor {
  snappedX: number;
  snappedY: number;
  snapDistanceMeters: number;
  associationMethod?: "inside-room-polygon" | "nearest-room-polygon";
}

interface Component {
  id: number;
  cells: number[];
  area: number;
  center?: Point2;
  minI: number;
  maxI: number;
  minJ: number;
  maxJ: number;
  touchesBoundary: boolean;
  /** Vector boundary extracted from semantic wall-constrained floor regions. */
  polygon?: Point2[];
  holes?: Point2[][];
  anchor?: ResolvedRoomAnchor;
  reconstructionSource?:
    | "ifc-space-step-profile-v1"
    | "ifc-space-body-envelope-v1"
    | "ifc-space-solid-v1"
    | "ifc-space-wall-constrained-geodesic-v2"
    | "wall-face-reconstruction"
    | "ifc-wall-topology-face-v1"
    | "ifc-open-plan-semantic-zone-v1";
  regionKind?: "physical-room" | "semantic-zone";
  physicalComponentId?: number;
  boundaryWallIds?: string[];
  semanticSpaces?: ResolvedRoomAnchor[];
  confidence?: number;
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

/**
 * web-ifc GetLine() exposes EXPRESS scalar values as typed wrappers, e.g.
 * IfcLengthMeasure { type: 4, value: 3.25 }. Number(wrapper) is NaN.
 * Always unwrap each aggregate member before numeric conversion; unwrapping
 * only the aggregate itself is not sufficient for Coordinates/DirectionRatios.
 */
function ifcScalarNumber(value: any, fallback = Number.NaN): number {
  const unwrapped = getWrappedValue(value);
  const number = typeof unwrapped === "number" ? unwrapped : Number(unwrapped);
  return Number.isFinite(number) ? number : fallback;
}

function ifcNumberArray(value: any): number[] {
  // Preserve coordinate indices; callers decide how to handle missing values.
  return asIfcArray(value).map((item) => ifcScalarNumber(item));
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

interface PlacementFrame {
  origin: Point3;
  xAxis: Point3;
  yAxis: Point3;
  zAxis: Point3;
}

function dot3(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross3(a: Point3, b: Point3): Point3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize3(vector: Point3, fallback: Point3): Point3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(length) || length <= 1e-10) return fallback;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function readPointCoordinates(ifc: IfcAPI, modelId: number, pointId: number | null): Point3 {
  if (!pointId) return { x: 0, y: 0, z: 0 };
  const point: any = ifc.GetLine(modelId, pointId);
  const values = ifcNumberArray(point?.Coordinates);
  return {
    x: Number.isFinite(values[0]) ? values[0] : 0,
    y: Number.isFinite(values[1]) ? values[1] : 0,
    z: Number.isFinite(values[2]) ? values[2] : 0,
  };
}

function readDirection(ifc: IfcAPI, modelId: number, directionId: number | null, fallback: Point3): Point3 {
  if (!directionId) return fallback;
  const direction: any = ifc.GetLine(modelId, directionId);
  const values = ifcNumberArray(direction?.DirectionRatios);
  return normalize3({
    x: Number.isFinite(values[0]) ? values[0] : fallback.x,
    y: Number.isFinite(values[1]) ? values[1] : fallback.y,
    z: Number.isFinite(values[2]) ? values[2] : fallback.z,
  }, fallback);
}

function composePlacementFrames(parent: PlacementFrame, local: PlacementFrame): PlacementFrame {
  const transformVector = (vector: Point3): Point3 => ({
    x: parent.xAxis.x * vector.x + parent.yAxis.x * vector.y + parent.zAxis.x * vector.z,
    y: parent.xAxis.y * vector.x + parent.yAxis.y * vector.y + parent.zAxis.y * vector.z,
    z: parent.xAxis.z * vector.x + parent.yAxis.z * vector.y + parent.zAxis.z * vector.z,
  });
  const translated = transformVector(local.origin);
  return {
    origin: {
      x: parent.origin.x + translated.x,
      y: parent.origin.y + translated.y,
      z: parent.origin.z + translated.z,
    },
    xAxis: normalize3(transformVector(local.xAxis), parent.xAxis),
    yAxis: normalize3(transformVector(local.yAxis), parent.yAxis),
    zAxis: normalize3(transformVector(local.zAxis), parent.zAxis),
  };
}

function axisPlacementFrame(ifc: IfcAPI, modelId: number, placementId: number): PlacementFrame | null {
  const placement: any = ifc.GetLine(modelId, placementId);
  if (!placement) return null;
  const origin = readPointCoordinates(ifc, modelId, lineRefId(placement, "Location"));
  const axisId = lineRefId(placement, "Axis");
  const referenceId = lineRefId(placement, "RefDirection");
  if (axisId != null) {
    const zAxis = readDirection(ifc, modelId, axisId, { x: 0, y: 0, z: 1 });
    const reference = readDirection(ifc, modelId, referenceId, { x: 1, y: 0, z: 0 });
    const projection = dot3(reference, zAxis);
    const xAxis = normalize3({
      x: reference.x - zAxis.x * projection,
      y: reference.y - zAxis.y * projection,
      z: reference.z - zAxis.z * projection,
    }, { x: 1, y: 0, z: 0 });
    const yAxis = normalize3(cross3(zAxis, xAxis), { x: 0, y: 1, z: 0 });
    return { origin, xAxis, yAxis, zAxis };
  }
  const reference = readDirection(ifc, modelId, referenceId, { x: 1, y: 0, z: 0 });
  const xAxis = normalize3({ x: reference.x, y: reference.y, z: 0 }, { x: 1, y: 0, z: 0 });
  const zAxis = { x: 0, y: 0, z: 1 };
  const yAxis = normalize3(cross3(zAxis, xAxis), { x: 0, y: 1, z: 0 });
  return { origin, xAxis, yAxis, zAxis };
}

function extractPlacementFrame(ifc: IfcAPI, modelId: number, placementExpressId: number | null, depth = 0): PlacementFrame | null {
  if (!placementExpressId || depth > 32) return null;
  const placement: any = ifc.GetLine(modelId, placementExpressId);
  if (!placement) return null;
  const relativePlacementId = lineRefId(placement, "RelativePlacement");
  const parentPlacementId = lineRefId(placement, "PlacementRelTo");
  if (!relativePlacementId) return null;
  const local = axisPlacementFrame(ifc, modelId, relativePlacementId);
  if (!local) return null;
  const parent = parentPlacementId ? extractPlacementFrame(ifc, modelId, parentPlacementId, depth + 1) : null;
  return parent ? composePlacementFrames(parent, local) : local;
}

function extractPlacementPointRaw(ifc: IfcAPI, modelId: number, placementExpressId: number | null): Point3 | null {
  return extractPlacementFrame(ifc, modelId, placementExpressId)?.origin ?? null;
}

function extractPlacementPoint(ifc: IfcAPI, modelId: number, placementExpressId: number | null): Point3 | null {
  const raw = extractPlacementPointRaw(ifc, modelId, placementExpressId);
  return raw ? ifcZUpToViewer(raw) : null;
}

/**
 * Reads an IfcSpace footprint from its IFC STEP representation instead of
 * depending on StreamAllMeshes(). Web-IFC may omit semantic/non-renderable
 * IfcSpace solids from the mesh stream even though their Body representation
 * is valid. The room detector still needs those profiles as authoritative
 * boundary input, so read the profile curve and compose its IFC placements.
 */
function ifcEntityTypeName(ifc: IfcAPI, modelId: number, expressId: number): string {
  try {
    return String(ifc.GetNameFromTypeCode(ifc.GetLineType(modelId, expressId)) || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  } catch {
    return "";
  }
}

function extractIfcPolylinePoints(ifc: IfcAPI, modelId: number, curveExpressId: number): Point2[] {
  const curve: any = ifc.GetLine(modelId, curveExpressId);
  if (!curve || ifcEntityTypeName(ifc, modelId, curveExpressId) !== "IFCPOLYLINE") return [];
  const result: Point2[] = [];
  for (const pointRef of asIfcArray(curve.Points)) {
    const pointId = asExpressId(pointRef);
    if (pointId == null) continue;
    const coordinates = ifcNumberArray((ifc.GetLine(modelId, pointId) as any)?.Coordinates);
    const x = Number(coordinates[0]);
    const y = Number(coordinates[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) result.push({ x, y });
  }
  if (result.length > 1) {
    const first = result[0];
    const last = result[result.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= 1e-7) result.pop();
  }
  return result.length >= 3 ? result : [];
}

function transformProfilePoint(frame: PlacementFrame, point: Point2): Point3 {
  return {
    x: frame.origin.x + frame.xAxis.x * point.x + frame.yAxis.x * point.y,
    y: frame.origin.y + frame.xAxis.y * point.x + frame.yAxis.y * point.y,
    z: frame.origin.z + frame.xAxis.z * point.x + frame.yAxis.z * point.y,
  };
}

function extractIfcSpaceBodyPolygon(
  ifc: IfcAPI,
  modelId: number,
  spaceExpressId: number,
  unitToMeters = 1,
): Point2[] | null {
  const space: any = ifc.GetLine(modelId, spaceExpressId);
  if (!space) return null;

  const objectPlacementId = lineRefId(space, "ObjectPlacement");
  const objectFrame = extractPlacementFrame(ifc, modelId, objectPlacementId);
  const productShapeId = lineRefId(space, "Representation");
  if (!objectFrame || productShapeId == null) return null;

  const productShape: any = ifc.GetLine(modelId, productShapeId);
  const representationIds = asIfcArray(productShape?.Representations)
    .map(asExpressId)
    .filter((id): id is number => id != null);
  let bestPolygon: Point2[] | null = null;
  let bestArea = 0;

  for (const representationId of representationIds) {
    const representation: any = ifc.GetLine(modelId, representationId);
    const representationIdentifier = String(getWrappedValue(representation?.RepresentationIdentifier) || "").toUpperCase();
    if (representationIdentifier && representationIdentifier !== "BODY") continue;

    const itemIds = asIfcArray(representation?.Items)
      .map(asExpressId)
      .filter((id): id is number => id != null);
    for (const itemId of itemIds) {
      if (ifcEntityTypeName(ifc, modelId, itemId) !== "IFCEXTRUDEDAREASOLID") continue;
      const solid: any = ifc.GetLine(modelId, itemId);
      const profileId = lineRefId(solid, "SweptArea");
      const positionId = lineRefId(solid, "Position");
      if (profileId == null) continue;

      const profile: any = ifc.GetLine(modelId, profileId);
      const outerCurveId = lineRefId(profile, "OuterCurve");
      if (outerCurveId == null) continue;
      const localProfile = extractIfcPolylinePoints(ifc, modelId, outerCurveId);
      if (localProfile.length < 3) continue;

      const solidPlacement = positionId == null
        ? null
        : axisPlacementFrame(ifc, modelId, positionId);
      const worldFrame = solidPlacement
        ? composePlacementFrames(objectFrame, solidPlacement)
        : objectFrame;
      const polygon = localProfile.map((point) => {
        const world = transformProfilePoint(worldFrame, point);
        // IFC source files use Z-up. The editor's horizontal plane is X/Z,
        // therefore IFC global X/Y maps to editor X/-Z (plan Y).
        return {
          x: world.x * unitToMeters,
          y: -world.y * unitToMeters,
        };
      });

      const area = Math.abs(planarPolygonArea(polygon));
      if (polygon.length >= 3 && Number.isFinite(area) && area > bestArea) {
        bestPolygon = polygon;
        bestArea = area;
      }
    }
  }

  return bestPolygon;
}

function collectIfcSpaceAnchors(
  ifc: IfcAPI,
  modelId: number,
  sourceFile: string,
  unitToMeters = 1,
): RoomFootprintAnchor[] {
  const anchors: RoomFootprintAnchor[] = [];
  const safeUnitToMeters = Number.isFinite(unitToMeters) && unitToMeters > 0 ? unitToMeters : 1;
  for (const expressId of idsWithType(ifc, modelId, IFCSPACE)) {
    const line: any = ifc.GetLine(modelId, expressId);
    const rawPlacement = extractPlacementPointRaw(ifc, modelId, lineRefId(line, "ObjectPlacement"));
    const scaledRawPlacement = rawPlacement ? {
      x: rawPlacement.x * safeUnitToMeters,
      y: rawPlacement.y * safeUnitToMeters,
      z: rawPlacement.z * safeUnitToMeters,
    } : null;
    const placement = scaledRawPlacement ? ifcZUpToViewer(scaledRawPlacement) : null;
    const globalId = lineGlobalId(line);
    const name = String(getWrappedValue(line?.LongName) || lineName(line) || `IFC Space ${expressId}`).trim();
    const description = String(getWrappedValue(line?.Description) || "").trim();
    const safeCenter = parseIfcSpaceSafeCameraCenter(description);
    // Prefer the explicitly authored, unit-qualified plan anchor when an IFC
    // exporter leaves every IfcSpace ObjectPlacement at (0, 0, 0). Description
    // metadata is in source IFC X/Y metres and must be converted exactly once
    // to the viewer's X/Z plane (viewer Z = -IFC Y). Normal placement remains
    // the fallback for standards-compliant IFC files without this metadata.
    const anchorX = safeCenter ? safeCenter.sourceX : placement?.x;
    const anchorY = safeCenter ? -safeCenter.sourceY : placement?.z;
    anchors.push({
      key: globalId || `${sourceFile}:${expressId}`,
      label: name,
      globalId,
      expressId,
      // extractPlacementPoint returns the viewer's Y-up frame; horizontal plan
      // coordinates are X/Z, not X/Y.
      // Preserve every IfcSpace identity even when its ObjectPlacement is
      // missing or malformed. The planar graph reports it as unmatched rather
      // than silently dropping it from semantic coverage diagnostics.
      x: anchorX ?? Number.NaN,
      y: anchorY ?? Number.NaN,
      elevationY: placement?.y ?? Number.NaN,
      description,
      positionSource: safeCenter ? "ifc-description-safe-camera-center" : "ifc-object-placement",
      hasGeometryRepresentation: lineRefId(line, "Representation") != null,
      sourceX: safeCenter?.sourceX ?? scaledRawPlacement?.x,
      sourceY: safeCenter?.sourceY ?? scaledRawPlacement?.y,
    });
  }
  return anchors;
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
      openingName: lineName(line),
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

function ifcToFrontend(p: Point2, floorY: number): RoomPolygonPoint {
  // RoomDetector normalizes all source IFC mesh points to the viewer's Y-up
  // frame before projecting them into this X/Z plan coordinate system.
  return { x: p.x, y: floorY, z: p.y };
}

function pointDistance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isWalkableFloorPoint(grid: Grid, point: Point2): boolean {
  const [i, j] = worldToGrid(grid, point);
  if (i < 0 || j < 0 || i >= grid.width || j >= grid.height) return false;
  const index = j * grid.width + i;
  return grid.floor[index] === 1 && grid.blocked[index] === 0;
}

function elementFromLine(ifc: IfcAPI, modelId: number, expressId: number, sourceFile: string, prefix: string): ElementFootprint | null {
  const line: any = ifc.GetLine(modelId, expressId);
  const globalId = lineGlobalId(line);
  const name = lineName(line);
  const points: Point2[] = [];

  let ifcType = "UNKNOWN";
  try {
    const typeCode = ifc.GetLineType(modelId, expressId);
    ifcType = String(ifc.GetNameFromTypeCode(typeCode) || "UNKNOWN").toUpperCase();
  } catch { /* type metadata is diagnostic only */ }

  return {
    key: `${prefix}:${expressId}`,
    sourceFile,
    expressId,
    globalId,
    name,
    predefinedType: String(getWrappedValue(line?.PredefinedType) ?? "").toUpperCase(),
    ifcType,
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

function addPoint(element: ElementFootprint, worldPoint: Point3) {
  // IMPORTANT: placedGeometry.flatTransformation is already the baked
  // web-ifc world transform used by compiler/geometry.ts. It is already in
  // the viewer's Y-up world frame, with X/Z as the horizontal plan axes.
  // Do not apply the IFC-placement Z-up conversion here and do not multiply
  // by the IFC unit factor again: web-ifc has already produced scene-space
  // geometry for the editor. IFC ObjectPlacement values are a different
  // source and are normalized separately in collectIfcSpaceAnchors().
  const point = { x: worldPoint.x, y: worldPoint.z };
  element.points.push(point);
  element.minX = Math.min(element.minX, worldPoint.x);
  element.maxX = Math.max(element.maxX, worldPoint.x);
  element.minY = Math.min(element.minY, worldPoint.y);
  element.maxY = Math.max(element.maxY, worldPoint.y);
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
  const jobRoot = path.resolve(jobDirectory);
  try {
    // Use a base URL so root-relative browser paths such as /jobs/<id>/file.ifc
    // are resolved just like absolute API URLs persisted by older editor builds.
    const url = new URL(src, "http://hci.local");
    if (url.pathname.startsWith("/jobs/")) {
      const match = url.pathname.match(/^\/jobs\/([^/]+)\/(.+)$/);
      if (!match) return null;
      const jobId = match[1];
      const relative = decodeURIComponent(match[2]);
      const current = path.resolve(jobRoot, relative);
      if (current.startsWith(`${jobRoot}${path.sep}`) && fs.existsSync(current)) return current;
      const siblingRoot = path.resolve(path.dirname(jobRoot), jobId);
      const sibling = path.resolve(siblingRoot, relative);
      return sibling.startsWith(`${siblingRoot}${path.sep}`) && fs.existsSync(sibling) ? sibling : null;
    }
    const backendRoot = path.resolve(jobRoot, "..", "..");
    if (url.pathname.startsWith("/assets/")) {
      const assetRoot = path.resolve(backendRoot, "assets");
      const candidate = path.resolve(assetRoot, path.basename(url.pathname));
      return fs.existsSync(candidate) ? candidate : null;
    }
    if (url.pathname.startsWith("/uploads/")) {
      const uploadsRoot = path.resolve(backendRoot, "uploads");
      const relative = decodeURIComponent(url.pathname.slice("/uploads/".length));
      const candidate = path.resolve(uploadsRoot, relative);
      return candidate.startsWith(`${uploadsRoot}${path.sep}`) && fs.existsSync(candidate) ? candidate : null;
    }
  } catch {
    // Absolute/local file paths below are handled directly.
  }

  if (path.isAbsolute(src) && fs.existsSync(src)) return src;
  const candidate = path.resolve(jobRoot, src.replace(/^\/+/, ""));
  return candidate.startsWith(`${jobRoot}${path.sep}`) && fs.existsSync(candidate) ? candidate : null;
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

const SI_PREFIX_TO_METRES: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6,
  KILO: 1e3, HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2,
  MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12,
};

function asIfcArray(value: any): any[] {
  const unwrapped = getWrappedValue(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  if (unwrapped && typeof unwrapped.size === "function" && typeof unwrapped.get === "function") {
    const result: any[] = [];
    for (let index = 0; index < unwrapped.size(); index++) result.push(unwrapped.get(index));
    return result;
  }
  if (unwrapped && typeof unwrapped.length === "number") return Array.from(unwrapped);
  return [];
}

function resolveIfcUnitToMeters(ifc: IfcAPI, modelId: number, unitExpressId: number, depth = 0): number | null {
  if (depth > 8) return null;
  let unit: any;
  try { unit = ifc.GetLine(modelId, unitExpressId); } catch { return null; }
  if (!unit) return null;

  const unitType = String(getWrappedValue(unit?.UnitType) || "").toUpperCase();
  const name = String(getWrappedValue(unit?.Name) || "").toUpperCase();
  const prefix = String(getWrappedValue(unit?.Prefix) || "").toUpperCase();
  if (unitType && unitType !== "LENGTHUNIT") return null;

  if (name === "METRE" || name === "METER") return prefix ? (SI_PREFIX_TO_METRES[prefix] ?? null) : 1;
  if (name === "FOOT" || name === "FEET") return 0.3048;
  if (name === "INCH") return 0.0254;
  if (name === "YARD") return 0.9144;
  if (name === "MILE") return 1609.344;

  const conversionId = asExpressId(unit?.ConversionFactor);
  if (conversionId) {
    let conversion: any;
    try { conversion = ifc.GetLine(modelId, conversionId); } catch { conversion = null; }
    const componentValue = Number(getWrappedValue(conversion?.ValueComponent));
    const baseUnitId = asExpressId(conversion?.UnitComponent);
    const baseScale = baseUnitId ? resolveIfcUnitToMeters(ifc, modelId, baseUnitId, depth + 1) : null;
    if (Number.isFinite(componentValue) && componentValue > 0 && baseScale != null) return componentValue * baseScale;
  }
  return null;
}

function readIfcLengthUnitFromModel(ifc: IfcAPI, modelId: number): {
  sourceLengthUnit: string;
  toMeters: number;
  confidence: "ifc-unit-assignment" | "assumed-metre";
  warning?: string;
} {
  for (const projectId of idsWithType(ifc, modelId, IFCPROJECT)) {
    const project: any = ifc.GetLine(modelId, projectId);
    const assignmentId = asExpressId(project?.UnitsInContext);
    if (!assignmentId) continue;
    const assignment: any = ifc.GetLine(modelId, assignmentId);
    for (const unitReference of asIfcArray(assignment?.Units)) {
      const unitId = asExpressId(unitReference);
      if (!unitId) continue;
      const unit: any = ifc.GetLine(modelId, unitId);
      const unitType = String(getWrappedValue(unit?.UnitType) || "").toUpperCase();
      if (unitType !== "LENGTHUNIT") continue;
      const toMeters = resolveIfcUnitToMeters(ifc, modelId, unitId);
      if (!Number.isFinite(toMeters) || toMeters == null || toMeters <= 0) continue;
      const name = String(getWrappedValue(unit?.Name) || "UNKNOWN").toLowerCase();
      const prefix = String(getWrappedValue(unit?.Prefix) || "").toLowerCase();
      return { sourceLengthUnit: `${prefix}${name}`, toMeters, confidence: "ifc-unit-assignment" };
    }
  }
  return {
    sourceLengthUnit: "unknown (assumed metre)",
    toMeters: 1,
    confidence: "assumed-metre",
    warning: "No supported IFC length unit was found. Scene geometry is treated as metres by the current web-ifc geometry pipeline; confirm model scale before applying ceilings.",
  };
}

function pointInsidePolygon(point: Point2, polygon: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = ((a.y > point.y) !== (b.y > point.y)) &&
      (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-12) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function canonicalRingSignature(points: Point2[]): string {
  const ring = points.map((point) => `${Math.round(point.x * 100)}:${Math.round(point.y * 100)}`);
  if (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
  if (!ring.length) return "empty";
  const variants: string[] = [];
  for (const sequence of [ring, [...ring].reverse()]) {
    for (let offset = 0; offset < sequence.length; offset++) {
      variants.push([...sequence.slice(offset), ...sequence.slice(0, offset)].join("|"));
    }
  }
  variants.sort();
  return variants[0];
}

function stableRoomId(outer: Point2[], floorY: number): string {
  const signature = `${Math.round(floorY * 100)}|${canonicalRingSignature(outer)}`;
  return `room_${createHash("sha1").update(signature).digest("hex").slice(0, 16)}`;
}

function stableLevelId(floorY: number): string {
  const signature = `floor-y:${Math.round(floorY * 100)}`;
  return `level_${createHash("sha1").update(signature).digest("hex").slice(0, 12)}`;
}

function candidateCoverage(component: Component, grid: Grid, polygon: Point2[]): number {
  if (component.cells.length === 0 || polygon.length < 3) return 0;
  const maxSamples = 3000;
  const stride = Math.max(1, Math.ceil(component.cells.length / maxSamples));
  let tested = 0;
  let covered = 0;
  for (let index = 0; index < component.cells.length; index += stride) {
    const cell = component.cells[index];
    const i = cell % grid.width;
    const j = Math.floor(cell / grid.width);
    const point = gridToWorld(grid, i, j);
    tested++;
    if (pointInsidePolygon(point, polygon)) covered++;
  }
  return tested ? covered / tested : 0;
}


function gridCellsInsidePolygon(grid: Grid, polygon: Point2[]): number[] {
  if (polygon.length < 3) return [];
  const bounds = bbox(polygon);
  const [minI, maxI] = clampRange(
    Math.floor((bounds.minX - grid.minX) / grid.cellSize),
    Math.floor((bounds.maxX - grid.minX) / grid.cellSize),
    0,
    grid.width - 1,
  );
  const [minJ, maxJ] = clampRange(
    Math.floor((bounds.minY - grid.minY) / grid.cellSize),
    Math.floor((bounds.maxY - grid.minY) / grid.cellSize),
    0,
    grid.height - 1,
  );
  const cells: number[] = [];
  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      const index = j * grid.width + i;
      if (!grid.floor[index] || grid.blocked[index]) continue;
      if (polygonContains(gridToWorld(grid, i, j), polygon)) cells.push(index);
    }
  }
  return cells;
}

function createRoomObjects(
  components: Component[],
  grid: Grid,
  floorY: number,
  boundaryWallsByComponent: Map<number, string[]>,
  wallTopElevationsById: Map<string, number>,
  wallElements: ElementFootprint[],
  overheadSurfaceElements: ElementFootprint[],
  anchorByComponent: Map<number, ResolvedRoomAnchor> = new Map(),
): { rooms: DetectedRoom[]; componentToRoom: Map<number, string> } {
  const candidates = components.filter((component) => component.area >= MIN_COMPONENT_AREA);

  const rooms: DetectedRoom[] = [];
  const componentToRoom = new Map<number, string>();
  let roomIndex = 1;
  for (const component of candidates) {
    // The geometry reconstructor must provide an actual vector boundary. Do not
    // fall back to inventing a generic grid component if it failed to do so.
    const outer = component.polygon || [];
    if (outer.length < 3) continue;
    const holes = component.holes || [];

    // Room geometry is authoritative. IFC space placements label a physical
    // face; they never become its centre or decide whether the face exists.
    const faceCenter = component.center ?? centroid(outer);
    const cx = faceCenter.x;
    const cy = faceCenter.y;

    const id = `room-${String(roomIndex).padStart(3, "0")}`;
    const semanticAssignments = component.semanticSpaces?.length
      ? component.semanticSpaces
      : (anchorByComponent.get(component.id) ?? component.anchor)
        ? [anchorByComponent.get(component.id) ?? component.anchor!]
        : [];
    const roomAnchor = semanticAssignments[0] ?? null;
    const stableId = semanticAssignments.length === 1 && roomAnchor?.globalId
      ? `ifcspace_${createHash("sha1").update(roomAnchor.globalId).digest("hex").slice(0, 16)}`
      : stableRoomId(outer, floorY);
    const levelId = stableLevelId(floorY);
    componentToRoom.set(component.id, id);
    const roomBoundaryWallIds = boundaryWallsByComponent.get(component.id) ?? [];
    const mappedWallTopValues = roomBoundaryWallIds
      .map((wallId) => wallTopElevationsById.get(wallId))
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > floorY + 1.8 && value < floorY + 6.5)
      .sort((a, b) => a - b);

    // The centre-cell association above is deliberately conservative, but a
    // wall can straddle the 5 cm analysis grid so its centre misses the room's
    // neighbouring cells. Only when that mapping found no wall tops, recover
    // enclosing walls from their actual plan-footprint distance to the detected
    // room perimeter. This prevents a generic 2.7 m fallback when the IFC has
    // measurable wall heads but the raster association missed them.
    const nearbyBoundaryWallTops = mappedWallTopValues.length
      ? []
      : wallElements
          .filter((wall) => (
            Number.isFinite(wall.maxY)
            && wall.maxY > floorY + 1.8
            && wall.maxY < floorY + 6.5
            && distanceBetweenFootprintLoops(outer, wall.points) <= Math.max(grid.cellSize * 3, 0.18)
          ))
          .map((wall) => wall.maxY)
          .sort((a, b) => a - b);
    const wallTopValues = mappedWallTopValues.length ? mappedWallTopValues : nearbyBoundaryWallTops;
    const ceilingCandidates = overheadSurfaceElements
      .filter((surface) => (
        surface.points.length >= 3 &&
        Number.isFinite(surface.minY) &&
        surface.minY > floorY + 1.8 &&
        surface.minY < floorY + 6.5
      ))
      .map((surface) => {
        const overlapRatio = candidateCoverage(component, grid, surface.points);
        const isCeilingCovering = surface.ifcType === "IFCCOVERING" && surface.predefinedType === "CEILING";
        const isRoof = surface.ifcType === "IFCROOF" || surface.predefinedType === "ROOF";
        const semanticBonus = isCeilingCovering ? 0.15 : isRoof ? 0.08 : 0;
        const verticalSpanY = Math.max(0, surface.maxY - surface.minY);
        // A flat ceiling can use a near-horizontal slab/covering as its reference.
        // A roof with substantial vertical extent may be pitched; keep it in the
        // diagnostics, but do not silently flatten it into a guessed ceiling level.
        const flatCeilingCompatible = verticalSpanY <= 0.35;
        const slopePenalty = flatCeilingCompatible ? 0 : 0.25;
        return {
          id: surface.globalId || `${surface.sourceFile}:${surface.expressId}`,
          sourceFile: surface.sourceFile,
          expressId: surface.expressId,
          globalId: surface.globalId,
          ifcType: surface.ifcType,
          predefinedType: surface.predefinedType,
          name: surface.name,
          elevationY: Number(surface.minY.toFixed(4)),
          verticalSpanY: Number(verticalSpanY.toFixed(4)),
          flatCeilingCompatible,
          overlapRatio: Number(overlapRatio.toFixed(4)),
          confidence: Number(Math.max(0, Math.min(0.99, overlapRatio * 0.82 + semanticBonus - slopePenalty)).toFixed(3)),
          semanticBonus,
        };
      })
      .filter((candidate) => candidate.overlapRatio >= 0.20)
      .sort((a, b) => b.confidence - a.confidence);
    const selectedOverhead = ceilingCandidates.find((candidate) => candidate.flatCeilingCompatible && candidate.overlapRatio >= 0.55) ?? null;
    const wallTopMedian = wallTopValues.length
      ? wallTopValues[Math.floor(wallTopValues.length / 2)]
      : null;
    const ceilingElevation = selectedOverhead?.elevationY ?? wallTopMedian ?? (floorY + 2.7);
    const ceilingElevationSource = selectedOverhead
      ? "ifc-overhead-surface"
      : wallTopMedian == null ? "fallback-estimate" : "boundary-wall-top";
    const ceilingConfidence = selectedOverhead
      ? selectedOverhead.confidence
      : wallTopMedian == null
        ? 0.25
        : (mappedWallTopValues.length
            ? Math.min(0.88, 0.55 + wallTopValues.length * 0.06)
            : Math.min(0.78, 0.50 + wallTopValues.length * 0.05));
    const roomAnchorPoint = roomAnchor
      ? ifcToFrontend({ x: roomAnchor.x, y: roomAnchor.y }, floorY)
      : null;
    rooms.push({
      id,
      stableId,
      levelId,
      boundary: {
        outer: outer.map((p) => ifcToFrontend(p, floorY)),
        holes: holes.map((loop) => loop.map((p) => ifcToFrontend(p, floorY))),
      },
      ceilingCandidates: ceilingCandidates.map(({ semanticBonus: _semanticBonus, ...candidate }) => candidate),
      label: semanticAssignments.length > 1
        ? semanticAssignments.map((item) => item.label).filter(Boolean).join(" / ")
        : roomAnchor?.label || `Room ${roomIndex}`,
      source: component.reconstructionSource === "wall-face-reconstruction"
        ? "ifc-wall-planar-graph-v1"
        : component.reconstructionSource === "ifc-space-step-profile-v1"
          ? "ifc-space-step-profile-v1"
          : component.reconstructionSource === "ifc-space-body-envelope-v1"
            ? "ifc-space-body-envelope-v1"
            : component.reconstructionSource === "ifc-wall-topology-face-v1"
              ? "ifc-wall-topology-face-v1"
              : component.reconstructionSource === "ifc-open-plan-semantic-zone-v1"
                ? "ifc-open-plan-semantic-zone-v1"
                : "ifc-space-wall-constrained-geodesic-v2",
      regionKind: component.regionKind,
      physicalComponentId: component.physicalComponentId,
      area: Number(component.area.toFixed(4)),
      center: ifcToFrontend({ x: cx, y: cy }, floorY),
      polygon: outer.map((p) => ifcToFrontend(p, floorY)),
      boundaryWalls: roomBoundaryWallIds,
      portals: [],
      touchesFloorBoundary: component.touchesBoundary,
      confidence: component.confidence ?? (component.touchesBoundary ? 0.55 : (roomAnchor ? 0.62 : 0.95)),
      floorElevation: floorY,
      ceilingElevation,
      ceilingElevationSource,
      ceilingConfidence,
      semanticSpaces: semanticAssignments.map((assignment) => ({
        expressId: Number(assignment.expressId) || 0,
        globalId: assignment.globalId || null,
        name: assignment.label,
        description: assignment.description || "",
        anchor: ifcToFrontend({ x: assignment.x, y: assignment.y }, floorY),
        associationDistanceMeters: Number(assignment.snapDistanceMeters.toFixed(3)),
        associationMethod: assignment.associationMethod || "nearest-room-polygon",
        hasGeometryRepresentation: Boolean(assignment.hasGeometryRepresentation),
      })),
      boundarySource: component.reconstructionSource === "wall-face-reconstruction"
        ? "wall-face-reconstruction"
        : component.reconstructionSource === "ifc-space-step-profile-v1"
          ? "ifc-space-step-profile"
          : component.reconstructionSource === "ifc-space-body-envelope-v1"
            ? "ifc-space-body-envelope"
            : component.reconstructionSource === "ifc-wall-topology-face-v1"
              ? "ifc-wall-topology-face"
              : component.reconstructionSource === "ifc-open-plan-semantic-zone-v1"
                ? "ifc-open-plan-semantic-zone"
                : "ifc-space-wall-constrained-geodesic",
      // IFCSPACE placements provide room identity and seed points, not exact
      // boundaries. A body-envelope fallback remains explicitly low-confidence.
      boundaryConfidence: component.confidence ?? (roomAnchor ? 0.55 : (component.touchesBoundary ? 0.55 : 0.82)),
      semanticSpace: roomAnchor ? {
        expressId: Number(roomAnchor.expressId) || 0,
        globalId: roomAnchor.globalId || null,
        name: roomAnchor.label,
        description: roomAnchor.description || "",
        anchor: roomAnchorPoint!,
        snapDistanceMeters: Number(roomAnchor.snapDistanceMeters.toFixed(3)),
        hasGeometryRepresentation: Boolean(roomAnchor.hasGeometryRepresentation),
        associationMethod: roomAnchor.associationMethod || "nearest-room-polygon",
      } : null,
    });
    roomIndex++;
  }
  return { rooms, componentToRoom };
}

function attachNativeFurnitureToRooms(
  rooms: DetectedRoom[],
  elements: ElementFootprint[],
  floorY: number,
): number {
  let assignedCount = 0;
  for (const room of rooms) {
    const outerPoints = (room.boundary?.outer?.length ? room.boundary.outer : room.polygon)
      .map((point) => ({ x: Number(point.x), y: Number(point.z) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    const holes = (room.boundary?.holes || []).map((ring) => ring
      .map((point) => ({ x: Number(point.x), y: Number(point.z) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
    if (outerPoints.length < 3) {
      room.elements = [];
      continue;
    }

    const assigned: DetectedRoomElement[] = [];
    for (const element of elements) {
      if (!element.globalId || !Number.isFinite(element.center.x) || !Number.isFinite(element.center.y)) continue;
      if (!pointInsidePolygon(element.center, outerPoints)) continue;
      if (holes.some((ring) => ring.length >= 3 && pointInsidePolygon(element.center, ring))) continue;
      if (Number.isFinite(element.maxY) && element.maxY < floorY - 0.5) continue;
      if (typeof room.ceilingElevation === "number" && Number.isFinite(room.ceilingElevation) && Number.isFinite(element.minY) && element.minY > room.ceilingElevation + 1.0) continue;

      assigned.push({
        globalId: element.globalId,
        expressId: element.expressId,
        name: element.name || `${element.ifcType} #${element.expressId}`,
        ifcType: element.ifcType,
        predefinedType: element.predefinedType || "",
        sourceFile: element.sourceFile,
        center: ifcToFrontend(element.center, floorY),
        size: {
          x: Number(element.sizeX.toFixed(3)),
          z: Number(element.sizeY.toFixed(3)),
          height: Number(Math.max(0, element.maxY - element.minY).toFixed(3)),
        },
        editingMode: "native-ifc-element",
      });
    }
    assigned.sort((a, b) => a.name.localeCompare(b.name) || a.expressId - b.expressId);
    room.elements = assigned;
    assignedCount += assigned.length;
  }
  return assignedCount;
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

function pointToSegmentDistance(point: Point2, start: Point2, end: Point2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const nearestX = start.x + t * dx;
  const nearestY = start.y + t * dy;
  return Math.hypot(point.x - nearestX, point.y - nearestY);
}

function segmentOrientation(a: Point2, b: Point2, c: Point2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const epsilon = 1e-8;
  const o1 = segmentOrientation(a, b, c);
  const o2 = segmentOrientation(a, b, d);
  const o3 = segmentOrientation(c, d, a);
  const o4 = segmentOrientation(c, d, b);
  if (((o1 > epsilon && o2 < -epsilon) || (o1 < -epsilon && o2 > epsilon))
    && ((o3 > epsilon && o4 < -epsilon) || (o3 < -epsilon && o4 > epsilon))) return true;

  const onSegment = (p: Point2, q: Point2, r: Point2) => (
    Math.abs(segmentOrientation(p, q, r)) <= epsilon
    && r.x >= Math.min(p.x, q.x) - epsilon
    && r.x <= Math.max(p.x, q.x) + epsilon
    && r.y >= Math.min(p.y, q.y) - epsilon
    && r.y <= Math.max(p.y, q.y) + epsilon
  );
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/** Minimum plan-distance between two closed IFC/room footprint outlines. */
function distanceBetweenFootprintLoops(a: Point2[], b: Point2[]): number {
  if (a.length < 2 || b.length < 2) return Number.POSITIVE_INFINITY;
  let minimum = Number.POSITIVE_INFINITY;
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b0 = b[j];
      const b1 = b[(j + 1) % b.length];
      if (segmentsIntersect(a0, a1, b0, b1)) return 0;
      minimum = Math.min(
        minimum,
        pointToSegmentDistance(a0, b0, b1),
        pointToSegmentDistance(a1, b0, b1),
        pointToSegmentDistance(b0, a0, a1),
        pointToSegmentDistance(b1, a0, a1),
      );
    }
  }
  return minimum;
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
  inputIfcPath?: string;
  outputPath?: string;
  /** Enable semantic IFC space geometry/placement reconstruction for room-aware consumers. */
  useIfcSpaceAnchors?: boolean;
}

export class RoomDetector {
  static async run(options: RoomDetectorOptions): Promise<RoomDebugArtifact> {
    const { jobDirectory } = options;
    const inputIfcPath = options.inputIfcPath ?? path.join(jobDirectory, "input.ifc");
    const outputPath = options.outputPath ?? path.join(jobDirectory, "rooms_debug.json");
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
    const excludedDuplicatePreviewSources: string[] = [];
    for (const item of Array.isArray(projectState?.furniture) ? projectState.furniture : []) {
      if (!(item?.isNativeIsolation || item?.nativeSourceId)) continue;
      if (String(item?.fileType ?? "").toLowerCase() !== "ifc") continue;
      const resolved = resolveJobRelativeSource(jobDirectory, String(item?.src ?? ""));
      if (!resolved) continue;

      const sourceBasename = path.basename(resolved);
      const isGeneratedDoorWallPreview = /_door_\d+_preview\.ifc$/i.test(sourceBasename)
        || (/_preview\.ifc$/i.test(sourceBasename) && /wall[_ -]?with[_ -]?void/i.test(String(item?.name ?? "")));
      if (isGeneratedDoorWallPreview) {
        excludedDuplicatePreviewSources.push(sourceBasename);

        // The editor keeps a wall-only preview IFC for each door insertion and
        // marks the original wall hidden while that preview is mounted. The
        // render compiler now uses the cumulative structural IFC instead of
        // stacking those previews. Room topology must follow the same authority:
        // keep the cumulative wall (which already contains all hosted openings)
        // and do not load each single-door preview as another wall/opening source.
        const nativeWallId = String(item?.nativeSourceId ?? item?.id ?? "").trim();
        if (nativeWallId) hiddenWallIds.delete(nativeWallId);
        continue;
      }

      replacementSources.set(resolved, String(item?.nativeSourceId ?? item?.id ?? "unknown"));
    }

    const ifc = new IfcAPI();
    await ifc.Init();
    const models: SourceModel[] = [];
    const modelUnitsByPath = new Map<string, ReturnType<typeof readIfcLengthUnitFromModel>>();
    const openedModelIds: number[] = [];

    const warnings: string[] = [];
    if (excludedDuplicatePreviewSources.length) {
      warnings.push(
        `Excluded ${excludedDuplicatePreviewSources.length} generated per-door wall-preview IFC source(s); topology uses the cumulative structural IFC for those host walls.`,
      );
      console.log(
        `[RoomDetector] Excluded ${excludedDuplicatePreviewSources.length} generated per-door wall-preview IFC source(s); using cumulative structural IFC host walls.`,
      );
    }
    const sourceFiles: string[] = [];
    const wallElements: ElementFootprint[] = [];
    const allWallElements: ElementFootprint[] = [];
    const openingElements: ElementFootprint[] = [];
    const doorElements: ElementFootprint[] = [];
    const slabElements: ElementFootprint[] = [];
    const overheadSurfaceElements: ElementFootprint[] = [];
    const nativeFurnitureElements: ElementFootprint[] = [];
    let nativeFurnitureSemanticCount = 0;
  let semanticOpeningCount = 0;
  let semanticDoorCount = 0;
  const semanticBySource: Array<{ sourceFile: string; wallCount: number; openingCount: number; doorCount: number; slabCount: number }> = [];

    try {
      const baseId = ifc.OpenModel(await bytesFor(inputIfcPath), { COORDINATE_TO_ORIGIN: false });
      openedModelIds.push(baseId);
      const lengthUnitInfo = readIfcLengthUnitFromModel(ifc, baseId);
      modelUnitsByPath.set(inputIfcPath, lengthUnitInfo);
      if (lengthUnitInfo.warning) warnings.push(lengthUnitInfo.warning);
      models.push({ label: path.basename(inputIfcPath), filePath: inputIfcPath, modelId: baseId, hiddenWallGlobalIds: hiddenWallIds });

      for (const [replacementPath] of replacementSources) {
        const modelId = ifc.OpenModel(await bytesFor(replacementPath), { COORDINATE_TO_ORIGIN: false });
        openedModelIds.push(modelId);
        modelUnitsByPath.set(replacementPath, readIfcLengthUnitFromModel(ifc, modelId));
        models.push({
          label: path.basename(replacementPath),
          filePath: replacementPath,
          modelId,
          hiddenWallGlobalIds: new Set(),
        });
      }

      for (const model of models) {
        sourceFiles.push(model.label);
        const modelLengthUnitInfo = readIfcLengthUnitFromModel(ifc, model.modelId);
        if (modelLengthUnitInfo.warning) warnings.push(`${model.label}: ${modelLengthUnitInfo.warning}`);
        const wallIds = Array.from(new Set([
          ...idsWithType(ifc, model.modelId, IFCWALL),
          ...idsWithType(ifc, model.modelId, IFCWALLSTANDARDCASE),
        ]));
        const openingIds = idsWithType(ifc, model.modelId, IFCOPENINGELEMENT);
        const doorIds = idsWithType(ifc, model.modelId, IFCDOOR);
        semanticOpeningCount += openingIds.length;
        semanticDoorCount += doorIds.length;
        const slabIds = model === models[0] ? idsWithType(ifc, model.modelId, IFCSLAB) : [];
        const roofIds = model === models[0] ? idsWithType(ifc, model.modelId, IFCROOF) : [];
        const coveringIds = model === models[0] ? idsWithType(ifc, model.modelId, IFCCOVERING) : [];
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
        overheadSurfaceElements.push(...slabs.values());

        const roofs = await collectElements(ifc, model.modelId, model.filePath, model.label, new Set(roofIds));
        overheadSurfaceElements.push(...roofs.values());
        const coverings = await collectElements(ifc, model.modelId, model.filePath, model.label, new Set(coveringIds));
        overheadSurfaceElements.push(...Array.from(coverings.values()).filter((element) => (
          element.predefinedType === "CEILING" || /ceiling|soffit/i.test(element.name)
        )));
      }

      // Native furniture is part of the base IFC, not projectState.furniture.
      // Collect it separately so the room workspace can list these elements
      // without pretending they are already isolated, transformable GLB assets.
      if (models[0]) {
        const baseModel = models[0];
        const furnishingIds = idsWithType(ifc, baseModel.modelId, IFCFURNISHINGELEMENT);
        nativeFurnitureSemanticCount = furnishingIds.length;
        const furnishingMap = await collectElements(
          ifc,
          baseModel.modelId,
          baseModel.filePath,
          baseModel.label,
          new Set(furnishingIds),
          true,
        );
        for (const expressId of furnishingIds) {
          const element = furnishingMap.get(expressId);
          if (!element) continue;
          if (element.points.length < 3) {
            const line = ifc.GetLine(baseModel.modelId, expressId);
            const rawPlacement = extractPlacementPointRaw(ifc, baseModel.modelId, lineRefId(line, "ObjectPlacement"));
            if (!rawPlacement) continue;
            const placement = ifcZUpToViewer({
              x: rawPlacement.x * lengthUnitInfo.toMeters,
              y: rawPlacement.y * lengthUnitInfo.toMeters,
              z: rawPlacement.z * lengthUnitInfo.toMeters,
            });
            element.center = { x: placement.x, y: placement.z };
            element.minY = placement.y;
            element.maxY = placement.y;
          }
          if (element.globalId && Number.isFinite(element.center.x) && Number.isFinite(element.center.y)) {
            if (baseModel.hiddenWallGlobalIds.has(element.globalId)) continue;
            nativeFurnitureElements.push(element);
          }
        }
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

      // IfcDoor placements are a geometry source in their own right. Some IFC
      // exporters omit IfcOpeningElement and both void/fill relationships, but
      // still publish the door's placement, OverallWidth and Body profile.
      const stepDoorPlacements: Array<{ sourceFile: string; door: StepDoorPlacement }> = [];
      for (const model of models) {
        const units = modelUnitsByPath.get(model.filePath) ?? readIfcLengthUnitFromModel(ifc, model.modelId);
        const parsed = readIfcStepDoorPlacements(model.filePath, units.toMeters);
        warnings.push(...parsed.diagnostics.map((message) => `${model.label}: ${message}`));
        for (const door of parsed.doors.values()) stepDoorPlacements.push({ sourceFile: model.label, door });
      }

      if (!slabElements.length) warnings.push("No IfcSlab geometry was found; room domain could not use a slab footprint.");
      if (!wallElements.length) throw new Error("RoomDetector: no wall geometry found.");
      if (!slabElements.length) throw new Error("RoomDetector: no slab geometry found.");
      if (semanticOpeningCount === 0) warnings.push("No IFCOPENINGELEMENT semantic entities were discovered in the active IFC sources.");
      if (semanticDoorCount === 0) warnings.push("No IFCDOOR semantic entities were discovered in the active IFC sources.");

      // Build one topology grid from the lowest floor-slab level. Level elevation
      // is the TOP of the floor slab (maxY), because room floor/ceiling heights
      // must be measured from the walking surface, not the slab underside (minY).
      // The navigation detector is currently a single-level solver; merging
      // projected slabs from every storey caused upper floors to collapse into
      // the same X/Z raster. We isolate the base level and report the others.
      const floorLikeSlabs = slabElements.filter((slab) =>
        ["FLOOR", "BASESLAB", "LANDING"].includes(slab.predefinedType),
      );
      const nonRoofSlabs = slabElements.filter((slab) => slab.predefinedType !== "ROOF");
      const floorCandidates = floorLikeSlabs.length ? floorLikeSlabs : nonRoofSlabs;
      const levelGroups: Array<{ elevation: number; slabs: ElementFootprint[] }> = [];
      for (const slab of floorCandidates.filter((item) => Number.isFinite(item.maxY) && item.points.length >= 3)) {
        const floorTopY = slab.maxY;
        const existing = levelGroups.find((group) => Math.abs(group.elevation - floorTopY) <= 0.35);
        if (existing) {
          existing.slabs.push(slab);
          existing.elevation = existing.slabs.reduce((sum, item) => sum + item.maxY, 0) / existing.slabs.length;
        } else {
          levelGroups.push({ elevation: floorTopY, slabs: [slab] });
        }
      }
      levelGroups.sort((a, b) => a.elevation - b.elevation);
      const selectedLevel = levelGroups[0] ?? null;
      const selectedFloorSlabs = selectedLevel?.slabs ?? slabElements;
      const floorPoints = selectedFloorSlabs.flatMap((slab) => slab.points);
      const actualFloorY = selectedLevel?.elevation ?? Math.min(...slabElements.map((slab) => slab.maxY).filter(Number.isFinite));
      if (!Number.isFinite(actualFloorY)) throw new Error("RoomDetector: could not resolve a valid floor elevation.");
      const semanticSpaceIds = options.useIfcSpaceAnchors && models.length
        ? idsWithType(ifc, models[0].modelId, IFCSPACE)
        : [];
      const semanticSpaceAnchors = options.useIfcSpaceAnchors && models.length
        ? collectIfcSpaceAnchors(ifc, models[0].modelId, models[0].label, lengthUnitInfo.toMeters)
        : [];
      const semanticSpaceAnchorsOnLevel = semanticSpaceAnchors.filter((anchor) =>
        !Number.isFinite(anchor.elevationY) || Math.abs(Number(anchor.elevationY) - actualFloorY) <= 0.45,
      );

      // Walls from other storeys must not be projected into the selected level's
      // room raster. Keep the full wall set separately for semantic relationships.
      const activeLevelWalls = wallElements.filter((wall) =>
        wall.minY <= actualFloorY + 0.45 && wall.maxY >= actualFloorY + 1.5,
      );
      if (activeLevelWalls.length) {
        wallElements.splice(0, wallElements.length, ...activeLevelWalls);
      }

      const grid = buildGrid(floorPoints, CELL_SIZE);
      const slabHull = hull(floorPoints);
      rasterizePolygon(grid, slabHull, grid.floor);

      // Walls define semantic room boundaries. For room partitioning, an actual door
      // is temporarily sealed so the two sides become distinct candidate rooms. The
      // corresponding opening/door relationship is then used as the portal between
      // those rooms. This keeps physical room semantics separate from walkability.
      for (const wall of wallElements) rasterizePolygon(grid, wall.points, grid.blocked);

      const doorGapClosureWalls: Array<{ id: string; points: Point2[] }> = [];
      const inferredDoorMatches: DoorWallMatch[] = [];
      const inferredDoorFailures = new Map<string, string>();
      const semanticLinkedDoorKeys = new Set(semanticOpenings
        .filter((opening) => opening.doorExpressId != null)
        .map((opening) => `${opening.sourceFile}:${opening.doorExpressId}`));
      for (const record of stepDoorPlacements) {
        const key = `${record.sourceFile}:${record.door.expressId}`;
        if (semanticLinkedDoorKeys.has(key)) continue;
        const result = inferDoorWallMatch({
          sourceFile: record.sourceFile,
          expressId: record.door.expressId,
          globalId: record.door.globalId,
          name: record.door.name,
          placementOrigin: record.door.placementOrigin,
          widthAxis: record.door.localWidthAxis,
          widthMeters: record.door.widthMeters,
          heightMeters: record.door.heightMeters,
        }, wallElements.map((wall) => ({
          key: wall.key,
          sourceFile: wall.sourceFile,
          expressId: wall.expressId,
          globalId: wall.globalId,
          name: wall.name,
          points: wall.points,
          center: wall.center,
          minY: wall.minY,
          maxY: wall.maxY,
          sizeX: wall.sizeX,
          sizeY: wall.sizeY,
        })), { floorElevation: actualFloorY });
        if (!result.match) {
          inferredDoorFailures.set(key, result.failureReason ?? "door-wall-match-failed");
          continue;
        }

        const sideSamples = findInteriorDoorSideSamples(
          result.match.center,
          result.match.normal,
          result.match.wallThickness,
          (point) => isWalkableFloorPoint(grid, point),
        );
        if (!sideSamples) {
          inferredDoorFailures.set(key, "door-does-not-have-walkable-floor-on-both-sides");
          continue;
        }
        // Do not require two IfcSpace placements to be known before closing an
        // internal door gap. That creates a circular dependency: the room
        // detector needs the wall closed to discover distinct room components,
        // but previously required distinct room anchors before it would close
        // the wall. Two walkable samples on opposite sides of a wall-aligned
        // door are the conservative precondition here. After segmentation, a
        // portal is emitted only if the samples resolve to two different room
        // components. Exterior doors normally fail because the outside sample
        // is not inside the slab's walkable floor mask.

        // The seal is aligned to the actual IFC door width axis, rather than
        // guessing horizontal/vertical from an axis-aligned wall bounding box.
        rasterizePolygon(grid, result.match.sealPolygon, grid.blocked);
        const closure = createDoorGapClosureFootprint(
          { id: result.match.wall.globalId ?? result.match.wall.key, points: result.match.wall.points },
          result.match.center,
          result.match.widthMeters,
          `door-gap:ifc-door-geometry:${record.door.globalId ?? record.door.expressId}`,
        );
        if (closure) doorGapClosureWalls.push(closure);
        inferredDoorMatches.push(result.match);
      }
      if (inferredDoorMatches.length) {
        warnings.push(`Inferred ${inferredDoorMatches.length} internal door opening(s) from IfcDoor placement/width and aligned host-wall geometry; exterior/ambiguous doors were not sealed. Each inferred opening will be emitted as a portal only if reconstructed room components differ on its two sides.`);
      }
      if (inferredDoorFailures.size) {
        warnings.push(`${inferredDoorFailures.size} IfcDoor geometry fallback candidate(s) were rejected: ${Array.from(inferredDoorFailures.entries()).map(([key, reason]) => `${key} (${reason})`).join(", ")}.`);
      }

      const sealableOpenings = semanticOpenings
        .filter((opening) => opening.doorExpressId != null || DOOR_MATCH_NAME.test(opening.openingName))
        .map((opening) => {
          const model = models.find((candidate) => candidate.label === opening.sourceFile);
          const door = opening.doorExpressId == null
            ? null
            : semanticDoors.find((d) => d.expressId === opening.doorExpressId && d.sourceFile === opening.sourceFile) ?? null;
          const placementExpressId = door?.objectPlacementExpressId
            ?? lineRefId(ifc.GetLine(model?.modelId ?? 0, opening.openingExpressId), "ObjectPlacement");
          const placement = model ? extractPlacementPoint(ifc, model.modelId, placementExpressId) : null;
          return { opening, door, placement };
        })
        .filter((value): value is { opening: SemanticOpening; door: SemanticDoor | null; placement: Point3 } => Boolean(value?.placement));

      for (const sealed of sealableOpenings) {
        const hostWallGlobalId = sealed.opening.hostWallGlobalId;
        const wall = hostWallGlobalId
          ? (wallElements.find((candidate) => candidate.globalId === hostWallGlobalId)
            ?? allWallElements.find((candidate) => candidate.globalId === hostWallGlobalId))
          : (sealed.opening.hostWallExpressId == null
            ? null
            : wallElements.find((candidate) => candidate.sourceFile === sealed.opening.sourceFile && candidate.expressId === sealed.opening.hostWallExpressId));
        if (!wall) continue;
        // A hosted opening from another storey must not be projected into this
        // level's planar graph or navigation grid.
        if (wall.minY > actualFloorY + 0.45 || wall.maxY < actualFloorY + 1.5) continue;

        const wallWidth = Math.min(wall.sizeX || Infinity, wall.sizeY || Infinity);
        const openingGeometry = openingElements.find(
          (candidate) => candidate.sourceFile === sealed.opening.sourceFile && candidate.expressId === sealed.opening.openingExpressId,
        );
        const openingWidth = openingGeometry
          ? Math.max(openingGeometry.sizeX, openingGeometry.sizeY)
          : null;
        const doorWidthMeters = Number.isFinite(sealed.door?.width) && Number(sealed.door?.width) > 0
          ? Number(sealed.door?.width) * lengthUnitInfo.toMeters
          : null;
        const width = Math.max(
          grid.cellSize * 2,
          doorWidthMeters ?? openingWidth ?? grid.cellSize * 8,
        );
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

        const openingCenter = openingGeometry?.center ?? { x: center.x, y: center.y };
        const closure = createDoorGapClosureFootprint(
          { id: wall.globalId ?? `${wall.sourceFile}:${wall.expressId}`, points: wall.points },
          openingCenter,
          width,
          `door-gap:${sealed.opening.openingGlobalId ?? sealed.opening.openingExpressId}`,
        );
        if (closure) doorGapClosureWalls.push(closure);
      }

      // Geometry-first room reconstruction. Wall footprints create a planar
      // graph; closed faces are the physical rooms. IFC space placements only
      // annotate those faces after the graph has already produced them.
      // Read source STEP profiles first. This path is independent of WebIFC's
      // GetLine wrappers and StreamAllMeshes output, so a missing semantic mesh
      // cannot suppress valid IfcSpace geometry.
      const stepProfiles = semanticSpaceIds.length
        ? readIfcStepSpaceFootprints(models[0].filePath, lengthUnitInfo.toMeters)
        : { footprints: new Map<number, { polygon: Point2[] }>(), diagnostics: [] as string[] };
      warnings.push(...stepProfiles.diagnostics);

      // Only ask WebIFC for geometry for spaces that did not have a supported
      // source STEP profile. This preserves compatibility with tessellated
      // exports without making the authoritative source depend on that stream.
      const spaceIdsNeedingMesh = semanticSpaceIds.filter((id) => !stepProfiles.footprints.has(id));
      let spaceGeometry = new Map<number, ElementFootprint>();
      if (spaceIdsNeedingMesh.length) {
        try {
          spaceGeometry = await collectElements(
            ifc,
            models[0].modelId,
            models[0].filePath,
            models[0].label,
            new Set(spaceIdsNeedingMesh),
            true,
          );
        } catch (error: any) {
          warnings.push(`WebIFC semantic-space mesh fallback failed; source STEP profiles and wall geometry remain available: ${String(error?.message || error)}`);
        }
      }

      const explicitSpacePolygons = new Map<string, Point2[]>();
      const explicitSpacePolygonSources = new Map<string, "ifc-space-step-profile" | "ifc-space-body-envelope">();
      let directSpaceProfileCount = 0;
      let stepSpaceProfileCount = 0;
      for (const anchor of semanticSpaceAnchorsOnLevel) {
        const expressId = Number(anchor.expressId);
        const stepOutline = stepProfiles.footprints.get(expressId)?.polygon;
        // Skip WebIFC line traversal for spaces already resolved by STEP.
        let directOutline: Point2[] | null = null;
        if (!stepOutline) {
          try {
            directOutline = extractIfcSpaceBodyPolygon(
              ifc,
              models[0].modelId,
              expressId,
              lengthUnitInfo.toMeters,
            );
          } catch (error: any) {
            warnings.push(`WebIFC profile extraction failed for IfcSpace #${expressId}; source STEP and mesh fallbacks remain available: ${String(error?.message || error)}`);
          }
        }
        const meshOutline = spaceGeometry.get(expressId)?.points;
        const outline = stepOutline && stepOutline.length >= 3
          ? stepOutline
          : (directOutline && directOutline.length >= 3
            ? directOutline
            : (meshOutline && meshOutline.length >= 3 ? hull(meshOutline) : null));
        if (outline && outline.length >= 3) {
          explicitSpacePolygons.set(anchor.key, outline);
          if (stepOutline && stepOutline.length >= 3) {
            explicitSpacePolygonSources.set(anchor.key, "ifc-space-step-profile");
            stepSpaceProfileCount++;
          } else if (directOutline && directOutline.length >= 3) {
            explicitSpacePolygonSources.set(anchor.key, "ifc-space-step-profile");
            directSpaceProfileCount++;
          } else {
            explicitSpacePolygonSources.set(anchor.key, "ifc-space-body-envelope");
          }
        }
      }
      if (directSpaceProfileCount) {
        warnings.push(`${directSpaceProfileCount} IfcSpace Body footprint(s) were read directly from WebIFC profile curves.`);
      }
      if (stepSpaceProfileCount) {
        warnings.push(`${stepSpaceProfileCount} IfcSpace footprint(s) were recovered from source IFC STEP profiles; these bypass WebIFC line-wrapper and mesh-stream interpretation.`);
      }
      const semanticSpacesForGraph = semanticSpaceAnchorsOnLevel.map((anchor) => ({
        ...anchor,
        explicitPolygon: explicitSpacePolygons.get(anchor.key) || null,
        explicitPolygonSource: explicitSpacePolygonSources.get(anchor.key),
      }));
      const explicitSpaceGeometryCount = explicitSpacePolygons.size;
      if (explicitSpaceGeometryCount) {
        warnings.push(`${explicitSpaceGeometryCount} IfcSpace body representation(s) contain usable plan geometry. These are preferred when consistent with wall-bounded room faces; smaller polygons inside one physical room remain semantic zones.`);
      }
      if (semanticSpaceIds.length && !semanticSpaceAnchorsOnLevel.length) {
        warnings.push(`Found ${semanticSpaceIds.length} IFC spaces, but no placement metadata could be resolved on the analysed floor (${actualFloorY.toFixed(3)} m). Physical wall-bounded faces will still be detected.`);
      }
      if (levelGroups.length > 1) {
        warnings.push(`Detected ${levelGroups.length} candidate floor levels using floor-slab top elevations. This release reconstructs the lowest floor level only (${actualFloorY.toFixed(3)} m); higher levels are reported but not segmented yet.`);
      }

      const roomGraph = reconstructRoomsFromWallFootprints({
        walls: [
          ...wallElements.map((wall) => ({
            id: wall.globalId ?? `${wall.sourceFile}:${wall.expressId}`,
            points: wall.points,
          })),
          ...doorGapClosureWalls,
        ],
        semanticSpaces: semanticSpacesForGraph,
        maxSemanticAssociationDistanceM: 3.25,
      });
      warnings.push(...roomGraph.warnings);

      // The planar wall graph is the highest-confidence physical boundary
      // source. The floor-grid topology solver runs for every floor, including
      // models without usable IfcSpace anchors: it can publish only independently
      // wall-enclosed geometry-derived rooms in that case. When semantic anchors
      // exist, it can also partition connected open-plan faces into labelled zones.
      // Compute the floor-grid room registry even when the wall graph has some
      // closed faces or semantic spaces are missing. A coarse wall face can
      // contain several IFC semantic spaces in an open-plan area; an incomplete
      // planar graph can also miss physical faces. Only prefer the grid result
      // when it adds valid regions and retains at least 85% walkable-floor coverage.
      const topologyReconstruction = reconstructRoomsFromWallTopology({
        floorPolygon: slabHull,
        anchors: semanticSpaceAnchorsOnLevel.map((anchor) => ({
          ...anchor,
          explicitPolygon: explicitSpacePolygons.get(anchor.key) || null,
        })),
        grid,
        explicitSpacePolygons: Object.fromEntries(explicitSpacePolygons.entries()),
        // IFC space ObjectPlacement origins are often placed on/near a
        // wall or an internal reference point rather than the walkable
        // cell centre. Snap progressively up to 1.5 m, but only while the
        // requested point remains inside the actual slab footprint. The
        // resolver records the actual offset and reduces confidence.
        maxAnchorSnapMeters: 1.5,
      });
      const useTopologyRegions = Boolean(topologyReconstruction?.regions.length)
        && shouldUseTopologyRoomRegions(
          roomGraph.faces.length,
          topologyReconstruction!.regions.length,
          topologyReconstruction!.coverageRatio,
        );
      if (useTopologyRegions) {
        const reason = roomGraph.faces.length === 0
          ? "Wall planar graph produced no closed faces"
          : `Semantic floor partition improved ${roomGraph.faces.length} wall face(s) to ${topologyReconstruction!.regions.length} room/zone target(s)`;
        const geometryOnlyRoomCount = topologyReconstruction!.regions.filter((region) => region.anchor.synthetic).length;
        const ifcAnchoredRegionCount = topologyReconstruction!.regions.length - geometryOnlyRoomCount;
        warnings.push(
          `${reason}. Reconstructed ${topologyReconstruction!.regions.length} room/zone areas from ${topologyReconstruction!.physicalComponentCount} disconnected floor components (${ifcAnchoredRegionCount} IFC-anchored and ${geometryOnlyRoomCount} geometry-derived); ${topologyReconstruction!.openPlanComponentCount} connected component(s) contain inferred open-plan zones, not physical partitions.`,
        );
        warnings.push(...topologyReconstruction!.warnings);
      }
      if (!semanticSpaceIds.length) {
        warnings.push("No IfcSpace entities were found. Physical rooms are still generated from closed wall geometry and receive editable generated names.");
      }

      const components: Component[] = [];
      const anchorByComponent = new Map<number, ResolvedRoomAnchor>();
      grid.room.fill(-1);
      for (const face of (useTopologyRegions ? [] : roomGraph.faces)) {
        const polygon = face.polygon;
        const cells = gridCellsInsidePolygon(grid, polygon);
        const semanticAssignments: ResolvedRoomAnchor[] = face.semanticSpaces.map((space) => ({
          ...space,
          snappedX: space.x,
          snappedY: space.y,
          snapDistanceMeters: space.associationDistanceMeters,
          associationMethod: space.associationMethod,
        }));
        let minI = grid.width - 1;
        let minJ = grid.height - 1;
        let maxI = 0;
        let maxJ = 0;
        for (const cell of cells) {
          const i = cell % grid.width;
          const j = Math.floor(cell / grid.width);
          minI = Math.min(minI, i);
          minJ = Math.min(minJ, j);
          maxI = Math.max(maxI, i);
          maxJ = Math.max(maxJ, j);
        }
        const id = components.length;
        const component: Component = {
          id,
          cells,
          area: face.areaM2,
          center: face.center,
          minI: cells.length ? minI : 0,
          maxI: cells.length ? maxI : 0,
          minJ: cells.length ? minJ : 0,
          maxJ: cells.length ? maxJ : 0,
          touchesBoundary: false,
          polygon,
          holes: [],
          boundaryWallIds: face.boundaryWallIds,
          semanticSpaces: semanticAssignments,
          anchor: semanticAssignments[0],
          reconstructionSource: face.geometrySource === "ifc-space-step-profile"
            ? "ifc-space-step-profile-v1"
            : face.geometrySource === "ifc-space-body-envelope"
              ? "ifc-space-body-envelope-v1"
              : "wall-face-reconstruction",
          confidence: face.confidence,
        };
        components.push(component);
        if (semanticAssignments[0]) anchorByComponent.set(id, semanticAssignments[0]);
        for (const cell of cells) grid.room[cell] = id;
      }

      if (useTopologyRegions && topologyReconstruction?.regions.length) {
        grid.room.fill(-1);
        for (const region of topologyReconstruction.regions) {
          const cells = region.cells;
          let minI = grid.width - 1;
          let minJ = grid.height - 1;
          let maxI = 0;
          let maxJ = 0;
          for (const cell of cells) {
            const i = cell % grid.width;
            const j = Math.floor(cell / grid.width);
            minI = Math.min(minI, i);
            minJ = Math.min(minJ, j);
            maxI = Math.max(maxI, i);
            maxJ = Math.max(maxJ, j);
          }
          const anchor: ResolvedRoomAnchor = {
            ...region.anchor,
            snappedX: region.anchor.snappedX,
            snappedY: region.anchor.snappedY,
            snapDistanceMeters: region.anchor.snapDistanceMeters,
            associationMethod: pointInsidePolygon(
              { x: region.anchor.x, y: region.anchor.y },
              region.polygon,
            ) ? "inside-room-polygon" : "nearest-room-polygon",
          };
          const id = components.length;
          const hasIfcSemanticIdentity = !region.anchor.synthetic;
          const component: Component = {
            id,
            cells,
            area: region.areaM2,
            // The selected centre is always a walkable cell. For synthetic
            // wall-enclosed components it is a geometry-derived interior point,
            // not an IFC semantic anchor.
            center: { x: anchor.snappedX, y: anchor.snappedY },
            minI: cells.length ? minI : 0,
            maxI: cells.length ? maxI : 0,
            minJ: cells.length ? minJ : 0,
            maxJ: cells.length ? maxJ : 0,
            touchesBoundary: false,
            polygon: region.polygon,
            holes: region.holes,
            boundaryWallIds: [],
            semanticSpaces: hasIfcSemanticIdentity ? [anchor] : [],
            anchor: hasIfcSemanticIdentity ? anchor : undefined,
            reconstructionSource: region.source,
            regionKind: region.regionKind,
            physicalComponentId: region.physicalComponentId,
            confidence: region.confidence,
          };
          components.push(component);
          if (hasIfcSemanticIdentity) anchorByComponent.set(id, anchor);
          for (const cell of cells) grid.room[cell] = id;
        }
      }

      const semanticMatchedSpaceCount = components.reduce((sum, component) => sum + (component.semanticSpaces?.length || 0), 0);
      const anchoredRoomCount = components.filter((component) => Boolean(component.semanticSpaces?.length)).length;
      const roomCoverageRatio = components.length
        ? Math.min(1, components.reduce((sum, component) => sum + component.area, 0) / Math.max(0.001, planarPolygonArea(slabHull)))
        : 0;
      const totalWalkableCells = grid.floor.reduce((sum, value, index) => sum + (value && !grid.blocked[index] ? 1 : 0), 0);
      const assignedRoomCells = components.reduce((sum, component) => sum + component.cells.length, 0);
      const topologyResolvedAnchors = useTopologyRegions && topologyReconstruction
        ? topologyReconstruction.resolvedAnchors
        : [];
      const topologyResolvedAnchorKeys = new Set(topologyResolvedAnchors.map((anchor) => anchor.key));
      const unmatchedSemanticSpaces = useTopologyRegions
        ? semanticSpaceAnchorsOnLevel.filter((anchor) => !topologyResolvedAnchorKeys.has(anchor.key)).map((anchor) => anchor.label)
        : roomGraph.unmatchedSemanticSpaces;
      const anchorPartition = {
        resolvedAnchors: useTopologyRegions && topologyReconstruction
          ? topologyReconstruction.resolvedAnchors
          : semanticSpaceAnchorsOnLevel.filter((anchor) => !roomGraph.unmatchedSemanticSpaces.includes(anchor.label)),
        mappingId: useTopologyRegions && topologyReconstruction ? topologyReconstruction.mappingId : "semantic-polygon-association",
        partitioned: components.length > 1,
      };
      const reconstruction = {
        regions: components,
        warnings: [...roomGraph.warnings, ...(useTopologyRegions && topologyReconstruction ? topologyReconstruction.warnings : [])],
        coverageRatio: useTopologyRegions && topologyReconstruction
          ? topologyReconstruction.coverageRatio
          : (totalWalkableCells ? assignedRoomCells / totalWalkableCells : 0),
        method: components.length
          ? (useTopologyRegions && topologyReconstruction
            ? topologyReconstruction.method
            : roomGraph.wallGraphFaceCount > 0
            ? "ifc-wall-planar-graph-v1" as const
            : (components.every((component) => component.reconstructionSource === "ifc-space-step-profile-v1")
              ? "ifc-space-step-profile-v1" as const
              : "ifc-space-body-envelope-v1" as const))
          : "none" as const,
        floorAreaM2: useTopologyRegions && topologyReconstruction ? topologyReconstruction.floorAreaM2 : planarPolygonArea(slabHull),
        totalWalkableCells: useTopologyRegions && topologyReconstruction ? topologyReconstruction.totalWalkableCells : totalWalkableCells,
        assignedWalkableCells: useTopologyRegions && topologyReconstruction ? topologyReconstruction.assignedWalkableCells : assignedRoomCells,
      };

      const boundaryWallsByComponent = new Map<number, string[]>();
      for (const component of components) {
        boundaryWallsByComponent.set(component.id, Array.from(new Set(component.boundaryWallIds || [])));
      }

      const wallTopElevationsById = new Map<string, number>();
      for (const wall of wallElements) {
        const wallId = wall.globalId ?? `${wall.sourceFile}:${wall.expressId}`;
        if (Number.isFinite(wall.maxY)) wallTopElevationsById.set(wallId, wall.maxY);
      }
      const { rooms, componentToRoom } = createRoomObjects(
        components,
        grid,
        actualFloorY,
        boundaryWallsByComponent,
        wallTopElevationsById,
        wallElements,
        overheadSurfaceElements,
        anchorByComponent,
      );
      const assignedNativeFurnitureCount = attachNativeFurnitureToRooms(rooms, nativeFurnitureElements, actualFloorY);

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
        const openingGeometry = openingElements.find(
          (e) => e.sourceFile === semanticOpening.sourceFile && e.expressId === semanticOpening.openingExpressId,
        ) ?? null;
        const hasOpeningFootprint = Boolean(
          openingGeometry && openingGeometry.points.length >= 3 &&
          Number.isFinite(openingGeometry.center.x) && Number.isFinite(openingGeometry.center.y),
        );
        const openingLine: any = ifc.GetLine(model.modelId, semanticOpening.openingExpressId);
        const openingPlacement = extractPlacementPoint(
          ifc,
          model.modelId,
          lineRefId(openingLine, "ObjectPlacement"),
        );
        // A semantic IfcOpeningElement may have no standalone mesh. In that
        // case collectElements retains its default (0,0) center; never use that
        // placeholder as a portal. Use the actual opening placement instead.
        const center = placement
          ? { x: placement.x, y: placement.z }
          : hasOpeningFootprint
            ? openingGeometry!.center
            : openingPlacement
              ? { x: openingPlacement.x, y: openingPlacement.z }
              : null;
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
          : (DOOR_MATCH_NAME.test(semanticOpening.openingName) ? "door-name" : "ifc-rel-voids");
        const id = `portal-${semanticOpening.sourceFile}-${semanticOpening.openingExpressId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
        portals.push({
          id,
          type: (door || DOOR_MATCH_NAME.test(semanticOpening.openingName)) ? "door" : "opening",
          source: "ifc-opening",
          openingExpressId: semanticOpening.openingExpressId,
          sourceFile: semanticOpening.sourceFile,
          center: ifcToFrontend(center, actualFloorY),
          roomA,
          roomB,
          hostWallId: semanticOpening.hostWallGlobalId,
          doorExpressId: semanticOpening.doorExpressId,
          doorGlobalId: semanticOpening.doorGlobalId,
          normal: [normal.x, 0, normal.y],
          width: door?.width ?? (openingGeometry ? Math.max(openingGeometry.sizeX, openingGeometry.sizeY) : null),
          height: door?.height ?? null,
          wallThickness,
          associationMethod,
        });
      }

      const inferredDoorPortalByKey = new Map<string, { roomA: string | null; roomB: string | null; sampleSweep: ReturnType<typeof sampleDoorSides>; failureReason: string | null }>();
      for (const match of inferredDoorMatches) {
        const sampleSweep = sampleDoorSides(
          match.center,
          match.normal,
          match.wallThickness,
          grid,
          components,
          componentToRoom,
        );
        const pair = sampleSweep.find((sample) => Boolean(sample.roomA && sample.roomB && sample.roomA !== sample.roomB));
        const key = `${match.door.sourceFile}:${match.door.expressId}`;
        if (!pair || !pair.roomA || !pair.roomB) {
          inferredDoorPortalByKey.set(key, {
            roomA: null,
            roomB: null,
            sampleSweep,
            failureReason: "door-side-samples-do-not-resolve-to-two-distinct-reconstructed-rooms",
          });
          continue;
        }
        inferredDoorPortalByKey.set(key, { roomA: pair.roomA, roomB: pair.roomB, sampleSweep, failureReason: null });
        const portalId = `portal-ifc-door-geometry-${match.door.sourceFile}-${match.door.expressId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
        portals.push({
          id: portalId,
          type: "door",
          source: "ifc-door-geometry",
          openingExpressId: null,
          sourceFile: match.door.sourceFile,
          center: ifcToFrontend(match.center, actualFloorY),
          roomA: pair.roomA,
          roomB: pair.roomB,
          hostWallId: match.wall.globalId ?? match.wall.key,
          doorExpressId: match.door.expressId,
          doorGlobalId: match.door.globalId,
          normal: [match.normal.x, 0, match.normal.y],
          width: match.widthMeters,
          height: match.heightMeters,
          wallThickness: match.wallThickness,
          associationMethod: "door-geometry-match",
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
          resolvedHostWallResolution: hostWallResolution.source,
          center: effectivePlacement ? { x: effectivePlacement.x, y: effectivePlacement.y, z: effectivePlacement.z } : null,
          wallNormal: normal,
          wallSize: hostWall ? { x: hostWall.sizeX, y: hostWall.sizeY } : null,
          doorWidth: door.width,
          sampleSweep,
          portalCandidate: candidate,
          failureReason,
        });
      });

      const inferredDoorDiagnostics: RoomDoorDiagnostic[] = stepDoorPlacements
        .filter((record) => !semanticLinkedDoorKeys.has(`${record.sourceFile}:${record.door.expressId}`))
        .map((record) => {
          const key = `${record.sourceFile}:${record.door.expressId}`;
          const match = inferredDoorMatches.find((candidate) => candidate.door.sourceFile === record.sourceFile && candidate.door.expressId === record.door.expressId) ?? null;
          const portalState = inferredDoorPortalByKey.get(key);
          const center = match?.center ?? record.door.openingCenter;
          const sampleSweep = (portalState?.sampleSweep ?? []).map((sample) => ({
            offset: sample.offset,
            sampleA: point2ToRoomPoint(sample.sampleA, actualFloorY),
            sampleB: point2ToRoomPoint(sample.sampleB, actualFloorY),
            componentA: sample.componentA,
            componentB: sample.componentB,
            roomA: sample.roomA,
            roomB: sample.roomB,
          }));
          const failureReason = portalState?.failureReason
            ?? inferredDoorFailures.get(key)
            ?? (match ? "door-portal-diagnostic-unavailable" : "door-wall-match-not-attempted");
          return makeDoorDiagnostic({
            sourceFile: record.sourceFile,
            doorExpressId: record.door.expressId,
            doorGlobalId: record.door.globalId,
            openingExpressId: null,
            openingGlobalId: null,
            hostWallExpressId: match?.wall.expressId ?? null,
            hostWallGlobalId: match?.wall.globalId ?? null,
            resolvedActiveHostWallGlobalId: match?.wall.globalId ?? null,
            resolvedActiveHostWallSourceFile: match?.wall.sourceFile ?? null,
            resolvedHostWallResolution: match ? "active" : null,
            center: ifcToFrontend(center, actualFloorY),
            wallNormal: match?.normal ?? null,
            wallSize: match ? { x: match.wall.sizeX, y: match.wall.sizeY } : null,
            doorWidth: record.door.widthMeters,
            sampleSweep,
            portalCandidate: Boolean(portalState?.roomA && portalState?.roomB),
            failureReason: portalState?.failureReason ?? (portalState ? null : failureReason),
          });
        });

      const blockedCellCount = grid.blocked.reduce((sum, value) => sum + (value ? 1 : 0), 0);
      const floorCellCount = grid.floor.reduce((sum, value) => sum + (value ? 1 : 0), 0);
      const blockedFloorCellCount = grid.blocked.reduce((sum, value, index) => sum + (value && grid.floor[index] ? 1 : 0), 0);
      const artifact: RoomDebugArtifact = {
        version: 1,
        units: {
          sourceLengthUnit: lengthUnitInfo.sourceLengthUnit,
          toMeters: lengthUnitInfo.toMeters,
          confidence: lengthUnitInfo.confidence,
        },
        status: "diagnostic",
        coordinateSystem: "web-ifc-world-y-up",
        frontendMapping: "[x, y, z] — no second axis conversion",
        cellSize: CELL_SIZE,
        floorElevation: actualFloorY,
        floorLevelElevations: levelGroups.map((group) => Number(group.elevation.toFixed(4))),
        sourceFiles,
        excludedDuplicatePreviewSources,
        rooms,
        portals,
        stats: {
          wallElementCount: wallElements.length,
          openingElementCount: semanticOpeningCount,
          doorElementCount: semanticDoorCount,
          floorPointCount: floorPoints.length,
          floorCellCount,
          blockedCellCount,
          wallMaskCoverageRatio: floorCellCount ? Number((blockedFloorCellCount / floorCellCount).toFixed(4)) : 0,
          activeLevelWallGeometryCount: wallElements.length,
          componentCount: components.length,
          retainedRoomCount: rooms.length,
          floorLevelGroupCount: levelGroups.length || 1,
          analysedFloorLevelCount: 1,
          semanticSpaceCount: semanticSpaceIds.length,
          semanticSpaceAssignedToFloorCount: semanticSpaceAnchorsOnLevel.length,
          anchoredRoomCount,
          resolvedAnchorCount: semanticMatchedSpaceCount,
          anchorMappingId: anchorPartition.mappingId,
          anchorMaxSnapDistanceMeters: Number(Math.max(0, ...(topologyReconstruction?.resolvedAnchors || []).map((anchor) => Number(anchor.snapDistanceMeters) || 0)).toFixed(4)),
          roomCoverageRatio: Number(roomCoverageRatio.toFixed(4)),
          roomReconstructionMethod: reconstruction.method,
          floorDomainAreaM2: Number(reconstruction.floorAreaM2.toFixed(4)),
          roomFootprintCoverageRatio: Number(reconstruction.coverageRatio.toFixed(4)),
          totalWalkableRoomCells: reconstruction.totalWalkableCells,
          assignedWalkableRoomCells: reconstruction.assignedWalkableCells,
          semanticMatchedSpaceCount,
          unmatchedSemanticSpaces,
          wallAxisCount: roomGraph.wallAxisCount,
          wallGraphNodeCount: roomGraph.graphNodeCount,
          wallGraphEdgeCount: roomGraph.graphEdgeCount,
          wallGraphFaceCount: roomGraph.wallGraphFaceCount,
          physicalComponentCount: useTopologyRegions && topologyReconstruction ? topologyReconstruction.physicalComponentCount : undefined,
          openPlanComponentCount: useTopologyRegions && topologyReconstruction ? topologyReconstruction.openPlanComponentCount : undefined,
          unanchoredComponentCount: useTopologyRegions && topologyReconstruction ? topologyReconstruction.unanchoredComponentCount : undefined,
          nativeFurnitureSemanticCount,
          nativeFurnitureGeometryCount: nativeFurnitureElements.length,
          nativeFurnitureAssignedCount: assignedNativeFurnitureCount,
          // Count all openings intentionally sealed for room partitioning,
          // including semantic opening relationships and geometry-validated IfcDoors.
          sealedDoorCount: sealableOpenings.length + inferredDoorMatches.length,
          inferredDoorGeometryCount: inferredDoorMatches.length,
          rejectedDoorGeometryCount: inferredDoorFailures.size,
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
          doors: [...doorDiagnostics, ...inferredDoorDiagnostics],
          anchors: topologyReconstruction?.anchorDiagnostics || [],
        },
      };

      fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2), "utf8");
      console.log(`[RoomDetector] Wrote ${outputPath} (${rooms.length} rooms, ${portals.length} portals)`);
      return artifact;
    } finally {
      for (const modelId of openedModelIds) {
        try { ifc.CloseModel(modelId); } catch { /* best effort */ }
      }
    }
  }
}
