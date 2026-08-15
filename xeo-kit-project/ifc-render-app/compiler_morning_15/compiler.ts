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
    // Structural replacements are authored in the current IFC/world frame.
    // Their geometry carries its native frame, so the wrapper must preserve it
    // rather than applying the furniture bottom-center placement convention.
    preservePlacement: true,
    applyMaterialOverrides: true,
  },
  [AssetType.FURNITURE]: {
    // Furniture positions/scales are already persisted in the CURRENT scene
    // frame by the frontend. Do not multiply them by scene_calibration again.
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
  fileType?: string;
  nativeSourceId?: string;
  isNativeIsolation?: boolean;
  /** Optional future authoritative world matrix, column-major glTF order. */
  matrix?: [
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
    number, number, number, number
  ];
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
  scene_calibration?: {
    scaleFactor?: { x: number; y: number; z: number };
    migratedToFrameScale?: boolean;
  };
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

function classifyAsset(
  item: FurnitureItem,
  structuralEdits: Record<string, StructuralEditEntry>
): AssetType {
  // Native-isolated entries are structural replacements even when an older
  // project_state.json does not carry an explicit `type` or structural-edits
  // record. Their source geometry lives in the IFC/world frame and must not
  // use the catalog-furniture placement convention.
  if (item.isNativeIsolation || item.nativeSourceId) {
    return AssetType.STRUCTURAL_REPLACEMENT;
  }

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

const DEBUG_COMPILER =
  process.env.HCI_COMPILER_DEBUG === "1" || process.env.HCI_COMPILER_DEBUG === "true";

function debugLog(...args: unknown[]): void {
  if (DEBUG_COMPILER) console.log(...args);
}

function isFiniteMatrix16(value: unknown): value is [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
] {
  return Array.isArray(value)
    && value.length === 16
    && value.every((v) => typeof v === "number" && Number.isFinite(v)) as boolean;
}

function resolveItemMaterial(
  item: FurnitureItem,
  materials: Record<string, MaterialEntry>
): MaterialEntry | undefined {
  // Current frontend state stores placed-asset material overrides by instanceId.
  // Keep id as a compatibility fallback for older states.
  return materials[item.instanceId] ?? materials[item.id];
}

function applyMaterialToSubtree(
  root: GltfNode,
  materialOverride: MaterialEntry | undefined,
  doc: Document
): void {
  if (!materialOverride) return;

  const [r, g, b] = materialOverride.rgb;
  const visit = (node: GltfNode): void => {
    const mesh = node.getMesh();
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        const source = primitive.getMaterial();
        const alpha = source ? source.getBaseColorFactor()[3] : 1;
        const material = doc
          .createMaterial(`${source?.getName() ?? node.getName()}_override`)
          .setBaseColorFactor([r, g, b, alpha])
          .setRoughnessFactor(source?.getRoughnessFactor() ?? 0.8)
          .setMetallicFactor(source?.getMetallicFactor() ?? 0.1)
          .setDoubleSided(source?.getDoubleSided() ?? true);
        primitive.setMaterial(material);
      }
    }
    for (const child of node.listChildren()) visit(child);
  };

  visit(root);
}

function computeScaledFurniturePivotTranslation(
  pivot: [number, number, number],
  targetPosition: [number, number, number],
  scale: [number, number, number]
): [number, number, number] {
  // Match the frontend asset restore contract exactly:
  // 1) apply persisted scale to the asset model,
  // 2) read the scaled AABB,
  // 3) place the model so the stored placement target is at the
  //    scaled bottom-center pivot.
  // Rotation is applied AFTER this translation in the frontend, so it is
  // intentionally not included in this pivot calculation.
  return [
    targetPosition[0] - pivot[0] * scale[0],
    targetPosition[1] - pivot[1] * scale[1],
    targetPosition[2] - pivot[2] * scale[2],
  ];
}

