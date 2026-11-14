import * as fs from "fs";
import * as path from "path";
import { RoomAnalysisService } from "../room-analysis/RoomAnalysisService";
import type { RoomAnalysisRoom, RoomAnalysisResponse } from "../room-analysis/RoomAnalysisService";

const ANALYSIS_SCHEMA_VERSION = 6;
const DETECTOR_VERSION = "hci-ceiling-canonical-room-registry-v2-room-anchor-coordinates-2026-11";

export interface CeilingAnalysisOptions {
  jobDirectory: string;
  inputIfcPath?: string;
  outputPath?: string;
  forceRebuild?: boolean;
}

export interface CeilingAnalysisRoom {
  id: string;
  navigationRoomId: string;
  label: string;
  levelId: string;
  source: string;
  areaM2: number;
  boundary: RoomAnalysisRoom["geometry"]["boundary"];
  geometry: RoomAnalysisRoom["geometry"];
  geometrySource: RoomAnalysisRoom["geometrySource"];
  validation: RoomAnalysisRoom["validation"];
  adjacentRooms: string[];
  boundaryWallGlobalIds: string[];
  floorY: number;
  ceilingCandidates: RoomAnalysisRoom["ceilingCandidates"];
  recommendedCeilingY: number;
  elevationSource: string;
  confidence: number;
  boundarySource: string;
  boundaryConfidence: number;
  semanticSpace: RoomAnalysisRoom["semanticSpace"];
  semanticSpaces: RoomAnalysisRoom["semanticSpaces"];
  diagnostics: string[];
  elements: RoomAnalysisRoom["elements"];
}

