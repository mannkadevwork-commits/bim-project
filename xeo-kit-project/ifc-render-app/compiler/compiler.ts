import * as fs from "fs";
import * as path from "path";
import { IfcAPI } from "web-ifc";
import {
  Document,
  NodeIO,
  Node as GltfNode,
  Texture,
} from "@gltf-transform/core";

import { extractGeometry } from "./geometry";
import { computeAssetPivotOffset, eulerToQuaternion } from "./math";
import { fileURLToPath, pathToFileURL } from "url";
import { WalkNavigationPipeline } from "./navigation/WalkNavigationPipeline";
import { RoomDetector } from "./navigation/RoomDetector";
import { optimizeGlb } from "./glb-optimizer";

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
  assetFormat?: "glb" | "ifc";
  fileType?: string;
  nativeSourceId?: string;
  isNativeIsolation?: boolean;
  matrix?: [
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
    number, number, number, number
  ];
  doorHostWallId?: string;
}

interface StructuralEditEntry {
  visible?: boolean;
  scale?: [number, number, number];
  offset?: [number, number, number];
}

interface MaterialEntry {
  kind?: "color" | "fabric" | "texture";
  color: string;
  rgb: [number, number, number];
  texture?: {
    id?: string;
    name?: string;
    src?: string;
    repeat?: [number, number];
  };
  roughness?: number;
  metallic?: number;
}

interface ProjectState {
  structural_edits?: Record<string, StructuralEditEntry>;
  materials?: Record<string, MaterialEntry>;
  furniture: FurnitureItem[];
  scene_calibration?: {
    scaleFactor?: {
      x: number;
      y: number;
      z: number;
    };
    migratedToFrameScale?: boolean;
  };
}

export interface CompileSceneOptions {
  jobDirectory: string;
  assetsDirectory: string;
}

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

