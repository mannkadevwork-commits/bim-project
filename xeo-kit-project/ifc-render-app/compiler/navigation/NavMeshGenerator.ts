import { promises as fs } from "fs";
import * as path from "path";

import { init as initRecast, getNavMeshPositionsAndIndices, NavMesh } from "recast-navigation";
import { generateSoloNavMesh } from "recast-navigation/generators";

import { GeometryExtractor } from "./GeometryExtractor";
import { NavMeshSurface, TriangleLabel, TriangleSoup } from "./types";

let recastReady: Promise<void> | null = null;

function ensureRecastInitialized(): Promise<void> {
  if (!recastReady) {
    recastReady = initRecast().then(() => undefined);
  }
  return recastReady;
}

export interface NavMeshGeneratorConfig {
  cellSize?: number;
  cellHeight?: number;
  walkableSlopeAngle?: number;
  walkableHeight?: number;
  walkableClimb?: number;
  walkableRadius?: number;
  injectSyntheticFloor?: boolean;
}

const DEFAULT_CONFIG: Required<NavMeshGeneratorConfig> = {
  cellSize: 0.15,
  cellHeight: 0.15,
  walkableSlopeAngle: 45,
  walkableHeight: 1.6,
  walkableClimb: 0.4,
  walkableRadius: 0.15,
  injectSyntheticFloor: true,
};

export interface NavMeshGenerationResult {
  success: boolean;
  navMesh: NavMesh | null;
  surface: NavMeshSurface | null;
  error?: string;
}

export class NavMeshGenerator {
  static async generate(
    soup: TriangleSoup,
    config: NavMeshGeneratorConfig = {},
    jobId?: string,
    triangleLabels?: TriangleLabel[]
  ): Promise<NavMeshGenerationResult> {
    if (soup.indices.length === 0) {
      return {
        success: false,
        navMesh: null,
        surface: null,
        error: "Triangle soup is empty - nothing to build a NavMesh from.",
      };
    }

    await ensureRecastInitialized();

    const merged = { ...DEFAULT_CONFIG, ...config };

    const workingSoup = merged.injectSyntheticFloor
      ? injectSyntheticFloor(soup)
      : soup;

    try {
      const originalTriangleCount = soup.indices.length / 3;
      const combinedTriangleCount = workingSoup.indices.length / 3;

      const baseLabels: TriangleLabel[] =
        triangleLabels && triangleLabels.length === originalTriangleCount
          ? triangleLabels
          : new Array(originalTriangleCount).fill("structural");

      const injectedLabels = merged.injectSyntheticFloor
        ? GeometryExtractor.buildInjectedFloorLabels(originalTriangleCount, combinedTriangleCount)
        : [];

      const fullLabels: TriangleLabel[] = [...baseLabels, ...injectedLabels];

      const debugDir = path.join("jobs", jobId ?? "debug");
      await fs.mkdir(debugDir, { recursive: true });
      const geometryDebugPath = path.join(debugDir, "geometry_debug.obj");

      GeometryExtractor.writeDebugObj(workingSoup, geometryDebugPath, fullLabels);
    } catch (err) {
      console.error(`[NavMesh] Failed to write geometry_debug.obj - ${(err as Error).message}`);
    }

    let generation: ReturnType<typeof generateSoloNavMesh>;
    try {
      generation = generateSoloNavMesh(
        Array.from(workingSoup.positions),
        Array.from(workingSoup.indices),
        {
          cs: merged.cellSize,
          ch: merged.cellHeight,
          walkableSlopeAngle: merged.walkableSlopeAngle,
          walkableHeight: merged.walkableHeight,
          walkableClimb: merged.walkableClimb,
          walkableRadius: merged.walkableRadius,
        }
      );
    } catch (err) {
      return {
        success: false,
        navMesh: null,
        surface: null,
        error: `generateSoloNavMesh threw - ${(err as Error).message}`,
      };
    }

    if (!generation.success || !generation.navMesh) {
      return {
        success: false,
        navMesh: null,
        surface: null,
        error: "generateSoloNavMesh reported failure (see recast build log above).",
      };
    }

    logConnectivityReport(generation.navMesh);

    const [surfacePositions, surfaceIndices] = getNavMeshPositionsAndIndices(
      generation.navMesh
    );

    const surface: NavMeshSurface = {
      positions: Float32Array.from(surfacePositions),
      indices: Uint32Array.from(surfaceIndices),
    };

    const surfaceVertexCount = surface.positions.length / 3;
    const surfaceTriangleCount = surface.indices.length / 3;
    console.log(`[NavMesh] Debug surface vertex count: ${surfaceVertexCount}`);
    console.log(`[NavMesh] Debug surface triangle count: ${surfaceTriangleCount}`);

    try {
      const debugPath = await writeDebugObj(jobId ?? "debug", surface);
      console.log(`[NavMesh] Wrote debug surface: ${debugPath}`);
    } catch (err) {
      console.error(`[NavMesh] Failed to write debug surface - ${(err as Error).message}`);
    }

    return {
      success: true,
      navMesh: generation.navMesh,
      surface,
    };
  }
}

interface BoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

