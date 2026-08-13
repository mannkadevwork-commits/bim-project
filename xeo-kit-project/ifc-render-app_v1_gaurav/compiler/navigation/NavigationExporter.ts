import * as fs from "fs";
import * as path from "path";

import { NavNode } from "./types";

/**
 * Writes navigation.json in the exact schema 360_viewer.html already
 * consumes: a flat JSON array of { id, position, lookAt, links }.
 */
export class NavigationExporter {
  static write(nodes: NavNode[], jobDirectory: string): string {
    const navigationJsonPath = path.join(jobDirectory, "navigation.json");
    fs.writeFileSync(navigationJsonPath, JSON.stringify(nodes, null, 2));
    console.log(
      `[NavigationPipeline] Wrote ${navigationJsonPath} (${nodes.length} viewpoints)`
    );
    return navigationJsonPath;
  }
}
