import * as fs from "fs";
import * as path from "path";
import { IfcAPI } from "web-ifc";
import { Document, NodeIO, Node as GltfNode, Primitive } from "@gltf-transform/core";
import * as THREE from "three";

import { extractGeometry } from "./geometry";
import { computeAssetPivotOffset, eulerToQuaternion } from "./math";
import { fileURLToPath, pathToFileURL } from "url";

enum AssetType {
  STRUCTURAL_REPLACEMENT = "structural_replacement",
  FURNITURE = "furniture",
}

interface AssetTypeBehavior {
  preservePlacement: boolean;
  applyMaterialOverrides: boolean;
}

const ASSET_TYPE_BEHAVIOR: Record<AssetType, AssetTypeBehavior> = {
  [AssetType.STRUCTURAL_REPLACEMENT]: {
    preservePlacement: true,
    applyMaterialOverrides: true,
  },
  [AssetType.FURNITURE]: {
    preservePlacement: false,
    applyMaterialOverrides: false,
  },
};

interface FurnitureItem {
  id: string;
  instanceId: string;
  name: string;
  src: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  type?: AssetType;
  assetFormat?: 'glb' | 'ifc';
}

interface StructuralEditEntry {
  visible?: boolean;
  scale?: [number, number, number];
  offset?: [number, number, number];
}

interface MaterialEntry {
  color: string;
  rgb: [number, number, number];
}

interface ProjectState {
  structural_edits: Record<string, StructuralEditEntry>;
  materials: Record<string, MaterialEntry>;
  furniture: FurnitureItem[];
}

export interface CompileSceneOptions {
  jobDirectory: string;
  assetsDirectory: string;
}

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEG_TO_RAD = Math.PI / 180;

function readFileAsUint8Array(filePath: string): Uint8Array {
  const raw = fs.readFileSync(filePath);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function degTupleToRadTuple(
  euler: [number, number, number]
): [number, number, number] {
  return [euler[0] * DEG_TO_RAD, euler[1] * DEG_TO_RAD, euler[2] * DEG_TO_RAD];
}

function classifyAsset(
  item: FurnitureItem,
  structuralEdits: Record<string, StructuralEditEntry>
): AssetType {
  if (
    item.type === AssetType.STRUCTURAL_REPLACEMENT ||
    item.type === AssetType.FURNITURE
  ) {
    return item.type;
  }

  if (Object.prototype.hasOwnProperty.call(structuralEdits, item.id)) {
    return AssetType.STRUCTURAL_REPLACEMENT;
  }

  return AssetType.FURNITURE;
}

function getIfcLineValue(line: any, key: string, fallback = ""): string {
  const v = line?.[key];
  if (v && typeof v === "object" && "value" in v) return String(v.value);
  if (typeof v === "string") return v;
  return fallback;
}

const NAV_GRID_SPACING = 0.8;
const NAV_EYE_HEIGHT = 1.6;
const NAV_FLOOR_DIST_MAX = 2.0;
const NAV_FLOOR_DIST_MIN = 1.0;
const NAV_WALL_CLEARANCE = 0.4;
const NAV_LINK_RADIUS = 1.5;
const NAV_DOORWAY_SEARCH_RADIUS = 2.5;
const NAV_HORIZONTAL_RAY_COUNT = 8;
const NAV_LOS_EPSILON = 0.05;

interface NavNode {
  id: string;
  position: [number, number, number];
  links: Set<string>;
}

function extractTriangleSoup(doc: Document): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  function visit(node: GltfNode, parentMatrix: THREE.Matrix4) {
    const localMatrix = new THREE.Matrix4().fromArray(node.getMatrix());
    const worldMatrix = parentMatrix.clone().multiply(localMatrix);

    const mesh = node.getMesh();
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        if (primitive.getMode() !== Primitive.Mode.TRIANGLES) continue;

        const positionAccessor = primitive.getAttribute("POSITION");
        if (!positionAccessor) continue;

        const posArray = positionAccessor.getArray();
        if (!posArray) continue;

        const vertexCount = positionAccessor.getCount();
        const tempVec = new THREE.Vector3();

        for (let i = 0; i < vertexCount; i++) {
          tempVec.set(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]);
          tempVec.applyMatrix4(worldMatrix);
          positions.push(tempVec.x, tempVec.y, tempVec.z);
        }

        const indexAccessor = primitive.getIndices();
        if (indexAccessor) {
          const idxArray = indexAccessor.getArray();
          if (idxArray) {
            for (let i = 0; i < idxArray.length; i++) {
              indices.push(vertexOffset + idxArray[i]);
            }
          }
        } else {
          for (let i = 0; i < vertexCount; i++) {
            indices.push(vertexOffset + i);
          }
        }

        vertexOffset += vertexCount;
      }
    }

    for (const child of node.listChildren()) {
      visit(child, worldMatrix);
    }
  }

  for (const scene of doc.getRoot().listScenes()) {
    for (const child of scene.listChildren()) {
      visit(child, new THREE.Matrix4());
    }
  }

  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
  };
}

