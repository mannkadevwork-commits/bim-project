import * as fs from "fs";
import * as path from "path";
import { IfcAPI } from "web-ifc";
import { Document, NodeIO, Node as GltfNode, Primitive } from "@gltf-transform/core";

import { extractGeometry } from "./geometry";
import { computeAssetPivotOffset, eulerToQuaternion } from "./math";
import { fileURLToPath, pathToFileURL } from "url";
import { WalkNavigationPipeline } from "./navigation/WalkNavigationPipeline";
import { RoomDetector } from "./navigation/RoomDetector";

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
  /** Set when a GLB door was placed via insert-door. Position is the exact
   * Python-computed void center; no AABB pivot correction must be applied. */
  doorHostWallId?: string;
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
    // Normalise: accept both full URLs (http://host/...) and bare paths (/assets/...)
    let pathname: string;
    try {
      pathname = new URL(src).pathname;
    } catch {
      // src is already a bare path like /assets/wall_standard.ifc
      pathname = src.startsWith("/") ? src : `/${src}`;
    }

    // Strip query-string / fragment that may survive URL parsing
    pathname = pathname.split("?")[0].split("#")[0];

    // /assets/<file>  →  assetsDirectory/<file>
    if (pathname.startsWith("/assets/")) {
      return path.join(assetsDirectory, path.basename(pathname));
    }

    // /uploads/<rest>  →  <serverRoot>/uploads/<rest>  (catalog-uploaded IFCs)
    if (pathname.startsWith("/uploads/")) {
      return path.join(ROOT_DIR, "..", pathname);
    }

    // /jobs/<jobId>/<relativePath>  →  job directory lookup
    if (pathname.startsWith("/jobs/")) {
      const match = pathname.match(/^\/jobs\/([^\/]+)\/(.+)$/);
      if (!match) throw new Error(`Invalid /jobs/ src: ${src}`);

      const originalJobId = match[1];
      const relativePath  = match[2];

      const currentPath = path.join(jobDirectory, relativePath);
      if (fs.existsSync(currentPath)) return currentPath;

      const originalJobPath = path.join(path.dirname(jobDirectory), originalJobId, relativePath);
      if (fs.existsSync(originalJobPath)) {
        console.warn(`[compiler] Using edited IFC from original job: ${originalJobPath}`);
        return originalJobPath;
      }

      throw new Error(`Edited IFC not found.\nCurrent: ${currentPath}\nOriginal: ${originalJobPath}`);
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

  // Phase 6A: semantic room detection is read-only and must never block scene compilation.
  // It operates from the current input.ifc + project_state structural replacements and
  // writes rooms_debug.json for validation before editor integration.
  try {
    await RoomDetector.run({ jobDirectory });
  } catch (err) {
    console.warn(`[compiler:rooms] Room detection failed; continuing GLB compilation - ${(err as Error).message}`);
  }

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

          // GLB doors placed via insert-door have doorHostWallId set. Their
          // position is the exact Python-computed void center — use it directly
          // without any AABB pivot correction (same contract as native-isolated IFCs).
          const isHostedDoor = !!item.doorHostWallId;
          applyAuthoredTransform(instanceWrapper, item, null, isHostedDoor);

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
      await WalkNavigationPipeline.run(OUTPUT_GLB_PATH, jobDirectory);
    } catch (err) {
      console.error(
        `[compiler] Recast navigation generation failed - ${(err as Error).message}. Continuing with output.glb.`
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