function applyAuthoredTransform(
  wrapper: GltfNode,
  item: FurnitureItem,
  pivot: [number, number, number] | null,
  preserveNativeFrame: boolean
): void {
  // IMPORTANT: item.matrix is intentionally NOT authoritative here. The
  // frontend treats position as the persisted placement target and rebuilds
  // the runtime matrix after the asset has loaded (see applyPersistedModelMatrix).
  // The uploaded calibrated state demonstrates why: the persisted matrix can
  // be a stale runtime snapshot (for example, missing the persisted Y rotation
  // or containing the raw AABB-corrected translation). Reusing it caused the
  // GLB output to lose sofa rotation and place doors/walls at different points
  // than the editor. Persisted TRS + the asset's frame convention are the
  // source of truth for the compositor.
  const rotation = eulerToQuaternion(item.rotation);
  const scale: [number, number, number] = Array.isArray(item.scale)
    ? item.scale
    : [1, 1, 1];

  if (preserveNativeFrame) {
    // Native isolated IFCs are already authored in the IFC/world frame. The
    // frontend restores them with their persisted TRS directly. Applying a
    // furniture-style AABB/pivot correction here changes the frame and causes
    // calibrated native edits to drift or appear as detached "ghost" geometry.
    wrapper.setTranslation(item.position);
    wrapper.setRotation(rotation);
    wrapper.setScale(scale);

    debugLog(`[compiler:transform] ${item.instanceId}`, {
      assetFrame: "native-isolation",
      position: item.position,
      rotation: item.rotation,
      scale,
    });
    return;
  }

  if (!pivot) {
    wrapper.setScale(scale);
    wrapper.setTranslation(item.position);
    wrapper.setRotation(rotation);
    return;
  }

  // Catalog/placed IFC furniture uses the same bottom-center placement
  // contract as the frontend. Do NOT rotate the pivot here: the frontend
  // computes placement after scale and then applies rotation around the node
  // origin. Reproducing that order is what keeps GLB output aligned with the
  // editor for rotated doors/sofas and non-uniformly resized assets.
  const translation = computeScaledFurniturePivotTranslation(
    pivot,
    item.position,
    scale
  );

  wrapper.setScale(scale);
  wrapper.setTranslation(translation);
  wrapper.setRotation(rotation);

  debugLog(`[compiler:transform] ${item.instanceId}`, {
    assetFrame: "catalog-furniture",
    pivot,
    placementTarget: item.position,
    translation,
    rotation: item.rotation,
    scale,
  });
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

  // Persisted furniture position/scale are already in the CURRENT calibrated
  // scene frame. Do not apply scene_calibration a second time to asset TRS.
  if (projectState.scene_calibration?.scaleFactor && DEBUG_COMPILER) {
    debugLog("[compiler:calibration] metadata only", projectState.scene_calibration);
  }

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

    // The persisted calibration factor represents the scene frame produced by
    // the backend /rescale operation. That operation rewrites the project IFC
    // coordinates by the factor about the IFC/world origin; the frontend then
    // transforms every persisted asset position and scale by the same factor.
    // The current GLB compiler is reading the structural IFC in its raw frame,
    // so we must reproduce that same structural frame transform exactly once.
    // Do NOT pivot the structure around its visual center here: the frontend's
    // persisted asset positions are already in the origin-scaled frame
    // (newCenter = oldCenter * ratio for this calibration path).
    const persistedCalibration = projectState.scene_calibration?.scaleFactor;
    const calibrationScale: [number, number, number] =
      persistedCalibration &&
      Number.isFinite(persistedCalibration.x) &&
      Number.isFinite(persistedCalibration.y) &&
      Number.isFinite(persistedCalibration.z) &&
      persistedCalibration.x > 0 && persistedCalibration.y > 0 && persistedCalibration.z > 0
        ? [persistedCalibration.x, persistedCalibration.y, persistedCalibration.z]
        : [1, 1, 1];

    if (calibrationScale.some((v) => Math.abs(v - 1) > 1e-9)) {
      const structureFrame = doc.createNode("IFC_Structure_Frame").addChild(structureNode);
      structureFrame.setScale(calibrationScale);
      scene.addChild(structureFrame);

      debugLog("[compiler:calibration] applied structural scene-frame scale", {
        calibrationScale,
        pivot: "world-origin",
      });
    } else {
      scene.addChild(structureNode);
    }

    const io = new NodeIO();

    for (const item of projectState.furniture) {
      const isGlb =
        item.assetFormat === 'glb' ||
        item.fileType === 'glb' ||
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

          const instanceWrapper = doc.createNode(item.instanceId).addChild(clonedRoot);

          const itemMaterial = resolveItemMaterial(item, materials);
          applyMaterialToSubtree(clonedRoot, itemMaterial, doc);

          // GLB assets are authored as standalone objects. Their persisted
          // position/scale is already in the current scene frame.
          applyAuthoredTransform(instanceWrapper, item, null, false);

          scene.addChild(instanceWrapper);
          debugLog(`[compiler] Mounted GLB "${item.instanceId}" (${item.name})`, {
            assetFrame: "catalog-glb",
            position: item.position,
            rotation: item.rotation,
            scale: item.scale,
            matrix: isFiniteMatrix16(item.matrix) ? item.matrix : null,
          });

        } else {
          // ── IFC branch ───────────────────────────────────────────────
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
              ifcApi,
              assetModelId,
              doc,
              buffer,
              `${item.instanceId}_geometry`,
              behavior.applyMaterialOverrides ? { materialOverrides: materials } : {}
            );
          } catch (err) {
            console.warn(`[compiler] Skipping "${item.instanceId}" (${item.name}): extractGeometry failed - ${(err as Error).message}`);
            continue;
          }

          // Furniture material overrides are keyed by the placed instance in
          // current frontend state, not by the source IFC GlobalId.
          if (assetType === AssetType.FURNITURE) {
            applyMaterialToSubtree(tempSubtree, resolveItemMaterial(item, materials), doc);
          }

          const instanceWrapper = doc.createNode(item.instanceId).addChild(tempSubtree);

          // Critical compositor rule:
          // - Furniture geometry is in the asset's local frame. Its saved
          //   position is the desired pivot position in the CURRENT scene frame.
          // - Native isolated IFC geometry already carries its IFC/world frame.
          //   Scale/rotation must therefore pivot around that geometry instead
          //   of the global origin (otherwise calibrated edits fly apart).
          let pivot: [number, number, number] | null = null;
          try {
            pivot = computeAssetPivotOffset(tempSubtree);
          } catch (err) {
            console.warn(
              `[compiler] Pivot computation failed for "${item.instanceId}": ${(err as Error).message}; falling back to raw TRS.`
            );
          }

          applyAuthoredTransform(
            instanceWrapper,
            item,
            pivot,
            assetType === AssetType.STRUCTURAL_REPLACEMENT
          );

          scene.addChild(instanceWrapper);
          debugLog(`[compiler] Mounted IFC "${item.instanceId}" (${item.name}) [${assetType}]`, {
            assetFrame: assetType === AssetType.STRUCTURAL_REPLACEMENT ? "native-isolation" : "catalog-furniture",
            position: item.position,
            rotation: item.rotation,
            scale: item.scale,
            pivot,
            matrix: isFiniteMatrix16(item.matrix) ? item.matrix : null,
          });
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