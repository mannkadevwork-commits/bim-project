import { NavMesh } from "recast-navigation";

import { NavNode } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * ----------------------------------------------------------------------
 * A note on the low-level NavMesh API used here
 * ----------------------------------------------------------------------
 * recast-navigation-js (v0.43.1) exposes the underlying Detour
 * dtNavMesh/dtMeshTile/dtPoly structures via embind, but the shape is
 * mixed: some things are accessor *methods* (`poly.vertCount()`,
 * `poly.verts(i)`, `tile.header()`, `tile.verts(i)`, `tile.polys(i)`,
 * `navMesh.getMaxTiles()`, `navMesh.getTile(i)`), while the result of
 * `navMesh.getTileAndPolyByRef(ref)` is a plain object whose `tile` and
 * `poly` fields are already-resolved *properties*
 * (`{ success, status, tile: DetourMeshTile, poly: DetourPoly }`), not
 * functions. Calling `lookup.poly()` throws, since `lookup.poly` is a
 * `DetourPoly` instance, not a callable.
 *
 * `DetourMeshTile.polys(index)` reads a poly directly off a tile with no
 * ref lookup involved at all, so that's what's used below to enumerate
 * polygons - it sidesteps the property-vs-method mismatch entirely rather
 * than patching around it.
 *
 * For *adjacency*, the lowest-level path would be walking each poly's
 * dtLink list (poly->firstLink through tile->links[k].next), but that part
 * of the binding surface isn't reliably documented/typed across package
 * versions, so guessing exact accessor names there would be worse than
 * useless if wrong.
 *
 * Instead we derive adjacency from the same information Detour itself
 * uses to *build* that link list in the first place: two polygons are
 * neighbours exactly when they share an edge, i.e. the same pair of
 * vertex indices in reverse order. `generateSoloNavMesh` (used by
 * NavMeshGenerator) always produces a single-tile NavMesh, so every
 * polygon's `verts(i)` indices reference the same tile's vertex pool -
 * no cross-tile position matching is needed, and comparing vertex indices
 * directly is exact, not approximate. This is topology read from the
 * NavMesh's own polygon data, not a geometric or pathfinding reconstruction.
 *
 * If this pipeline ever moves to `generateTiledNavMesh`, this file needs
 * revisiting: vertex ids are only unique within a tile, so cross-tile
 * edges would need position-based matching (or the real dtLink walk).
 * ----------------------------------------------------------------------
 */

const EYE_HEIGHT = 1.6;

interface PolyRecord {
  vertexIds: number[];
  centroid: [number, number, number];
}

/**
 * Builds the navigation graph by enumerating every polygon in the NavMesh,
 * placing one viewpoint per polygon centroid, and linking viewpoints
 * wherever their source polygons share an edge. No grid sampling, no
 * nearest-poly snapping, no pairwise pathfinding - the NavMesh already
 * knows its own topology, so we just read it.
 */
export class GraphBuilder {
  static build(navMesh: NavMesh | any): NavNode[] {
    const polys = enumeratePolygons(navMesh);
    const adjacency = computeAdjacencyFromSharedEdges(polys);

    const ids = polys.map((_, index) => nodeId(index));
    const positions: [number, number, number][] = polys.map((poly) => {
      const [cx, cy, cz] = poly.centroid;
      return [cx, cy + EYE_HEIGHT, cz];
    });

    return polys.map((_, index) => {
      const neighborIndices = adjacency.get(index) ?? [];
      const position = positions[index];

      return {
        id: ids[index],
        position,
        lookAt: computeLookAt(position, neighborIndices, positions),
        links: neighborIndices.map((n) => ids[n]),
      };
    });
  }
}

function nodeId(index: number): string {
  return `poly-${index}`;
}

function computeLookAt(
  position: [number, number, number],
  neighborIndices: number[],
  positions: [number, number, number][]
): [number, number, number] {
  if (neighborIndices.length === 0) {
    return [position[0], position[1], position[2] + 1];
  }

  let sx = 0;
  let sy = 0;
  let sz = 0;

  neighborIndices.forEach((n) => {
    const [nx, ny, nz] = positions[n];
    sx += nx;
    sy += ny;
    sz += nz;
  });

  const count = neighborIndices.length;
  return [sx / count, sy / count, sz / count];
}

function enumeratePolygons(navMesh: any): PolyRecord[] {
  const records: PolyRecord[] = [];
  const maxTiles: number = navMesh.getMaxTiles();

  for (let t = 0; t < maxTiles; t++) {
    const tile = navMesh.getTile(t);
    if (!tile) continue;

    const header = tile.header?.();
    if (!header) continue;

    const polyCount: number = header.polyCount();
    if (polyCount <= 0) continue;

    for (let p = 0; p < polyCount; p++) {
      const poly = tile.polys(p);
      if (!poly) continue;

      if (typeof poly.getType === "function" && poly.getType() !== 0) {
        continue;
      }

      const vertCount: number = poly.vertCount();
      if (vertCount < 3) continue;

      const vertexIds: number[] = [];
      let cx = 0;
      let cy = 0;
      let cz = 0;

      for (let v = 0; v < vertCount; v++) {
        const vertexId: number = poly.verts(v);
        vertexIds.push(vertexId);

        const base3 = vertexId * 3;
        cx += tile.verts(base3);
        cy += tile.verts(base3 + 1);
        cz += tile.verts(base3 + 2);
      }

      records.push({
        vertexIds,
        centroid: [cx / vertCount, cy / vertCount, cz / vertCount],
      });
    }
  }

  return records;
}

/**
 * Two polygons are adjacent iff they share an edge - the same pair of
 * vertex ids, regardless of winding direction. This is the exact relation
 * Recast's own intra-tile link building uses (see dtNavMesh::connectIntLinks
 * in the upstream C++ library), just read from polygon vertex loops instead
 * of walking the compiled dtLink list.
 */
function computeAdjacencyFromSharedEdges(
  polys: PolyRecord[]
): Map<number, number[]> {
  const edgeToPolyIndices = new Map<string, number[]>();

  polys.forEach((poly, polyIndex) => {
    const n = poly.vertexIds.length;
    for (let i = 0; i < n; i++) {
      const a = poly.vertexIds[i];
      const b = poly.vertexIds[(i + 1) % n];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;

      let bucket = edgeToPolyIndices.get(key);
      if (!bucket) {
        bucket = [];
        edgeToPolyIndices.set(key, bucket);
      }
      bucket.push(polyIndex);
    }
  });

  const adjacency = new Map<number, Set<number>>();
  polys.forEach((_, i) => adjacency.set(i, new Set()));

  edgeToPolyIndices.forEach((polyIndices) => {
    for (let i = 0; i < polyIndices.length; i++) {
      for (let j = i + 1; j < polyIndices.length; j++) {
        adjacency.get(polyIndices[i])!.add(polyIndices[j]);
        adjacency.get(polyIndices[j])!.add(polyIndices[i]);
      }
    }
  });

  const result = new Map<number, number[]>();
  adjacency.forEach((set, i) => result.set(i, Array.from(set)));
  return result;
}
