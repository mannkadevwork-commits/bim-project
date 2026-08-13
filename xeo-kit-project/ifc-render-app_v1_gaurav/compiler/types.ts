/**
 * A single viewpoint in navigation.json. This shape is the existing,
 * frozen schema that 360_viewer.html already knows how to render -
 * do not change field names/types without updating the viewer.
 */
export interface NavNode {
  id: string;
  position: [number, number, number];
  lookAt: [number, number, number];
  links: string[];
}

/** World-space triangle soup, ready to hand to a navmesh generator. */
export interface TriangleSoup {
  /** Flat [x0, y0, z0, x1, y1, z1, ...] world-space vertex positions. */
  positions: Float32Array;
  /** Triangle list indices into `positions` (grouped by 3). */
  indices: Uint32Array;
}

/** Flat triangulated surface of a generated NavMesh (for graph building). */
export interface NavMeshSurface {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface GraphStats {
  nodeCount: number;
  linkCount: number;
  componentCount: number;
  largestComponentSize: number;
  isolatedNodeIds: string[];
  deadEndNodeIds: string[];
}
