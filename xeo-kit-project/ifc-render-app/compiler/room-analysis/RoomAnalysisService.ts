import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { RoomDetector } from "../navigation/RoomDetector";
import type { DetectedRoom, RoomDebugArtifact, RoomPolygonPoint } from "../navigation/RoomTypes";

const ROOM_ANALYSIS_SCHEMA_VERSION = 2;
const ROOM_DETECTOR_VERSION = "hci-room-wall-planar-graph-v6-ifc-step-space-profile-fallback-2026-11";

export interface RoomAnalysisOptions {
  jobDirectory: string;
  inputIfcPath?: string;
  outputPath?: string;
  debugOutputPath?: string;
  forceRebuild?: boolean;
}

export interface RoomAnalysisRoom {
  id: string;
  navigationRoomId: string;
  label: string;
  levelId: string;
  source: string;
  areaM2: number;
  boundary: {
    outer: Array<{ x: number; z: number }>;
    holes: Array<Array<{ x: number; z: number }>>;
  };
  geometry: {
    boundary: {
      outer: Array<{ x: number; z: number }>;
      holes: Array<Array<{ x: number; z: number }>>;
    };
    areaM2: number;
    perimeterM: number;
  };
  geometrySource: "ifc-space-step-profile" | "ifc-space-body-envelope" | "ifc-space-boundary" | "wall-face-reconstruction" | "inferred-wall-grid" | "designer-override";
  validation: {
    closedBoundary: boolean;
    selfIntersection: boolean;
    overlapsOtherRooms: boolean | null;
  };
  adjacentRooms: string[];
  hostedElements: NonNullable<DetectedRoom["elements"]>;
  revision: number;
  semanticSpaces: NonNullable<DetectedRoom["semanticSpaces"]>;
  ceilingCandidates: NonNullable<DetectedRoom["ceilingCandidates"]>;
  boundaryWallGlobalIds: string[];
  floorY: number;
  recommendedCeilingY: number;
  elevationSource: string;
  confidence: number;
  boundarySource: string;
  boundaryConfidence: number;
  semanticSpace: DetectedRoom["semanticSpace"];
  diagnostics: string[];
  elements: NonNullable<DetectedRoom["elements"]>;
}

export interface RoomAnalysisResponse {
  schemaVersion: number;
  contract: "hci.room-analysis";
  detectorVersion: string;
  analysisId: string;
  sourceFingerprint: string;
  sourceIfcFileName: string;
  sourceIfcSha256: string;
  sourceIfcSizeBytes: number;
  coordinateSystem: "hci-y-up-xz-horizontal";
  units: {
    sourceLengthUnit: string;
    sceneUnit: "metre";
    toMeters: number;
    geometryScaleAppliedByWebIfc: true;
    confidence: "ifc-unit-assignment" | "assumed-metre";
  };
  levels: Array<{
    id: string;
    label: string;
    elevationY: number;
    roomCount: number;
    analysisStatus: "analysed" | "detected-not-segmented";
  }>;
  rooms: RoomAnalysisRoom[];
  warnings: string[];
  stats: {
    roomCount: number;
    floorLevelGroupCount: number;
    analysedFloorLevelCount: number;
    semanticSpaceCount: number;
    anchoredRoomCount: number;
    resolvedAnchorCount: number;
    anchorMappingId: string;
    roomCoverageRatio: number;
    roomReconstructionMethod: string;
    floorDomainAreaM2: number;
    roomFootprintCoverageRatio: number;
    totalWalkableRoomCells: number;
    assignedWalkableRoomCells: number;
    nativeFurnitureSemanticCount: number;
    nativeFurnitureGeometryCount: number;
    nativeFurnitureAssignedCount: number;
    semanticMatchedSpaceCount: number;
    unmatchedSemanticSpaces: string[];
    wallAxisCount: number;
    wallGraphNodeCount: number;
    wallGraphEdgeCount: number;
    wallGraphFaceCount: number;
    cacheHit: boolean;
  };
}

