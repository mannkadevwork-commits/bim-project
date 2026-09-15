import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compileScene } from "./compiler";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface ProductionCompileOptions {
  jobDirectory: string;
  assetsDirectory: string;
}

/**
 * Production render entry point.
 *
 * IMPORTANT:
 * compileScene() already performs the full production visual pipeline:
 *   1. exact scene compilation
 *   2. navigation generation from the raw compiled geometry
 *   3. GLB optimization
 *   4. removal of the temporary raw GLB
 *
 * The server calls this production entry point, so optimization must NOT be
 * repeated here. Re-optimizing output.glb would attempt to read a GLB that
 * already contains EXT_meshopt_compression and would require a MeshoptDecoder.
 *
 * Keep this wrapper deliberately thin so there is one authoritative compiler
 * pipeline and one browser-facing output.glb.
 */
export async function compileProductionScene({
  jobDirectory,
  assetsDirectory,
}: ProductionCompileOptions): Promise<void> {
  const outputGlbPath = path.join(jobDirectory, "output.glb");

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

  console.log(
    `[production-compile] optimized walkthrough ready: ${outputGlbPath} (${stat.size} bytes)`,
  );
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

  compileProductionScene({
    jobDirectory,
    assetsDirectory,
  })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(
        "[production-compile] Fatal:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    });
}
