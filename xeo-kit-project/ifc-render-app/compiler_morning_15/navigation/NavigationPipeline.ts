import * as fs from "fs";
import * as path from "path";

import { GeometryExtractor } from "./GeometryExtractor";
import { NavMeshGenerator } from "./NavMeshGenerator";
import { GraphBuilder } from "./GraphBuilder";
import { GraphValidator } from "./GraphValidator";
import { NavigationExporter } from "./NavigationExporter";
import { NavNode } from "./types";

/**
 * Generates navigation.json from a compiled output.glb.
 *
 * output.glb is the single source of truth: this pipeline never reads the
 * raw IFC, so structural edits, inserted doors, and furniture are all
 * already accounted for by the time the NavMesh is built - unlike the old
 * pipeline, which raycast against the structural IFC before assembly and
 * had no way to know a door had been inserted.
 *
 *   GeometryExtractor -> triangle soup
 *   NavMeshGenerator  -> recast NavMesh
 *   GraphBuilder      -> NavNode[] (viewpoints + links)
 *   GraphValidator     -> connectivity stats (logged, non-fatal)
 *   NavigationExporter -> navigation.json (existing schema, unchanged)
 */
export class NavigationPipeline {
  static async run(outputGlbPath: string, jobDirectory: string): Promise<void> {
    if (!fs.existsSync(outputGlbPath)) {
      throw new Error(`NavigationPipeline: output.glb not found at ${outputGlbPath}`);
    }

    console.log(`[NavigationPipeline] Extracting geometry from ${outputGlbPath}`);
    const soup = await GeometryExtractor.extract(outputGlbPath);

    if (soup.indices.length === 0) {
      console.warn(
        "[NavigationPipeline] No triangle geometry found in output.glb - writing empty navigation.json"
      );
      NavigationExporter.write([], jobDirectory);
      return;
    }

    console.log(
      `[NavigationPipeline] Generating NavMesh from ${soup.indices.length / 3} triangles`
    );
    const navMeshResult = await NavMeshGenerator.generate(soup);

    if (!navMeshResult.success || !navMeshResult.navMesh || !navMeshResult.surface) {
      console.warn(
        `[NavigationPipeline] NavMesh generation failed - ${navMeshResult.error}. Writing empty navigation.json`
      );
      NavigationExporter.write([], jobDirectory);
      return;
    }

    console.log("[NavigationPipeline] Building viewpoint graph from NavMesh");
    const nodes: NavNode[] = await GraphBuilder.build(
      navMeshResult.navMesh,
      navMeshResult.surface
    );

    const stats = GraphValidator.validate(nodes);
    GraphValidator.logSummary(stats);

    NavigationExporter.write(nodes, jobDirectory);

    navMeshResult.navMesh.destroy?.();
  }
}
