import { GraphStats, NavNode } from "./types";

/**
 * Analyzes a navigation graph for the failure modes that made the old
 * pipeline unreliable: isolated nodes, dead ends, and multiple disconnected
 * components (users trapped in a room with no way out). This never mutates
 * or drops nodes - it only reports, so NavigationExporter and callers can
 * decide what to do with the numbers (e.g. fail the job, or ship a
 * navigation.json with a logged warning).
 */
export class GraphValidator {
  static validate(nodes: NavNode[]): GraphStats {
    const nodesById = new Map(nodes.map((n) => [n.id, n]));

    const isolatedNodeIds = nodes
      .filter((n) => n.links.length === 0)
      .map((n) => n.id);

    const deadEndNodeIds = nodes
      .filter((n) => n.links.length === 1)
      .map((n) => n.id);

    const components = computeConnectedComponents(nodes, nodesById);
    const largestComponentSize = components.reduce(
      (max, component) => Math.max(max, component.length),
      0
    );

    const linkCount =
      nodes.reduce((sum, n) => sum + n.links.length, 0) / 2;

    return {
      nodeCount: nodes.length,
      linkCount,
      componentCount: components.length,
      largestComponentSize,
      isolatedNodeIds,
      deadEndNodeIds,
    };
  }

  /** Logs a human-readable summary of GraphStats to the console. */
  static logSummary(stats: GraphStats): void {
    console.log(
      `[NavigationPipeline] Graph: ${stats.nodeCount} nodes, ${stats.linkCount} links, ` +
        `${stats.componentCount} connected component(s), largest = ${stats.largestComponentSize} node(s).`
    );

    if (stats.componentCount > 1) {
      console.warn(
        `[NavigationPipeline] Graph is NOT fully connected - ${stats.componentCount} ` +
          `separate components found. Users can become trapped depending on their entry point.`
      );
    }

    if (stats.isolatedNodeIds.length > 0) {
      console.warn(
        `[NavigationPipeline] ${stats.isolatedNodeIds.length} isolated node(s) with no links: ` +
          stats.isolatedNodeIds.join(", ")
      );
    }

    if (stats.deadEndNodeIds.length > 0) {
      console.log(
        `[NavigationPipeline] ${stats.deadEndNodeIds.length} dead-end node(s) (exactly 1 link): ` +
          stats.deadEndNodeIds.join(", ")
      );
    }
  }
}

function computeConnectedComponents(
  nodes: NavNode[],
  nodesById: Map<string, NavNode>
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const node of nodes) {
    if (visited.has(node.id)) continue;

    const component: string[] = [];
    const stack = [node.id];
    visited.add(node.id);

    while (stack.length > 0) {
      const currentId = stack.pop()!;
      component.push(currentId);

      const current = nodesById.get(currentId);
      if (!current) continue;

      for (const linkId of current.links) {
        if (!visited.has(linkId)) {
          visited.add(linkId);
          stack.push(linkId);
        }
      }
    }

    components.push(component);
  }

  return components;
}
