import * as fs from "fs";
import * as path from "path";
import { NodeIO, Node as GltfNode } from "@gltf-transform/core";
import * as THREE from "three";
import {
  exportNavMesh,
  getNavMeshPositionsAndIndices,
  init as initRecast,
  NavMesh,
  NavMeshQuery,
  QueryFilter,
} from "recast-navigation";
import { generateSoloNavMesh } from "recast-navigation/generators";

const GLTF_MODE_TRIANGLES = 4;
const GLTF_MODE_TRIANGLE_STRIP = 5;
const GLTF_MODE_TRIANGLE_FAN = 6;

const DOOR_KEYWORDS = ["door", "sliding", "automatic_door", "door_sliding"];
const FURNITURE_KEYWORDS = [
  "furniture", "chair", "table", "desk", "sofa", "couch", "shelf",
  "shelving", "cabinet", "wardrobe", "bed", "sink", "toilet", "counter", "appliance",
];

const DEFAULT_METRES = {
  eyeHeight: 1.6,
  radius: 0.15,
  climb: 0.4,
  cellSize: 0.15,
  cellHeight: 0.05,
  slope: 45,
};

interface MeshRecord {
  name: string;
  triangleStart: number;
  triangleCount: number;
  upwardArea: number;
  upwardMeanY: number;
  upwardMinY: number;
  upwardMaxY: number;
}

interface ExtractedGeometry {
  positions: number[];
  indices: number[];
  labels: string[];
  meshes: MeshRecord[];
  floorMeshNames: string[];
  floorElevation: number;
  hostedDoorMeshNodesExcluded: number;
  hostedDoorInstanceIdsMatched: string[];
}

interface HotspotCandidate {
  position: [number, number, number];
  clearanceMeters: number;
  openDirections: number;
  angularSpan: number;
  maxReachMeters: number;
  centerScore: number;
  viewScore: number;
}

interface SemanticArea {
  id: string;
  label: string;
  center: [number, number, number];
}

interface CuratedHotspot {
  id: string;
  label: string;
  position: [number, number, number];
  clearanceMeters: number;
  score: number;
  source: string;
  areaId: string;
  areaLabel: string;
  presentationRole: "room-center" | "room-entrance" | "viewpoint" | "transition" | "walkpoint";
  displayOrder: number;
}

let recastReady: Promise<void> | null = null;

async function ensureRecast(): Promise<void> {
  if (!recastReady) recastReady = initRecast().then(() => undefined);
  await recastReady;
}

function keyWords(name: string, words: string[]): boolean {
  const lower = name.toLowerCase();
  return words.some((word) => lower.includes(word));
}

function isDoor(name: string): boolean {
  return keyWords(name, DOOR_KEYWORDS);
}

function isFurniture(name: string): boolean {
  return keyWords(name, FURNITURE_KEYWORDS);
}
function readHostedDoorInstanceIds(jobDirectory: string): Set<string> {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(jobDirectory, "project_state.json"), "utf8"));
    // The hosted door leaf can be IFC or GLB. The portal metadata, rather than
    // the asset file format, decides that it is a visual leaf on a traversable
    // opening and must not become a second NavMesh obstacle.
    return new Set(
      Array.isArray(state?.furniture)
        ? state.furniture
            .filter((item: any) => Boolean(item?.doorHostWallId) && item?.instanceId)
            .map((item: any) => String(item.instanceId))
        : [],
    );
  } catch {
    return new Set();
  }
}

function triNormal(positions: number[], ia: number, ib: number, ic: number): THREE.Vector3 {
  const a = new THREE.Vector3(positions[ia], positions[ia + 1], positions[ia + 2]);
  const b = new THREE.Vector3(positions[ib], positions[ib + 1], positions[ib + 2]);
  const c = new THREE.Vector3(positions[ic], positions[ic + 1], positions[ic + 2]);
  return new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).normalize();
}

function triArea(positions: number[], ia: number, ib: number, ic: number): number {
  const a = new THREE.Vector3(positions[ia], positions[ia + 1], positions[ia + 2]);
  const b = new THREE.Vector3(positions[ib], positions[ib + 1], positions[ib + 2]);
  const c = new THREE.Vector3(positions[ic], positions[ic + 1], positions[ic + 2]);
  return new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).length() * 0.5;
}

function triangleIndicesForPrimitive(primitive: any, mode: number, vertexCount: number): number[] {
  const indexAttr = primitive.getIndices();
  const raw: number[] = indexAttr
    ? Array.from(indexAttr.getArray() as any)
    : Array.from({ length: vertexCount }, (_, i) => i);

  if (mode === GLTF_MODE_TRIANGLES) return raw.slice(0, Math.floor(raw.length / 3) * 3);
  const out: number[] = [];

  if (mode === GLTF_MODE_TRIANGLE_STRIP) {
    for (let i = 0; i + 2 < raw.length; i++) {
      const a = raw[i], b = raw[i + 1], c = raw[i + 2];
      if (i % 2 === 0) out.push(a, b, c);
      else out.push(b, a, c);
    }
    return out;
  }

  if (mode === GLTF_MODE_TRIANGLE_FAN) {
    const center = raw[0];
    for (let i = 1; i + 1 < raw.length; i++) out.push(center, raw[i], raw[i + 1]);
  }
  return out;
}

/**
 * Resolve the hosted-door instance represented by a mesh node or one of its
 * ancestors. compiler.ts wraps every imported GLB under a node named
 * `${instanceId}_geometry` (not `instanceId` exactly). The old equality check
 * therefore missed every imported hosted GLB door and left its leaf in the
 * structural obstacle soup, blocking the doorway that was just cut into the
 * host wall.
 */
function findHostedDoorAncestorId(node: GltfNode, instanceIds: Set<string>): string | null {
  let ancestor: any = node;
  while (ancestor) {
    const name = String(ancestor.getName?.() || "");

    // compiler.ts tags every mesh-bearing hosted GLB-door node explicitly.
    // Parent/wrapper-based detection failed in the uploaded job: 0/4 instance
    // wrappers matched even though the door meshes were in the scene.
    const marker = "HCI_HOSTED_DOOR::";
    if (name.startsWith(marker)) {
      const instanceId = name.slice(marker.length).split("::", 1)[0];
      if (instanceIds.has(instanceId)) return instanceId;
    }

    if (instanceIds.has(name)) return name;
    if (name.endsWith("_geometry")) {
      const wrapperInstanceId = name.slice(0, -"_geometry".length);
      if (instanceIds.has(wrapperInstanceId)) return wrapperInstanceId;
    }
    ancestor = typeof ancestor.getParent === "function" ? ancestor.getParent() : null;
  }
  return null;
}