function buildCollisionMesh(doc: Document): THREE.Mesh {
  const { positions, indices } = extractTriangleSoup(doc);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();

  return new THREE.Mesh(geometry);
}

function findConnectedComponents(nodes: NavNode[]): Map<string, number> {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const componentOf = new Map<string, number>();
  let nextComponentId = 0;

  for (const node of nodes) {
    if (componentOf.has(node.id)) continue;

    const queue: string[] = [node.id];
    componentOf.set(node.id, nextComponentId);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = nodeById.get(currentId)!;
      for (const neighborId of current.links) {
        if (!componentOf.has(neighborId)) {
          componentOf.set(neighborId, nextComponentId);
          queue.push(neighborId);
        }
      }
    }

    nextComponentId++;
  }

  return componentOf;
}

async function generateDenseNavigationGraph(
  doc: Document,
  jobDirectory: string
): Promise<void> {
  const outputPath = path.join(jobDirectory, "navigation.json");
  const mesh = buildCollisionMesh(doc);
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const bbox = geometry.boundingBox;

  if (!bbox || !geometry.getAttribute("position") || geometry.getAttribute("position").count === 0) {
    console.warn("[navigation] No collidable geometry found, writing empty navigation.json");
    fs.writeFileSync(outputPath, "[]");
    return;
  }

  const raycaster = new THREE.Raycaster();
  const downDirection = new THREE.Vector3(0, -1, 0);
  const survivors: NavNode[] = [];
  let nodeCounter = 1;

  for (let x = bbox.min.x; x <= bbox.max.x; x += NAV_GRID_SPACING) {
    for (let z = bbox.min.z; z <= bbox.max.z; z += NAV_GRID_SPACING) {
      const candidate = new THREE.Vector3(x, NAV_EYE_HEIGHT, z);

      raycaster.set(candidate, downDirection);
      raycaster.far = Infinity;
      const floorHits = raycaster.intersectObject(mesh);
      if (floorHits.length === 0) continue;

      const floorDistance = floorHits[0].distance;
      if (floorDistance > NAV_FLOOR_DIST_MAX || floorDistance < NAV_FLOOR_DIST_MIN) continue;

      let blockedByWall = false;
      for (let i = 0; i < NAV_HORIZONTAL_RAY_COUNT; i++) {
        const angle = (i / NAV_HORIZONTAL_RAY_COUNT) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
        raycaster.set(candidate, dir);
        raycaster.far = NAV_WALL_CLEARANCE;
        const wallHits = raycaster.intersectObject(mesh);
        if (wallHits.length > 0) {
          blockedByWall = true;
          break;
        }
      }
      if (blockedByWall) continue;

      survivors.push({
        id: `vp_${nodeCounter++}`,
        position: [candidate.x, NAV_EYE_HEIGHT, candidate.z],
        links: new Set<string>(),
      });
    }
  }

  function hasLineOfSight(
    a: [number, number, number],
    b: [number, number, number]
  ): boolean {
    const origin = new THREE.Vector3(a[0], a[1], a[2]);
    const target = new THREE.Vector3(b[0], b[1], b[2]);
    const delta = target.clone().sub(origin);
    const distance = delta.length();
    if (distance <= NAV_LOS_EPSILON) return true;

    delta.normalize();
    raycaster.set(origin, delta);
    raycaster.far = distance - NAV_LOS_EPSILON;
    const hits = raycaster.intersectObject(mesh);
    return hits.length === 0;
  }

  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      const a = survivors[i];
      const b = survivors[j];
      const dx = a.position[0] - b.position[0];
      const dz = a.position[2] - b.position[2];
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > NAV_LINK_RADIUS) continue;

      if (hasLineOfSight(a.position, b.position)) {
        a.links.add(b.id);
        b.links.add(a.id);
      }
    }
  }

  function bridgeAcrossComponents(
    searchRadius: number,
    requireLineOfSight: boolean
  ): boolean {
    const componentOf = findConnectedComponents(survivors);
    if (new Set(componentOf.values()).size <= 1) return false;

    let bridgedAny = false;

    for (let i = 0; i < survivors.length; i++) {
      for (let j = i + 1; j < survivors.length; j++) {
        const a = survivors[i];
        const b = survivors[j];
        if (componentOf.get(a.id) === componentOf.get(b.id)) continue;

        const dx = a.position[0] - b.position[0];
        const dz = a.position[2] - b.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > searchRadius) continue;

        if (requireLineOfSight && !hasLineOfSight(a.position, b.position)) continue;

        a.links.add(b.id);
        b.links.add(a.id);
        bridgedAny = true;
      }
    }

    return bridgedAny;
  }

  let doorwayPasses = 0;
  while (
    bridgeAcrossComponents(NAV_DOORWAY_SEARCH_RADIUS, true) &&
    doorwayPasses < survivors.length
  ) {
    doorwayPasses++;
  }

  let forcedPasses = 0;
  while (forcedPasses < survivors.length) {
    const componentOf = findConnectedComponents(survivors);
    const componentIds = new Set(componentOf.values());
    if (componentIds.size <= 1) break;
    forcedPasses++;

    const componentSizes = new Map<number, number>();
    for (const c of componentOf.values()) {
      componentSizes.set(c, (componentSizes.get(c) ?? 0) + 1);
    }

    let mainComponentId = -1;
    let mainComponentSize = -1;
    for (const [componentId, size] of componentSizes) {
      if (size > mainComponentSize) {
        mainComponentSize = size;
        mainComponentId = componentId;
      }
    }

    let bestPair: [NavNode, NavNode] | null = null;
    let bestDist = Infinity;

    for (const a of survivors) {
      if (componentOf.get(a.id) !== mainComponentId) continue;
      for (const b of survivors) {
        if (componentOf.get(b.id) === mainComponentId) continue;
        const dx = a.position[0] - b.position[0];
        const dz = a.position[2] - b.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < bestDist) {
          bestDist = dist;
          bestPair = [a, b];
        }
      }
    }

    if (!bestPair) break;

    const [a, b] = bestPair;
    a.links.add(b.id);
    b.links.add(a.id);
    console.warn(
      `[navigation] Force-bridged isolated cluster: ${a.id} <-> ${b.id} (${bestDist.toFixed(2)}m)`
    );
  }

  const output = survivors.map((node) => ({
    id: node.id,
    position: node.position,
    lookAt: [node.position[0], node.position[1], node.position[2] - 1] as [
      number,
      number,
      number
    ],
    links: Array.from(node.links),
  }));

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  const totalLinks = survivors.reduce((sum, n) => sum + n.links.size, 0) / 2;
  console.log(
    `[navigation] Generated ${output.length} viewpoints with ${totalLinks} links -> ${outputPath}`
  );
}