export interface CeilingAnalysisResponse {
  schemaVersion: number;
  detectorVersion: string;
  analysisId: string;
  sourceFingerprint: string;
  sourceIfcFileName: string;
  sourceIfcSha256: string;
  sourceIfcSizeBytes: number;
  coordinateSystem: "hci-y-up-xz-horizontal";
  units: RoomAnalysisResponse["units"];
  levels: RoomAnalysisResponse["levels"];
  rooms: CeilingAnalysisRoom[];
  warnings: string[];
  stats: {
    roomCount: number;
    candidateCeilingCount: number;
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

function mapCanonicalRoom(room: RoomAnalysisRoom): CeilingAnalysisRoom {
  return {
    id: room.id,
    navigationRoomId: room.navigationRoomId,
    label: room.label,
    levelId: room.levelId,
    source: room.source,
    areaM2: room.areaM2,
    // Both editor and ceiling designer receive the same canonical boundary
    // object. No second polygon reconstruction or axis conversion occurs.
    boundary: room.geometry.boundary,
    geometry: room.geometry,
    geometrySource: room.geometrySource,
    validation: room.validation,
    adjacentRooms: room.adjacentRooms,
    boundaryWallGlobalIds: room.boundaryWallGlobalIds,
    floorY: room.floorY,
    ceilingCandidates: room.ceilingCandidates,
    recommendedCeilingY: room.recommendedCeilingY,
    elevationSource: room.elevationSource,
    confidence: room.confidence,
    boundarySource: room.boundarySource,
    boundaryConfidence: room.boundaryConfidence,
    semanticSpace: room.semanticSpace,
    semanticSpaces: room.semanticSpaces,
    diagnostics: room.diagnostics,
    elements: room.elements,
  };
}

export class CeilingAnalysisService {
  static async run(options: CeilingAnalysisOptions): Promise<CeilingAnalysisResponse> {
    const jobDirectory = path.resolve(options.jobDirectory);
    const inputIfcPath = path.resolve(options.inputIfcPath || path.join(jobDirectory, "input.ifc"));
    const outputPath = path.resolve(options.outputPath || path.join(jobDirectory, "ceiling_analysis.json"));
    if (!fs.existsSync(inputIfcPath)) throw new Error(`CeilingAnalysis: IFC source not found at ${inputIfcPath}`);

    // RoomAnalysisService is the single owner of the IFC room geometry contract.
    // Calling it first also means the ceiling cache is keyed by the exact room
    // detector fingerprint, including structural edits and native IFC sources.
    const roomAnalysis = await RoomAnalysisService.run({
      jobDirectory,
      inputIfcPath,
      forceRebuild: Boolean(options.forceRebuild),
    });

    if (!options.forceRebuild && fs.existsSync(outputPath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(outputPath, "utf8")) as CeilingAnalysisResponse;
        if (cached?.schemaVersion === ANALYSIS_SCHEMA_VERSION
          && cached?.detectorVersion === DETECTOR_VERSION
          && cached?.sourceFingerprint === roomAnalysis.sourceFingerprint
          && Array.isArray(cached.rooms)) {
          return { ...cached, stats: { ...cached.stats, cacheHit: true } };
        }
      } catch { /* invalid or stale cache is rebuilt */ }
    }

    const rooms = roomAnalysis.rooms.map(mapCanonicalRoom);
    const response: CeilingAnalysisResponse = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      detectorVersion: DETECTOR_VERSION,
      analysisId: `ceiling_${roomAnalysis.sourceFingerprint.slice(7, 23)}`,
      sourceFingerprint: roomAnalysis.sourceFingerprint,
      sourceIfcFileName: roomAnalysis.sourceIfcFileName,
      sourceIfcSha256: roomAnalysis.sourceIfcSha256,
      sourceIfcSizeBytes: roomAnalysis.sourceIfcSizeBytes,
      coordinateSystem: roomAnalysis.coordinateSystem,
      units: roomAnalysis.units,
      levels: roomAnalysis.levels,
      rooms,
      warnings: [...roomAnalysis.warnings],
      stats: {
        roomCount: rooms.length,
        candidateCeilingCount: rooms.reduce((sum, room) => sum + room.ceilingCandidates.length, 0),
        floorLevelGroupCount: roomAnalysis.stats.floorLevelGroupCount,
        analysedFloorLevelCount: roomAnalysis.stats.analysedFloorLevelCount,
        semanticSpaceCount: roomAnalysis.stats.semanticSpaceCount,
        anchoredRoomCount: roomAnalysis.stats.anchoredRoomCount,
        resolvedAnchorCount: roomAnalysis.stats.resolvedAnchorCount,
        anchorMappingId: roomAnalysis.stats.anchorMappingId,
        roomCoverageRatio: roomAnalysis.stats.roomCoverageRatio,
        roomReconstructionMethod: roomAnalysis.stats.roomReconstructionMethod,
        floorDomainAreaM2: roomAnalysis.stats.floorDomainAreaM2,
        roomFootprintCoverageRatio: roomAnalysis.stats.roomFootprintCoverageRatio,
        totalWalkableRoomCells: roomAnalysis.stats.totalWalkableRoomCells,
        assignedWalkableRoomCells: roomAnalysis.stats.assignedWalkableRoomCells,
        nativeFurnitureSemanticCount: roomAnalysis.stats.nativeFurnitureSemanticCount,
        nativeFurnitureGeometryCount: roomAnalysis.stats.nativeFurnitureGeometryCount,
        nativeFurnitureAssignedCount: roomAnalysis.stats.nativeFurnitureAssignedCount,
        semanticMatchedSpaceCount: roomAnalysis.stats.semanticMatchedSpaceCount,
        unmatchedSemanticSpaces: roomAnalysis.stats.unmatchedSemanticSpaces,
        wallAxisCount: roomAnalysis.stats.wallAxisCount,
        wallGraphNodeCount: roomAnalysis.stats.wallGraphNodeCount,
        wallGraphEdgeCount: roomAnalysis.stats.wallGraphEdgeCount,
        wallGraphFaceCount: roomAnalysis.stats.wallGraphFaceCount,
        cacheHit: false,
      },
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(response, null, 2), "utf8");
    fs.renameSync(temporaryPath, outputPath);
    return response;
  }
}
