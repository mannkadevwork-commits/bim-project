import * as fs from "fs";
import * as path from "path";

import { NodeIO, Node as GltfNode } from "@gltf-transform/core";
import * as THREE from "three";

import { TriangleLabel, TriangleSoup } from "./types";

const GLTF_MODE_TRIANGLES = 4;
const GLTF_MODE_TRIANGLE_STRIP = 5;
const GLTF_MODE_TRIANGLE_FAN = 6;

const DOOR_MESH_KEYWORDS = ["door", "sliding", "automatic_door", "door_sliding"];
const FURNITURE_MESH_KEYWORDS = [
  "furniture",
  "chair",
  "table",
  "desk",
  "sofa",
  "couch",
  "shelf",
  "shelving",
  "cabinet",
  "wardrobe",
  "bed",
  "sink",
  "toilet",
  "counter",
  "appliance",
];

export interface ExtractResult {
  soup: TriangleSoup;
  triangleLabels: TriangleLabel[];
}

export class GeometryExtractor {
  static async extract(glbPath: string): Promise<TriangleSoup> {
    return (await GeometryExtractor.extractWithLabels(glbPath)).soup;
  }

  static async extractWithLabels(glbPath: string): Promise<ExtractResult> {
    const io = new NodeIO();
    const document = await io.read(glbPath);

    const root = document.getRoot();
    const scene = root.getDefaultScene() ?? root.listScenes()[0];

    const positions: number[] = [];
    const indices: number[] = [];
    const triangleLabels: TriangleLabel[] = [];

    if (!scene) {
      return {
        soup: { positions: Float32Array.from([]), indices: Uint32Array.from([]) },
        triangleLabels: [],
      };
    }

    scene.traverse((node: GltfNode) => {
      const mesh = node.getMesh();
      if (!mesh) return;

      const meshName = node.getName() || mesh.getName() || "unnamed_mesh";

      if (isDecorativeDoorMesh(meshName)) {
        console.log(`[NavMesh] Skipping door mesh: ${meshName}`);
        return;
      }

      console.log(`[NavMesh] Including mesh: ${meshName}`);

      const label: TriangleLabel = isFurnitureMesh(meshName) ? "furniture" : "structural";

      const worldMatrix = new THREE.Matrix4().fromArray(node.getWorldMatrix());
      const v = new THREE.Vector3();

      for (const primitive of mesh.listPrimitives()) {
        const mode = primitive.getMode();
        if (
          mode !== GLTF_MODE_TRIANGLES &&
          mode !== GLTF_MODE_TRIANGLE_STRIP &&
          mode !== GLTF_MODE_TRIANGLE_FAN
        ) {
          continue;
        }

        const positionAttr = primitive.getAttribute("POSITION");
        if (!positionAttr) continue;

        const localPositions = positionAttr.getArray();
        if (!localPositions) continue;

        const vertexCount = positionAttr.getCount();
        const vertexOffset = positions.length / 3;

        for (let i = 0; i < vertexCount; i++) {
          v.set(
            localPositions[i * 3],
            localPositions[i * 3 + 1],
            localPositions[i * 3 + 2]
          );
          v.applyMatrix4(worldMatrix);
          positions.push(v.x, v.y, v.z);
        }

        const localTriangleIndices = triangleIndicesForPrimitive(
          primitive,
          mode,
          vertexCount
        );
        for (const idx of localTriangleIndices) {
          indices.push(idx + vertexOffset);
        }

        const triangleCount = localTriangleIndices.length / 3;
        for (let t = 0; t < triangleCount; t++) {
          triangleLabels.push(label);
        }
      }
    });

    return {
      soup: {
        positions: Float32Array.from(positions),
        indices: Uint32Array.from(indices),
      },
      triangleLabels,
    };
  }

  static writeDebugObj(
    soup: TriangleSoup,
    outputPath: string,
    triangleLabels?: TriangleLabel[]
  ): void {
    const { positions, indices } = soup;
    const vertexCount = positions.length / 3;
    const triangleCount = indices.length / 3;

    if (triangleLabels && triangleLabels.length !== triangleCount) {
      throw new Error(
        `[NavMesh] triangleLabels length (${triangleLabels.length}) does not match triangle count (${triangleCount})`
      );
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    const lines: string[] = [];

    for (let i = 0; i < vertexCount; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      lines.push(`v ${x} ${y} ${z}`);

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    if (triangleLabels) {
      let currentLabel: TriangleLabel | null = null;
      for (let t = 0; t < triangleCount; t++) {
        const label = triangleLabels[t];
        if (label !== currentLabel) {
          lines.push(`g ${label}`);
          currentLabel = label;
        }
        const a = indices[t * 3] + 1;
        const b = indices[t * 3 + 1] + 1;
        const c = indices[t * 3 + 2] + 1;
        lines.push(`f ${a} ${b} ${c}`);
      }
    } else {
      lines.push("g combined");
      for (let t = 0; t < triangleCount; t++) {
        const a = indices[t * 3] + 1;
        const b = indices[t * 3 + 1] + 1;
        const c = indices[t * 3 + 2] + 1;
        lines.push(`f ${a} ${b} ${c}`);
      }
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, lines.join("\n") + "\n");

    console.log(`[NavMesh] Wrote debug OBJ: ${outputPath}`);
    console.log(`[NavMesh] Total triangles: ${triangleCount}`);
    console.log(`[NavMesh] Total vertices: ${vertexCount}`);
    console.log(
      `[NavMesh] Bounding box: min(${minX}, ${minY}, ${minZ}) max(${maxX}, ${maxY}, ${maxZ})`
    );

    if (triangleLabels) {
      const counts: Record<string, number> = {};
      for (const label of triangleLabels) {
        counts[label] = (counts[label] ?? 0) + 1;
      }
      for (const [label, count] of Object.entries(counts)) {
        console.log(`[NavMesh]   ${label}: ${count} triangles`);
      }
    }
  }

  static buildInjectedFloorLabels(
    extractedTriangleCount: number,
    combinedTriangleCount: number
  ): TriangleLabel[] {
    const injectedCount = combinedTriangleCount - extractedTriangleCount;
    if (injectedCount < 0) {
      throw new Error(
        `[NavMesh] combinedTriangleCount (${combinedTriangleCount}) is less than extractedTriangleCount (${extractedTriangleCount})`
      );
    }
    return new Array(injectedCount).fill("injected_floor");
  }
}

function isDecorativeDoorMesh(name: string): boolean {
  const lower = name.toLowerCase();
  return DOOR_MESH_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function isFurnitureMesh(name: string): boolean {
  const lower = name.toLowerCase();
  return FURNITURE_MESH_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function triangleIndicesForPrimitive(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  primitive: any,
  mode: number,
  vertexCount: number
): number[] {
  const indexAttr = primitive.getIndices();
  const raw: number[] = indexAttr
    ? Array.from(indexAttr.getArray() as ArrayLike<number>)
    : Array.from({ length: vertexCount }, (_, i) => i);

  if (mode === GLTF_MODE_TRIANGLES) {
    return raw;
  }

  const out: number[] = [];
  if (mode === GLTF_MODE_TRIANGLE_STRIP) {
    for (let i = 0; i + 2 < raw.length; i++) {
      if (i % 2 === 0) {
        out.push(raw[i], raw[i + 1], raw[i + 2]);
      } else {
        out.push(raw[i + 1], raw[i], raw[i + 2]);
      }
    }
    return out;
  }

  for (let i = 1; i + 1 < raw.length; i++) {
    out.push(raw[0], raw[i], raw[i + 1]);
  }
  return out;
}