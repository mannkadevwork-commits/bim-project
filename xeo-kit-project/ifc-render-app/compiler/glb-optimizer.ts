import * as fs from "node:fs";
import * as path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
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
  reportPath?: string;
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
  fileReductionPercent: number;
  trianglesBefore: number;
  trianglesAfter: number;
  verticesBefore: number;
  verticesAfter: number;
  meshesBefore: number;
  meshesAfter: number;
  primitivesBefore: number;
  primitivesAfter: number;
  materialsBefore: number;
  materialsAfter: number;
  texturesBefore: number;
  texturesAfter: number;
  generatedAt: string;
}

type GeometryStats = {
  triangles: number;
  vertices: number;
  meshes: number;
  primitives: number;
  materials: number;
  textures: number;
};

function countGeometryStats(document: any): GeometryStats {
  let triangles = 0;
  let vertices = 0;
  let primitives = 0;

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitives += 1;

      const indices = primitive.getIndices();
      if (indices?.getCount()) {
        triangles += Math.floor(indices.getCount() / 3);
      }

      const position = primitive.getAttribute("POSITION");
      if (position?.getCount()) {
        vertices += position.getCount();
      }
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

function reductionPercent(before: number, after: number): number {
  return before > 0 ? ((before - after) / before) * 100 : 0;
}

function writeReport(
  reportPath: string | undefined,
  stats: GlbOptimizationStats,
): void {
  if (!reportPath) return;
  fs.writeFileSync(reportPath, JSON.stringify(stats, null, 2), "utf8");
}

/**
 * Converts the compiler's exact GLB into the production visual GLB used by
 * the browser walkthrough.
 *
 * We intentionally do not arbitrarily join/instance scene nodes because HCI
 * relies on authored transforms, semantic names, furniture placement and
 * door isolation.
 */
export async function optimizeGlb(
  options: GlbOptimizationOptions,
): Promise<GlbOptimizationStats> {
  if (!fs.existsSync(options.inputPath)) {
    throw new Error(`GLB input does not exist: ${options.inputPath}`);
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;

  const inputBytes = fs.statSync(options.inputPath).size;
  const document = await io.read(options.inputPath);
  const before = countGeometryStats(document);

  const ratio = Math.min(
    1,
    Math.max(0.5, options.simplifyRatio ?? 0.70),
  );
  const error = Math.max(0, options.simplifyError ?? 0.001);
  const maxTextureSize = Math.max(512, options.maxTextureSize ?? 2048);
  const textureQuality = Math.min(
    100,
    Math.max(60, options.textureQuality ?? 86),
  );

  await document.transform(
    dedup(),
    weld({ tolerance: 0.0001 }),
    simplify({
      simplifier: MeshoptSimplifier,
      ratio,
      error,
      lockBorder: true,
    }),
    textureCompress({
      encoder: sharp,
      targetFormat: "webp",
      resize: [maxTextureSize, maxTextureSize],
      quality: textureQuality,
    }),
    prune(),
  );

  const after = countGeometryStats(document);

  await document.transform(
    meshopt({
      encoder: MeshoptEncoder,
      level: "high",
    }),
  );

  const outputIO = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "meshopt.encoder": MeshoptEncoder,
    });

  const outputDir = path.dirname(options.outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  await outputIO.write(options.outputPath, document);

  const outputBytes = fs.statSync(options.outputPath).size;
  const generatedAt = new Date().toISOString();

  const stats: GlbOptimizationStats = {
    inputBytes,
    outputBytes,
    inputMb: inputBytes / 1024 / 1024,
    outputMb: outputBytes / 1024 / 1024,
    fileReductionPercent: reductionPercent(inputBytes, outputBytes),
    trianglesBefore: before.triangles,
    trianglesAfter: after.triangles,
    verticesBefore: before.vertices,
    verticesAfter: after.vertices,
    meshesBefore: before.meshes,
    meshesAfter: after.meshes,
    primitivesBefore: before.primitives,
    primitivesAfter: after.primitives,
    materialsBefore: before.materials,
    materialsAfter: after.materials,
    texturesBefore: before.textures,
    texturesAfter: after.textures,
    generatedAt,
  };

  writeReport(options.reportPath, stats);

  console.log("[compiler:glb-opt] production GLB ready", {
    inputMB: stats.inputMb.toFixed(2),
    outputMB: stats.outputMb.toFixed(2),
    fileReduction: `${stats.fileReductionPercent.toFixed(1)}%`,
    triangleReduction: `${reductionPercent(
      before.triangles,
      after.triangles,
    ).toFixed(1)}%`,
    vertexReduction: `${reductionPercent(
      before.vertices,
      after.vertices,
    ).toFixed(1)}%`,
    primitiveReduction: `${reductionPercent(
      before.primitives,
      after.primitives,
    ).toFixed(1)}%`,
  });

  return stats;
}

const isMainModule =
  import.meta.url ===
  new URL(`file://${process.argv[1]?.replace(/\\/g, "/")}`).href;

if (isMainModule) {
  const [inputPath, outputPath, reportPath] = process.argv.slice(2);

  if (!inputPath || !outputPath) {
    console.error(
      "Usage: npx tsx glb-optimizer.ts <input.glb> <output.glb> [report.json]",
    );
    process.exit(1);
  }

  optimizeGlb({ inputPath, outputPath, reportPath })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(
        "[compiler:glb-opt] failed:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    });
}
