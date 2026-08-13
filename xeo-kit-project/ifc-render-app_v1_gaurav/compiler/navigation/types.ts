export interface NavNode {
  id: string;
  position: [number, number, number];
  lookAt: [number, number, number];
  links: string[];
}

export interface TriangleSoup {
  positions: Float32Array;
  indices: Uint32Array;
}

export type TriangleLabel = "structural" | "furniture" | "injected_floor";

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