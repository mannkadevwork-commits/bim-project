import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { RoomDetector } from "../navigation/RoomDetector";
import type { DetectedCeilingCandidate, DetectedRoom, RoomDebugArtifact, RoomPolygonPoint } from "../navigation/RoomTypes";

const ANALYSIS_SCHEMA_VERSION = 1;
const DETECTOR_VERSION = "hci-ceiling-room-topology-2026-10-v3";

export interface CeilingAnalysisOptions {
  jobDirectory: string;
  inputIfcPath?: string;
  outputPath?: string;
  forceRebuild?: boolean;
}

export interface CeilingAnalysisRoom {
  id: string;
  /** Original sequential detector id retained for matching legacy authored ceilings. */
  navigationRoomId: string;
  label: string;
  levelId: string;
  source: string;
  areaM2: number;
  boundary: {
    outer: Array<{ x: number; z: number }>;
    holes: Array<Array<{ x: number; z: number }>>;
  };
  floorY: number;
  ceilingCandidates: DetectedCeilingCandidate[];
  recommendedCeilingY: number;
  elevationSource: string;
  confidence: number;
  diagnostics: string[];
}

export interface CeilingAnalysisResponse {
  schemaVersion: number;
  detectorVersion: string;
  analysisId: string;
  sourceFingerprint: string;
  coordinateSystem: "hci-y-up-xz-horizontal";
  units: {
    sourceLengthUnit: string;
    sceneUnit: "metre";
    toMeters: number;
    geometryScaleAppliedByWebIfc: boolean;
    confidence: "ifc-unit-assignment" | "assumed-metre";
  };
  levels: Array<{
    id: string;
    label: string;
    elevationY: number;
    roomCount: number;
    analysisStatus: "analysed" | "detected-not-segmented";
  }>;
  rooms: CeilingAnalysisRoom[];
  warnings: string[];
  stats: {
    roomCount: number;
    candidateCeilingCount: number;
    floorLevelGroupCount: number;
    analysedFloorLevelCount: number;
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
  } catch { /* local path handled below */ }
  if (path.isAbsolute(source) && fs.existsSync(source)) return source;
  const candidate = path.resolve(jobDirectory, source.replace(/^\/+/, ""));
  return candidate.startsWith(`${path.resolve(jobDirectory)}${path.sep}`) && fs.existsSync(candidate) ? candidate : null;
}

function calculateSourceFingerprint(inputIfcPath: string, jobDirectory: string, projectState: any): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(inputIfcPath));
  hash.update("\nceiling-detector:");
  hash.update(DETECTOR_VERSION);
  hash.update("\nstructural-edits:");
  hash.update(stableStringify(projectState?.structural_edits || {}));

  // Room topology also depends on isolated/replacement IFC sources. Include
  // their exact bytes, not just the persisted URL, so a changed wall IFC can
  // never reuse a stale room-boundary cache entry.
  const nativeIfcItems = (Array.isArray(projectState?.furniture) ? projectState.furniture : [])
    .filter((item: any) => (item?.isNativeIsolation || item?.nativeSourceId) && String(item?.fileType || "").toLowerCase() === "ifc")
    .map((item: any) => ({
      id: String(item?.instanceId || item?.id || ""),
      nativeSourceId: String(item?.nativeSourceId || ""),
      src: String(item?.src || ""),
      visible: item?.visible !== false,
      path: resolveNativeIfcSource(jobDirectory, String(item?.src || "")),
    }))
    .sort((a: any, b: any) => a.id.localeCompare(b.id));
  hash.update("\nnative-ifc-sources:");
  for (const item of nativeIfcItems) {
    hash.update(stableStringify({ id: item.id, nativeSourceId: item.nativeSourceId, src: item.src, visible: item.visible }));
    if (item.path) hash.update(fs.readFileSync(item.path));
    else hash.update("missing-source");
  }
  return `sha256:${hash.digest("hex")}`;
}

