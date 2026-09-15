import * as fs from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
  instance,
  prune,
  simplify,
  textureCompress,
  weld,
  meshopt,
} from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

export interface GlbOptimizationOptions {
  inputPath: string;
  outputPath: string;
  rawBackupPath?: string;
  minInputBytes?: number;
  simplifyRatio?: number;
  simplifyError?: number;
  maxTextureSize?: number;
  textureQuality?: number;
}

export interface GlbOptimizationStats {
  inputBytes: number;
  outputBytes: number;
  inputMb: number;
  outputMb: number;
  reductionPercent: number;
  triangles: number;
  vertices: number;
  meshes: number;
  primitives: number;
  materials: number;
  textures: number;
}

function countStats(document: any): Pick<GlbOptimizationStats, "triangles" | "vertices" | "meshes" | "primitives" | "materials" | "textures"> {
  let triangles = 0;
  let vertices = 0;
  let primitives = 0;

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitives += 1;
      const indices = primitive.getIndices();
      if (indices?.getCount()) triangles += Math.floor(indices.getCount() / 3);

      const position = primitive.getAttribute("POSITION");
      if (position?.getCount()) vertices += position.getCount();
    }
  }

  return {
    triangles,
    vertices,
    meshes: document.getRoot().listMeshes().length,
    primitives,
    materials: document.getRoot().listMaterials().length,
    textures: document.getRoot().listTextures().length,
  };
}

export async function optimizeGlb(
  options: GlbOptimizationOptions,
): Promise<GlbOptimizationStats | null> {
  if (!fs.existsSync(options.inputPath)) {
    throw new Error(`GLB input does not exist: ${options.inputPath}`);
  }

  const inputBytes = fs.statSync(options.inputPath).size;
  const minInputBytes = options.minInputBytes ?? 8 * 1024 * 1024;

  // Preserve the raw compiler output for debugging/fallback.
  if (options.rawBackupPath) {
    fs.copyFileSync(options.inputPath, options.rawBackupPath);
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;

  const document = await io.read(options.inputPath);
  const before = countStats(document);

  // For small scenes, don't spend compiler CPU just to squeeze a few bytes.
  if (inputBytes < minInputBytes) {
    fs.copyFileSync(options.inputPath, options.outputPath);
    return {
      inputBytes,
      outputBytes: inputBytes,
      inputMb: inputBytes / 1024 / 1024,
      outputMb: inputBytes / 1024 / 1024,
      reductionPercent: 0,
      ...before,
    };
  }

  const ratio = Math.min(1, Math.max(0.5, options.simplifyRatio ?? 0.70));
  const error = options.simplifyError ?? 0.001;

  await document.transform(
    // Lossless graph cleanup and repeated-asset reuse.
    dedup(),
    // Weld only before simplification. The simplifier itself also avoids
    // unsupported primitive modes, so LINE/POINT primitives remain intact.
    weld({ tolerance: 0.0001 }),
    simplify({
      simplifier: MeshoptSimplifier,
      ratio,
      error,
      lockBorder: true,
    }),

    // Keep runtime payloads small without touching material semantics.
    ...(options.maxTextureSize
      ? [
          textureCompress({
            encoder: sharp,
            targetFormat: "webp",
            resize: [options.maxTextureSize, options.maxTextureSize],
            quality: options.textureQuality ?? 84,
          }),
        ]
      : []),

    prune(),
  );

  // Meshopt is the final geometry-encoding pass. It both prepares the
  // accessors for web delivery and writes EXT_meshopt_compression data.
  await document.transform(
    meshopt({ encoder: MeshoptEncoder, level: "high" }),
  );

  // NodeIO gets the encoder from the dependency registry on write.
  const encodedIo = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "meshopt.encoder": MeshoptEncoder,
    });

  await encodedIo.write(options.outputPath, document);

  const outputBytes = fs.statSync(options.outputPath).size;
  const after = countStats(document);

  const stats: GlbOptimizationStats = {
    inputBytes,
    outputBytes,
    inputMb: inputBytes / 1024 / 1024,
    outputMb: outputBytes / 1024 / 1024,
    reductionPercent: inputBytes > 0
      ? ((inputBytes - outputBytes) / inputBytes) * 100
      : 0,
    ...after,
  };

  console.log("[compiler:glb-opt] complete", {
    inputMb: stats.inputMb.toFixed(2),
    outputMb: stats.outputMb.toFixed(2),
    reductionPercent: stats.reductionPercent.toFixed(1),
    trianglesBefore: before.triangles,
    trianglesAfter: after.triangles,
    verticesBefore: before.vertices,
    verticesAfter: after.vertices,
    primitivesBefore: before.primitives,
    primitivesAfter: after.primitives,
    materialsBefore: before.materials,
    materialsAfter: after.materials,
    texturesBefore: before.textures,
    texturesAfter: after.textures,
  });

  return stats;
}
