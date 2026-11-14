import { CollisionIndex } from './HomeTourGeometry.mjs';

/**
 * Load world-space collision triangles from output.glb using @gltf-transform
 * (already a compiler dependency). Door-named nodes are skipped because doors are
 * hidden/opened during Home Tour. If the GLB cannot be decoded the caller gets
 * { index:null, reason } and the planner reports collisionChecked:false instead of
 * pretending the route was collision-tested.
 */
export async function loadGlbCollision(glbPath, { ignoredNodePattern = '(^|[^a-z])door([^a-z]|$)', cellSize = 1 } = {}) {
  let core; let ext;
  try {
    core = await import('@gltf-transform/core');
    ext = await import('@gltf-transform/extensions').catch(() => null);
  } catch (error) {
    return { index: null, reason: `GLTF_TOOLING_UNAVAILABLE: ${error.message}` };
  }
  try {
    const io = new core.NodeIO();
    if (ext?.ALL_EXTENSIONS) io.registerExtensions(ext.ALL_EXTENSIONS);
    const doc = await io.read(glbPath);
    const ignored = new RegExp(ignoredNodePattern, 'i');
    const positions = []; const indices = [];
    let skippedNodes = 0; let meshNodes = 0;
    for (const node of doc.getRoot().listNodes()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      if (hasIgnoredName(node, ignored)) { skippedNodes += 1; continue; }
      meshNodes += 1;
      const m = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue; // triangles only
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const base = positions.length / 3;
        const v = [0, 0, 0];
        for (let i = 0; i < pos.getCount(); i += 1) {
          pos.getElement(i, v);
          positions.push(
            m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
            m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
          );
        }
        const idx = prim.getIndices();
        if (idx) { const a = idx.getArray(); for (let i = 0; i < a.length; i += 1) indices.push(base + a[i]); }
        else for (let i = 0; i < pos.getCount(); i += 1) indices.push(base + i);
      }
    }
    if (!indices.length) return { index: null, reason: 'GLB_HAS_NO_TRIANGLES' };
    return {
      index: new CollisionIndex(Float64Array.from(positions), Uint32Array.from(indices), { cellSize }),
      stats: { triangleCount: indices.length / 3, meshNodes, skippedDoorNodes: skippedNodes },
    };
  } catch (error) {
    return { index: null, reason: `GLB_DECODE_FAILED: ${error.message}` };
  }
}

function hasIgnoredName(node, pattern) {
  for (let n = node; n; n = n.getParentNode?.() ?? null) {
    if (pattern.test(String(n.getName() || ''))) return true;
  }
  return false;
}