function normalizeBoundary(room: DetectedRoom): { outer: Array<{ x: number; z: number }>; holes: Array<Array<{ x: number; z: number }>> } {
  const outerPoints: RoomPolygonPoint[] = room.boundary?.outer?.length ? room.boundary.outer : room.polygon;
  const holes = Array.isArray(room.boundary?.holes) ? room.boundary!.holes : [];
  const to2D = (points: RoomPolygonPoint[]) => points
    .map((point) => ({ x: Number(point.x), z: Number(point.z) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  return { outer: to2D(outerPoints), holes: holes.map(to2D).filter((ring) => ring.length >= 3) };
}

function roomDiagnostics(room: DetectedRoom): string[] {
  const diagnostics: string[] = [];
  if (!room.boundary?.outer?.length) diagnostics.push("Room boundary came from the legacy outer-loop field; no verified inner opening loops were returned.");
  if (room.ceilingElevationSource === "fallback-estimate") diagnostics.push("Ceiling elevation is a low-confidence fallback estimate and requires manual confirmation.");
  if (!room.ceilingCandidates?.length) diagnostics.push("No overhead IFC surface with meaningful projected room overlap was found.");
  else if (!room.ceilingCandidates.some((candidate) => candidate.flatCeilingCompatible)) diagnostics.push("Overhead candidates have significant vertical variation and may represent a pitched roof; they are not used as a flat-ceiling height reference.");
  else if (room.ceilingCandidates.filter((candidate) => candidate.flatCeilingCompatible).sort((a, b) => b.confidence - a.confidence)[0]?.overlapRatio < 0.55) diagnostics.push("The best flat-compatible overhead surface has limited room overlap; inspect it before applying a ceiling.");
  return diagnostics;
}

export class CeilingAnalysisService {
  static async run(options: CeilingAnalysisOptions): Promise<CeilingAnalysisResponse> {
    const jobDirectory = path.resolve(options.jobDirectory);
    const inputIfcPath = path.resolve(options.inputIfcPath || path.join(jobDirectory, "input.ifc"));
    const outputPath = path.resolve(options.outputPath || path.join(jobDirectory, "ceiling_analysis.json"));
    const statePath = path.join(jobDirectory, "project_state.json");
    if (!fs.existsSync(inputIfcPath)) throw new Error(`CeilingAnalysis: IFC source not found at ${inputIfcPath}`);
    if (!fs.existsSync(statePath)) throw new Error(`CeilingAnalysis: project_state.json not found at ${statePath}`);
    const projectState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const sourceFingerprint = calculateSourceFingerprint(inputIfcPath, jobDirectory, projectState);

    if (!options.forceRebuild && fs.existsSync(outputPath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(outputPath, "utf8")) as CeilingAnalysisResponse;
        if (cached?.schemaVersion === ANALYSIS_SCHEMA_VERSION && cached?.detectorVersion === DETECTOR_VERSION && cached?.sourceFingerprint === sourceFingerprint) {
          return { ...cached, stats: { ...cached.stats, cacheHit: true } };
        }
      } catch { /* rebuild invalid or stale cache */ }
    }

    // RoomDetector extracts IFC units and room topology from one loaded web-ifc
    // model. Avoid opening the same IFC twice in parallel; large models can have
    // substantial WASM memory footprints.
    const roomArtifact = await RoomDetector.run({
      jobDirectory,
      inputIfcPath,
      outputPath: path.join(jobDirectory, "ceiling_room_topology_debug.json"),
    });
    const unitInfo = roomArtifact.units || {
      sourceLengthUnit: "unknown (assumed metre)",
      toMeters: 1,
      confidence: "assumed-metre" as const,
    };

    const warnings = [...(roomArtifact.warnings || [])];
    if ((roomArtifact.stats?.floorLevelGroupCount || 1) > 1) {
      warnings.push("Multiple floor elevations were found. This release analyses the lowest floor level only; additional levels are listed but not room-segmented yet.");
    }

    const roomCountsByLevel = new Map<string, number>();
    const rooms: CeilingAnalysisRoom[] = (roomArtifact.rooms || []).map((room) => {
      const levelId = room.levelId || `level_${Math.round((room.floorElevation || roomArtifact.floorElevation || 0) * 100)}`;
      roomCountsByLevel.set(levelId, (roomCountsByLevel.get(levelId) || 0) + 1);
      const diagnostics = roomDiagnostics(room);
      return {
        id: room.stableId || room.id,
        navigationRoomId: room.id,
        label: room.label || room.id,
        levelId,
        source: room.source,
        areaM2: Number(room.area) || 0,
        boundary: normalizeBoundary(room),
        floorY: Number(room.floorElevation ?? roomArtifact.floorElevation ?? 0),
        ceilingCandidates: Array.isArray(room.ceilingCandidates) ? room.ceilingCandidates : [],
        recommendedCeilingY: Number(room.ceilingElevation ?? ((room.floorElevation || 0) + 2.7)),
        elevationSource: room.ceilingElevationSource || "fallback-estimate",
        confidence: Number(room.ceilingConfidence ?? room.confidence ?? 0.25),
        diagnostics,
      };
    });

    const levelElevations = Array.from(new Set((roomArtifact.floorLevelElevations || [roomArtifact.floorElevation]).filter(Number.isFinite)))
      .sort((a, b) => a - b);
    const levels = levelElevations.map((elevationY, index) => {
      const id = `level_${createHash("sha1").update(`floor-y:${Math.round(elevationY * 100)}`).digest("hex").slice(0, 12)}`;
      const roomCount = roomCountsByLevel.get(id) || 0;
      return {
        id,
        label: `Level ${index + 1}`,
        elevationY: Number(elevationY.toFixed(4)),
        roomCount,
        analysisStatus: roomCount > 0 ? "analysed" as const : "detected-not-segmented" as const,
      };
    });

    const response: CeilingAnalysisResponse = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      detectorVersion: DETECTOR_VERSION,
      analysisId: `analysis_${sourceFingerprint.slice(7, 23)}`,
      sourceFingerprint,
      coordinateSystem: "hci-y-up-xz-horizontal",
      units: {
        sourceLengthUnit: unitInfo.sourceLengthUnit,
        sceneUnit: "metre",
        toMeters: unitInfo.toMeters,
        // RoomDetector uses StreamAllMeshes with web-ifc's default linear scaling enabled.
        // The editor/compiler use that same geometry frame and must not scale it again.
        geometryScaleAppliedByWebIfc: true,
        confidence: unitInfo.confidence,
      },
      levels,
      rooms,
      warnings,
      stats: {
        roomCount: rooms.length,
        candidateCeilingCount: rooms.reduce((sum, room) => sum + room.ceilingCandidates.length, 0),
        floorLevelGroupCount: Number(roomArtifact.stats?.floorLevelGroupCount) || levels.length || 1,
        analysedFloorLevelCount: 1,
        cacheHit: false,
      },
    };

    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(response, null, 2), "utf8");
    fs.renameSync(temporaryPath, outputPath);
    return response;
  }
}