async function extractFinalGlb(glbPath: string, hostedDoorInstanceIds: Set<string>): Promise<ExtractedGeometry> {
  const io = new NodeIO();
  const document = await io.read(glbPath);
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) throw new Error("WalkNavigationPipeline: output.glb has no scene.");

  const positions: number[] = [];
  const indices: number[] = [];
  const labels: string[] = [];
  const meshes: MeshRecord[] = [];
  let hostedDoorMeshNodesExcluded = 0;
  const hostedDoorInstanceIdsMatched = new Set<string>();

  scene.traverse((node: GltfNode) => {
    const mesh = node.getMesh();
    if (!mesh) return;

    const meshName = node.getName() || mesh.getName() || "unnamed_mesh";

    // Do this before generic name-based filtering: hosted GLB door assets often
    // have child mesh names like "Geom_0_0" that do not contain the word door.
    // Their imported root is `${instanceId}_geometry`, so matching only the bare
    // instance ID silently failed and the door leaf blocked its own NavMesh gap.
    const hostedDoorId = findHostedDoorAncestorId(node, hostedDoorInstanceIds);
    if (hostedDoorId) {
      hostedDoorMeshNodesExcluded += 1;
      hostedDoorInstanceIdsMatched.add(hostedDoorId);
      return;
    }

    if (isDoor(meshName)) return;

    const worldMatrix = new THREE.Matrix4().fromArray(node.getWorldMatrix());
    const v = new THREE.Vector3();
    const triangleStart = indices.length / 3;
    let triangleCount = 0;
    let upwardArea = 0;
    let upwardYSum = 0;
    let upwardAreaWeight = 0;
    let upwardMinY = Infinity;
    let upwardMaxY = -Infinity;

    for (const primitive of mesh.listPrimitives()) {
      const mode = primitive.getMode();
      if (![GLTF_MODE_TRIANGLES, GLTF_MODE_TRIANGLE_STRIP, GLTF_MODE_TRIANGLE_FAN].includes(mode)) continue;
      const positionAttr = primitive.getAttribute("POSITION");
      if (!positionAttr) continue;
      const localPositions = positionAttr.getArray();
      if (!localPositions) continue;
      const vertexCount = positionAttr.getCount();
      const vertexOffset = positions.length / 3;

      for (let i = 0; i < vertexCount; i++) {
        v.set(localPositions[i * 3], localPositions[i * 3 + 1], localPositions[i * 3 + 2]);
        v.applyMatrix4(worldMatrix);
        positions.push(v.x, v.y, v.z);
      }

      const localIndices = triangleIndicesForPrimitive(primitive, mode, vertexCount);
      for (const idx of localIndices) indices.push(idx + vertexOffset);

      const primitiveTriangles = localIndices.length / 3;
      triangleCount += primitiveTriangles;
      const label = isFurniture(meshName) ? "furniture" : "structural";
      for (let t = 0; t < primitiveTriangles; t++) {
        const a = (localIndices[t * 3] + vertexOffset) * 3;
        const b = (localIndices[t * 3 + 1] + vertexOffset) * 3;
        const c = (localIndices[t * 3 + 2] + vertexOffset) * 3;
        const n = triNormal(positions, a, b, c);
        const area = triArea(positions, a, b, c);
        const cy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
        if (n.y > 0.70710678) {
          upwardArea += area;
          upwardYSum += cy * area;
          upwardAreaWeight += area;
          upwardMinY = Math.min(upwardMinY, cy);
          upwardMaxY = Math.max(upwardMaxY, cy);
        }
        labels.push(label);
      }
    }

    if (triangleCount > 0) {
      meshes.push({
        name: meshName,
        triangleStart,
        triangleCount,
        upwardArea,
        upwardMeanY: upwardAreaWeight > 0 ? upwardYSum / upwardAreaWeight : Infinity,
        upwardMinY: upwardMinY === Infinity ? Infinity : upwardMinY,
        upwardMaxY: upwardMaxY === -Infinity ? -Infinity : upwardMaxY,
      });
    }
  });

  const largestArea = meshes.reduce((max, mesh) => Math.max(max, mesh.upwardArea), 0);
  const areaThreshold = largestArea * 0.05;
  const substantial = meshes.filter((mesh) => mesh.upwardArea >= areaThreshold && Number.isFinite(mesh.upwardMeanY));
  const floorElevation = substantial.reduce((min, mesh) => Math.min(min, mesh.upwardMeanY), Infinity);
  const elevationTolerance = Math.max(0.02, Math.abs(floorElevation) * 0.1);
  const floorMeshNames = substantial
    .filter((mesh) => mesh.upwardMeanY <= floorElevation + elevationTolerance)
    .map((mesh) => mesh.name);

  const floorNameSet = new Set(floorMeshNames);
  for (const mesh of meshes) {
    if (!floorNameSet.has(mesh.name)) continue;
    for (let t = 0; t < mesh.triangleCount; t++) labels[mesh.triangleStart + t] = "floor_candidate";
  }

  console.log(`[WalkNav] Floor candidates: ${floorMeshNames.join(", ") || "NONE"}`);
  console.log(`[WalkNav] Floor elevation: ${Number.isFinite(floorElevation) ? floorElevation : "unknown"}`);
  return {
    positions,
    indices,
    labels,
    meshes,
    floorMeshNames,
    floorElevation,
    hostedDoorMeshNodesExcluded,
    hostedDoorInstanceIdsMatched: Array.from(hostedDoorInstanceIdsMatched),
  };
}

function buildFilteredSoup(input: ExtractedGeometry, slopeAngle: number) {
  const positions: number[] = [];
  const indices: number[] = [];
  const labels: string[] = [];
  let keptFloor = 0;
  let removedUpward = 0;
  let removedNonFloorWalkableSurface = 0;

  const keepTriangle = (t: number): boolean => {
    const ia = input.indices[t * 3] * 3;
    const ib = input.indices[t * 3 + 1] * 3;
    const ic = input.indices[t * 3 + 2] * 3;
    const n = triNormal(input.positions, ia, ib, ic);
    const slopeCos = Math.cos((slopeAngle * Math.PI) / 180);
    const isUpward = n.y > slopeCos;
    const isWalkableOrientation = Math.abs(n.y) > slopeCos;
    const isFloor = input.labels[t] === "floor_candidate";

    if (isFloor) {
      if (isUpward) keptFloor++;
      return isUpward;
    }
    if (isWalkableOrientation) {
      removedUpward++;
      removedNonFloorWalkableSurface++;
      return false;
    }
    return true;
  };

  for (let t = 0; t < input.indices.length / 3; t++) {
    if (!keepTriangle(t)) continue;
    const base = positions.length / 3;
    const ia = input.indices[t * 3] * 3;
    const ib = input.indices[t * 3 + 1] * 3;
    const ic = input.indices[t * 3 + 2] * 3;
    positions.push(
      input.positions[ia], input.positions[ia + 1], input.positions[ia + 2],
      input.positions[ib], input.positions[ib + 1], input.positions[ib + 2],
      input.positions[ic], input.positions[ic + 1], input.positions[ic + 2],
    );
    indices.push(base, base + 1, base + 2);
    labels.push(input.labels[t] === "floor_candidate" ? "floor_candidate" : `${input.labels[t]}_obstacle`);
  }

  return {
    soup: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) },
    labels,
    stats: {
      inputTriangles: input.indices.length / 3,
      filteredTriangles: indices.length / 3,
      keptFloorTriangles: keptFloor,
      removedUpwardTriangles: removedUpward,
      removedNonFloorWalkableSurfaceTriangles: removedNonFloorWalkableSurface,
    },
  };
}

function readScale(jobDirectory: string): number {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(jobDirectory, "project_state.json"), "utf8"));
    const raw = state?.scene_calibration?.scaleFactor;
    const sx = Number(raw?.x);
    const sy = Number(raw?.y);
    const sz = Number(raw?.z);
    const scale = [sx, sy, sz].filter((v) => Number.isFinite(v) && v > 0);
    return scale.length ? scale.reduce((a, b) => a + b, 0) / scale.length : 1;
  } catch {
    return 1;
  }
}