function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function resolveNativeIfcSource(jobDirectory: string, source: string): string | null {
  if (!source) return null;
  try {
    const parsed = new URL(source, "http://hci.local");
    if (parsed.pathname.startsWith("/jobs/")) {
      const match = parsed.pathname.match(/^\/jobs\/([^/]+)\/(.+)$/);
      if (!match) return null;
      const current = path.resolve(jobDirectory, match[2]);
      if (current.startsWith(`${path.resolve(jobDirectory)}${path.sep}`) && fs.existsSync(current)) return current;
      const sibling = path.resolve(path.dirname(jobDirectory), match[1], match[2]);
      return fs.existsSync(sibling) ? sibling : null;
    }
    const backendRoot = path.resolve(jobDirectory, "..", "..");
    if (parsed.pathname.startsWith("/assets/")) {
      const candidate = path.resolve(backendRoot, "assets", path.basename(parsed.pathname));
      return fs.existsSync(candidate) ? candidate : null;
    }
    if (parsed.pathname.startsWith("/uploads/")) {
      const uploadsRoot = path.resolve(backendRoot, "uploads");
      const relative = decodeURIComponent(parsed.pathname.slice("/uploads/".length));
      const candidate = path.resolve(uploadsRoot, relative);
      return candidate.startsWith(`${uploadsRoot}${path.sep}`) && fs.existsSync(candidate) ? candidate : null;
    }
  } catch { /* fall through to job-relative source */ }
  if (path.isAbsolute(source) && fs.existsSync(source)) return source;
  const candidate = path.resolve(jobDirectory, source.replace(/^\/+/, ""));
  return candidate.startsWith(`${path.resolve(jobDirectory)}${path.sep}`) && fs.existsSync(candidate) ? candidate : null;
}

function calculateSourceFingerprint(inputIfcPath: string, jobDirectory: string, projectState: any): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(inputIfcPath));
  hash.update(`\nroom-detector:${ROOM_DETECTOR_VERSION}`);
  hash.update(`\nstructural-edits:${stableStringify(projectState?.structural_edits || {})}`);

  const nativeIfcItems = (Array.isArray(projectState?.furniture) ? projectState.furniture : [])
    .filter((item: any) => (item?.isNativeIsolation || item?.nativeSourceId) && String(item?.fileType || "").toLowerCase() === "ifc")
    .map((item: any) => ({
      id: String(item?.instanceId || item?.id || ""),
      src: String(item?.src || ""),
      visible: item?.visible !== false,
      path: resolveNativeIfcSource(jobDirectory, String(item?.src || "")),
    }))
    .sort((a: any, b: any) => a.id.localeCompare(b.id));

  for (const item of nativeIfcItems) {
    hash.update(stableStringify({ id: item.id, src: item.src, visible: item.visible }));
    hash.update(item.path ? fs.readFileSync(item.path) : "missing-native-ifc-source");
  }
  return `sha256:${hash.digest("hex")}`;
}

function toBoundaryRing(points: RoomPolygonPoint[] | undefined): Array<{ x: number; z: number }> {
  return (Array.isArray(points) ? points : [])
    .map((point) => ({ x: Number(point.x), z: Number(point.z) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
}

function ringPerimeter(points: Array<{ x: number; z: number }>): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + Math.hypot(next.x - point.x, next.z - point.z);
  }, 0);
}

function ringHasSelfIntersection(points: Array<{ x: number; z: number }>): boolean {
  const orientation = (a: any, b: any, c: any) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const intersects = (a: any, b: any, c: any, d: any) => {
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);
    return o1 * o2 < -1e-9 && o3 * o4 < -1e-9;
  };
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j++) {
      if (j === i || j === (i + 1) % points.length || (j + 1) % points.length === i) continue;
      const c = points[j];
      const d = points[(j + 1) % points.length];
      if (intersects(a, b, c, d)) return true;
    }
  }
  return false;
}

