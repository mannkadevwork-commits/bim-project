import type {
  DetectedRoom,
  RoomBoundaryWallDiagnostic,
  RoomComponentDiagnostic,
  RoomDoorDiagnostic,
  RoomPortalSampleDiagnostic,
} from "./RoomTypes";

export interface DiagnosticPoint3 {
  x: number;
  y: number;
  z: number;
}

export function makeComponentDiagnostics(
  components: Array<{ id: number; area: number; touchesBoundary: boolean }>,
  componentToRoom: Map<number, string>,
): RoomComponentDiagnostic[] {
  return components
    .map((component) => ({
      componentId: component.id,
      area: Number(component.area.toFixed(4)),
      touchesBoundary: component.touchesBoundary,
      roomId: componentToRoom.get(component.id) ?? null,
    }))
    .sort((a, b) => a.componentId - b.componentId);
}

export function makeRoomBoundaryCandidateDiagnostics(
  rooms: DetectedRoom[],
  walls: Array<{
    id: string;
    center: { x: number; y: number };
    roomAdjacencyCount?: number;
  }>,
): RoomBoundaryWallDiagnostic[] {
  const result: RoomBoundaryWallDiagnostic[] = [];
  for (const room of rooms) {
    const roomCenter = { x: room.center.x, y: room.center.z };
    const candidates = walls
      .map((wall) => {
        const dx = wall.center.x - roomCenter.x;
        const dy = wall.center.y - roomCenter.y;
        return {
          roomId: room.id,
          wallId: wall.id,
          distanceToRoomCenter: Math.hypot(dx, dy),
          adjacentRoomCellCount: wall.roomAdjacencyCount ?? 0,
        };
      })
      .sort((a, b) => a.distanceToRoomCenter - b.distanceToRoomCenter)
      .slice(0, 12);
    result.push(...candidates);
  }
  return result;
}

export function makeDoorDiagnostic(args: {
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
  center: DiagnosticPoint3 | null;
  wallNormal: { x: number; y: number } | null;
  wallSize: { x: number; y: number } | null;
  doorWidth: number | null;
  sampleSweep: RoomPortalSampleDiagnostic[];
  portalCandidate: boolean;
  failureReason: string | null;
}): RoomDoorDiagnostic {
  return {
    sourceFile: args.sourceFile,
    doorExpressId: args.doorExpressId,
    doorGlobalId: args.doorGlobalId,
    openingExpressId: args.openingExpressId,
    openingGlobalId: args.openingGlobalId,
    hostWallExpressId: args.hostWallExpressId,
    hostWallGlobalId: args.hostWallGlobalId,
    resolvedActiveHostWallGlobalId: args.resolvedActiveHostWallGlobalId,
    resolvedActiveHostWallSourceFile: args.resolvedActiveHostWallSourceFile,
    resolvedHostWallResolution: args.resolvedHostWallResolution,
    center: args.center ? { ...args.center } : null,
    wallNormal: args.wallNormal ? { ...args.wallNormal } : null,
    wallSize: args.wallSize ? { ...args.wallSize } : null,
    doorWidth: args.doorWidth,
    sampleSweep: args.sampleSweep,
    portalCandidate: args.portalCandidate,
    failureReason: args.failureReason,
  };
}
