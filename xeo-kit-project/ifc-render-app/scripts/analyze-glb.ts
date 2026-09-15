import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import * as fs from "node:fs";

function analyze(document: any) {
  let triangles = 0;
  let vertices = 0;
  let primitives = 0;

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitives += 1;
      const indices = primitive.getIndices();
      if (indices?.getCount()) triangles += Math.floor(indices.getCount() / 3);
      const position = primitive.getAttribute("POSITION");
      if (position?.getCount()) vertices += position.getCount();
    }
  }

  return {
    bytes: 0,
    meshes: document.getRoot().listMeshes().length,
    primitives,
    triangles,
    vertices,
    materials: document.getRoot().listMaterials().length,
    textures: document.getRoot().listTextures().length,
  };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    throw new Error("Usage: npx tsx scripts/analyze-glb.ts <file.glb> [file2.glb ...]");
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const rows = [];

  for (const file of files) {
    const document = await io.read(file);
    const stats = analyze(document);
    stats.bytes = fs.statSync(file).size;
    rows.push({ file, ...stats });
  }

  console.table(rows.map((row) => ({
    file: row.file,
    MB: (row.bytes / 1024 / 1024).toFixed(2),
    meshes: row.meshes,
    primitives: row.primitives,
    triangles: row.triangles,
    vertices: row.vertices,
    materials: row.materials,
    textures: row.textures,
  })));
}

main().catch((error) => {
  console.error("[glb-analyze] failed", error);
  process.exitCode = 1;
});
