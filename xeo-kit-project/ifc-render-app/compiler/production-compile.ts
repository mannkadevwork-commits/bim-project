import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compileScene } from "./compiler";

const ROOT_DIR = path.dirname(
  fileURLToPath(import.meta.url),
);

export interface ProductionCompileOptions {
  jobDirectory: string;
  assetsDirectory: string;
}

const PRODUCTION_ONLY_ARTIFACTS = [
  "output.raw.glb",
  "walk_nav_input_debug.obj",
  "rooms_debug.json",
  "360_viewer.html",
];

function cleanupProductionOnlyArtifacts(
  jobDirectory: string,
): void {
  for (const fileName of PRODUCTION_ONLY_ARTIFACTS) {
    const filePath = path.join(
      jobDirectory,
      fileName,
    );

    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, {
          force: true,
        });

        console.log(
          `[production-compile] removed build/debug artifact: ${fileName}`,
        );
      }
    } catch (error) {
      // Cleanup must never turn a successful render into a 500.
      console.warn(
        `[production-compile] cleanup failed for ${fileName}:`,
        error instanceof Error
          ? error.message
          : error,
      );
    }
  }
}

/**
 * Production 360 render entry point.
 *
 * There is exactly ONE GLB optimization pass:
 *
 *   production-compile
 *       -> compileScene
 *           -> output.raw.glb
 *           -> navigation from exact compiled geometry
 *           -> optimizeGlb
 *           -> output.glb
 *
 * compileScene is the authoritative owner of the visual GLB pipeline.
 * This wrapper intentionally DOES NOT call optimizeGlb again.
 */
export async function compileProductionScene({
  jobDirectory,
  assetsDirectory,
}: ProductionCompileOptions): Promise<void> {
  const outputGlbPath = path.join(
    jobDirectory,
    "output.glb",
  );

  await compileScene({
    jobDirectory,
    assetsDirectory,
  });

  if (!fs.existsSync(outputGlbPath)) {
    throw new Error(
      `Production compile completed without output.glb: ${outputGlbPath}`,
    );
  }

  const stat = fs.statSync(outputGlbPath);

  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(
      `Production compile created an invalid output.glb: ${outputGlbPath}`,
    );
  }

  // Do not keep huge raw/debug artifacts in customer jobs.
  cleanupProductionOnlyArtifacts(
    jobDirectory,
  );

  console.log(
    `[production-compile] optimized walkthrough ready: ${outputGlbPath} (${stat.size} bytes)`,
  );
}

const isMainModule =
  import.meta.url ===
  new URL(
    `file://${process.argv[1]?.replace(/\\/g, "/")}`,
  ).href;

if (isMainModule) {
  const [
    jobDirectory,
    assetsDirectory,
  ] = process.argv.slice(2);

  if (!jobDirectory || !assetsDirectory) {
    console.error(
      "Usage: npx tsx production-compile.ts <jobDirectory> <assetsDirectory>",
    );
    process.exit(1);
  }

  compileProductionScene({
    jobDirectory,
    assetsDirectory,
  })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(
        "[production-compile] Fatal:",
        error instanceof Error
          ? error.message
          : error,
      );
      process.exit(1);
    });
}