function distanceXZ(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function writeRoomConnectivity(jobDirectory: string, query: NavMeshQuery, physicalMetersPerUnit: number) {
  const topologyPath = path.join(jobDirectory, "presentation_rooms.json");
  const hotspotPath = path.join(jobDirectory, "walk_hotspots.json");
  if (!fs.existsSync(topologyPath) && !fs.existsSync(hotspotPath)) return;

  try {
    const payload = fs.existsSync(topologyPath) ? JSON.parse(fs.readFileSync(topologyPath, "utf8")) : { rooms: [] };
    const hotspotPayload = fs.existsSync(hotspotPath) ? JSON.parse(fs.readFileSync(hotspotPath, "utf8")) : null;
    const toVec3 = (value: any): [number, number, number] | null => {
      const values = Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? [value.x, value.y, value.z]
          : null;
      if (!values || values.length < 3) return null;
      const result = values.slice(0, 3).map(Number);
      return result.every(Number.isFinite) ? [result[0], result[1], result[2]] : null;
    };
    const curatedSpaces = Array.isArray(hotspotPayload?.areas) ? hotspotPayload.areas : [];
    const useCuratedSpaces = curatedSpaces.length > 1;
    const entities = useCuratedSpaces ? curatedSpaces : (Array.isArray(payload?.rooms) ? payload.rooms : []);
    const rooms = entities.map((room: any) => ({ room, center: toVec3(room?.center) }))
      .filter((entry: any) => entry.room?.id && entry.center);
    if (!rooms.length) {
      console.warn("[WalkNav] Connectivity diagnostics skipped: no semantic rooms or curated navigation spaces with valid centers.");
      return;
    }

    const unit = Math.max(Number(physicalMetersPerUnit) || 1, 1e-6);
    const completePathTolerance = Math.max(0.4 * unit, 0.3);
    const verticalTolerance = Math.max(0.5 * unit, 0.35);
    const snapped = rooms.map(({ room, center }: any) => {
      const point = query.findClosestPoint(
        { x: center[0], y: Number(center[1]) || 0, z: center[2] },
        {
          halfExtents: {
            x: Math.max(1.0 * unit, 0.35),
            y: Math.max(1.5 * unit, 0.7),
            z: Math.max(1.0 * unit, 0.35),
          },
          filter: new QueryFilter(),
        },
      );
      const snappedPoint = point?.success ? toVec3(point.point) : null;
      const snapDistance = snappedPoint
        ? Math.hypot(snappedPoint[0] - center[0], snappedPoint[2] - center[2]) / unit
        : null;
      return { room, center, point, snappedPoint, snapDistance };
    });

    const connections: Array<Record<string, any>> = [];
    const unreachable: string[] = [];
    let reachablePairs = 0;
    // Count every ordered pair up front so an unsnappable source room cannot
    // accidentally make the report look fully connected by reducing its denominator.
    const possiblePairs = Math.max(0, snapped.length * (snapped.length - 1));

    for (const from of snapped) {
      if (!from.point?.success || !from.snappedPoint) {
        unreachable.push(String(from.room.id));
        for (const to of snapped) {
          if (from.room.id === to.room.id) continue;
          connections.push({
            from: String(from.room.id),
            to: String(to.room.id),
            reachable: false,
            reason: "source-has-no-nearby-navmesh-point",
            sourceSnapDistanceMeters: from.snapDistance,
            targetSnapDistanceMeters: to.snapDistance,
          });
        }
        continue;
      }
      for (const to of snapped) {
        if (from.room.id === to.room.id) continue;
        if (!to.point?.success || !to.snappedPoint) {
          connections.push({
            from: String(from.room.id),
            to: String(to.room.id),
            reachable: false,
            reason: "target-has-no-nearby-navmesh-point",
            targetSnapDistanceMeters: to.snapDistance,
          });
          continue;
        }

        const result = query.computePath(from.point.point, to.point.point, {
          filter: new QueryFilter(),
          maxStraightPathSize: 512,
          maxPathSize: 512,
        });
        const pathPoints: any[] = Array.isArray(result?.path) ? result.path : [];
        const endpoint = pathPoints.length ? pathPoints[pathPoints.length - 1] : null;
        const endpointDistance = endpoint
          ? Math.hypot(endpoint.x - to.point.point.x, endpoint.z - to.point.point.z)
          : Infinity;
        const endpointVerticalDistance = endpoint
          ? Math.abs(endpoint.y - to.point.point.y)
          : Infinity;
        // Detour can return a valid partial path whose endpoint is merely the
        // nearest reachable polygon. Non-empty path + success is NOT proof that
        // the requested room was reached; require the last point to match target.
        const reachable = Boolean(
          result?.success && pathPoints.length > 0 &&
          endpointDistance <= completePathTolerance &&
          endpointVerticalDistance <= verticalTolerance
        );

        let pathLength = 0;
        let previous = from.point.point;
        for (const point of pathPoints) {
          pathLength += Math.hypot(point.x - previous.x, point.z - previous.z);
          previous = point;
        }
        const endpointDistanceMeters = Number.isFinite(endpointDistance)
          ? Number((endpointDistance / unit).toFixed(3))
          : null;
        const pathLengthMeters = Number((pathLength / unit).toFixed(3));
        if (reachable) reachablePairs += 1;
        connections.push({
          from: String(from.room.id),
          to: String(to.room.id),
          reachable,
          reason: reachable ? "complete-path" : result?.success && pathPoints.length ? "partial-path-endpoint" : "no-path",
          pathLengthMeters,
          endpointDistanceMeters,
          endpointVerticalDistanceMeters: Number.isFinite(endpointVerticalDistance)
            ? Number((endpointVerticalDistance / unit).toFixed(3))
            : null,
          targetSnapDistanceMeters: to.snapDistance,
          startPolyRef: from.point.polyRef ?? from.point.ref ?? null,
          targetPolyRef: to.point.polyRef ?? to.point.ref ?? null,
          ...(endpoint ? { endpoint: [endpoint.x, endpoint.y, endpoint.z] } : {}),
          target: [to.point.point.x, to.point.point.y, to.point.point.z],
        });
      }
    }

    const fullyConnected = possiblePairs === 0 || reachablePairs === possiblePairs;
    const artifact = {
      version: 3,
      source: useCuratedSpaces ? "recast-curated-navigation-space-connectivity-check" : "recast-room-connectivity-check",
      entityType: useCuratedSpaces ? "navigation-space" : "detected-room",
      validation: "complete-endpoint-required",
      completePathToleranceMeters: Number((completePathTolerance / unit).toFixed(3)),
      roomCount: useCuratedSpaces ? undefined : rooms.length,
      spaceCount: useCuratedSpaces ? rooms.length : undefined,
      entityCount: rooms.length,
      reachablePairs,
      possiblePairs,
      fullyConnected,
      unreachableRooms: Array.from(new Set(unreachable)),
      snappedRooms: snapped.map((entry: any) => ({
        id: String(entry.room.id),
        requestedCenter: entry.center,
        snappedCenter: entry.snappedPoint,
        snapDistanceMeters: entry.snapDistance,
        polyRef: entry.point?.polyRef ?? entry.point?.ref ?? null,
        success: Boolean(entry.point?.success),
      })),
      connections,
    };
    fs.writeFileSync(path.join(jobDirectory, "room_connectivity.json"), JSON.stringify(artifact, null, 2), "utf8");
    const entityLabel = useCuratedSpaces ? "navigation-space" : "detected-room";
    console.log(`[WalkNav] ${entityLabel} connectivity (complete paths only): ${reachablePairs}/${possiblePairs} directed pairs reachable.`);
    if (!fullyConnected) {
      const partial = connections.filter((entry) => !entry.reachable);
      console.warn(`[WalkNav] ${partial.length} ${entityLabel} route(s) failed complete-endpoint validation; see room_connectivity.json.`);
    }
  } catch (error) {
    console.warn(`[WalkNav] Room connectivity check failed: ${(error as Error).message}`);
  }
}

function writeDoorwayTraversability(jobDirectory: string, query: NavMeshQuery, physicalMetersPerUnit: number) {
  const sourcePath = path.join(jobDirectory, "hosted_door_portals.json");
  if (!fs.existsSync(sourcePath)) return;

  try {
    const payload = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const doors = Array.isArray(payload?.doors) ? payload.doors : [];
    if (!doors.length) return;

    const unit = Math.max(Number(physicalMetersPerUnit) || 1, 1e-6);
    const endpointTolerance = Math.max(0.4 * unit, 0.3);
    const verticalTolerance = Math.max(0.5 * unit, 0.35);
    const searchRadius = Math.max(0.28 * unit, 0.22);
    const results: Array<Record<string, any>> = [];

    const findSidePoint = (probe: [number, number, number]) => {
      return query.findClosestPoint(
        { x: probe[0], y: probe[1], z: probe[2] },
        {
          halfExtents: {
            x: searchRadius,
            y: Math.max(1.2 * unit, 0.7),
            z: searchRadius,
          },
          filter: new QueryFilter(),
        },
      );
    };

    for (const door of doors) {
      const placement = door?.doorPlacement?.position;
      if (!Array.isArray(placement) || placement.length < 3 || !placement.slice(0, 3).every(Number.isFinite)) {
        results.push({
          id: String(door?.instanceId || door?.globalId || "unknown-door"),
          connected: false,
          reason: "missing-door-placement",
        });
        continue;
      }
      const center: [number, number, number] = [Number(placement[0]), Number(placement[1]) || 0, Number(placement[2])];
      const rawAxis = door?.hostPlacement?.thicknessAxis;
      let nx = Array.isArray(rawAxis) ? Number(rawAxis[0]) : 0;
      let nz = Array.isArray(rawAxis) ? -Number(rawAxis[1]) : 0;
      let norm = Math.hypot(nx, nz);
      if (!Number.isFinite(norm) || norm < 1e-6) {
        const yaw = Number(door?.doorPlacement?.rotation?.[1] ?? 0) * Math.PI / 180;
        nx = -Math.sin(yaw);
        nz = Math.cos(yaw);
        norm = Math.hypot(nx, nz);
      }
      if (!Number.isFinite(norm) || norm < 1e-6) {
        results.push({ id: String(door?.instanceId || door?.globalId || "unknown-door"), connected: false, reason: "invalid-portal-normal" });
        continue;
      }
      nx /= norm;
      nz /= norm;

      const wallThickness = Math.max(0, Number(door?.hostPlacement?.wallThickness) || 0);
      const baseOffset = Math.max(0.55 * unit, wallThickness * 0.5 + 0.4 * unit);
      let bestAttempt: any = null;
      for (const offsetMultiplier of [1, 1.35, 1.7]) {
        const offset = baseOffset * offsetMultiplier;
        const probeA: [number, number, number] = [center[0] + nx * offset, center[1], center[2] + nz * offset];
        const probeB: [number, number, number] = [center[0] - nx * offset, center[1], center[2] - nz * offset];
        const sideA = findSidePoint(probeA);
        const sideB = findSidePoint(probeB);
        if (!sideA?.success || !sideB?.success || !sideA.point || !sideB.point) {
          bestAttempt = {
            id: String(door.instanceId || door.globalId || "unknown-door"),
            assetId: door.assetId ?? null,
            wallGlobalId: door.globalId ?? door.hostPlacement?.wallGlobalId ?? null,
            openingGlobalId: door.openingGlobalId ?? null,
            center,
            widthMeters: Number(door?.voidDimensions?.width) || null,
            heightMeters: Number(door?.voidDimensions?.height) || null,
            offsetMeters: Number((offset / unit).toFixed(3)),
            connected: false,
            reason: !sideA?.success && !sideB?.success ? "no-navmesh-point-on-either-side"
              : !sideA?.success ? "no-navmesh-point-on-side-a" : "no-navmesh-point-on-side-b",
            sideA: sideA?.success ? [sideA.point.x, sideA.point.y, sideA.point.z] : null,
            sideB: sideB?.success ? [sideB.point.x, sideB.point.y, sideB.point.z] : null,
          };
          continue;
        }

        const pathResult = query.computePath(sideA.point, sideB.point, {
          filter: new QueryFilter(),
          maxStraightPathSize: 512,
          maxPathSize: 512,
        });
        const points: any[] = Array.isArray(pathResult?.path) ? pathResult.path : [];
        const endpoint = points.length ? points[points.length - 1] : null;
        const endpointDistance = endpoint ? Math.hypot(endpoint.x - sideB.point.x, endpoint.z - sideB.point.z) : Infinity;
        const endpointVerticalDistance = endpoint ? Math.abs(endpoint.y - sideB.point.y) : Infinity;
        const connected = Boolean(
          pathResult?.success && points.length > 0 &&
          endpointDistance <= endpointTolerance && endpointVerticalDistance <= verticalTolerance
        );
        let pathLength = 0;
        let previous = sideA.point;
        for (const point of points) {
          pathLength += Math.hypot(point.x - previous.x, point.z - previous.z);
          previous = point;
        }
        bestAttempt = {
          id: String(door.instanceId || door.globalId || "unknown-door"),
          assetId: door.assetId ?? null,
          wallGlobalId: door.globalId ?? door.hostPlacement?.wallGlobalId ?? null,
          openingGlobalId: door.openingGlobalId ?? null,
          center,
          widthMeters: Number(door?.voidDimensions?.width) || null,
          heightMeters: Number(door?.voidDimensions?.height) || null,
          offsetMeters: Number((offset / unit).toFixed(3)),
          connected,
          reason: connected ? "complete-path-through-portal" : pathResult?.success && points.length ? "partial-path-endpoint" : "no-path-between-sides",
          sideA: [sideA.point.x, sideA.point.y, sideA.point.z],
          sideB: [sideB.point.x, sideB.point.y, sideB.point.z],
          sideAPolyRef: sideA.polyRef ?? sideA.ref ?? null,
          sideBPolyRef: sideB.polyRef ?? sideB.ref ?? null,
          endpoint: endpoint ? [endpoint.x, endpoint.y, endpoint.z] : null,
          endpointDistanceMeters: Number.isFinite(endpointDistance) ? Number((endpointDistance / unit).toFixed(3)) : null,
          pathLengthMeters: Number((pathLength / unit).toFixed(3)),
        };
        if (connected) break;
      }
      results.push(bestAttempt || {
        id: String(door?.instanceId || door?.globalId || "unknown-door"),
        connected: false,
        reason: "portal-test-not-completed",
      });
    }

    const traversableCount = results.filter((result) => result.connected).length;
    const summary = {
      version: 1,
      source: "hosted-door-navmesh-side-to-side-test",
      validation: "complete-path-endpoint-required",
      hostedDoorCount: doors.length,
      traversableCount,
      blockedCount: doors.length - traversableCount,
      endpointToleranceMeters: Number((endpointTolerance / unit).toFixed(3)),
      doors: results,
    };
    fs.writeFileSync(path.join(jobDirectory, "doorway_traversability.json"), JSON.stringify(summary, null, 2), "utf8");
    console.log(`[WalkNav] Doorway traversability: ${traversableCount}/${doors.length} hosted door passages reachable side-to-side.`);
    for (const result of results) {
      console.log(`[WalkNav] Door ${result.id}: ${result.connected ? "PASS" : "BLOCKED"} (${result.reason || "unknown"})`);
    }
  } catch (error) {
    console.warn(`[WalkNav] Doorway traversability check failed: ${(error as Error).message}`);
  }
}

function horizontalDistance(a: any, b: any): number {
  const av = Array.isArray(a) ? a : a && typeof a === "object" ? [a.x, a.y, a.z] : null;
  const bv = Array.isArray(b) ? b : b && typeof b === "object" ? [b.x, b.y, b.z] : null;
  if (!av || !bv || av.length < 3 || bv.length < 3) return Infinity;
  return Math.hypot(Number(av[0]) - Number(bv[0]), Number(av[2]) - Number(bv[2]));
}

function connectedComponentsForGraph(nodes: Array<{ id: string; neighbors: string[] }>): string[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const groups: string[][] = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const queue = [node.id];
    const group: string[] = [];
    visited.add(node.id);
    while (queue.length) {
      const id = queue.shift()!;
      group.push(id);
      for (const next of byId.get(id)?.neighbors || []) {
        if (visited.has(next) || !byId.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    groups.push(group);
  }
  return groups;
}

function writePresentationPortalGraph(jobDirectory: string, query: NavMeshQuery, physicalMetersPerUnit: number) {
  const manifestPath = path.join(jobDirectory, "presentation_portals.json");
  const hotspotsPath = path.join(jobDirectory, "walk_hotspots.json");
  const hostedPath = path.join(jobDirectory, "hosted_door_portals.json");
  const traversalPath = path.join(jobDirectory, "doorway_traversability.json");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(hotspotsPath)) return;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const hotspotPayload = JSON.parse(fs.readFileSync(hotspotsPath, "utf8"));
    const hostedPayload = fs.existsSync(hostedPath) ? JSON.parse(fs.readFileSync(hostedPath, "utf8")) : { doors: [] };
    const traversalPayload = fs.existsSync(traversalPath) ? JSON.parse(fs.readFileSync(traversalPath, "utf8")) : { doors: [] };
    const connectivityPath = path.join(jobDirectory, "room_connectivity.json");
    const connectivityPayload = fs.existsSync(connectivityPath) ? JSON.parse(fs.readFileSync(connectivityPath, "utf8")) : { connections: [] };
    const hostedDoors = Array.isArray(hostedPayload?.doors) ? hostedPayload.doors : [];
    const traversalDoors = Array.isArray(traversalPayload?.doors) ? traversalPayload.doors : [];
    const areas = (Array.isArray(hotspotPayload?.areas) ? hotspotPayload.areas : [])
      .filter((area: any) => area?.id && Array.isArray(area?.center) && area.center.length >= 3)
      .map((area: any) => ({ ...area, portalIds: [], neighbors: [] as string[] }));
    const portals = Array.isArray(manifest?.portals) ? manifest.portals : [];
    const byArea = new Map(areas.map((area: any) => [String(area.id), area]));

    const getDoorRecord = (portal: any) => hostedDoors.find((door: any) =>
      String(door?.instanceId || "") === String(portal?.assetInstanceId || "")
    ) ?? null;
    const getTraversalRecord = (portal: any, door: any) => {
      if (!door) return null;
      const instanceId = String(portal?.assetInstanceId || portal?.instanceId || door?.instanceId || "");
      const exact = traversalDoors.find((entry: any) => String(entry?.id || "") === instanceId);
      if (exact) return exact;
      const center = portal?.center ?? door?.doorPlacement?.position;
      let best: any = null;
      let bestDistance = Infinity;
      for (const entry of traversalDoors) {
        const distance = horizontalDistance(center, entry?.center);
        if (distance < bestDistance) { best = entry; bestDistance = distance; }
      }
      return bestDistance <= 0.5 ? best : null;
    };
    const probePortalOnNavMesh = (center: number[], nx: number, nz: number, wallThickness = 0.2) => {
      const unit = Math.max(Number(physicalMetersPerUnit) || 1, 1e-6);
      const endpointTolerance = Math.max(0.4 * unit, 0.3);
      const verticalTolerance = Math.max(0.5 * unit, 0.35);
      const offset0 = Math.max(0.55 * unit, Math.max(0, wallThickness) * 0.5 + 0.4 * unit);
      let best: any = null;
      for (const multiplier of [1, 1.35, 1.7]) {
        const offset = offset0 * multiplier;
        const pa = { x: center[0] + nx * offset, y: Number(center[1]) || 0, z: center[2] + nz * offset };
        const pb = { x: center[0] - nx * offset, y: Number(center[1]) || 0, z: center[2] - nz * offset };
        const opts = { halfExtents: { x: Math.max(0.45 * unit, 0.3), y: Math.max(1.2 * unit, 0.7), z: Math.max(0.45 * unit, 0.3) }, filter: new QueryFilter() };
        const sideA = query.findClosestPoint(pa, opts);
        const sideB = query.findClosestPoint(pb, opts);
        if (!sideA?.success || !sideB?.success || !sideA.point || !sideB.point) {
          best = { connected: false, reason: !sideA?.success && !sideB?.success ? "no-navmesh-point-on-either-side" : !sideA?.success ? "no-navmesh-point-on-side-a" : "no-navmesh-point-on-side-b", sideA: sideA?.success ? [sideA.point.x, sideA.point.y, sideA.point.z] : null, sideB: sideB?.success ? [sideB.point.x, sideB.point.y, sideB.point.z] : null };
          continue;
        }
        const route = query.computePath(sideA.point, sideB.point, { filter: new QueryFilter(), maxStraightPathSize: 512, maxPathSize: 512 });
        const points: any[] = Array.isArray(route?.path) ? route.path : [];
        const endpoint = points.length ? points[points.length - 1] : null;
        const distance = endpoint ? Math.hypot(endpoint.x - sideB.point.x, endpoint.z - sideB.point.z) : Infinity;
        const vertical = endpoint ? Math.abs(endpoint.y - sideB.point.y) : Infinity;
        const connected = Boolean(route?.success && points.length && distance <= endpointTolerance && vertical <= verticalTolerance);
        best = { connected, reason: connected ? "complete-path-through-portal" : route?.success && points.length ? "partial-path-endpoint" : "no-path-between-sides", sideA: [sideA.point.x, sideA.point.y, sideA.point.z], sideB: [sideB.point.x, sideB.point.y, sideB.point.z], endpoint: endpoint ? [endpoint.x, endpoint.y, endpoint.z] : null, endpointDistanceMeters: Number.isFinite(distance) ? Number((distance / unit).toFixed(3)) : null };
        if (connected) break;
      }
      return best || { connected: false, reason: "portal-test-not-completed" };
    };

    for (const portal of portals) {
      const door = getDoorRecord(portal);
      let traversal = door ? getTraversalRecord(portal, door) : null;
      const center = Array.isArray(portal?.center) ? portal.center : door?.doorPlacement?.position;
      let nx = Number(portal?.normal?.[0]);
      let nz = Number(portal?.normal?.[2]);
      if (!Number.isFinite(nx) || !Number.isFinite(nz) || Math.hypot(nx, nz) < 1e-5) {
        const rawAxis = door?.hostPlacement?.thicknessAxis;
        nx = Array.isArray(rawAxis) ? Number(rawAxis[0]) : 0;
        nz = Array.isArray(rawAxis) ? -Number(rawAxis[1]) : 0;
      }
      let norm = Math.hypot(nx, nz);
      if ((!Number.isFinite(norm) || norm < 1e-5) && door) {
        const yaw = Number(door?.doorPlacement?.rotation?.[1] ?? 0) * Math.PI / 180;
        nx = -Math.sin(yaw); nz = Math.cos(yaw); norm = Math.hypot(nx, nz);
      }
      if (!Array.isArray(center) || center.length < 3 || !Number.isFinite(norm) || norm < 1e-5) {
        portal.spaceA = null; portal.spaceB = null;
        portal.navigationStatus = "unresolved-portal-transform";
        portal.traversable = false;
        continue;
      }
      nx /= norm; nz /= norm;
      portal.normal = [nx, 0, nz];
      if (!traversal) {
        traversal = probePortalOnNavMesh(center, nx, nz, Number(portal?.wallThickness) || 0.2);
      }

      const sampleA = Array.isArray(traversal?.sideA) ? traversal.sideA : [center[0] + nx * 0.6, center[1] || 0, center[2] + nz * 0.6];
      const sampleB = Array.isArray(traversal?.sideB) ? traversal.sideB : [center[0] - nx * 0.6, center[1] || 0, center[2] - nz * 0.6];
      const selectSpace = (side: 1 | -1, probe: number[]) => {
        const candidates = areas.map((area: any) => {
          const c = area.center;
          const signed = (Number(c[0]) - Number(center[0])) * nx + (Number(c[2]) - Number(center[2])) * nz;
          if (signed * side < 0.08) return null;
          const distance = Math.hypot(Number(c[0]) - Number(probe[0]), Number(c[2]) - Number(probe[2]));
          return { area, distance };
        }).filter(Boolean) as Array<{ area: any; distance: number }>;
        candidates.sort((a, b) => a.distance - b.distance);
        return candidates[0] && candidates[0].distance <= 12 ? candidates[0].area : null;
      };
      const spaceA = selectSpace(1, sampleA);
      const spaceB = selectSpace(-1, sampleB);
      portal.spaceA = spaceA?.id ?? null;
      portal.spaceB = spaceB?.id ?? null;
      portal.navigationValidation = traversal ? {
        traversable: Boolean(traversal.connected),
        reason: String(traversal.reason || "unknown"),
        endpointDistanceMeters: traversal.endpointDistanceMeters ?? null,
      } : { traversable: false, reason: "no-doorway-traversability-result" };
      portal.traversable = Boolean(traversal?.connected);
      portal.navigationStatus = traversal?.connected
        ? (spaceA && spaceB && spaceA.id !== spaceB.id ? "traversable" : "traversable-space-unmapped")
        : /no-navmesh-point-on-(side-a|side-b|either-side)/.test(String(traversal?.reason || ""))
          ? "exterior-or-no-walkable-side"
          : traversal?.reason === "partial-path-endpoint" || traversal?.reason === "no-path-between-sides"
            ? "blocked-in-navmesh"
            : "unverified";
      if (spaceA && !spaceA.portalIds.includes(portal.id)) spaceA.portalIds.push(portal.id);
      if (spaceB && spaceB.id !== spaceA?.id && !spaceB.portalIds.includes(portal.id)) spaceB.portalIds.push(portal.id);
      if (spaceA && spaceB && spaceA.id !== spaceB.id && traversal?.connected) {
        if (!spaceA.neighbors.includes(spaceB.id)) spaceA.neighbors.push(spaceB.id);
        if (!spaceB.neighbors.includes(spaceA.id)) spaceB.neighbors.push(spaceA.id);
      }
    }

    const spaceNodes = areas.map((area: any) => ({ id: String(area.id), label: String(area.label || area.id), center: area.center, neighbors: [] as string[] }));
    const spacePortalEdges = portals
      .filter((portal: any) => portal.navigationStatus === "traversable" && portal.spaceA && portal.spaceB && portal.spaceA !== portal.spaceB)
      .map((portal: any) => ({ id: `space-portal-edge-${portal.id}`, portalId: portal.id, from: portal.spaceA, to: portal.spaceB, status: "traversable", edgeType: "door-portal" }));
    const spaceById = new Map(spaceNodes.map((space: any) => [space.id, space]));
    for (const edge of spacePortalEdges) {
      const from: any = spaceById.get(edge.from);
      const to: any = spaceById.get(edge.to);
      if (from && to) {
        if (!from.neighbors.includes(to.id)) from.neighbors.push(to.id);
        if (!to.neighbors.includes(from.id)) to.neighbors.push(from.id);
      }
    }
    const reachabilityRows = Array.isArray(connectivityPayload?.connections) ? connectivityPayload.connections : [];
    const reachablePairMap = new Map<string, any>();
    for (const row of reachabilityRows) {
      if (!row?.reachable || !row?.from || !row?.to || row.from === row.to) continue;
      const key = [String(row.from), String(row.to)].sort().join("::");
      if (!reachablePairMap.has(key)) reachablePairMap.set(key, { from: String(row.from), to: String(row.to), pathLengthMeters: row.pathLengthMeters ?? null, status: "complete-navmesh-path" });
    }
    const reachablePairs = Array.from(reachablePairMap.values());
    const reachabilityNeighbors = new Map(spaceNodes.map((node: any) => [node.id, new Set<string>()]));
    for (const pair of reachablePairs) {
      const a: any = reachabilityNeighbors.get(pair.from);
      const b: any = reachabilityNeighbors.get(pair.to);
      if (a && b) { a.add(pair.to); b.add(pair.from); }
    }
    const reachabilityComponents = connectedComponentsForGraph(spaceNodes.map((node: any) => ({
      id: node.id,
      neighbors: Array.from(reachabilityNeighbors.get(node.id) || []),
    })));
    const roomNodes = (Array.isArray(manifest?.rooms) ? manifest.rooms : []).map((room: any) => ({
      id: String(room.id), label: String(room.label || room.id), center: room.center,
      portalIds: Array.isArray(room.portals) ? room.portals : [],
    }));
    const roomEdges = portals
      .filter((portal: any) => portal.roomA && portal.roomB && portal.roomA !== portal.roomB && portal.navigationStatus === "traversable")
      .map((portal: any) => ({ id: `room-edge-${portal.id}`, portalId: portal.id, from: portal.roomA, to: portal.roomB, status: "traversable" }));
    const roomAdjacency: Record<string, string[]> = Object.fromEntries(roomNodes.map((node: any) => [node.id, []]));
    for (const edge of roomEdges) {
      if (roomAdjacency[edge.from] && !roomAdjacency[edge.from].includes(edge.to)) roomAdjacency[edge.from].push(edge.to);
      if (roomAdjacency[edge.to] && !roomAdjacency[edge.to].includes(edge.from)) roomAdjacency[edge.to].push(edge.from);
    }
    const roomPortalIdsByRoom = Object.fromEntries(roomNodes.map((node: any) => [node.id, portals.filter((portal: any) => portal.roomA === node.id || portal.roomB === node.id).map((portal: any) => portal.id)]));
    const portalAdjacencyComponentCount = connectedComponentsForGraph(
      spaceNodes.map((node: any) => ({ id: node.id, neighbors: node.neighbors })),
    ).length;

    manifest.version = Math.max(3, Number(manifest.version) || 0);
    manifest.spaces = areas;
    manifest.graph = {
      version: 2,
      nodeType: "detected-room",
      adjacency: roomAdjacency,
      portalIdsByRoom: roomPortalIdsByRoom,
      edges: roomEdges,
      validation: "complete-doorway-navmesh-test",
    };
    manifest.navigationSpaceGraph = {
      version: 2,
      nodeType: "curated-navigation-space",
      nodes: spaceNodes,
      // Direct physical adjacency established by a traversable door/portal.
      portalEdges: spacePortalEdges,
      // Reachability edges describe a complete NavMesh path, which may pass
      // through several doors or an open-plan passage; they are not claimed to
      // represent direct room adjacency.
      reachablePairs,
      connectedComponents: reachabilityComponents,
      componentCount: reachabilityComponents.length,
      fullyConnected: reachabilityComponents.length <= 1 && spaceNodes.length > 0,
      portalAdjacencyComponentCount,
      validation: "portal-edges-require-navmesh-side-to-side-pass; reachability-edges-require-complete-room-connectivity-path",
    };
    manifest.stats = {
      ...(manifest.stats || {}),
      roomCount: roomNodes.length,
      portalCount: portals.length,
      spaceCount: areas.length,
      connectedPortalCount: portals.filter((p: any) => p.roomA && p.roomB && p.roomA !== p.roomB).length,
      traversablePortalCount: portals.filter((p: any) => p.navigationStatus === "traversable").length,
      navigationSpacePortalEdgeCount: spacePortalEdges.length,
      navigationSpaceReachablePairCount: reachablePairs.length,
      navigationSpaceComponentCount: reachabilityComponents.length,
    };

    for (const room of Array.isArray(manifest.rooms) ? manifest.rooms : []) {
      room.portals = portals.filter((p: any) => p.roomA === room.id || p.roomB === room.id).map((p: any) => p.id);
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    fs.writeFileSync(path.join(jobDirectory, "presentation_room_graph.json"), JSON.stringify({
      version: 1,
      source: "presentation_portals.json + walk_hotspots.json + doorway_traversability.json",
      roomGraph: { nodes: roomNodes, edges: roomEdges },
      navigationSpaceGraph: manifest.navigationSpaceGraph,
      portals: portals.map((portal: any) => ({
        id: portal.id, assetInstanceId: portal.assetInstanceId ?? null,
        hostWallId: portal.hostWallId ?? null, center: portal.center,
        roomA: portal.roomA ?? null, roomB: portal.roomB ?? null,
        spaceA: portal.spaceA ?? null, spaceB: portal.spaceB ?? null,
        traversable: Boolean(portal.traversable), navigationStatus: portal.navigationStatus,
        width: portal.width ?? null, height: portal.height ?? null,
      })),
      diagnostics: {
        detectedRoomCount: roomNodes.length,
        navigationSpaceCount: spaceNodes.length,
        hostedDoorCount: hostedDoors.length,
        navmeshTraversableDoorCount: portals.filter((p: any) => p.navigationValidation?.traversable).length,
        mappedTraversablePortalEdges: spacePortalEdges.length,
        completeReachablePairs: reachablePairs.length,
        navigationSpaceComponentCount: reachabilityComponents.length,
        unmappedPortals: portals.filter((p: any) => p.navigationValidation?.traversable && p.navigationStatus === "traversable-space-unmapped").map((p: any) => p.id),
      },
    }, null, 2), "utf8");
    console.log(`[WalkGraph] Spaces: ${areas.length}; portals: ${portals.length}; verified portal edges: ${spacePortalEdges.length}; NavMesh-connected components: ${reachabilityComponents.length}.`);
    for (const portal of portals) {
      console.log(`[WalkGraph] ${portal.id}: ${portal.spaceA || "outside/unmapped"} ↔ ${portal.spaceB || "outside/unmapped"} (${portal.navigationStatus || "unverified"}).`);
    }
  } catch (error) {
    console.warn(`[WalkGraph] Room/portal graph enrichment failed: ${(error as Error).message}`);
  }
}

function closestCandidate(candidates: HotspotCandidate[], target: [number, number, number]): HotspotCandidate | null {
  let best: HotspotCandidate | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = distanceXZ(candidate.position, target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function normalizedCoverage(candidates: HotspotCandidate[], centers: HotspotCandidate[]): number {
  if (!candidates.length || !centers.length) return 0;
  let total = 0;
  for (const candidate of candidates) {
    let nearest = Infinity;
    for (const center of centers) nearest = Math.min(nearest, distanceXZ(candidate.position, center.position));
    total += nearest;
  }
  return total / candidates.length;
}

function angularSpanFromDirections(openDirections: boolean[]): number {
  if (!openDirections.length) return 0;
  let best = 0;
  for (let start = 0; start < openDirections.length; start++) {
    let run = 0;
    for (let offset = 0; offset < openDirections.length; offset++) {
      if (!openDirections[(start + offset) % openDirections.length]) break;
      run++;
    }
    best = Math.max(best, run);
  }
  return best / openDirections.length;
}

function rayDistanceToGeometry(
  positions: number[],
  indices: number[],
  origin: [number, number, number],
  direction: [number, number, number],
  maxDistance: number,
): number {
  const ox = origin[0], oy = origin[1], oz = origin[2];
  const dx = direction[0], dy = direction[1], dz = direction[2];
  let nearest = Infinity;
  const epsilon = 1e-8;

  for (let t = 0; t < indices.length / 3; t += 1) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < epsilon) continue;

    const invDet = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = (sx * hx + sy * hy + sz * hz) * invDet;
    if (u < 0 || u > 1) continue;

    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < 0 || u + v > 1) continue;

    const distance = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (distance > epsilon && distance < nearest && distance <= maxDistance) nearest = distance;
  }

  return nearest;
}

function sampleHotspotCandidates(
  navMesh: NavMesh,
  surfacePositions: number[],
  metersPerUnit: number,
  sceneGeometry: ExtractedGeometry,
): HotspotCandidate[] {
  const query = new NavMeshQuery(navMesh);
  const unit = Math.max(metersPerUnit, 1e-6);
  const sampleSpacing = 0.9 * unit;
  const snapTolerance = 0.38 * unit;
  const probeDistance = 0.72 * unit;
  const probeCount = 12;
  const halfExtents = { x: snapTolerance, y: Math.max(0.7 * unit, 1.6 * unit), z: snapTolerance };

  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < surfacePositions.length; i += 3) {
    xs.push(surfacePositions[i]);
    zs.push(surfacePositions[i + 2]);
  }
  if (!xs.length) return [];

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);

  const probe = (x: number, y: number, z: number) => query.findClosestPoint({ x, y, z }, { halfExtents, filter: undefined });
  const localHalfExtents = { x: 0.06 * unit, y: Math.max(0.7 * unit, 1.6 * unit), z: 0.06 * unit };
  const probeLocal = (x: number, y: number, z: number) => query.findClosestPoint(
    { x, y, z },
    { halfExtents: localHalfExtents, filter: undefined },
  );
  const candidates: HotspotCandidate[] = [];
  const quantize = (v: number) => Number(v.toFixed(4));
  const seen = new Set<string>();

  for (let x = minX; x <= maxX + 1e-6; x += sampleSpacing) {
    for (let z = minZ; z <= maxZ + 1e-6; z += sampleSpacing) {
      const center = probe(x, 0, z);
      if (!center?.success) continue;
      const cx = Number(center.point.x);
      const cy = Number(center.point.y);
      const cz = Number(center.point.z);
      if (distanceXZ([cx, cy, cz], [x, cy, z]) > snapTolerance) continue;

      const key = `${quantize(cx)}:${quantize(cz)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const openFlags: boolean[] = [];
      const reaches: number[] = [];
      const binarySteps = 7;
      const headroomRequired = 1.65 * unit;
      const headroomHit = rayDistanceToGeometry(
        sceneGeometry.positions,
        sceneGeometry.indices,
        [cx, cy + 0.06 * unit, cz],
        [0, 1, 0],
        headroomRequired,
      );
      if (Number.isFinite(headroomHit) && headroomHit < headroomRequired) continue;

      for (let i = 0; i < probeCount; i += 1) {
        const angle = (Math.PI * 2 * i) / probeCount;
        const dirX = Math.cos(angle);
        const dirZ = Math.sin(angle);

        let low = 0;
        let high = probeDistance;
        for (let step = 0; step < binarySteps; step += 1) {
          const mid = (low + high) * 0.5;
          const ring = probeLocal(cx + dirX * mid, cy, cz + dirZ * mid);
          const valid = Boolean(
            ring?.success &&
            Math.hypot(ring.point.x - (cx + dirX * mid), ring.point.z - (cz + dirZ * mid)) <= 0.075 * unit,
          );
          if (valid) low = mid;
          else high = mid;
        }

        const reachMeters = low / unit;
        reaches.push(reachMeters);
        openFlags.push(reachMeters >= 0.42);
      }

      const openDirections = openFlags.filter(Boolean).length;
      if (openDirections < 5) continue;

      const angularSpan = angularSpanFromDirections(openFlags);
      const maxReachMeters = Math.max(...reaches, 0);
      const averageReach = reaches.reduce((a, b) => a + b, 0) / Math.max(reaches.length, 1);
      const minReachMeters = Math.min(...reaches, probeDistance / unit);
      if (minReachMeters < 0.24) continue;
      const clearanceMeters = Number(Math.min(probeDistance / unit, minReachMeters).toFixed(3));

      const centerScore =
        openDirections * 1.65 +
        angularSpan * 5.2 +
        averageReach * 0.75 +
        maxReachMeters * 0.45;
      const viewScore =
        openDirections * 1.25 +
        angularSpan * 7.5 +
        maxReachMeters * 0.9 +
        averageReach * 0.4;

      candidates.push({
        position: [cx, cy, cz],
        clearanceMeters,
        openDirections,
        angularSpan,
        maxReachMeters,
        centerScore,
        viewScore,
      });
    }
  }

  return candidates;
}

function selectRoomCenters(candidates: HotspotCandidate[], metersPerUnit: number): HotspotCandidate[] {
  if (!candidates.length) return [];
  const unit = Math.max(metersPerUnit, 1e-6);
  const minCenterSpacing = 2.8 * unit;
  const coverageRadius = 3.7 * unit;
  const maxCenters = 6;
  const ranked = [...candidates].sort((a, b) => b.centerScore - a.centerScore);

  // Phase 7 correction: do not greedily take the top-scoring candidates and
  // compact afterwards. That strategy can select several excellent points along
  // one corridor/strip, then collapse them into one semantic area while leaving
  // the opposite side of the apartment completely uncovered.
  //
  // Instead use a farthest-point coverage pass: keep the strongest candidate as
  // the first seed, then repeatedly add the candidate that is farthest from the
  // already selected set. Center quality is only used as a tie-breaker. This
  // guarantees that a large building gets semantic coverage across its footprint
  // instead of clustering all room centers in one region.
  const centers: HotspotCandidate[] = [ranked[0]];

  while (centers.length < maxCenters) {
    let best: HotspotCandidate | null = null;
    let bestDistance = -Infinity;

    for (const candidate of candidates) {
      if (centers.some((center) => distanceXZ(center.position, candidate.position) < minCenterSpacing)) continue;

      let nearest = Infinity;
      for (const center of centers) {
        nearest = Math.min(nearest, distanceXZ(center.position, candidate.position));
      }

      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = candidate;
      } else if (best && Math.abs(nearest - bestDistance) < 0.15 * unit && candidate.centerScore > best.centerScore) {
        best = candidate;
      }
    }

    if (!best || bestDistance < coverageRadius) break;
    centers.push(best);
  }

  // A two-stage safety rule keeps open-plan zones from becoming a cloud of fake
  // rooms while preserving genuinely separated parts of a larger floor.
  const compact: HotspotCandidate[] = [];
  const clusterMergeDistance = 3.4 * unit;
  for (const center of centers) {
    if (compact.some((existing) => distanceXZ(existing.position, center.position) < clusterMergeDistance)) continue;
    compact.push(center);
  }

  if (!compact.length) compact.push(ranked[0]);
  return compact.slice(0, maxCenters);
}

function curateHotspots(
  candidates: HotspotCandidate[],
  metersPerUnit: number,
): { areas: SemanticArea[]; hotspots: CuratedHotspot[] } {
  if (!candidates.length) return { areas: [], hotspots: [] };
  const unit = Math.max(metersPerUnit, 1e-6);
  const centers = selectRoomCenters(candidates, unit);
  const assignments = centers.map(() => [] as HotspotCandidate[]);

  for (const candidate of candidates) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    centers.forEach((center, index) => {
      const distance = distanceXZ(center.position, candidate.position);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    assignments[bestIndex].push(candidate);
  }

  const areaOrder = centers
    .map((center, index) => ({ center, index }))
    .sort((a, b) => (a.center.position[2] - b.center.position[2]) || (a.center.position[0] - b.center.position[0]));

  type AreaRecord = {
    area: SemanticArea;
    centerCandidate: HotspotCandidate;
    cluster: HotspotCandidate[];
    nearestOtherCenter: HotspotCandidate | null;
  };

  const areaRecords: AreaRecord[] = [];
  for (const entry of areaOrder) {
    const { center, index } = entry;
    const cluster = assignments[index];
    if (!cluster.length) continue;

    const areaLabel = `Space ${areaRecords.length + 1}`;
    const areaId = `space-${areaRecords.length + 1}`;
    const centerCandidate = closestCandidate(cluster, center.position) ?? center;
    const area: SemanticArea = {
      id: areaId,
      label: areaLabel,
      center: centerCandidate.position,
    };

    let nearestOtherCenter: HotspotCandidate | null = null;
    let nearestCenterDistance = Infinity;
    for (const other of centers) {
      if (other === center) continue;
      const d = distanceXZ(center.position, other.position);
      if (d < nearestCenterDistance) {
        nearestCenterDistance = d;
        nearestOtherCenter = other;
      }
    }

    areaRecords.push({ area, centerCandidate, cluster, nearestOtherCenter });
  }

  const selected: Array<{ hotspot: CuratedHotspot; candidate: HotspotCandidate }> = [];
  const minHotspotSpacing = 1.45 * unit;

  const addSelected = (hotspot: CuratedHotspot, candidate: HotspotCandidate) => {
    if (selected.some((entry) => distanceXZ(entry.candidate.position, candidate.position) < minHotspotSpacing)) return false;
    selected.push({ hotspot, candidate });
    return true;
  };

  // Pass 1: reserve one true semantic center for every retained space before
  // optional entrance/viewpoint points consume the global spacing budget. The
  // centers themselves are already separated by selectRoomCenters().
  areaRecords.forEach(({ area, centerCandidate }, index) => {
    addSelected({
      id: `pending-center-${index + 1}`,
      label: `${area.label} · Center`,
      position: centerCandidate.position,
      clearanceMeters: Number(centerCandidate.clearanceMeters.toFixed(3)),
      score: Number((centerCandidate.centerScore + 12).toFixed(3)),
      source: "curated-center",
      areaId: area.id,
      areaLabel: area.label,
      presentationRole: "room-center",
      displayOrder: (index + 1) * 10,
    }, centerCandidate);
  });

  // Pass 2: enrich each semantic space with a transition-oriented entrance and
  // one alternate viewpoint, but never at the expense of its center.
  areaRecords.forEach(({ area, centerCandidate, cluster, nearestOtherCenter }, index) => {
    if (nearestOtherCenter) {
      const dx = nearestOtherCenter.position[0] - centerCandidate.position[0];
      const dz = nearestOtherCenter.position[2] - centerCandidate.position[2];
      const len = Math.max(Math.hypot(dx, dz), 1e-6);
      const dirX = dx / len;
      const dirZ = dz / len;
      const entranceCandidate = cluster
        .filter((candidate) => candidate !== centerCandidate)
        .map((candidate) => {
          const vx = candidate.position[0] - centerCandidate.position[0];
          const vz = candidate.position[2] - centerCandidate.position[2];
          const vLen = Math.max(Math.hypot(vx, vz), 1e-6);
          const alignment = (vx * dirX + vz * dirZ) / vLen;
          const distanceFromCenter = Math.hypot(vx, vz) / unit;
          const edgeBias = 1 - Math.min(candidate.openDirections / 12, 1);
          return {
            candidate,
            score: alignment * 2.5 + edgeBias * 1.4 - Math.abs(distanceFromCenter - 1.8) * 0.35,
          };
        })
        .filter((entry) => entry.score > 0.35)
        .sort((a, b) => b.score - a.score)[0]?.candidate;

      if (entranceCandidate) {
        addSelected({
          id: `pending-entrance-${index + 1}`,
          label: `${area.label} · Entrance`,
          position: entranceCandidate.position,
          clearanceMeters: Number(entranceCandidate.clearanceMeters.toFixed(3)),
          score: Number((entranceCandidate.centerScore + 5).toFixed(3)),
          source: "curated-entrance",
          areaId: area.id,
          areaLabel: area.label,
          presentationRole: "room-entrance",
          displayOrder: (index + 1) * 10 + 1,
        }, entranceCandidate);
      }
    }

    const viewpointCandidate = [...cluster]
      .filter((candidate) => candidate !== centerCandidate)
      .sort((a, b) => b.viewScore - a.viewScore)
      .find((candidate) => distanceXZ(candidate.position, centerCandidate.position) >= 1.55 * unit);

    if (viewpointCandidate) {
      addSelected({
        id: `pending-viewpoint-${index + 1}`,
        label: `${area.label} · View`,
        position: viewpointCandidate.position,
        clearanceMeters: Number(viewpointCandidate.clearanceMeters.toFixed(3)),
        score: Number((viewpointCandidate.viewScore + 8).toFixed(3)),
        source: "curated-viewpoint",
        areaId: area.id,
        areaLabel: area.label,
        presentationRole: "viewpoint",
        displayOrder: (index + 1) * 10 + 2,
      }, viewpointCandidate);
    }
  });

  // Second pass: keep uncovered, useful transition points only when they sit
  // between semantic spaces. These are not presented as primary room choices.
  const transitionCandidates = candidates
    .filter((candidate) => {
      const nearestCenter = Math.min(...centers.map((center) => distanceXZ(center.position, candidate.position)));
      return nearestCenter > 1.1 * unit && nearestCenter < 2.8 * unit && candidate.openDirections <= 9;
    })
    .sort((a, b) => (a.openDirections - b.openDirections) || (b.viewScore - a.viewScore));

  for (const candidate of transitionCandidates) {
    const nearestAreas = areaRecords
      .map(({ area }) => ({ area, distance: distanceXZ(area.center, candidate.position) }))
      .sort((a, b) => a.distance - b.distance);
    if (nearestAreas.length < 2 || nearestAreas[1].distance > 3.4 * unit) continue;
    const area = nearestAreas[0].area;
    const hotspot: CuratedHotspot = {
      id: `pending-transition-${selected.length + 1}`,
      label: `${area.label} · Transition`,
      position: candidate.position,
      clearanceMeters: Number(candidate.clearanceMeters.toFixed(3)),
      score: Number((candidate.centerScore + 2).toFixed(3)),
      source: "curated-transition",
      areaId: area.id,
      areaLabel: area.label,
      presentationRole: "transition",
      displayOrder: 90 + selected.length,
    };
    if (addSelected(hotspot, candidate) && selected.length >= 16) break;
  }

  // Keep centers first, then viewpoint / entrance, then transition. The global
  // cap applies only after centers for all semantic spaces are guaranteed.
  selected.sort((a, b) => {
    const rolePriority = (role: CuratedHotspot["presentationRole"]) =>
      role === "room-center" ? 0 : role === "viewpoint" ? 1 : role === "room-entrance" ? 2 : 3;
    return (rolePriority(a.hotspot.presentationRole) - rolePriority(b.hotspot.presentationRole))
      || (a.hotspot.displayOrder - b.hotspot.displayOrder)
      || (b.hotspot.score - a.hotspot.score);
  });

  const hotspots = selected.slice(0, 16).map((entry, index) => ({
    ...entry.hotspot,
    id: `hotspot-${index + 1}`,
    displayOrder: index + 1,
  }));

  const centerAreaIds = new Set(
    hotspots.filter((hotspot) => hotspot.presentationRole === "room-center").map((hotspot) => hotspot.areaId),
  );
  const normalizedAreas = areaRecords
    .map(({ area }) => area)
    .filter((area) => centerAreaIds.has(area.id));

  const retainedAreaIds = new Set(normalizedAreas.map((area) => area.id));
  for (const hotspot of hotspots) {
    if (!retainedAreaIds.has(hotspot.areaId)) continue;
    hotspot.areaLabel = normalizedAreas.find((area) => area.id === hotspot.areaId)?.label || hotspot.areaLabel;
  }

  return { areas: normalizedAreas, hotspots };
}

function writeDebugObj(filePath: string, positions: Float32Array, indices: Uint32Array, labels: string[]) {
  const lines: string[] = [];
  for (let i = 0; i < positions.length; i += 3) lines.push(`v ${positions[i]} ${positions[i + 1]} ${positions[i + 2]}`);
  let current = "";
  for (let t = 0; t < indices.length / 3; t++) {
    if (labels[t] !== current) { current = labels[t]; lines.push(`g ${current}`); }
    lines.push(`f ${indices[t * 3] + 1} ${indices[t * 3 + 1] + 1} ${indices[t * 3 + 2] + 1}`);
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

export class WalkNavigationPipeline {
  static async run(outputGlbPath: string, jobDirectory: string): Promise<void> {
    if (!fs.existsSync(outputGlbPath)) throw new Error(`WalkNavigationPipeline: output.glb not found at ${outputGlbPath}`);
    await ensureRecast();

    const physicalMetersPerUnit = readScale(jobDirectory);
    const walkableHeight = DEFAULT_METRES.eyeHeight * physicalMetersPerUnit;
    const walkableRadius = DEFAULT_METRES.radius * physicalMetersPerUnit;
    const walkableClimb = DEFAULT_METRES.climb * physicalMetersPerUnit;
    const cellSize = DEFAULT_METRES.cellSize * physicalMetersPerUnit;
    const cellHeight = DEFAULT_METRES.cellHeight * physicalMetersPerUnit;

    console.log(`[WalkNav] physical metres -> GLB units: ${physicalMetersPerUnit}`);

    const hostedDoorInstanceIds = readHostedDoorInstanceIds(jobDirectory);
    const extracted = await extractFinalGlb(outputGlbPath, hostedDoorInstanceIds);
    const matchedDoorIds = new Set(extracted.hostedDoorInstanceIdsMatched);
    const unmatchedDoorIds = Array.from(hostedDoorInstanceIds).filter((id) => !matchedDoorIds.has(id));
    console.log(
      `[WalkNav] Hosted GLB door obstacle exclusion: ${matchedDoorIds.size}/${hostedDoorInstanceIds.size} door instance IDs matched; ${extracted.hostedDoorMeshNodesExcluded} mesh nodes excluded by explicit node marker.`,
    );
    if (unmatchedDoorIds.length) {
      console.warn(
        `[WalkNav] Hosted door instance wrappers were not found in the navigation scene: ${unmatchedDoorIds.join(", ")}`,
      );
    }
    const filtered = buildFilteredSoup(extracted, DEFAULT_METRES.slope);
    if (filtered.soup.indices.length === 0) throw new Error("WalkNavigationPipeline: filtered navigation geometry is empty.");

    fs.mkdirSync(jobDirectory, { recursive: true });
    writeDebugObj(path.join(jobDirectory, "walk_nav_input_debug.obj"), filtered.soup.positions, filtered.soup.indices, filtered.labels);

    const generation = generateSoloNavMesh(
      Array.from(filtered.soup.positions),
      Array.from(filtered.soup.indices),
      {
        cs: cellSize,
        ch: cellHeight,
        walkableSlopeAngle: DEFAULT_METRES.slope,
        walkableHeight,
        walkableClimb,
        walkableRadius,
      }
    );

    if (!generation.success || !generation.navMesh) throw new Error("WalkNavigationPipeline: Recast generation failed.");
    const navMesh = generation.navMesh;
    const topologyQuery = new NavMeshQuery(navMesh);
    writeDoorwayTraversability(jobDirectory, topologyQuery, physicalMetersPerUnit);
    const [surfacePositions, surfaceIndices] = getNavMeshPositionsAndIndices(navMesh);
    const serialized = exportNavMesh(navMesh);
    fs.writeFileSync(path.join(jobDirectory, "navigation_navmesh.bin"), Buffer.from(serialized));

    const surfaceY = Array.from(surfacePositions).filter((_, i) => i % 3 === 1);
    const surfaceMinY = surfaceY.length ? Math.min(...surfaceY) : NaN;
    const surfaceMaxY = surfaceY.length ? Math.max(...surfaceY) : NaN;
    const surfaceMeanY = surfaceY.length ? surfaceY.reduce((a, b) => a + b, 0) / surfaceY.length : NaN;
    const floorDelta = Number.isFinite(surfaceMeanY) && Number.isFinite(extracted.floorElevation)
      ? surfaceMeanY - extracted.floorElevation
      : NaN;

    const surface = {
      version: 4,
      positions: Array.from(surfacePositions),
      indices: Array.from(surfaceIndices),
      metadata: {
        physicalMetersPerUnit,
        eyeHeightMeters: DEFAULT_METRES.eyeHeight,
        agentRadiusMeters: DEFAULT_METRES.radius,
        floorElevation: Number.isFinite(extracted.floorElevation) ? extracted.floorElevation : 0,
        navMeshSurfaceY: { min: surfaceMinY, max: surfaceMaxY, mean: surfaceMeanY, offsetFromFloor: floorDelta },
      },
    };
    fs.writeFileSync(path.join(jobDirectory, "navigation_surface.json"), JSON.stringify(surface), "utf8");

    const candidates = sampleHotspotCandidates(
      navMesh,
      Array.from(surfacePositions),
      physicalMetersPerUnit,
      extracted,
    );
    const curated = curateHotspots(candidates, physicalMetersPerUnit);

    fs.writeFileSync(path.join(jobDirectory, "walk_hotspots.json"), JSON.stringify({
      version: 4,
      metadata: {
        navigationQuality: "curated-v1",
        source: "recast-navmesh-semantic-curation",
        candidateCount: candidates.length,
        areaCount: curated.areas.length,
        hotspotCount: curated.hotspots.length,
        maxHotspots: 16,
        candidateSpacingMeters: 0.9,
        roomCenterMinSpacingMeters: 2.8,
        destinationMinSpacingMeters: 1.45,
        roleModel: ["room-center", "room-entrance", "viewpoint", "transition", "walkpoint"],
      },
      areas: curated.areas,
      hotspots: curated.hotspots,
    }, null, 2), "utf8");

    // Curated navigation spaces are sampled from the generated NavMesh itself,
    // unlike room-detector centroids which can sit on the wrong side of a wall.
    // Use these for the route matrix, then produce one canonical portal/space graph.
    writeRoomConnectivity(jobDirectory, topologyQuery, physicalMetersPerUnit);
    writePresentationPortalGraph(jobDirectory, topologyQuery, physicalMetersPerUnit);
    topologyQuery.destroy?.();

    const meta = {
      version: 5,
      success: true,
      source: "output.glb",
      runtime: "serialized-detour-navmesh",
      floorSurface: {
        selectedMeshNames: extracted.floorMeshNames,
        selectedElevationGlb: extracted.floorElevation,
      },
      walkability: filtered.stats,
      verticalResolution: { cellHeightMeters: DEFAULT_METRES.cellHeight },
      recast: {
        cellSize,
        cellHeight,
        walkableHeight,
        walkableClimb,
        walkableRadius,
        walkableSlopeAngle: DEFAULT_METRES.slope,
        injectSyntheticFloor: false,
      },
      semanticDestinations: {
        source: "walk_hotspots.json",
        quality: "curated-v1",
        sampledCandidates: candidates.length,
        areas: curated.areas.length,
        hotspots: curated.hotspots.length,
        roles: curated.hotspots.reduce<Record<string, number>>((acc, hotspot) => {
          acc[hotspot.presentationRole] = (acc[hotspot.presentationRole] || 0) + 1;
          return acc;
        }, {}),
      },
      navMesh: { serializedBytes: serialized.length },
    };
    fs.writeFileSync(path.join(jobDirectory, "navigation_meta.json"), JSON.stringify(meta, null, 2), "utf8");

    console.log(`[WalkNav] Wrote navigation_navmesh.bin (${serialized.length} bytes)`);
    console.log(`[WalkNav] Semantic candidates: ${candidates.length}`);
    console.log(`[WalkNav] Curated spaces: ${curated.areas.length}`);
    console.log(`[WalkNav] Curated destinations: ${curated.hotspots.length}`);
    console.log(`[WalkNav] Floor authority: ${extracted.floorMeshNames.join(", ") || "NONE"}`);
    console.log(`[WalkNav] Generated navigation is floor-constrained; destinations are curated semantic hotspots.`);

    navMesh.destroy?.();
  }
}
