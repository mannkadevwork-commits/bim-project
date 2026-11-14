import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGlbCollision } from '../HomeTourCollisionLoader.mjs';

let core = null;
try { core = await import('@gltf-transform/core'); } catch { /* optional */ }

test('GLB collision: wall mesh loads in world space, door-named nodes are ignored', { skip: !core && '@gltf-transform/core not installed' }, async () => {
  const doc = new core.Document(); const buf = doc.createBuffer();
  const mk = (name, x) => {
    const pos = doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]));
    const idx = doc.createAccessor().setType('SCALAR').setBuffer(buf).setArray(new Uint16Array([0, 1, 2]));
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx);
    return doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)).setTranslation([x, 0, 0]);
  };
  const scene = doc.createScene(); scene.addChild(mk('Wall_01', 10)); scene.addChild(mk('Door_Leaf', 20));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glb-')), 'output.glb');
  await new core.NodeIO().write(file, doc);
  const r = await loadGlbCollision(file);
  assert.ok(r.index, r.reason); assert.equal(r.stats.skippedDoorNodes, 1); assert.equal(r.stats.triangleCount, 1);
  assert.ok(r.index.nearestWithin({ x: 10.2, y: 0.5, z: 0 }, 0.5) !== null, 'wall at translated x=10 is hit');
  assert.equal(r.index.nearestWithin({ x: 20.2, y: 0.5, z: 0 }, 0.5), null, 'door leaf ignored');
});

test('GLB collision: unreadable file reports a reason instead of faking a check', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glb-')), 'bad.glb'); fs.writeFileSync(file, 'nope');
  const r = await loadGlbCollision(file); assert.equal(r.index, null); assert.match(r.reason, /GLB_DECODE_FAILED|GLTF_TOOLING_UNAVAILABLE/);
});
