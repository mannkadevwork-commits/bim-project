import * as fs from "node:fs";
import * as path from "node:path";
import type { Node as GltfNode } from "@gltf-transform/core";

export interface TreePerformanceMetrics {
  nodeCount: number;
  meshInstances: number;
  uniqueMeshes: number;
  primitiveCount: number;
  vertexCount: number;
  triangleCount: number;
  materialCount: number;
  textureCount: number;
  embeddedTextureBytes: number;
  knownTextureGpuBytes: number;
  texturesWithKnownDimensions: number;
  texturesWithUnknownDimensions: number;
  estimatedDrawCalls: number;
}

type WalkNode = GltfNode & {
  getMesh?: () => any;
  listChildren?: () => WalkNode[];
};

function textureDimensions(image: Uint8Array | null | undefined): { width: number; height: number } | null {
  if (!image || image.byteLength < 24) return null;
  // PNG dimensions are available in the fixed IHDR header.
  if (
    image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e &&
    image[3] === 0x47 && image[4] === 0x0d && image[5] === 0x0a &&
    image[6] === 0x1a && image[7] === 0x0a
  ) {
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

function materialTextures(material: any): any[] {
  const getters = [
    "getBaseColorTexture",
    "getMetallicRoughnessTexture",
    "getNormalTexture",
    "getOcclusionTexture",
    "getEmissiveTexture",
  ];
  const result: any[] = [];
  for (const getter of getters) {
    try {
      const texture = typeof material?.[getter] === "function" ? material[getter]() : null;
      if (texture && !result.includes(texture)) result.push(texture);
    } catch {
      // An unsupported extension texture is counted by the browser runtime if used.
    }
  }
  return result;
}

/** Summarize a glTF node subtree without modifying geometry or materials. */
export function collectNodePerformanceMetrics(root: WalkNode | any): TreePerformanceMetrics {
  const uniqueMeshes = new Set<any>();
  const materials = new Set<any>();
  const textures = new Set<any>();
  let nodeCount = 0;
  let meshInstances = 0;
  let primitiveCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let estimatedDrawCalls = 0;

  const visit = (node: WalkNode | any) => {
    if (!node) return;
    nodeCount += 1;
    let mesh: any = null;
    try { mesh = typeof node.getMesh === "function" ? node.getMesh() : null; } catch { mesh = null; }
    if (mesh) {
      meshInstances += 1;
      uniqueMeshes.add(mesh);
      for (const primitive of mesh.listPrimitives?.() ?? []) {
        primitiveCount += 1;
        estimatedDrawCalls += 1;
        const positions = primitive.getAttribute?.("POSITION");
        const indices = primitive.getIndices?.();
        const vertexCountForPrimitive = Number(positions?.getCount?.() ?? 0);
        vertexCount += vertexCountForPrimitive;
        const elementCount = Number(indices?.getCount?.() ?? vertexCountForPrimitive);
        const mode = Number(primitive.getMode?.() ?? 4);
        if (mode === 4) triangleCount += Math.floor(elementCount / 3);
        else if (mode === 5 || mode === 6) triangleCount += Math.max(0, elementCount - 2);
        const material = primitive.getMaterial?.();
        if (material) {
          materials.add(material);
          for (const texture of materialTextures(material)) textures.add(texture);
        }
      }
    }
    for (const child of node.listChildren?.() ?? []) visit(child);
  };

  visit(root);
  let embeddedTextureBytes = 0;
  let knownTextureGpuBytes = 0;
  let texturesWithKnownDimensions = 0;
  let texturesWithUnknownDimensions = 0;
  for (const texture of textures) {
    const image = texture.getImage?.() as Uint8Array | null | undefined;
    embeddedTextureBytes += Number(image?.byteLength ?? 0);
    const dimensions = textureDimensions(image);
    if (dimensions) {
      knownTextureGpuBytes += dimensions.width * dimensions.height * 4;
      texturesWithKnownDimensions += 1;
    } else {
      texturesWithUnknownDimensions += 1;
    }
  }

  return {
    nodeCount,
    meshInstances,
    uniqueMeshes: uniqueMeshes.size,
    primitiveCount,
    vertexCount,
    triangleCount,
    materialCount: materials.size,
    textureCount: textures.size,
    embeddedTextureBytes,
    knownTextureGpuBytes,
    texturesWithKnownDimensions,
    texturesWithUnknownDimensions,
    estimatedDrawCalls,
  };
}

export function readJsonIfPresent(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function writePerformanceReport(jobDirectory: string, report: Record<string, any>): string {
  const reportPath = path.join(jobDirectory, "performance_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}
