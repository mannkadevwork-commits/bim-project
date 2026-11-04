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

export interface TextureSlotCounts {
  baseColor: number;
  metallicRoughness: number;
  normal: number;
  occlusion: number;
  emissive: number;
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
  nodesBefore: number;
  nodesAfter: number;
  materialsBefore: number;
  materialsAfter: number;
  texturesBefore: number;
  texturesAfter: number;
  textureSlotsBefore: TextureSlotCounts;
  textureSlotsAfter: TextureSlotCounts;
  maxTextureSizeApplied: number;
  textureQualityApplied: number;
  generatedAt: string;
}

type GeometryStats = {
  triangles: number;
  vertices: number;
  meshes: number;
  primitives: number;
  nodes: number;
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
    nodes: document.getRoot().listNodes().length,
    materials: document.getRoot().listMaterials().length,
    textures: document.getRoot().listTextures().length,
  };
}

function countMaterialTextureSlots(document: any): TextureSlotCounts {
  const counts: TextureSlotCounts = {
    baseColor: 0,
    metallicRoughness: 0,
    normal: 0,
    occlusion: 0,
    emissive: 0,
  };
  const slots: Array<[keyof TextureSlotCounts, string]> = [
    ["baseColor", "getBaseColorTexture"],
    ["metallicRoughness", "getMetallicRoughnessTexture"],
    ["normal", "getNormalTexture"],
    ["occlusion", "getOcclusionTexture"],
    ["emissive", "getEmissiveTexture"],
  ];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      if (!material) continue;
      for (const [slot, getter] of slots) {
        if (typeof material[getter] === "function" && material[getter]()) {
          counts[slot] += 1;
        }
      }
    }
  }
  return counts;
}

function reductionPercent(before: number, after: number): number {
  return before > 0 ? ((before - after) / before) * 100 : 0;
}

function writeReport(
  reportPath: string | undefined,
  stats: GlbOptimizationStats,
): void {
  if (!reportPath) return;

  fs.writeFileSync(
    reportPath,
    JSON.stringify(stats, null, 2),
    "utf8",
  );
}

/**
 * Converts the compiled scene into the browser-facing production GLB.
 *
 * Important transform-safety choices:
 * - Preserve the source node hierarchy. Catalogue instances are mounted under
 *   non-uniformly-scaled wrapper nodes, and their source GLBs may contain
 *   rotated descendants. Collapsing those transforms can create shear; glTF
 *   Transform's flatten() decomposes the result back to TRS and can therefore
 *   change geometry shape/position. Keep the hierarchy and let Three.js compose
 *   the matrices at runtime.
 * - We intentionally do NOT blindly join or instance named nodes. The HCI
 *   presentation/camera code can still use semantic mesh/node names.
 * - Meshopt compression, conservative simplification and texture resizing
 *   reduce delivery cost without baking parent transforms into child meshes.
 * - Visual Phase 1 uses a high-fidelity simplify floor (0.88) and less geometric
 *   error, because previous output reduced triangles by 70–90% and softened
 *   architectural edges. Textures are preserved at high quality when present.
 */
