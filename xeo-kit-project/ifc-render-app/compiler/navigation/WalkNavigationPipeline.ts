import * as fs from "fs";
import * as path from "path";
import { NodeIO, Node as GltfNode } from "@gltf-transform/core";
import * as THREE from "three";
import {
  exportNavMesh,
  getNavMeshPositionsAndIndices,
  init as initRecast,
  NavMesh,
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
  // Vertical voxel resolution is deliberately finer than the 150 mm horizontal cell size.
  // 150 mm cell height quantizes a 0.0m architectural floor to ~0.15m in the NavMesh,
  // which is exactly the furniture/bed-top height observed in the failing walkthrough.
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
}

interface SceneMetrics {
  physicalMetersPerUnit: number;
  eyeHeightMeters: number;
  radiusMeters: number;
  climbMeters: number;
  cellSizeMeters: number;
  cellHeightMeters: number;
  walkableHeight: number;
  walkableRadius: number;
  walkableClimb: number;
  cellSize: number;
  cellHeight: number;
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

function triNormal(
  positions: number[],
  ia: number,
  ib: number,
  ic: number
): THREE.Vector3 {
  const a = new THREE.Vector3(positions[ia], positions[ia + 1], positions[ia + 2]);
  const b = new THREE.Vector3(positions[ib], positions[ib + 1], positions[ib + 2]);
  const c = new THREE.Vector3(positions[ic], positions[ic + 1], positions[ic + 2]);
  return new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).normalize();
}

