// Synthetic 12m x 8m apartment: six zones in a 3x2 grid, interior walls with door gaps,
// real Recast NavMesh. Mirrors the failure modes of the supplied job (zero-clearance
// room centre, single oversized "room", zero portals).
import * as R from 'recast-navigation';
import { generateSoloNavMesh } from '@recast-navigation/generators';
import { createRecastNavAdapter } from '../HomeTourNav.mjs';
import { CollisionIndex } from '../HomeTourGeometry.mjs';

export const W = 12; export const D = 8; export const WALL = 0.5;
// vertical walls x=4 and x=8 (vertical-wall door gaps 1.4 m wide at z 0.5-1.9 and 6.1-7.5 (offset so legs must bend)); horizontal wall z=4 (gaps centred at x=2,6,10)
const vWalls = [4, 8].flatMap((x) => [[x, 0, 0.5], [x, 1.9, 6.1], [x, 7.5, D]]);
const hWalls = [[0, 1.3], [2.7, 5.3], [6.7, 9.3], [10.7, W]].map(([a, b]) => [a, b, 4]);

export function wallBoxes() {
  const boxes = [];
  for (const [x, z0, z1] of vWalls) boxes.push({ x0: x - WALL / 2, x1: x + WALL / 2, z0, z1 });
  for (const [x0, x1, z] of hWalls) boxes.push({ x0, x1, z0: z - WALL / 2, z1: z + WALL / 2 });
  return boxes;
}
const inWall = (x, z) => wallBoxes().some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1);

function floorMesh(step = 0.1, island = false) {
  const pos = []; const idx = [];
  if (island) { const b = 0; pos.push(14, 0, 0, 17, 0, 0, 17, 0, 3, 14, 0, 3); idx.push(b, b + 2, b + 1, b, b + 3, b + 2); }
  for (let xi = 0; xi < W / step; xi += 1) for (let zi = 0; zi < D / step; zi += 1) {
    const x0 = xi * step; const z0 = zi * step; const x1 = x0 + step; const z1 = z0 + step;
    if (inWall((x0 + x1) / 2, (z0 + z1) / 2)) continue;
    const b = pos.length / 3;
    pos.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1); idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Collision soup of the vertical walls (real 3D boxes, 2.6 m high). */
export function wallCollision() {
  const pos = []; const idx = [];
  for (const b of wallBoxes()) {
    const base = pos.length / 3; const h = 2.6;
    const v = [[b.x0, 0, b.z0], [b.x1, 0, b.z0], [b.x1, 0, b.z1], [b.x0, 0, b.z1], [b.x0, h, b.z0], [b.x1, h, b.z0], [b.x1, h, b.z1], [b.x0, h, b.z1]];
    for (const p of v) pos.push(...p);
    for (const f of [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]]) idx.push(base + f[0], base + f[1], base + f[2]);
  }
  return new CollisionIndex(Float64Array.from(pos), Uint32Array.from(idx), { cellSize: 1 });
}

export async function buildFixture({ metersPerUnit = 1, island = false } = {}) {
  await R.init();
  const { positions, indices } = floorMesh(0.1, island);
  const { success, navMesh } = generateSoloNavMesh(positions, indices, {
    cellSize: 0.1, cellHeight: 0.1, walkableRadius: 2, walkableClimb: 3, walkableHeight: 18, walkableSlopeAngle: 45,
  });
  if (!success) throw new Error('fixture navmesh failed');
  const query = new R.NavMeshQuery(navMesh); const filter = new R.QueryFilter();
  const nav = createRecastNavAdapter({ query, filter, metersPerUnit });
  return { navMesh, query, filter, nav, exportBytes: () => R.exportNavMesh(navMesh), destroy() { query.destroy(); navMesh.destroy(); } };
}

// zone cells: A B C (z 0-4) / D E F (z 4-8)
export const areas = [
  { id: 'zone-a', label: 'Navigation Area 1', center: [2, 0, 2] },
  { id: 'zone-b', label: 'Navigation Area 2', center: [6, 0, 2] },
  { id: 'zone-c', label: 'Navigation Area 3', center: [10, 0, 2] },
  { id: 'zone-d', label: 'Navigation Area 4', center: [2, 0, 6] },
  { id: 'zone-e', label: 'Navigation Area 5', center: [6, 0, 6] },
  { id: 'zone-f', label: 'Navigation Area 6', center: [10, 0, 6] },
];
export const hotspots = [
  { id: 'a-view', areaId: 'zone-a', role: 'viewpoint', position: [2.3, 0, 2.2] },
  { id: 'e-view', areaId: 'zone-e', role: 'viewpoint', position: [6.3, 0, 6.3] },
  { id: 'b-door', areaId: 'zone-b', role: 'room-entrance', position: [4.2, 0, 2.0] },
];
export const origin = [1, 0, 1];