function pointInRingStrict(point: { x: number; z: number }, ring: Array<{ x: number; z: number }>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const cross = (point.x - a.x) * (b.z - a.z) - (point.z - a.z) * (b.x - a.x);
    const within = point.x >= Math.min(a.x, b.x) - 1e-8 && point.x <= Math.max(a.x, b.x) + 1e-8
      && point.z >= Math.min(a.z, b.z) - 1e-8 && point.z <= Math.max(a.z, b.z) + 1e-8;
    if (Math.abs(cross) <= 1e-8 && within) return false; // touching a shared boundary is not an overlap
    const crosses = ((a.z > point.z) !== (b.z > point.z))
      && point.x < ((b.x - a.x) * (point.z - a.z)) / ((b.z - a.z) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function ringsHaveInteriorOverlap(
  first: Array<{ x: number; z: number }>,
  second: Array<{ x: number; z: number }>,
): boolean {
  if (first.length < 3 || second.length < 3) return false;
  const orientation = (a: any, b: any, c: any) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const properIntersection = (a: any, b: any, c: any, d: any) => {
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);
    return o1 * o2 < -1e-9 && o3 * o4 < -1e-9;
  };

  if (first.some((point) => pointInRingStrict(point, second)) || second.some((point) => pointInRingStrict(point, first))) return true;
  for (let i = 0; i < first.length; i++) {
    const a = first[i];
    const b = first[(i + 1) % first.length];
    for (let j = 0; j < second.length; j++) {
      const c = second[j];
      const d = second[(j + 1) % second.length];
      if (properIntersection(a, b, c, d)) return true;
    }
  }

  // Identical room polygons are an overlap even though all edges are shared.
  const pointKey = (point: { x: number; z: number }) => `${Math.round(point.x * 1000)}:${Math.round(point.z * 1000)}`;
  const firstKeys = new Set(first.map(pointKey));
  return first.length === second.length && second.every((point) => firstKeys.has(pointKey(point)));
}

function buildRoom(room: DetectedRoom): RoomAnalysisRoom {
  const floorY = Number(room.floorElevation ?? 0);
  const boundary = room.boundary || { outer: room.polygon || [], holes: [] };
  const outer = toBoundaryRing(boundary.outer);
  const holes = (Array.isArray(boundary.holes) ? boundary.holes : []).map(toBoundaryRing).filter((ring) => ring.length >= 3);
  const diagnostics: string[] = [];
  if (room.boundarySource === "ifc-space-step-profile") {
    diagnostics.push("Boundary was read from an explicit IFC IfcSpace FootPrint/Body profile. Verify it aligns with room-bounding walls and adjacent room boundaries before structural editing.");
  }
  if (room.boundarySource === "ifc-space-body-envelope") {
    diagnostics.push("Boundary is a convex envelope of the IFC space body mesh, not a validated exact room boundary. It may overfill concavities or voids and requires manual review.");
  }
  if (room.boundarySource === "wall-face-reconstruction") {
    diagnostics.push("Boundary is inferred from a planar graph of IFC wall footprints and inset to the room-facing wall sides. Review complex junctions before structural edits.");
  } else if (room.boundarySource === "ifc-space-wall-constrained-geodesic" || room.boundarySource === "ifc-space-anchor-geodesic") {
    diagnostics.push("This room footprint is inferred from an IFC space anchor and wall-constrained floor grid. Review the outline before making structural changes.");
  }
  if (room.ceilingElevationSource === "fallback-estimate") {
    diagnostics.push("Ceiling elevation is an estimate and requires manual confirmation.");
  }
  if (!room.boundaryWalls?.length) diagnostics.push("No boundary wall GlobalIds were resolved for this room.");

  const areaM2 = Number(room.area) || 0;
  const perimeterM = ringPerimeter(outer);
  const selfIntersection = outer.length < 3 || ringHasSelfIntersection(outer)
    || holes.some((ring) => ringHasSelfIntersection(ring));
  const geometryBoundary = { outer, holes };
  const geometrySource: RoomAnalysisRoom["geometrySource"] = room.boundarySource === "wall-face-reconstruction"
    ? "wall-face-reconstruction"
    : room.boundarySource === "ifc-space-step-profile" ? "ifc-space-step-profile"
      : room.boundarySource === "ifc-space-body-envelope" ? "ifc-space-body-envelope"
        : room.boundarySource === "ifc-space-wall-constrained-geodesic" || room.boundarySource === "ifc-space-anchor-geodesic"
          ? "ifc-space-boundary"
          : "inferred-wall-grid";
  const elements = Array.isArray(room.elements) ? room.elements : [];

  return {
    id: room.stableId || room.id,
    navigationRoomId: room.id,
    label: room.label || room.semanticSpace?.name || room.id,
    levelId: room.levelId || `level_${Math.round(floorY * 100)}`,
    source: room.source,
    areaM2,
    boundary: geometryBoundary,
    geometry: { boundary: geometryBoundary, areaM2, perimeterM },
    geometrySource,
    validation: {
      closedBoundary: outer.length >= 3,
      selfIntersection,
      // Cross-room overlap is evaluated after all room faces are constructed.
      // null means not evaluated, rather than claiming a clean result.
      overlapsOtherRooms: null,
    },
    adjacentRooms: [],
    hostedElements: elements,
    revision: 1,
    semanticSpaces: Array.isArray(room.semanticSpaces) ? room.semanticSpaces : [],
    ceilingCandidates: Array.isArray(room.ceilingCandidates) ? room.ceilingCandidates : [],
    boundaryWallGlobalIds: Array.from(new Set((room.boundaryWalls || []).map((id) => String(id).trim()).filter((id) => id && !id.includes(":")))),
    floorY,
    recommendedCeilingY: Number(room.ceilingElevation ?? (floorY + 2.7)),
    elevationSource: room.ceilingElevationSource || "fallback-estimate",
    confidence: Number(room.ceilingConfidence ?? room.confidence ?? 0.25),
    boundarySource: room.boundarySource || "wall-topology-grid",
    boundaryConfidence: Number(room.boundaryConfidence ?? room.confidence ?? 0.5),
    semanticSpace: room.semanticSpace || null,
    diagnostics,
    elements,
  };
}

function createResponse(
  artifact: RoomDebugArtifact,
  inputIfcPath: string,
  sourceFingerprint: string,
  cacheHit: boolean,
): RoomAnalysisResponse {
  const rooms = (artifact.rooms || []).map(buildRoom);
  const wallOwners = new Map<string, string[]>();
  for (const room of rooms) {
    for (const wallId of room.boundaryWallGlobalIds) {
      const owners = wallOwners.get(wallId) || [];
      owners.push(room.id);
      wallOwners.set(wallId, owners);
    }
  }
  for (const room of rooms) {
    room.adjacentRooms = Array.from(new Set(room.boundaryWallGlobalIds.flatMap((wallId) => wallOwners.get(wallId) || []).filter((id) => id !== room.id)));
  }
  const overlappingRoomIds = new Set<string>();
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const overlaps = ringsHaveInteriorOverlap(rooms[i].geometry.boundary.outer, rooms[j].geometry.boundary.outer);
      if (overlaps) {
        overlappingRoomIds.add(rooms[i].id);
        overlappingRoomIds.add(rooms[j].id);
      }
    }
  }
  for (const room of rooms) {
    room.validation.overlapsOtherRooms = overlappingRoomIds.has(room.id);
    if (room.validation.overlapsOtherRooms) room.diagnostics.push("This room polygon overlaps another detected room. Review the boundary graph before applying structural edits.");
  }
  const roomCountsByLevel = new Map<string, number>();
  for (const room of rooms) roomCountsByLevel.set(room.levelId, (roomCountsByLevel.get(room.levelId) || 0) + 1);

  const levelElevations = Array.from(new Set((artifact.floorLevelElevations || [artifact.floorElevation]).filter(Number.isFinite))).sort((a, b) => a - b);
  const levels = levelElevations.map((elevationY, index) => {
    const roomAtElevation = rooms.find((room) => Math.abs(room.floorY - elevationY) <= 0.01);
    const id = roomAtElevation?.levelId || `level_${Math.round(elevationY * 100)}`;
    const roomCount = roomCountsByLevel.get(id) || 0;
    return {
      id,
      label: `Level ${index + 1}`,
      elevationY: Number(elevationY.toFixed(4)),
      roomCount,
      analysisStatus: roomCount > 0 ? "analysed" as const : "detected-not-segmented" as const,
    };
  });

  const semanticSpaceCount = Number(artifact.stats?.semanticSpaceCount) || 0;
  const semanticMatchedSpaceCount = Number(artifact.stats?.semanticMatchedSpaceCount ?? artifact.stats?.resolvedAnchorCount) || 0;
  if (semanticSpaceCount > 0 && semanticMatchedSpaceCount < semanticSpaceCount) {
    artifact.warnings.push(`Room reconstruction matched ${semanticMatchedSpaceCount} of ${semanticSpaceCount} IFC space identities to physical room polygons. Unmatched spaces are listed in diagnostics; wall-bounded physical rooms remain available.`);
  }

  const sourceBytes = fs.readFileSync(inputIfcPath);
  return {
    schemaVersion: ROOM_ANALYSIS_SCHEMA_VERSION,
    contract: "hci.room-analysis",
    detectorVersion: ROOM_DETECTOR_VERSION,
    analysisId: `rooms_${sourceFingerprint.slice(7, 23)}`,
    sourceFingerprint,
    sourceIfcFileName: path.basename(inputIfcPath),
    sourceIfcSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    sourceIfcSizeBytes: sourceBytes.byteLength,
    coordinateSystem: "hci-y-up-xz-horizontal",
    units: {
      sourceLengthUnit: artifact.units?.sourceLengthUnit || "unknown (assumed metre)",
      sceneUnit: "metre",
      toMeters: Number(artifact.units?.toMeters) || 1,
      geometryScaleAppliedByWebIfc: true,
      confidence: artifact.units?.confidence || "assumed-metre",
    },
    levels,
    rooms,
    warnings: Array.from(new Set(artifact.warnings || [])),
    stats: {
      roomCount: rooms.length,
      floorLevelGroupCount: Number(artifact.stats?.floorLevelGroupCount) || levels.length || 1,
      analysedFloorLevelCount: Number(artifact.stats?.analysedFloorLevelCount) || 1,
      semanticSpaceCount,
      anchoredRoomCount: Number(artifact.stats?.anchoredRoomCount) || 0,
      resolvedAnchorCount: Number(artifact.stats?.resolvedAnchorCount) || 0,
      anchorMappingId: String(artifact.stats?.anchorMappingId || "none"),
      roomCoverageRatio: Number(artifact.stats?.roomCoverageRatio) || 0,
      roomReconstructionMethod: String(artifact.stats?.roomReconstructionMethod || "none"),
      floorDomainAreaM2: Number(artifact.stats?.floorDomainAreaM2) || 0,
      roomFootprintCoverageRatio: Number(artifact.stats?.roomFootprintCoverageRatio ?? artifact.stats?.roomCoverageRatio) || 0,
      totalWalkableRoomCells: Number(artifact.stats?.totalWalkableRoomCells) || 0,
      assignedWalkableRoomCells: Number(artifact.stats?.assignedWalkableRoomCells) || 0,
      nativeFurnitureSemanticCount: Number(artifact.stats?.nativeFurnitureSemanticCount) || 0,
      nativeFurnitureGeometryCount: Number(artifact.stats?.nativeFurnitureGeometryCount) || 0,
      nativeFurnitureAssignedCount: Number(artifact.stats?.nativeFurnitureAssignedCount) || 0,
      semanticMatchedSpaceCount,
      unmatchedSemanticSpaces: Array.isArray(artifact.stats?.unmatchedSemanticSpaces) ? artifact.stats!.unmatchedSemanticSpaces! : [],
      wallAxisCount: Number(artifact.stats?.wallAxisCount) || 0,
      wallGraphNodeCount: Number(artifact.stats?.wallGraphNodeCount) || 0,
      wallGraphEdgeCount: Number(artifact.stats?.wallGraphEdgeCount) || 0,
      wallGraphFaceCount: Number(artifact.stats?.wallGraphFaceCount) || 0,
      cacheHit,
    },
  };
}