function triArea(
  positions: number[],
  ia: number,
  ib: number,
  ic: number
): number {
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

async function extractFinalGlb(glbPath: string): Promise<ExtractedGeometry> {
  const io = new NodeIO();
  const document = await io.read(glbPath);
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) throw new Error("WalkNavigationPipeline: output.glb has no scene.");

  const positions: number[] = [];
  const indices: number[] = [];
  const labels: string[] = [];
  const meshes: MeshRecord[] = [];

  scene.traverse((node: GltfNode) => {
    const mesh = node.getMesh();
    if (!mesh) return;

    const meshName = node.getName() || mesh.getName() || "unnamed_mesh";
    if (isDoor(meshName)) {
      // Decorative door panels are not nav blockers; the host wall/opening remains structural.
      return;
    }

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
  const floorElevation = substantial.reduce(
    (min, mesh) => Math.min(min, mesh.upwardMeanY),
    Infinity
  );
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
  console.log(`[WalkNav] Floor threshold area: ${areaThreshold}`);

  return { positions, indices, labels, meshes, floorMeshNames, floorElevation };
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

    // The authoritative floor must be the ONLY surface that may become
    // walkable.  For all other geometry we keep near-vertical faces as
    // obstacles, but remove both upward AND reversed-winding horizontal /
    // gently sloped faces. Recast can treat either winding as a valid
    // walkable surface; checking only n.y > 0 was why furniture tops leaked
    // into the previous NavMesh.
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

function buildAreas(surfacePositions: number[], surfaceIndices: number[], cellSize: number, eyeHeight: number, floorY: number) {
  const buckets = new Map<string, { x: number; z: number; count: number }>();
  for (let t = 0; t < surfaceIndices.length / 3; t++) {
    const ia = surfaceIndices[t * 3] * 3;
    const ib = surfaceIndices[t * 3 + 1] * 3;
    const ic = surfaceIndices[t * 3 + 2] * 3;
    const x = (surfacePositions[ia] + surfacePositions[ib] + surfacePositions[ic]) / 3;
    const z = (surfacePositions[ia + 2] + surfacePositions[ib + 2] + surfacePositions[ic + 2]) / 3;
    const ix = Math.floor(x / cellSize);
    const iz = Math.floor(z / cellSize);
    const key = `${ix}:${iz}`;
    const bucket = buckets.get(key) ?? { x: 0, z: 0, count: 0 };
    bucket.x += x; bucket.z += z; bucket.count++;
    buckets.set(key, bucket);
  }

  const areas = Array.from(buckets.values())
    .filter((b) => b.count >= 3)
    .map((b, i) => ({ id: `area-${i + 1}`, label: `Room ${i + 1}`, center: [b.x / b.count, floorY, b.z / b.count] as [number, number, number] }));

  // Sort spatially for deterministic presentation/tour order.
  areas.sort((a, b) => (a.center[2] - b.center[2]) || (a.center[0] - b.center[0]));
  areas.forEach((a, i) => { a.id = `area-${i + 1}`; a.label = `Room ${i + 1}`; });

  return areas;
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
    console.log(`[WalkNav] eye height: ${walkableHeight}`);

    const extracted = await extractFinalGlb(outputGlbPath);
    const filtered = buildFilteredSoup(extracted, DEFAULT_METRES.slope);
    if (filtered.soup.indices.length === 0) throw new Error("WalkNavigationPipeline: filtered navigation geometry is empty.");

    const debugDir = path.join(jobDirectory);
    fs.mkdirSync(debugDir, { recursive: true });
    writeDebugObj(path.join(debugDir, "walk_nav_input_debug.obj"), filtered.soup.positions, filtered.soup.indices, filtered.labels);

    console.log(`[WalkNav] input triangles: ${filtered.stats.inputTriangles}`);
    console.log(`[WalkNav] filtered triangles: ${filtered.stats.filteredTriangles}`);
    console.log(`[WalkNav] kept floor triangles: ${filtered.stats.keptFloorTriangles}`);
    console.log(`[WalkNav] removed non-floor walkable-surface triangles (both windings): ${filtered.stats.removedNonFloorWalkableSurfaceTriangles}`);

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
    const [surfacePositions, surfaceIndices] = getNavMeshPositionsAndIndices(navMesh);
    const serialized = exportNavMesh(navMesh);
    fs.writeFileSync(path.join(debugDir, "navigation_navmesh.bin"), Buffer.from(serialized));

    const surfaceY = Array.from(surfacePositions).filter((_, i) => i % 3 === 1);
    const surfaceMinY = surfaceY.length ? Math.min(...surfaceY) : NaN;
    const surfaceMaxY = surfaceY.length ? Math.max(...surfaceY) : NaN;
    const surfaceMeanY = surfaceY.length ? surfaceY.reduce((a, b) => a + b, 0) / surfaceY.length : NaN;
    const floorDelta = Number.isFinite(surfaceMeanY) && Number.isFinite(extracted.floorElevation)
      ? surfaceMeanY - extracted.floorElevation
      : NaN;

    console.log(`[WalkNav] NavMesh floor Y: min=${surfaceMinY} max=${surfaceMaxY} mean=${surfaceMeanY}`);
    console.log(`[WalkNav] NavMesh mean floor offset from authoritative slab: ${floorDelta}`);

    const surface = {
      version: 3,
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
    fs.writeFileSync(path.join(debugDir, "navigation_surface.json"), JSON.stringify(surface), "utf8");

    const areas = buildAreas(
      Array.from(surfacePositions),
      Array.from(surfaceIndices),
      3.0 * physicalMetersPerUnit,
      DEFAULT_METRES.eyeHeight,
      surface.metadata.floorElevation,
    );
    fs.writeFileSync(path.join(debugDir, "walk_areas.json"), JSON.stringify({ version: 1, areas }, null, 2), "utf8");

    const navigationNodes = areas.map((area, index) => ({
      id: area.id,
      position: [area.center[0], area.center[1] + walkableHeight, area.center[2]],
      lookAt: areas[index + 1]?.center ?? [area.center[0], area.center[1] + walkableHeight, area.center[2] + 1],
      links: [areas[index - 1]?.id, areas[index + 1]?.id].filter(Boolean),
      label: area.label,
    }));
    fs.writeFileSync(path.join(debugDir, "navigation.json"), JSON.stringify(navigationNodes, null, 2), "utf8");

    const meta = {
      version: 3,
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
      areas: { count: areas.length },
      navMesh: { serializedBytes: serialized.length },
    };
    fs.writeFileSync(path.join(debugDir, "navigation_meta.json"), JSON.stringify(meta, null, 2), "utf8");

    console.log(`[WalkNav] Wrote navigation_navmesh.bin (${serialized.length} bytes)`);
    console.log(`[WalkNav] Wrote walk_areas.json (${areas.length} areas)`);
    console.log(`[WalkNav] Floor authority: ${extracted.floorMeshNames.join(", ") || "NONE"}`);
    console.log(`[WalkNav] Generated navigation is floor-constrained; no synthetic floor.`);

    navMesh.destroy?.();
  }
}
