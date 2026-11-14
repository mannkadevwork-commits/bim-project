/** Pure geometry helpers for Home Tour (no Recast dependency). Y-up, X/Z horizontal. */

export function finitePoint(value) {
  let p = null;
  if (Array.isArray(value) && value.length >= 3) p = { x: Number(value[0]), y: Number(value[1]), z: Number(value[2]) };
  else if (value && typeof value === 'object') p = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? p : null;
}

export const toArray = (p) => [p.x, p.y, p.z];
export const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const distance3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distance3(points[i - 1], points[i]);
  return total;
}

/** Drop consecutive points closer than `epsilon` (scene units). Always keeps first and last. */
export function dedupeConsecutive(points, epsilon) {
  if (!points.length) return [];
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    if (distance3(out[out.length - 1], points[i]) > epsilon) out.push(points[i]);
  }
  if (points.length > 1) {
    const last = points[points.length - 1];
    if (distance3(out[out.length - 1], last) > epsilon) out.push(last);
    else out[out.length - 1] = last;
  }
  return out;
}

/** Resample a polyline at roughly `step` spacing, always including every vertex. */
export function samplePolyline(points, step) {
  const samples = [];
  if (!points.length) return samples;
  samples.push(points[0]);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const len = distance3(a, b);
    const n = Math.max(1, Math.ceil(len / Math.max(step, 1e-6)));
    for (let k = 1; k <= n; k += 1) {
      const t = k / n;
      samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return samples;
}

// --- point/triangle distance (Ericson, Real-Time Collision Detection 5.1.5) ---
export function pointTriangleDistanceSq(p, a, b, c) {
  const ab = sub(b, a); const ac = sub(c, a); const ap = sub(p, a);
  const d1 = dot(ab, ap); const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
  const bp = sub(p, b); const d3 = dot(ab, bp); const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return lenSq(sub(ap, scale(ab, v))); }
  const cp = sub(p, c); const d5 = dot(ab, cp); const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return lenSq(sub(ap, scale(ac, w))); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return lenSq(sub(bp, scale(sub(c, b), w)));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom; const w = vc * denom;
  return lenSq(sub(ap, add(scale(ab, v), scale(ac, w))));
}
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const lenSq = (a) => dot(a, a);

/**
 * Uniform XZ grid over a triangle soup. Answers "is any triangle within `radius`
 * of this point" without a BVH dependency. Triangles are in SCENE units.
 */
export class CollisionIndex {
  constructor(positions, indices, { cellSize = 1 } = {}) {
    this.positions = positions;
    this.cell = Math.max(cellSize, 1e-3);
    this.cells = new Map();
    this.triangleCount = Math.floor(indices.length / 3);
    this.tris = new Float64Array(this.triangleCount * 9);
    for (let t = 0; t < this.triangleCount; t += 1) {
      for (let k = 0; k < 3; k += 1) {
        const vi = indices[t * 3 + k] * 3;
        this.tris[t * 9 + k * 3] = positions[vi];
        this.tris[t * 9 + k * 3 + 1] = positions[vi + 1];
        this.tris[t * 9 + k * 3 + 2] = positions[vi + 2];
      }
      const o = t * 9;
      const minX = Math.min(this.tris[o], this.tris[o + 3], this.tris[o + 6]);
      const maxX = Math.max(this.tris[o], this.tris[o + 3], this.tris[o + 6]);
      const minZ = Math.min(this.tris[o + 2], this.tris[o + 5], this.tris[o + 8]);
      const maxZ = Math.max(this.tris[o + 2], this.tris[o + 5], this.tris[o + 8]);
      for (let ix = Math.floor(minX / this.cell); ix <= Math.floor(maxX / this.cell); ix += 1) {
        for (let iz = Math.floor(minZ / this.cell); iz <= Math.floor(maxZ / this.cell); iz += 1) {
          const key = `${ix},${iz}`;
          let list = this.cells.get(key);
          if (!list) { list = []; this.cells.set(key, list); }
          list.push(t);
        }
      }
    }
  }

  /** Smallest distance from `p` to any triangle within `radius`, or null if none. */
  nearestWithin(p, radius) {
    const r2 = radius * radius;
    let best = null;
    const x0 = Math.floor((p.x - radius) / this.cell); const x1 = Math.floor((p.x + radius) / this.cell);
    const z0 = Math.floor((p.z - radius) / this.cell); const z1 = Math.floor((p.z + radius) / this.cell);
    const seen = new Set();
    for (let ix = x0; ix <= x1; ix += 1) {
      for (let iz = z0; iz <= z1; iz += 1) {
        const list = this.cells.get(`${ix},${iz}`);
        if (!list) continue;
        for (const t of list) {
          if (seen.has(t)) continue;
          seen.add(t);
          const o = t * 9;
          const d2 = pointTriangleDistanceSq(p,
            { x: this.tris[o], y: this.tris[o + 1], z: this.tris[o + 2] },
            { x: this.tris[o + 3], y: this.tris[o + 4], z: this.tris[o + 5] },
            { x: this.tris[o + 6], y: this.tris[o + 7], z: this.tris[o + 8] });
          if (d2 <= r2 && (best === null || d2 < best)) best = d2;
        }
      }
    }
    return best === null ? null : Math.sqrt(best);
  }
}
