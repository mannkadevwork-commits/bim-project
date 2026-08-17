export type RoomSource =
  | "wall-topology-grid-v1"
  | "mixed-structural-sources"
  | "wall-topology-grid-v2";

export interface RoomPolygonPoint {
  x: number;
  y: number;
  z: number;
}

export interface RoomPortal {
  id: string;
  type: "door" | "opening";
  source: "ifc-opening";
  openingExpressId: number;
  sourceFile: string;
  center: RoomPolygonPoint;
  roomA: string | null;
  roomB: string | null;
  hostWallId?: string | null;
  doorExpressId?: number | null;
  doorGlobalId?: string | null;
  associationMethod: "ifc-rel-fills" | "ifc-rel-voids" | "door-name" | "door-geometry-match" | "opening-only";
}

export interface DetectedRoom {
  id: string;
  label: string;
  source: RoomSource;
  area: number;
  center: RoomPolygonPoint;
  polygon: RoomPolygonPoint[];
  boundaryWalls: string[];
  portals: string[];
  touchesFloorBoundary: boolean;
  confidence: number;
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
  status: "diagnostic";
  coordinateSystem: "web-ifc-world-y-up";
  frontendMapping: "[x, y, z] — no second axis conversion";
  cellSize: number;
  floorElevation: number;
  sourceFiles: string[];
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
