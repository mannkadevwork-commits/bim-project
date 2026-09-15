import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compileScene } from "./compiler";
import { optimizeGlb } from "./glb-optimizer";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface ProductionCompileOptions {
  jobDirectory: string;
  assetsDirectory: string;
}

/**
 * Production render entry point.
 *
 * Existing compileScene() remains responsible for the exact scene assembly
 * and navigation generation. Once it has finished, output.glb is still the
 * exact compiler artifact; navigation has already been generated from it.
 * We then replace only the visual output.glb with the optimized asset.
 *
 * This keeps the existing navigation/collision behavior intact while making
 * the browser-facing artifact production-optimized automatically.
 */
export async function compileProductionScene({
  jobDirectory,
  assetsDirectory,
}: ProductionCompileOptions): Promise<void> {
  const outputGlbPath = path.join(jobDirectory, "output.glb");
  const optimizedPath = path.join(jobDirectory, "output.optimized.tmp.glb");
  const reportPath = path.join(jobDirectory, "optimization_report.json");

  await compileScene({
    jobDirectory,
    assetsDirectory,
  });

  if (!fs.existsSync(outputGlbPath)) {
    throw new Error(
      `Production compile completed without output.glb: ${outputGlbPath}`,
    );
  }

  try {
    await optimizeGlb({
      inputPath: outputGlbPath,
      outputPath: optimizedPath,
      reportPath,
      simplifyRatio: Number(process.env.HCI_GLB_SIMPLIFY_RATIO) || 0.70,
      simplifyError: Number(process.env.HCI_GLB_SIMPLIFY_ERROR) || 0.001,
      maxTextureSize: Number(process.env.HCI_GLB_MAX_TEXTURE_SIZE) || 2048,
      textureQuality: Number(process.env.HCI_GLB_TEXTURE_QUALITY) || 86,
    });

    // Replace the browser-facing artifact only after the optimized file has
    // been completely written. Existing output.glb therefore stays intact if
    // optimization fails midway.
    fs.rmSync(outputGlbPath, { force: true });
    fs.renameSync(optimizedPath, outputGlbPath);
  } finally {
    if (fs.existsSync(optimizedPath)) {
      fs.rmSync(optimizedPath, { force: true });
    }
  }

  console.log(`[production-compile] optimized walkthrough ready: ${outputGlbPath}`);
}

const isMainModule =
  import.meta.url ===
  new URL(`file://${process.argv[1]?.replace(/\\/g, "/")}`).href;

if (isMainModule) {
  const [jobDirectory, assetsDirectory] = process.argv.slice(2);

  if (!jobDirectory || !assetsDirectory) {
    console.error(
      "Usage: npx tsx production-compile.ts <jobDirectory> <assetsDirectory>",
    );
    process.exit(1);
  }

  compileProductionScene({ jobDirectory, assetsDirectory })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(
        "[production-compile] Fatal:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    });
}