function readFileAsUint8Array(filePath: string): Uint8Array {
  const raw = fs.readFileSync(filePath);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function classifyAsset(
  item: FurnitureItem,
  structuralEdits: Record<string, StructuralEditEntry>,
): AssetType {
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

const DEBUG_COMPILER =
  process.env.HCI_COMPILER_DEBUG === "1" ||
  process.env.HCI_COMPILER_DEBUG === "true";

function debugLog(...args: unknown[]): void {
  if (DEBUG_COMPILER) console.log(...args);
}

function isFiniteMatrix16(value: unknown): value is [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
] {
  return (
    Array.isArray(value) &&
    value.length === 16 &&
    value.every(
      (v) => typeof v === "number" && Number.isFinite(v),
    )
  );
}

function resolveItemMaterial(
  item: FurnitureItem,
  materials: Record<string, MaterialEntry>,
): MaterialEntry | undefined {
  return materials[item.instanceId] ?? materials[item.id];
}

function resolveMaterialTexturePath(
  src: string | undefined,
  assetsDirectory: string,
): string | null {
  if (!src) return null;

  const clean = String(src).split("?")[0].split("#")[0];
  const compilerMaterials = path.join(ROOT_DIR, "materials");

  if (clean.startsWith("/materials/")) {
    const candidate = path.resolve(
      compilerMaterials,
      clean.slice("/materials/".length),
    );
    if (fs.existsSync(candidate)) return candidate;
  }

  if (clean.startsWith("/assets/")) {
    const candidate = path.resolve(
      assetsDirectory,
      clean.slice("/assets/".length),
    );
    if (fs.existsSync(candidate)) return candidate;
  }

  return fs.existsSync(clean) ? clean : null;
}

function mimeForTexture(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function applyMaterialToSubtree(
  root: GltfNode,
  materialOverride: MaterialEntry | undefined,
  doc: Document,
  assetsDirectory: string,
): void {
  if (!materialOverride) return;

  const [r, g, b] = materialOverride.rgb;
  let sharedTexture: Texture | null = null;

  if (
    (materialOverride.kind === "fabric" ||
      materialOverride.kind === "texture") &&
    materialOverride.texture?.src
  ) {
    const texturePath = resolveMaterialTexturePath(
      materialOverride.texture.src,
      assetsDirectory,
    );

    if (texturePath) {
      sharedTexture = doc
        .createTexture(
          `Tex_${materialOverride.texture.id || "material"}`,
        )
        .setMimeType(mimeForTexture(texturePath))
        .setImage(fs.readFileSync(texturePath));
    }
  }

  const visit = (node: GltfNode): void => {
    const mesh = node.getMesh();

    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        const source = primitive.getMaterial();

        let material = doc
          .createMaterial(
            `${source?.getName() ?? node.getName()}_override`,
          )
          .setBaseColorFactor([
            r,
            g,
            b,
            source ? source.getBaseColorFactor()[3] : 1,
          ])
          .setRoughnessFactor(
            materialOverride.roughness ??
              source?.getRoughnessFactor() ??
              0.8,
          )
          .setMetallicFactor(
            materialOverride.metallic ??
              source?.getMetallicFactor() ??
              0.1,
          )
          .setDoubleSided(source?.getDoubleSided() ?? true);

        if (sharedTexture) {
          material = material.setBaseColorTexture(sharedTexture);
        }

        primitive.setMaterial(material);
      }
    }

    for (const child of node.listChildren()) {
      visit(child);
    }
  };

  visit(root);
}

function computeScaledFurniturePivotTranslation(
  pivot: [number, number, number],
  targetPosition: [number, number, number],
  scale: [number, number, number],
): [number, number, number] {
  return [
    targetPosition[0] - pivot[0] * scale[0],
    targetPosition[1] - pivot[1] * scale[1],
    targetPosition[2] - pivot[2] * scale[2],
  ];
}

function applyPersistedGlbTransform(
  wrapper: GltfNode,
  item: FurnitureItem,
  preserveNativeFrame: boolean,
): boolean {
  if (preserveNativeFrame || !isFiniteMatrix16(item.matrix)) {
    return false;
  }

  try {
    wrapper.setMatrix(item.matrix);
  } catch (error) {
    console.warn(
      `[compiler:glb-transform] ${item.instanceId}: failed to apply persisted matrix; falling back to TRS - ${
        (error as Error).message
      }`,
    );
    return false;
  }

  debugLog(`[compiler:glb-transform] ${item.instanceId}`, {
    mode: "persisted-matrix",
    placementTarget: item.position,
    persistedMatrix: item.matrix,
  });

  return true;
}

function applyAuthoredTransform(
  wrapper: GltfNode,
  item: FurnitureItem,
  pivot: [number, number, number] | null,
  preserveNativeFrame: boolean,
): void {
  const rotation = eulerToQuaternion(item.rotation);
  const scale: [number, number, number] = Array.isArray(item.scale)
    ? item.scale
    : [1, 1, 1];

  if (preserveNativeFrame) {
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

  const translation = computeScaledFurniturePivotTranslation(
    pivot,
    item.position,
    scale,
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
  options: CompileSceneOptions,
): Promise<void> {
  const { jobDirectory, assetsDirectory } = options;

  const INPUT_IFC_PATH = path.join(jobDirectory, "input.ifc");
  const PROJECT_STATE_PATH = path.join(jobDirectory, "project_state.json");

  // Build artifact. This file is never exposed to the browser and is removed
  // after navigation + optimization complete.
  const RAW_GLB_PATH = path.join(jobDirectory, "output.raw.glb");

  // Browser-facing production artifact.
  const OUTPUT_GLB_PATH = path.join(jobDirectory, "output.glb");

  const OPTIMIZATION_REPORT_PATH = path.join(
    jobDirectory,
    "optimization_report.json",
  );

  function resolveGlbPath(src: string): string {
    let pathname: string;

    try {
      pathname = new URL(src).pathname;
    } catch {
      pathname = src;
    }

    if (pathname.startsWith("/uploads/")) {
      return path.join(ROOT_DIR, "..", pathname);
    }

    return pathname;
  }

  function resolveIfcPath(src: string): string {
    let pathname: string;

    try {
      pathname = new URL(src).pathname;
    } catch {
      pathname = src.startsWith("/") ? src : `/${src}`;
    }

    pathname = pathname.split("?")[0].split("#")[0];

    if (pathname.startsWith("/assets/")) {
      return path.join(
        assetsDirectory,
        path.basename(pathname),
      );
    }

    if (pathname.startsWith("/uploads/")) {
      return path.join(ROOT_DIR, "..", pathname);
    }

    if (pathname.startsWith("/jobs/")) {
      const match = pathname.match(/^\/jobs\/([^/]+)\/(.+)$/);

      if (!match) {
        throw new Error(`Invalid /jobs/ src: ${src}`);
      }

      const originalJobId = match[1];
      const relativePath = match[2];

      const currentPath = path.join(
        jobDirectory,
        relativePath,
      );

      if (fs.existsSync(currentPath)) {
        return currentPath;
      }

      const originalJobPath = path.join(
        path.dirname(jobDirectory),
        originalJobId,
        relativePath,
      );

      if (fs.existsSync(originalJobPath)) {
        console.warn(
          `[compiler] Using edited IFC from original job: ${originalJobPath}`,
        );
        return originalJobPath;
      }

      throw new Error(
        `Edited IFC not found.\nCurrent: ${currentPath}\nOriginal: ${originalJobPath}`,
      );
    }

    throw new Error(`Unsupported src: ${src}`);
  }

  if (!fs.existsSync(INPUT_IFC_PATH)) {
    throw new Error(
      `Fatal: structural IFC not found at ${INPUT_IFC_PATH}`,
    );
  }

  if (!fs.existsSync(PROJECT_STATE_PATH)) {
    throw new Error(
      `Fatal: project_state.json not found at ${PROJECT_STATE_PATH}`,
    );
  }

  const structuralIfcBytes = readFileAsUint8Array(
    INPUT_IFC_PATH,
  );

  let projectState: ProjectState;

  try {
    projectState = JSON.parse(
      fs.readFileSync(PROJECT_STATE_PATH, "utf-8"),
    ) as ProjectState;
  } catch (error) {
    throw new Error(
      `Fatal: could not parse project_state.json - ${
        (error as Error).message
      }`,
    );
  }

  if (!Array.isArray(projectState.furniture)) {
    throw new Error(
      "Fatal: project_state.json is malformed - 'furniture' must be an array.",
    );
  }

  const structuralEdits =
    projectState.structural_edits ?? {};
  const materials = projectState.materials ?? {};

  // Room detection is a diagnostics/editor aid. Do not run it during
  // production 360 renders unless explicitly enabled.
  if (process.env.HCI_ENABLE_LEGACY_ROOM_DETECTOR === "1") {
    try {
      await RoomDetector.run({ jobDirectory });
    } catch (error) {
      console.warn(
        `[compiler:rooms] Room detection failed; continuing GLB compilation - ${
          (error as Error).message
        }`,
      );
    }
  }

  if (
    projectState.scene_calibration?.scaleFactor &&
    DEBUG_COMPILER
  ) {
    debugLog(
      "[compiler:calibration] metadata only",
      projectState.scene_calibration,
    );
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
      structuralModelId = ifcApi.OpenModel(
        structuralIfcBytes,
        {
          COORDINATE_TO_ORIGIN: false,
        },
      );
      openModelIds.push(structuralModelId);
    } catch (error) {
      throw new Error(
        `Fatal: failed to parse structural input.ifc via web-ifc - ${
          (error as Error).message
        }`,
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
          assetsDirectory,
        },
      );
    } catch (error) {
      throw new Error(
        `Fatal: extractGeometry failed on structural model - ${
          (error as Error).message
        }`,
      );
    }

    const persistedCalibration =
      projectState.scene_calibration?.scaleFactor;

    const calibrationScale: [
      number,
      number,
      number
    ] =
      persistedCalibration &&
      Number.isFinite(persistedCalibration.x) &&
      Number.isFinite(persistedCalibration.y) &&
      Number.isFinite(persistedCalibration.z) &&
      persistedCalibration.x > 0 &&
      persistedCalibration.y > 0 &&
      persistedCalibration.z > 0
        ? [
            persistedCalibration.x,
            persistedCalibration.y,
            persistedCalibration.z,
          ]
        : [1, 1, 1];

    if (
      calibrationScale.some(
        (value) => Math.abs(value - 1) > 1e-9,
      )
    ) {
      const structureFrame = doc
        .createNode("IFC_Structure_Frame")
        .addChild(structureNode);

      structureFrame.setScale(calibrationScale);
      scene.addChild(structureFrame);

      debugLog(
        "[compiler:calibration] applied structural scene-frame scale",
        {
          calibrationScale,
          pivot: "world-origin",
        },
      );
    } else {
      scene.addChild(structureNode);
    }

    const io = new NodeIO();

    for (const item of projectState.furniture) {
      const isGlb =
        item.assetFormat === "glb" ||
        item.fileType === "glb" ||
        item.src.toLowerCase().endsWith(".glb");

      try {
        if (isGlb) {
          const assetPath = resolveGlbPath(item.src);

          console.log(
            `[compiler] Loading GLB: ${item.name} -> ${assetPath}`,
          );

          if (!fs.existsSync(assetPath)) {
            console.warn(
              `[compiler] Skipping "${item.instanceId}" (${item.name}): GLB not found at ${assetPath}`,
            );
            continue;
          }

          let glbDoc: Document;

          try {
            const glbBytes = fs.readFileSync(assetPath);

            glbDoc = await io.readBinary(
              new Uint8Array(
                glbBytes.buffer,
                glbBytes.byteOffset,
                glbBytes.byteLength,
              ),
            );
          } catch (error) {
            console.warn(
              `[compiler] Skipping "${item.instanceId}" (${item.name}): failed to read GLB - ${
                (error as Error).message
              }`,
            );
            continue;
          }

          const clonedRoot = doc.createNode(
            `${item.instanceId}_geometry`,
          );

          function cloneNode(
            srcNode: GltfNode,
            parentDst: GltfNode,
          ): void {
            const dstNode = doc.createNode(
              srcNode.getName(),
            );

            let copiedSourceMatrix = false;

            try {
              const sourceMatrix = srcNode.getMatrix();

              if (
                sourceMatrix &&
                sourceMatrix.length === 16
              ) {
                dstNode.setMatrix(sourceMatrix);
                copiedSourceMatrix = true;
              }
            } catch {
              copiedSourceMatrix = false;
            }

            if (!copiedSourceMatrix) {
              dstNode.setTranslation(
                srcNode.getTranslation(),
              );
              dstNode.setRotation(
                srcNode.getRotation(),
              );
              dstNode.setScale(srcNode.getScale());
            }

            const srcMesh = srcNode.getMesh();

            if (srcMesh) {
              const dstMesh = doc.createMesh(
                srcMesh.getName(),
              );

              for (const srcPrim of srcMesh.listPrimitives()) {
                const dstPrim = doc.createPrimitive();

                dstPrim.setMode(srcPrim.getMode());

                const srcIdx = srcPrim.getIndices();

                if (srcIdx) {
                  const srcArr = srcIdx.getArray();

                  if (srcArr) {
                    dstPrim.setIndices(
                      doc
                        .createAccessor()
                        .setType(srcIdx.getType())
                        .setArray(srcArr.slice())
                        .setBuffer(buffer),
                    );
                  }
                }

                for (const semantic of srcPrim.listSemantics()) {
                  const srcAttr =
                    srcPrim.getAttribute(semantic)!;
                  const srcArr = srcAttr.getArray();

                  if (srcArr) {
                    dstPrim.setAttribute(
                      semantic,
                      doc
                        .createAccessor()
                        .setType(srcAttr.getType())
                        .setArray(srcArr.slice())
                        .setBuffer(buffer),
                    );
                  }
                }

                const srcMat =
                  srcPrim.getMaterial();

                if (srcMat) {
                  const [r, g, b, a] =
                    srcMat.getBaseColorFactor();

                  const dstMat = doc
                    .createMaterial(srcMat.getName())
                    .setBaseColorFactor([
                      r,
                      g,
                      b,
                      a,
                    ])
                    .setRoughnessFactor(
                      srcMat.getRoughnessFactor(),
                    )
                    .setMetallicFactor(
                      srcMat.getMetallicFactor(),
                    )
                    .setDoubleSided(
                      srcMat.getDoubleSided(),
                    );

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

          for (const glbScene of glbDoc
            .getRoot()
            .listScenes()) {
            for (const rootNode of glbScene.listChildren()) {
              cloneNode(rootNode, clonedRoot);
            }
          }

          const instanceWrapper = doc
            .createNode(item.instanceId)
            .addChild(clonedRoot);

          applyMaterialToSubtree(
            clonedRoot,
            resolveItemMaterial(item, materials),
            doc,
            assetsDirectory,
          );

          const isHostedDoor =
            !!item.doorHostWallId;

          const appliedPersistedMatrix =
            applyPersistedGlbTransform(
              instanceWrapper,
              item,
              isHostedDoor,
            );

          if (!appliedPersistedMatrix) {
            applyAuthoredTransform(
              instanceWrapper,
              item,
              null,
              isHostedDoor,
            );
          }

          scene.addChild(instanceWrapper);

          debugLog(
            `[compiler] Mounted GLB "${item.instanceId}" (${item.name})`,
            {
              assetFrame: "catalog-glb",
              position: item.position,
              rotation: item.rotation,
              scale: item.scale,
              matrix: isFiniteMatrix16(item.matrix)
                ? item.matrix
                : null,
              matrixApplied: appliedPersistedMatrix,
            },
          );
        } else {
          const assetType = classifyAsset(
            item,
            structuralEdits,
          );
          const behavior =
            ASSET_TYPE_BEHAVIOR[assetType];

          const assetPath = resolveIfcPath(item.src);

          console.log(
            `[compiler] Loading IFC: ${item.name} -> ${assetPath}`,
          );

          if (!fs.existsSync(assetPath)) {
            console.warn(
              `[compiler] Skipping "${item.instanceId}" (${item.name}): asset not found at ${assetPath}`,
            );
            continue;
          }

          let assetBytes: Uint8Array;

          try {
            assetBytes =
              readFileAsUint8Array(assetPath);
          } catch (error) {
            console.warn(
              `[compiler] Skipping "${item.instanceId}" (${item.name}): failed to read asset - ${
                (error as Error).message
              }`,
            );
            continue;
          }

          let assetModelId: number;

          try {
            assetModelId = ifcApi.OpenModel(
              assetBytes,
              {
                COORDINATE_TO_ORIGIN: false,
              },
            );
            openModelIds.push(assetModelId);
          } catch (error) {
            console.warn(
              `[compiler] Skipping "${item.instanceId}" (${item.name}): web-ifc failed - ${
                (error as Error).message
              }`,
            );
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
              behavior.applyMaterialOverrides
                ? {
                    materialOverrides:
                      materials,
                    assetsDirectory,
                  }
                : {},
            );
          } catch (error) {
            console.warn(
              `[compiler] Skipping "${item.instanceId}" (${item.name}): extractGeometry failed - ${
                (error as Error).message
              }`,
            );
            continue;
          }

          if (assetType === AssetType.FURNITURE) {
            applyMaterialToSubtree(
              tempSubtree,
              resolveItemMaterial(
                item,
                materials,
              ),
              doc,
              assetsDirectory,
            );
          }

          const instanceWrapper = doc
            .createNode(item.instanceId)
            .addChild(tempSubtree);

          let pivot:
            | [number, number, number]
            | null = null;

          try {
            pivot =
              computeAssetPivotOffset(
                tempSubtree,
              );
          } catch (error) {
            console.warn(
              `[compiler] Pivot computation failed for "${item.instanceId}": ${
                (error as Error).message
              }; falling back to raw TRS.`,
            );
          }

          applyAuthoredTransform(
            instanceWrapper,
            item,
            pivot,
            assetType ===
              AssetType.STRUCTURAL_REPLACEMENT,
          );

          scene.addChild(instanceWrapper);

          debugLog(
            `[compiler] Mounted IFC "${item.instanceId}" (${item.name}) [${assetType}]`,
            {
              assetFrame:
                assetType ===
                AssetType.STRUCTURAL_REPLACEMENT
                  ? "native-isolation"
                  : "catalog-furniture",
              position: item.position,
              rotation: item.rotation,
              scale: item.scale,
              pivot,
              matrix: isFiniteMatrix16(item.matrix)
                ? item.matrix
                : null,
            },
          );
        }
      } catch (error) {
        console.warn(
          `[compiler] Unexpected error processing "${
            item.instanceId ?? "unknown"
          }": ${(error as Error).message}. Skipping.`,
        );
        continue;
      }
    }

    // -----------------------------------------------------------
    // BUILD RAW GLB
    // -----------------------------------------------------------

    const glbBuffer = await io.writeBinary(doc);

    fs.writeFileSync(
      RAW_GLB_PATH,
      Buffer.from(glbBuffer),
    );

    console.log(
      `[compiler] Wrote raw build GLB ${RAW_GLB_PATH} (${glbBuffer.byteLength} bytes)`,
    );

    // -----------------------------------------------------------
    // NAVIGATION FROM EXACT COMPILED GEOMETRY
    // -----------------------------------------------------------

    try {
      await WalkNavigationPipeline.run(
        RAW_GLB_PATH,
        jobDirectory,
      );
    } catch (error) {
      throw new Error(
        `Recast navigation generation failed - ${
          (error as Error).message
        }`,
      );
    }

    // -----------------------------------------------------------
    // PRODUCTION VISUAL GLB
    // -----------------------------------------------------------

    try {
      await optimizeGlb({
        inputPath: RAW_GLB_PATH,
        outputPath: OUTPUT_GLB_PATH,
        reportPath: OPTIMIZATION_REPORT_PATH,
        simplifyRatio:
          Number(
            process.env.HCI_GLB_SIMPLIFY_RATIO,
          ) || 0.70,
        simplifyError:
          Number(
            process.env.HCI_GLB_SIMPLIFY_ERROR,
          ) || 0.001,
        maxTextureSize:
          Number(
            process.env.HCI_GLB_MAX_TEXTURE_SIZE,
          ) || 2048,
        textureQuality:
          Number(
            process.env.HCI_GLB_TEXTURE_QUALITY,
          ) || 86,
      });
    } finally {
      // Never leave the massive raw build artifact in a production job.
      try {
        if (fs.existsSync(RAW_GLB_PATH)) {
          fs.rmSync(RAW_GLB_PATH, {
            force: true,
          });
        }
      } catch (cleanupError) {
        console.warn(
          `[compiler] Failed to remove temporary raw GLB: ${
            (cleanupError as Error).message
          }`,
        );
      }
    }

    if (!fs.existsSync(OUTPUT_GLB_PATH)) {
      throw new Error(
        `Production optimization completed without output.glb: ${OUTPUT_GLB_PATH}`,
      );
    }

    console.log(
      `[compiler] Production visual GLB ready at ${OUTPUT_GLB_PATH}`,
    );
  } finally {
    for (const modelId of openModelIds) {
      try {
        ifcApi.CloseModel(modelId);
      } catch (error) {
        console.warn(
          `[compiler] Warning: failed to close model ${modelId} - ${
            (error as Error).message
          }`,
        );
      }
    }
  }
}

const isMainModule =
  import.meta.url ===
  pathToFileURL(process.argv[1] ?? "").href;

if (isMainModule) {
  const [jobDirectory, assetsDirectory] =
    process.argv.slice(2);

  if (!jobDirectory || !assetsDirectory) {
    console.error(
      "Usage: npx tsx compiler.ts <jobDirectory> <assetsDirectory>",
    );
    process.exit(1);
  }

  compileScene({
    jobDirectory,
    assetsDirectory,
  })
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(
        "[compiler] Fatal error:",
        error instanceof Error
          ? error.message
          : error,
      );
      process.exit(1);
    });
}