export async function optimizeGlb(
  options: GlbOptimizationOptions,
): Promise<GlbOptimizationStats> {
  if (!fs.existsSync(options.inputPath)) {
    throw new Error(
      `GLB input does not exist: ${options.inputPath}`,
    );
  }

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS);

  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;

  const inputBytes = fs.statSync(options.inputPath).size;
  const document = await io.read(options.inputPath);
  const before = countGeometryStats(document);
  const textureSlotsBefore = countMaterialTextureSlots(document);

  // Visual Phase 1 favours visible detail over the previous aggressively small
  // output. The caller may request a higher ratio, but quality mode will not
  // collapse below 88% of triangles. This still leaves meshopt compression on.
  const ratio = Math.min(
    1,
    Math.max(0.88, options.simplifyRatio ?? 0.90),
  );

  // A smaller geometric error better preserves door frames, wall edges and
  // thin interior details. Keep caller values only when they are stricter.
  const error = Math.max(
    0,
    Math.min(0.0005, options.simplifyError ?? 0.0005),
  );

  // Respect the caller's texture budget. The old Math.max(4096, requested)
  // expression accidentally forced every texture to allow 4K dimensions, even
  // when HCI_GLB_MAX_TEXTURE_SIZE requested 2048. A bounded 2K default keeps
  // uploaded furniture detailed while avoiding unbounded texture memory use.
  const maxTextureSize = Math.round(Math.max(
    256,
    Math.min(4096, options.maxTextureSize ?? 2048),
  ));

  // Honour quality settings instead of silently forcing >=92, which defeated
  // the deployment's configured value and increased encoded asset size.
  const textureQuality = Math.round(Math.max(
    70,
    Math.min(100, options.textureQuality ?? 88),
  ));

  await document.transform(
    // Remove duplicate buffer/accessor/material data first.
    dedup(),

    // Keep node transforms hierarchical. In particular, do not flatten a
    // non-uniformly-scaled asset wrapper containing rotated source descendants:
    // the composed world matrix may contain shear, which cannot be represented
    // by a single glTF TRS node without changing the asset's shape.

    // Merge duplicate vertices before simplification.
    weld({
      tolerance: 0.0001,
    }),

    // Conservative, error-bounded visual simplification.
    simplify({
      simplifier: MeshoptSimplifier,
      ratio,
      error,
      lockBorder: true,
    }),

    // Lossy WebP is appropriate for color imagery, but normal, occlusion, and
    // metallic/roughness maps encode numeric surface data. Compressing those
    // slots as lossy WebP changes the material response and can make furniture
    // look dull, metallic, or unusually dark. Preserve data-map bytes here;
    // only resize/convert authored color textures in this pass.
    textureCompress({
      encoder: sharp,
      targetFormat: "webp",
      resize: [
        maxTextureSize,
        maxTextureSize,
      ],
      quality: textureQuality,
      slots: /^(baseColorTexture|emissiveTexture)$/,
    }),

    prune(),
  );

  const after = countGeometryStats(document);
  const textureSlotsAfter = countMaterialTextureSlots(document);

  // Compress geometry for network/storage and fast browser decode.
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

  await outputIO.write(
    options.outputPath,
    document,
  );

  const outputBytes = fs.statSync(
    options.outputPath,
  ).size;

  const stats: GlbOptimizationStats = {
    inputBytes,
    outputBytes,
    inputMb: inputBytes / 1024 / 1024,
    outputMb: outputBytes / 1024 / 1024,
    fileReductionPercent: reductionPercent(
      inputBytes,
      outputBytes,
    ),
    trianglesBefore: before.triangles,
    trianglesAfter: after.triangles,
    verticesBefore: before.vertices,
    verticesAfter: after.vertices,
    meshesBefore: before.meshes,
    meshesAfter: after.meshes,
    primitivesBefore: before.primitives,
    primitivesAfter: after.primitives,
    nodesBefore: before.nodes,
    nodesAfter: after.nodes,
    materialsBefore: before.materials,
    materialsAfter: after.materials,
    texturesBefore: before.textures,
    texturesAfter: after.textures,
    textureSlotsBefore,
    textureSlotsAfter,
    maxTextureSizeApplied: maxTextureSize,
    textureQualityApplied: textureQuality,
    generatedAt: new Date().toISOString(),
  };

  writeReport(
    options.reportPath,
    stats,
  );

  console.log(
    "[compiler:glb-opt] production GLB ready",
    {
      inputMB: stats.inputMb.toFixed(2),
      outputMB: stats.outputMb.toFixed(2),
      fileReduction:
        `${stats.fileReductionPercent.toFixed(1)}%`,
      triangleReduction:
        `${reductionPercent(
          before.triangles,
          after.triangles,
        ).toFixed(1)}%`,
      vertexReduction:
        `${reductionPercent(
          before.vertices,
          after.vertices,
        ).toFixed(1)}%`,
      primitiveReduction:
        `${reductionPercent(
          before.primitives,
          after.primitives,
        ).toFixed(1)}%`,
      nodeReduction:
        `${reductionPercent(
          before.nodes,
          after.nodes,
        ).toFixed(1)}%`,
    },
  );

  return stats;
}

const isMainModule =
  import.meta.url ===
  new URL(
    `file://${process.argv[1]?.replace(/\\/g, "/")}`,
  ).href;

if (isMainModule) {
  const [
    inputPath,
    outputPath,
    reportPath,
  ] = process.argv.slice(2);

  if (!inputPath || !outputPath) {
    console.error(
      "Usage: npx tsx glb-optimizer.ts <input.glb> <output.glb> [report.json]",
    );
    process.exit(1);
  }

  optimizeGlb({
    inputPath,
    outputPath,
    reportPath,
  })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(
        "[compiler:glb-opt] failed:",
        error instanceof Error
          ? error.message
          : error,
      );
      process.exit(1);
    });
}
