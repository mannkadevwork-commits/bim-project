export type RoomSource =
  | "wall-topology-grid-v1"
  | "mixed-structural-sources"
  | "wall-topology-grid-v2"
  | "ifc-space-anchor-geodesic-v1";

export interface RoomPolygonPoint {
  x: number;
  y: number;
  z: number;
}

export interface RoomPortal {
  id: string;
  type: "door" | "opening";
  source: "ifc-opening" | "hosted-glb-door";
  openingExpressId?: number | null;
  sourceFile?: string | null;
  center: RoomPolygonPoint;
  roomA: string | null;
  roomB: string | null;
  hostWallId?: string | null;
  doorExpressId?: number | null;
  doorGlobalId?: string | null;
  /** Frontend X/Y/Z basis; normal is horizontal and points toward roomA. */
  normal?: [number, number, number] | null;
  width?: number | null;
  height?: number | null;
  wallThickness?: number | null;
  instanceId?: string | null;
  assetId?: string | null;
  associationMethod?: "ifc-rel-fills" | "ifc-rel-voids" | "door-name" | "door-geometry-match" | "opening-only" | "hosted-door-side-sampling";
}

export interface RoomBoundaryLoops {
  outer: RoomPolygonPoint[];
  holes: RoomPolygonPoint[][];
}

export interface DetectedCeilingCandidate {
  id: string;
  sourceFile: string;
  expressId: number;
  globalId: string | null;
  ifcType: string;
  predefinedType: string;
  name: string;
  elevationY: number;
  verticalSpanY: number;
  flatCeilingCompatible: boolean;
  overlapRatio: number;
  confidence: number;
}

export interface DetectedRoom {
  id: string;
  /** Stable geometry-derived identity for authored ceiling designs; navigation id remains unchanged. */
  stableId?: string;
  levelId?: string;
  boundary?: RoomBoundaryLoops;
  ceilingCandidates?: DetectedCeilingCandidate[];
  label: string;
  source: RoomSource;
  area: number;
  center: RoomPolygonPoint;
  polygon: RoomPolygonPoint[];
  boundaryWalls: string[];
  portals: string[];
  touchesFloorBoundary: boolean;
  confidence: number;
  /** Estimated top-of-room elevation in the existing Y-up scene frame. */
  floorElevation?: number;
  ceilingElevation?: number;
  ceilingElevationSource?: "ifc-overhead-surface" | "boundary-wall-top" | "fallback-estimate";
  ceilingConfidence?: number;
  /** How the room footprint was obtained. Anchor geodesic boundaries are inferred, not exact IFC space solids. */
  boundarySource?: "ifc-space-anchor-geodesic" | "wall-topology-grid";
  boundaryConfidence?: number;
  semanticSpace?: {
    expressId: number;
    globalId: string | null;
    name: string;
    description: string;
    anchor: RoomPolygonPoint;
    snapDistanceMeters: number;
    hasGeometryRepresentation: boolean;
  } | null;
}

export interface RoomComponentDiagnostic {
  componentId: number;
  area: number;
  touchesBoundary: boolean;
  roomId: string | null;
}

export interface RoomBoundaryWallDiagnostic {
  roomId: string;
  wallId: string;
  distanceToRoomCenter: number;
  adjacentRoomCellCount: number;
}

export interface RoomPortalSampleDiagnostic {
  offset: number;
  sampleA: RoomPolygonPoint;
  sampleB: RoomPolygonPoint;
  componentA: number | null;
  componentB: number | null;
  roomA: string | null;
  roomB: string | null;
}

export interface RoomDoorDiagnostic {
  sourceFile: string;
  doorExpressId: number;
  doorGlobalId: string | null;
  openingExpressId: number | null;
  openingGlobalId: string | null;
  hostWallExpressId: number | null;
  hostWallGlobalId: string | null;
  resolvedActiveHostWallGlobalId: string | null;
  resolvedActiveHostWallSourceFile: string | null;
  resolvedHostWallResolution: "active" | "semantic-source" | null;
  center: RoomPolygonPoint | null;
  wallNormal: { x: number; y: number } | null;
  wallSize: { x: number; y: number } | null;
  doorWidth: number | null;
  sampleSweep: RoomPortalSampleDiagnostic[];
  portalCandidate: boolean;
  failureReason: string | null;
}

export interface RoomDebugArtifact {
  version: 1;
  units?: {
    sourceLengthUnit: string;
    toMeters: number;
    confidence: "ifc-unit-assignment" | "assumed-metre";
  };
  status: "diagnostic";
  coordinateSystem: "web-ifc-world-y-up";
  frontendMapping: "[x, y, z] — no second axis conversion";
  cellSize: number;
  floorElevation: number;
  floorLevelElevations?: number[];
  sourceFiles: string[];
  /** Generated per-door preview IFCs excluded because the canonical structural IFC already contains cumulative wall cuts. */
  excludedDuplicatePreviewSources: string[];
  rooms: DetectedRoom[];
  portals: RoomPortal[];
  stats: {
    wallElementCount: number;
    openingElementCount: number;
    doorElementCount: number;
    floorPointCount: number;
    floorCellCount: number;
    blockedCellCount: number;
    componentCount: number;
    retainedRoomCount: number;
    floorLevelGroupCount?: number;
    analysedFloorLevelCount?: number;
    semanticSpaceCount?: number;
    anchoredRoomCount?: number;
    roomCoverageRatio?: number;
    sealedDoorCount: number;
    portalCount: number;
  };
  warnings: string[];
  semantic: {
    bySource: Array<{ sourceFile: string; wallCount: number; openingCount: number; doorCount: number; slabCount: number }>;
    openingGeometryCount: number;
    doorGeometryCount: number;
    voidRelationshipCount: number;
    fillRelationshipCount: number;
  };
  diagnostics: {
    components: RoomComponentDiagnostic[];
    roomBoundaryCandidates: RoomBoundaryWallDiagnostic[];
    doors: RoomDoorDiagnostic[];
  };
}