export class RoomAnalysisService {
  static async run(options: RoomAnalysisOptions): Promise<RoomAnalysisResponse> {
    const jobDirectory = path.resolve(options.jobDirectory);
    const inputIfcPath = path.resolve(options.inputIfcPath || path.join(jobDirectory, "input.ifc"));
    const outputPath = path.resolve(options.outputPath || path.join(jobDirectory, "room_analysis.json"));
    const debugOutputPath = path.resolve(options.debugOutputPath || path.join(jobDirectory, "room_topology_debug.json"));
    const statePath = path.join(jobDirectory, "project_state.json");
    if (!fs.existsSync(inputIfcPath)) throw new Error(`RoomAnalysis: IFC source not found at ${inputIfcPath}`);
    if (!fs.existsSync(statePath)) throw new Error(`RoomAnalysis: project_state.json not found at ${statePath}`);

    const projectState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const sourceFingerprint = calculateSourceFingerprint(inputIfcPath, jobDirectory, projectState);
    if (!options.forceRebuild && fs.existsSync(outputPath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(outputPath, "utf8")) as RoomAnalysisResponse;
        if (cached?.schemaVersion === ROOM_ANALYSIS_SCHEMA_VERSION
          && cached?.contract === "hci.room-analysis"
          && cached?.detectorVersion === ROOM_DETECTOR_VERSION
          && cached?.sourceFingerprint === sourceFingerprint
          && Array.isArray(cached.rooms)
          && Array.isArray(cached.levels)) {
          return { ...cached, stats: { ...cached.stats, cacheHit: true } };
        }
      } catch { /* invalid cache is rebuilt */ }
    }

    const artifact = await RoomDetector.run({
      jobDirectory,
      inputIfcPath,
      outputPath: debugOutputPath,
      useIfcSpaceAnchors: true,
    });
    const response = createResponse(artifact, inputIfcPath, sourceFingerprint, false);
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(response, null, 2), "utf8");
    fs.renameSync(temporaryPath, outputPath);
    return response;
  }
}
