/**
 * Deterministic open-path TSP: start node 0, visit every zone exactly once.
 * Exact Held-Karp for small N (six zones => trivial). Ties break by lexicographic
 * zone id so the same inputs ALWAYS give the same order.
 *
 * @param {number[][]} startToZone  distance start -> zone i
 * @param {number[][]} zoneToZone   distance zone i -> zone j (Infinity when unreachable)
 * @param {string[]}   ids          zone ids, same index space (already sorted)
 */
export function optimizeVisitOrder({ startToZone, zoneToZone, ids, maxExact = 12 }) {
  const n = ids.length;
  if (n === 0) return { order: [], total: 0, method: 'empty' };
  if (n > maxExact) return nearestNeighbourWithTwoOpt({ startToZone, zoneToZone, ids });

  const FULL = (1 << n) - 1;
  const dp = Array.from({ length: 1 << n }, () => new Array(n).fill(Infinity));
  const parent = Array.from({ length: 1 << n }, () => new Array(n).fill(-1));
  for (let i = 0; i < n; i += 1) dp[1 << i][i] = startToZone[i];
  for (let mask = 1; mask <= FULL; mask += 1) {
    for (let last = 0; last < n; last += 1) {
      const cur = dp[mask][last];
      if (!Number.isFinite(cur) || !(mask & (1 << last))) continue;
      for (let next = 0; next < n; next += 1) {
        if (mask & (1 << next)) continue;
        const cost = cur + zoneToZone[last][next];
        const nm = mask | (1 << next);
        const better = cost < dp[nm][next] - 1e-9
          || (Math.abs(cost - dp[nm][next]) <= 1e-9 && parent[nm][next] !== -1 && ids[last] < ids[parent[nm][next]]);
        if (better) { dp[nm][next] = cost; parent[nm][next] = last; }
      }
    }
  }
  let bestLast = -1; let best = Infinity;
  for (let i = 0; i < n; i += 1) {
    if (dp[FULL][i] < best - 1e-9 || (Math.abs(dp[FULL][i] - best) <= 1e-9 && bestLast !== -1 && ids[i] < ids[bestLast])) { best = dp[FULL][i]; bestLast = i; }
  }
  if (!Number.isFinite(best)) return { order: null, total: Infinity, method: 'held-karp' };
  const order = []; let mask = FULL; let cur = bestLast;
  while (cur !== -1) { order.push(cur); const p = parent[mask][cur]; mask &= ~(1 << cur); cur = p; }
  order.reverse();
  return { order, total: best, method: 'held-karp' };
}

function nearestNeighbourWithTwoOpt({ startToZone, zoneToZone, ids }) {
  const n = ids.length; const left = new Set(ids.map((_, i) => i)); const order = [];
  let cur = -1;
  while (left.size) {
    let pick = -1; let bd = Infinity;
    for (const i of [...left].sort((a, b) => ids[a].localeCompare(ids[b]))) {
      const d = cur === -1 ? startToZone[i] : zoneToZone[cur][i];
      if (d < bd) { bd = d; pick = i; }
    }
    if (pick === -1) return { order: null, total: Infinity, method: 'nn-2opt' };
    order.push(pick); left.delete(pick); cur = pick;
  }
  const cost = (o) => o.reduce((s, z, k) => s + (k === 0 ? startToZone[z] : zoneToZone[o[k - 1]][z]), 0);
  let improved = true; let total = cost(order);
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i += 1) for (let j = i + 1; j < n; j += 1) {
      const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
      const c = cost(cand);
      if (c < total - 1e-9) { order.splice(0, n, ...cand); total = c; improved = true; }
    }
  }
  return { order, total, method: 'nn-2opt' };
}