function computeBoundingBox(positions: Float32Array): BoundingBox {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function injectSyntheticFloor(soup: TriangleSoup): TriangleSoup {
  const bounds = computeBoundingBox(soup.positions);

  console.log("[NavMesh] Bounding Box:");
  console.log(`[NavMesh]   minX: ${bounds.minX}`);
  console.log(`[NavMesh]   maxX: ${bounds.maxX}`);
  console.log(`[NavMesh]   minY: ${bounds.minY}`);
  console.log(`[NavMesh]   maxY: ${bounds.maxY}`);
  console.log(`[NavMesh]   minZ: ${bounds.minZ}`);
  console.log(`[NavMesh]   maxZ: ${bounds.maxZ}`);

  const floorY = bounds.minY + 0.01;
  const floorMinX = bounds.minX - 2;
  const floorMaxX = bounds.maxX + 2;
  const floorMinZ = bounds.minZ - 2;
  const floorMaxZ = bounds.maxZ + 2;

  const floorVertices: Array<[number, number, number]> = [
    [floorMinX, floorY, floorMinZ],
    [floorMaxX, floorY, floorMinZ],
    [floorMaxX, floorY, floorMaxZ],
    [floorMinX, floorY, floorMaxZ],
  ];

  console.log(`[NavMesh] Injected Floor Y: ${floorY}`);
  console.log("[NavMesh] Injected Floor Vertices:");
  floorVertices.forEach(([x, y, z]) => {
    console.log(`[NavMesh]   (${x}, ${y}, ${z})`);
  });

  const originalTriangleCount = soup.indices.length / 3;
  const vertexOffset = soup.positions.length / 3;

  const positions = new Float32Array(soup.positions.length + floorVertices.length * 3);
  positions.set(soup.positions, 0);
  floorVertices.forEach((vertex, i) => {
    positions.set(vertex, soup.positions.length + i * 3);
  });

  const floorIndices = [
    vertexOffset, vertexOffset + 2, vertexOffset + 1,
    vertexOffset, vertexOffset + 3, vertexOffset + 2,
  ];

  const indices = new Uint32Array(soup.indices.length + floorIndices.length);
  indices.set(soup.indices, 0);
  indices.set(floorIndices, soup.indices.length);

  const triangleCountAfterInjection = indices.length / 3;

  console.log(`[NavMesh] Original triangle count: ${originalTriangleCount}`);
  console.log(`[NavMesh] Triangle count after injection: ${triangleCountAfterInjection}`);

  return { positions, indices };
}

async function writeDebugObj(jobId: string, surface: NavMeshSurface): Promise<string> {
  const dir = path.join("jobs", jobId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "navmesh_debug.obj");

  const lines: string[] = [];
  const vertexCount = surface.positions.length / 3;
  for (let i = 0; i < vertexCount; i++) {
    const x = surface.positions[i * 3];
    const y = surface.positions[i * 3 + 1];
    const z = surface.positions[i * 3 + 2];
    lines.push(`v ${x} ${y} ${z}`);
  }

  const triangleCount = surface.indices.length / 3;
  for (let i = 0; i < triangleCount; i++) {
    const a = surface.indices[i * 3] + 1;
    const b = surface.indices[i * 3 + 1] + 1;
    const c = surface.indices[i * 3 + 2] + 1;
    lines.push(`f ${a} ${b} ${c}`);
  }

  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

interface WalkablePolygon {
  vertexIds: number[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function enumerateWalkablePolygons(navMesh: any): WalkablePolygon[] {
  const records: WalkablePolygon[] = [];
  const maxTiles: number = navMesh.getMaxTiles();

  for (let t = 0; t < maxTiles; t++) {
    const tile = navMesh.getTile(t);
    if (!tile) continue;

    const header = tile.header?.();
    if (!header) continue;

    const polyCount: number = header.polyCount();
    if (polyCount <= 0) continue;

    for (let p = 0; p < polyCount; p++) {
      const poly = tile.polys(p);
      if (!poly) continue;

      if (typeof poly.getType === "function" && poly.getType() !== 0) {
        continue;
      }

      const vertCount: number = poly.vertCount();
      if (vertCount < 3) continue;

      const vertexIds: number[] = [];
      for (let v = 0; v < vertCount; v++) {
        vertexIds.push(poly.verts(v));
      }

      records.push({ vertexIds });
    }
  }

  return records;
}

function computeConnectedComponents(polys: WalkablePolygon[]): number[][] {
  const edgeToPolyIndices = new Map<string, number[]>();

  polys.forEach((poly, polyIndex) => {
    const n = poly.vertexIds.length;
    for (let i = 0; i < n; i++) {
      const a = poly.vertexIds[i];
      const b = poly.vertexIds[(i + 1) % n];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;

      let bucket = edgeToPolyIndices.get(key);
      if (!bucket) {
        bucket = [];
        edgeToPolyIndices.set(key, bucket);
      }
      bucket.push(polyIndex);
    }
  });

  const adjacency = new Map<number, Set<number>>();
  polys.forEach((_, i) => adjacency.set(i, new Set()));

  edgeToPolyIndices.forEach((polyIndices) => {
    for (let i = 0; i < polyIndices.length; i++) {
      for (let j = i + 1; j < polyIndices.length; j++) {
        adjacency.get(polyIndices[i])!.add(polyIndices[j]);
        adjacency.get(polyIndices[j])!.add(polyIndices[i]);
      }
    }
  });

  const visited = new Set<number>();
  const components: number[][] = [];

  polys.forEach((_, start) => {
    if (visited.has(start)) return;

    const component: number[] = [];
    const stack = [start];
    visited.add(start);

    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);

      adjacency.get(current)!.forEach((neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      });
    }

    components.push(component);
  });

  return components;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logConnectivityReport(navMesh: any): void {
  const polys = enumerateWalkablePolygons(navMesh);
  const components = computeConnectedComponents(polys);
  const largest = components.reduce((max, c) => Math.max(max, c.length), 0);
  const isolated = components.filter((c) => c.length === 1).length;

  console.log(`[NavMesh] Walkable polygons: ${polys.length}`);
  console.log(`[NavMesh] Connected components: ${components.length}`);
  console.log(`[NavMesh] Largest component size: ${largest}`);
  console.log(`[NavMesh] Isolated polygons: ${isolated}`);
}