export async function compileScene(
  options: CompileSceneOptions
): Promise<void> {

  const { jobDirectory, assetsDirectory } = options;

  const INPUT_IFC_PATH = path.join(jobDirectory, "input.ifc");
  const PROJECT_STATE_PATH = path.join(jobDirectory, "project_state.json");
  const OUTPUT_GLB_PATH = path.join(jobDirectory, "output.glb");

    function resolveGlbPath(src: string): string {
      // src is a full URL like http://localhost:3000/uploads/catalog/models/xxx.glb
      // or a relative path like /uploads/catalog/models/xxx.glb
      let pathname: string;
      try {
        pathname = new URL(src).pathname;
      } catch {
        pathname = src;
      }
      // Map /uploads/... to the uploads folder sitting next to the compiler's server root
      if (pathname.startsWith("/uploads/")) {
        return path.join(ROOT_DIR, "..", pathname);
      }
      // Fallback: treat as absolute path
      return pathname;
    }

    function resolveIfcPath(src: string): string {
    const url = new URL(src);

    if (url.pathname.startsWith("/assets/")) {
        return path.join(
            assetsDirectory,
            path.basename(url.pathname)
        );
    }

if (url.pathname.startsWith("/jobs/")) {

    const match = url.pathname.match(
        /^\/jobs\/([^\/]+)\/(.+)$/
    );

    if (!match) {
        throw new Error(`Invalid src: ${src}`);
    }

    const originalJobId = match[1];
    const relativePath = match[2];

    const currentPath = path.join(
        jobDirectory,
        relativePath
    );

    if (fs.existsSync(currentPath)) {
        return currentPath;
    }

    const originalJobPath = path.join(
        path.dirname(jobDirectory),
        originalJobId,
        relativePath
    );

    if (fs.existsSync(originalJobPath)) {
        console.warn(
            `[compiler] Using edited IFC from original job: ${originalJobPath}`
        );
        return originalJobPath;
    }

    throw new Error(
        `Edited IFC not found.\nCurrent: ${currentPath}\nOriginal: ${originalJobPath}`
    );
}

    throw new Error(`Unsupported src: ${src}`);
}
  
  if (!fs.existsSync(INPUT_IFC_PATH)) {
    throw new Error(`Fatal: structural IFC not found at ${INPUT_IFC_PATH}`);
  }
  if (!fs.existsSync(PROJECT_STATE_PATH)) {
    throw new Error(
      `Fatal: project_state.json not found at ${PROJECT_STATE_PATH}`
    );
  }

  const structuralIfcBytes = readFileAsUint8Array(INPUT_IFC_PATH);

  let projectState: ProjectState;
  try {
    const raw = fs.readFileSync(PROJECT_STATE_PATH, "utf-8");
    projectState = JSON.parse(raw) as ProjectState;
  } catch (err) {
    throw new Error(
      `Fatal: could not parse project_state.json - ${(err as Error).message}`
    );
  }

  if (!Array.isArray(projectState.furniture)) {
    throw new Error(
      "Fatal: project_state.json is malformed - 'furniture' must be an array."
    );
  }

  const structuralEdits = projectState.structural_edits ?? {};
  const materials = projectState.materials ?? {};

  const ifcApi = new IfcAPI();
  await ifcApi.Init();

  const openModelIds: number[] = [];

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");

  try {
    let structuralModelId: number;
    try {
      structuralModelId = ifcApi.OpenModel(structuralIfcBytes, {
        COORDINATE_TO_ORIGIN: false,
      });
      openModelIds.push(structuralModelId);
    } catch (err) {
      throw new Error(
        `Fatal: failed to parse structural input.ifc via web-ifc - ${
          (err as Error).message
        }`
      );
    }

    let structureNode: GltfNode;
    try {
      structureNode = extractGeometry(
        ifcApi,
        structuralModelId,
        doc,
        buffer,
        "IFC_Structure",
        {
          structuralEdits,
          materialOverrides: materials,
        }
      );
    } catch (err) {
      throw new Error(
        `Fatal: extractGeometry failed on structural model - ${
          (err as Error).message
        }`
      );
    }

    scene.addChild(structureNode);

    const io = new NodeIO();

    for (const item of projectState.furniture) {
      const isGlb =
        item.assetFormat === 'glb' ||
        item.src.toLowerCase().endsWith('.glb');

      try {
        if (isGlb) {
          // ── GLB branch ──────────────────────────────────────────────
          const assetPath = resolveGlbPath(item.src);
          console.log(`[compiler] Loading GLB: ${item.name} -> ${assetPath}`);

          if (!fs.existsSync(assetPath)) {
            console.warn(`[compiler] Skipping "${item.instanceId}" (${item.name}): GLB not found at ${assetPath}`);
            continue;
          }

          let glbDoc: Document;
          try {
            const glbBytes = fs.readFileSync(assetPath);
            glbDoc = await io.readBinary(new Uint8Array(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength));
          } catch (err) {
            console.warn(`[compiler] Skipping "${item.instanceId}" (${item.name}): failed to read GLB - ${(err as Error).message}`);
            continue;
          }

          // Clone all meshes/accessors/materials from glbDoc into output doc
          const clonedRoot = doc.createNode(`${item.instanceId}_geometry`);

          function cloneNode(srcNode: GltfNode, parentDst: GltfNode): void {
            const dstNode = doc.createNode(srcNode.getName());
            dstNode.setTranslation(srcNode.getTranslation());
            dstNode.setRotation(srcNode.getRotation());
            dstNode.setScale(srcNode.getScale());

            const srcMesh = srcNode.getMesh();
            if (srcMesh) {
              const dstMesh = doc.createMesh(srcMesh.getName());
              for (const srcPrim of srcMesh.listPrimitives()) {
                const dstPrim = doc.createPrimitive();
                dstPrim.setMode(srcPrim.getMode());

                // Clone indices
                const srcIdx = srcPrim.getIndices();
                if (srcIdx) {
                  const srcArr = srcIdx.getArray();
                  if (srcArr) {
                    dstPrim.setIndices(
                      doc.createAccessor()
                        .setType(srcIdx.getType())
                        .setArray(srcArr.slice())
                        .setBuffer(buffer)
                    );
                  }
                }

                // Clone attributes
                for (const semantic of srcPrim.listSemantics()) {
                  const srcAttr = srcPrim.getAttribute(semantic)!;
                  const srcArr = srcAttr.getArray();
                  if (srcArr) {
                    dstPrim.setAttribute(
                      semantic,
                      doc.createAccessor()
                        .setType(srcAttr.getType())
                        .setArray(srcArr.slice())
                        .setBuffer(buffer)
                    );
                  }
                }

                // Clone material
                const srcMat = srcPrim.getMaterial();
                if (srcMat) {
                  const [r, g, b, a] = srcMat.getBaseColorFactor();
                  const dstMat = doc.createMaterial(srcMat.getName())
                    .setBaseColorFactor([r, g, b, a])
                    .setRoughnessFactor(srcMat.getRoughnessFactor())
                    .setMetallicFactor(srcMat.getMetallicFactor())
                    .setDoubleSided(srcMat.getDoubleSided());
                  dstPrim.setMaterial(dstMat);
                }

                dstMesh.addPrimitive(dstPrim);
              }
              dstNode.setMesh(dstMesh);
            }

            parentDst.addChild(dstNode);

            for (const child of srcNode.listChildren()) {
              cloneNode(child, dstNode);
            }
          }

          const glbScenes = glbDoc.getRoot().listScenes();
          for (const glbScene of glbScenes) {
            for (const rootNode of glbScene.listChildren()) {
              cloneNode(rootNode, clonedRoot);
            }
          }

          const [centerX, bottomY, centerZ] = computeAssetPivotOffset(clonedRoot);
          const finalX = item.position[0] - centerX;
          const finalY = item.position[1] - bottomY;
          const finalZ = item.position[2] - centerZ;

          const instanceWrapper = doc.createNode(item.instanceId).addChild(clonedRoot);
          instanceWrapper.setTranslation([finalX, finalY, finalZ]);
          instanceWrapper.setRotation(eulerToQuaternion(degTupleToRadTuple(item.rotation)));
          instanceWrapper.setScale(Array.isArray(item.scale) ? item.scale : [1, 1, 1]);

          scene.addChild(instanceWrapper);
          console.log(`[compiler] Mounted GLB "${item.instanceId}" (${item.name}) at [${finalX.toFixed(3)}, ${finalY.toFixed(3)}, ${finalZ.toFixed(3)}]`);

        } else {
          // ── IFC branch (unchanged) ───────────────────────────────────
          const assetType = classifyAsset(item, structuralEdits);
          const behavior = ASSET_TYPE_BEHAVIOR[assetType];

          const assetPath = resolveIfcPath(item.src);
          console.log(`[compiler] Loading IFC: ${item.name} -> ${assetPath}`);

          if (!fs.existsSync(assetPath)) {
            console.warn(`[compiler] Skipping "${item.instanceId}" (${item.name}): asset not found at ${assetPath}`);
            continue;
          }

          let assetBytes: Uint8Array;
          try {
            assetBytes = readFileAsUint8Array(assetPath);
          } catch (err) {
            console.warn(`[compiler] Skipping "${item.instanceId}" (${item.name}): failed to read asset - ${(err as Error).message}`);
            continue;
          }

          let assetModelId: number;
          try {
            assetModelId = ifcApi.OpenModel(assetBytes, { COORDINATE_TO_ORIGIN: false });
            openModelIds.push(assetModelId);
          } catch (err) {
            console.warn(`[compiler] Skipping "${item.instanceId}" (${item.name}): web-ifc failed - ${(err as Error).message}`);
            continue;
          }

          let tempSubtree: GltfNode;
          try {
            tempSubtree = extractGeometry(
              ifcApi, assetModelId, doc, buffer,
              `${item.instanceId}_geometry`,
              behavior.applyMaterialOverrides ? { materialOverrides: materials } : {}
            );
          } catch (err) {
            console.warn(`[compiler] Skipping "${item.instanceId}" (${item.name}): extractGeometry failed - ${(err as Error).message}`);
            continue;
          }

          let finalX: number, finalY: number, finalZ: number;
          if (behavior.preservePlacement) {
            [finalX, finalY, finalZ] = item.position;
          } else {
            const [centerX, bottomY, centerZ] = computeAssetPivotOffset(tempSubtree);
            finalX = item.position[0] - centerX;
            finalY = item.position[1] - bottomY;
            finalZ = item.position[2] - centerZ;
          }

          const instanceWrapper = doc.createNode(item.instanceId).addChild(tempSubtree);
          instanceWrapper.setTranslation([finalX, finalY, finalZ]);
          instanceWrapper.setRotation(eulerToQuaternion(degTupleToRadTuple(item.rotation)));
          instanceWrapper.setScale(Array.isArray(item.scale) ? item.scale : [1, 1, 1]);

          scene.addChild(instanceWrapper);
          console.log(`[compiler] Mounted IFC "${item.instanceId}" (${item.name}) [${assetType}] at [${finalX.toFixed(3)}, ${finalY.toFixed(3)}, ${finalZ.toFixed(3)}]`);
        }
      } catch (err) {
        console.warn(`[compiler] Unexpected error processing "${item.instanceId ?? 'unknown'}": ${(err as Error).message}. Skipping.`);
        continue;
      }
    }

    const glbBuffer = await io.writeBinary(doc);
    fs.writeFileSync(OUTPUT_GLB_PATH, Buffer.from(glbBuffer));

    console.log(`[compiler] Wrote ${OUTPUT_GLB_PATH} (${glbBuffer.byteLength} bytes)`);

    try {
      await generateDenseNavigationGraph(doc, jobDirectory);
    } catch (err) {
      console.error(
        `[compiler] Dense navigation graph generation failed - ${(err as Error).message}. Continuing without navigation.json.`
      );
    }
  } finally {
    for (const modelId of openModelIds) {
      try {
        ifcApi.CloseModel(modelId);
      } catch (err) {
        console.warn(
          `[compiler] Warning: failed to close model ${modelId} - ${
            (err as Error).message
          }`
        );
      }
    }
  }
}

const isMainModule = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isMainModule) {
  const [jobDirectory, assetsDirectory] = process.argv.slice(2);

  if (!jobDirectory || !assetsDirectory) {
    console.error(
      "Usage: npx tsx compiler.ts <jobDirectory> <assetsDirectory>"
    );
    process.exit(1);
  }

  compileScene({ jobDirectory, assetsDirectory })
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("[compiler] Fatal error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}