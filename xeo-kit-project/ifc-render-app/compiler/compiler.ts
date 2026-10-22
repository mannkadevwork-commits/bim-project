import * as fs from "fs";
import * as path from "path";
import { IfcAPI } from "web-ifc";
import * as THREE from "three";
import {
  Document,
  NodeIO,
  Node as GltfNode,
  Texture,
} from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureTransform } from "@gltf-transform/extensions";

import { extractGeometry } from "./geometry";
import { computeAssetPivotOffset, eulerToQuaternion } from "./math";
import { fileURLToPath, pathToFileURL } from "url";
import { spawnSync } from "child_process";
import { WalkNavigationPipeline } from "./navigation/WalkNavigationPipeline";
import { RoomDetector } from "./navigation/RoomDetector";
import { optimizeGlb } from "./glb-optimizer";
import { collectNodePerformanceMetrics, readJsonIfPresent, writePerformanceReport } from "./performanceReport";
import { writePresentationManifest } from "./presentationManifest";

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
  doorDimensions?: {
    width?: number;
    height?: number;
    thickness?: number;
  };
  /**
   * The editor persists GLB positions as semantic pivot targets. Reuse the
   * same pivot descriptor during compilation when it is available.
   */
  glbNormalization?: {
    version?: number;
    pivotLocal?: [number, number, number];
    pivotMode?: string;
  };
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
  // Backwards-compatible fields for projects saved before nested texture metadata was standardized.
  textureSrc?: string;
  repeat?: [number, number];
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

  let clean = String(src).split("?")[0].split("#")[0];
  // Projects saved by older editor builds sometimes persisted the browser's full
  // API URL. Resolve only local /assets paths; never fetch or read arbitrary URLs.
  if (/^https?:\/\//i.test(clean)) {
    try {
      const parsed = new URL(clean);
      if (!parsed.pathname.startsWith("/assets/")) return null;
      clean = parsed.pathname;
    } catch {
      return null;
    }
  }

  const resolveWithin = (baseDirectory: string, relativePath: string): string | null => {
    const base = path.resolve(baseDirectory);
    const candidate = path.resolve(base, relativePath);
    if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) return null;
    return fs.existsSync(candidate) ? candidate : null;
  };

  const compilerMaterials = path.join(ROOT_DIR, "materials");
  if (clean.startsWith("/materials/")) {
    return resolveWithin(compilerMaterials, clean.slice("/materials/".length));
  }

  if (clean.startsWith("/assets/")) {
    return resolveWithin(assetsDirectory, clean.slice("/assets/".length));
  }

  // Legacy absolute paths remain supported for existing local projects only.
  return path.isAbsolute(clean) && fs.existsSync(clean) ? clean : null;
}

function mimeForTexture(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

const textureTransformExtensions = new WeakMap<Document, KHRTextureTransform>();

function getTextureTransformExtension(doc: Document): KHRTextureTransform {
  let extension = textureTransformExtensions.get(doc);
  if (!extension) {
    extension = doc.createExtension(KHRTextureTransform);
    extension.setRequired(false);
    textureTransformExtensions.set(doc, extension);
  }
  return extension;
}

function applyBaseColorTextureRepeat(
  doc: Document,
  material: ReturnType<Document["createMaterial"]>,
  repeat: [number, number] | undefined,
): void {
  const textureInfo = material.getBaseColorTextureInfo();
  if (!textureInfo) return;
  const scale: [number, number] = [
    Math.max(0.05, Math.min(100, Number(repeat?.[0]) || 1)),
    Math.max(0.05, Math.min(100, Number(repeat?.[1]) || 1)),
  ];
  textureInfo.setExtension(
    "KHR_texture_transform",
    getTextureTransformExtension(doc).createTransform().setScale(scale),
  );
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

  const textureSource = materialOverride.texture?.src || materialOverride.textureSrc;
  const textureRepeat = materialOverride.texture?.repeat || materialOverride.repeat || [1, 1];
  if (
    (materialOverride.kind === "fabric" ||
      materialOverride.kind === "texture") &&
    textureSource
  ) {
    const texturePath = resolveMaterialTexturePath(
      textureSource,
      assetsDirectory,
    );

    if (texturePath) {
      sharedTexture = doc
        .createTexture(
          `Tex_${materialOverride.texture?.id || "material"}`,
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
          applyBaseColorTextureRepeat(doc, material, textureRepeat);
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


/**
 * Computes the wrapper translation for an imported asset whose geometry has
 * not been normalized around the placement pivot. Transform order in glTF is
 * T * R * S, so the scaled local pivot must be rotated before it is subtracted
 * from the target world position. Used for unnormalized catalog GLBs and
 * hosted IFC catalog doors that retain their source geometry frame.
 */
function computeRotatedFurniturePivotTranslation(
  pivot: [number, number, number],
  targetPosition: [number, number, number],
  scale: [number, number, number],
  rotationDegrees: [number, number, number],
): [number, number, number] {
  const [qx, qy, qz, qw] = eulerToQuaternion(rotationDegrees);
  const rotatedOffset = new THREE.Vector3(
    pivot[0] * scale[0],
    pivot[1] * scale[1],
    pivot[2] * scale[2],
  ).applyQuaternion(new THREE.Quaternion(qx, qy, qz, qw));

  return [
    targetPosition[0] - rotatedOffset.x,
    targetPosition[1] - rotatedOffset.y,
    targetPosition[2] - rotatedOffset.z,
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
  rotationAwarePivot = false,
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

  const translation = rotationAwarePivot
    ? computeRotatedFurniturePivotTranslation(
        pivot,
        item.position,
        scale,
        item.rotation,
      )
    : computeScaledFurniturePivotTranslation(
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


const HOSTED_DOOR_DEFAULTS = {
  door_single: { width: 0.9, height: 2.1, thickness: 0.05 },
  door_double: { width: 1.2, height: 2.1, thickness: 0.05 },
  door_sliding: { width: 2.0, height: 2.1, thickness: 0.05 },
  door_revolving: { width: 2.0, height: 2.1, thickness: 0.1 },
  door_fire: { width: 1.0, height: 2.1, thickness: 0.06 },
  door_3bhk: { width: 0.9, height: 2.1, thickness: 0.04 },
} as const;

function hostedDoorPreset(item: FurnitureItem) {
  const catalogId = String(item.id || "").toLowerCase();
  const name = String(item.name || "").toLowerCase();
  return HOSTED_DOOR_DEFAULTS[catalogId as keyof typeof HOSTED_DOOR_DEFAULTS] ??
    (name.includes("sliding") ? HOSTED_DOOR_DEFAULTS.door_sliding :
      name.includes("double") ? HOSTED_DOOR_DEFAULTS.door_double :
      name.includes("fire") ? HOSTED_DOOR_DEFAULTS.door_fire :
      name.includes("revolving") ? HOSTED_DOOR_DEFAULTS.door_revolving :
      name.includes("3bhk") ? HOSTED_DOOR_DEFAULTS.door_3bhk :
      HOSTED_DOOR_DEFAULTS.door_single);
}

interface GlbDoorBounds {
  x: number;
  y: number;
  z: number;
  min: [number, number, number];
  max: [number, number, number];
}

function measureGlbDoorBounds(document: Document): GlbDoorBounds | null {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let found = false;

  const visit = (node: GltfNode, parentWorld: THREE.Matrix4) => {
    // A glTF node may use either a matrix OR TRS. Respect the source matrix
    // when present so the measured bounds match the mesh as it is rendered.
    const sourceMatrix = node.getMatrix();
    let local: THREE.Matrix4;
    if (sourceMatrix && sourceMatrix.length === 16) {
      local = new THREE.Matrix4().fromArray(sourceMatrix);
    } else {
      const translation = node.getTranslation() || [0, 0, 0];
      const rotation = node.getRotation() || [0, 0, 0, 1];
      const scale = node.getScale() || [1, 1, 1];
      local = new THREE.Matrix4().compose(
        new THREE.Vector3(translation[0] ?? 0, translation[1] ?? 0, translation[2] ?? 0),
        new THREE.Quaternion(rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1),
        new THREE.Vector3(scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1),
      );
    }
    const world = parentWorld.clone().multiply(local);
    const mesh = node.getMesh();
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        const position = primitive.getAttribute("POSITION");
        if (!position) continue;

        // glTF-Transform v4 requires a target array for getMin/getMax.
        // Calling these with no arguments throws "Cannot set properties of
        // undefined (setting '0')", which was forcing every affected door to
        // fall back to the generic 0.9 x 2.1 m opening.
        const lo = position.getMin([]);
        const hi = position.getMax([]);
        if (!lo || !hi || lo.length < 3 || hi.length < 3) continue;
        if (![lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]].every(Number.isFinite)) continue;

        for (const x of [lo[0], hi[0]]) {
          for (const y of [lo[1], hi[1]]) {
            for (const z of [lo[2], hi[2]]) {
              const corner = new THREE.Vector3(x, y, z).applyMatrix4(world);
              min.min(corner);
              max.max(corner);
              found = true;
            }
          }
        }
      }
    }
    for (const child of node.listChildren()) visit(child, world);
  };

  for (const scene of document.getRoot().listScenes()) {
    for (const child of scene.listChildren()) visit(child, new THREE.Matrix4());
  }
  if (!found) return null;
  return {
    x: max.x - min.x,
    y: max.y - min.y,
    z: max.z - min.z,
    min: [min.x, min.y, min.z],
    max: [max.x, max.y, max.z],
  };
}

/**
 * Resolve the pivot used by the editor for a catalog GLB.
 *
 * GLBAssetTransform uses a semantic pivot (normally bottom-center) rather than
 * the raw exporter origin. Applying item.position directly to an unnormalized
 * GLB moves assets whose source scene contains baked-in offsets. Prefer the
 * persisted v3 pivot when available; otherwise measure the scene bounds and
 * derive the same bottom-center pivot as the frontend.
 */
function getCatalogFurniturePivot(
  sourceDocument: Document,
  item: FurnitureItem,
): [number, number, number] | null {
  const savedPivot = item.glbNormalization?.pivotLocal;
  if (
    item.glbNormalization?.version === 3 &&
    Array.isArray(savedPivot) &&
    savedPivot.length === 3 &&
    savedPivot.every(Number.isFinite)
  ) {
    return [savedPivot[0], savedPivot[1], savedPivot[2]];
  }

  const bounds = measureGlbDoorBounds(sourceDocument);
  if (!bounds) return null;

  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    bounds.min[1],
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

async function resolveHostedDoorDimensions(
  item: FurnitureItem,
  resolveGlbPath: (src: string) => string,
  io: NodeIO,
) {
  const dims = item.doorDimensions ?? {};
  const preset = hostedDoorPreset(item);
  const positive = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  let measured: { width: number; height: number; thickness: number } | null = null;
  try {
    const filePath = resolveGlbPath(item.src);
    if (fs.existsSync(filePath)) {
      const document = await io.read(filePath);
      const bounds = measureGlbDoorBounds(document);
      const scale = Array.isArray(item.scale) ? item.scale : [1, 1, 1];
      if (bounds) {
        const sx = bounds.x * Math.abs(Number(scale[0]) || 1);
        const sy = bounds.y * Math.abs(Number(scale[1]) || 1);
        const sz = bounds.z * Math.abs(Number(scale[2]) || 1);
        // Door assets are normally Y-up. The leaf width may be authored along
        // local X or Z, so use the larger horizontal span and the Y span as height.
        const width = Math.max(sx, sz);
        const height = sy;
        const thickness = Math.max(0.025, Math.min(sx, sz));
        // Reject unit/pivot anomalies instead of cutting a catastrophic opening.
        if (width >= 0.4 && width <= 3.0 && height >= 1.5 && height <= 3.5) {
          measured = { width, height, thickness };
        } else {
          console.warn(`[compiler:doors] ${item.name || item.instanceId}: measured GLB dimensions (${width.toFixed(3)} x ${height.toFixed(3)}m) are implausible; using configured/preset dimensions.`);
        }
      }
    }
  } catch (error) {
    console.warn(`[compiler:doors] Could not measure GLB bounds for ${item.name || item.instanceId}: ${(error as Error).message}`);
  }
  // The actual rendered GLB bounds after the persisted instance scale are
  // authoritative. Older editor builds stored preset doorDimensions even when
  // the catalog model had a different physical size, so those values are only
  // a fallback when the GLB bounds cannot be measured.
  return {
    width: positive(measured?.width, positive(dims.width, preset.width)),
    height: positive(measured?.height, positive(dims.height, preset.height)),
    thickness: positive(measured?.thickness, positive(dims.thickness, preset.thickness)),
  };
}


function buildHostedDoorGeometryRoot(
  sourceDocument: Document,
  targetDocument: Document,
  clonedRoot: GltfNode,
  item: FurnitureItem,
): GltfNode {
  // Bounds belong to the original catalog document, but clonedRoot and every
  // wrapper around it belong to the compilation document. Creating the new
  // scale/axis nodes in sourceDocument causes glTF-Transform to throw
  // "Cannot connect disconnected graphs" when they are attached to clonedRoot.
  const bounds = measureGlbDoorBounds(sourceDocument);
  if (!bounds) {
    console.warn(`[compiler:doors] ${item.instanceId}: could not normalize GLB pivot; retaining source pivot.`);
    return clonedRoot;
  }

  // The wall-host solver returns the opening's horizontal CENTER and floor
  // elevation. Normalize the asset to that same convention: horizontal
  // bounds centered at the origin, lowest point at Y=0.
  clonedRoot.setTranslation([
    -(bounds.min[0] + bounds.max[0]) / 2,
    -bounds.min[1],
    -(bounds.min[2] + bounds.max[2]) / 2,
  ]);

  const scale = Array.isArray(item.scale) ? item.scale : [1, 1, 1];
  const scaledX = bounds.x * Math.abs(Number(scale[0]) || 1);
  const scaledZ = bounds.z * Math.abs(Number(scale[2]) || 1);
  const widthAlongZ = scaledZ > scaledX;

  // Some catalog doors are authored with their leaf width on local Z, while
  // the host-wall solver aligns the portal width to local X. Keep scaling in
  // the source asset frame, then rotate the complete asset frame so non-uniform
  // scale is not accidentally applied to the wrong (post-rotation) axis.
  const scaleNode = targetDocument.createNode(`${item.instanceId}_doorAssetScale`);
  scaleNode.setScale([
    Number(scale[0]) || 1,
    Number(scale[1]) || 1,
    Number(scale[2]) || 1,
  ]);
  scaleNode.addChild(clonedRoot);

  if (!widthAlongZ) {
    console.log(`[compiler:doors] ${item.instanceId}: normalized pivot; width axis=X; bounds ${bounds.x.toFixed(3)} x ${bounds.y.toFixed(3)} x ${bounds.z.toFixed(3)}.`);
    return scaleNode;
  }

  const axisNode = targetDocument.createNode(`${item.instanceId}_doorAxisAlignment`);
  axisNode.setRotation([0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]);
  axisNode.addChild(scaleNode);
  console.log(`[compiler:doors] ${item.instanceId}: normalized pivot; width axis=Z, applying +90° local yaw; bounds ${bounds.x.toFixed(3)} x ${bounds.y.toFixed(3)} x ${bounds.z.toFixed(3)}.`);
  return axisNode;
}

interface HostedDoorSpec {
  instanceId: string;
  assetId: string;
  wallGlobalId: string;
  position: [number, number, number];
  dimensions: { width: number; height: number; thickness: number };
}

async function collectHostedGlbDoors(
  furniture: FurnitureItem[],
  resolveGlbPath: (src: string) => string,
  io: NodeIO,
): Promise<HostedDoorSpec[]> {
  const hosted = furniture.filter((item) => isGlbFurnitureItem(item) && Boolean(item.doorHostWallId));
  return Promise.all(hosted.map(async (item) => {
    if (!Array.isArray(item.position) || item.position.length !== 3 || item.position.some((value) => !Number.isFinite(value))) {
      throw new Error(`Hosted GLB door ${item.instanceId} has invalid persisted position.`);
    }
    return {
      instanceId: item.instanceId,
      assetId: item.id,
      wallGlobalId: String(item.doorHostWallId),
      position: [Number(item.position[0]), Number(item.position[1]), Number(item.position[2])],
      dimensions: await resolveHostedDoorDimensions(item, resolveGlbPath, io),
    };
  }));
}

function isGlbFurnitureItem(item: FurnitureItem): boolean {
  const explicit = String((item as any).assetFormat ?? item.fileType ?? (item as any).file_type ?? "").toLowerCase();
  const src = String(item.src || "").toLowerCase().split("?")[0].split("#")[0];
  return explicit === "glb" || explicit === "gltf" || src.endsWith(".glb") || src.endsWith(".gltf");
}

function looksLikeDoorFurniture(item: FurnitureItem): boolean {
  const identity = `${String(item.id || "")} ${String(item.name || "")}`.toLowerCase();
  const source = String(item.src || "").toLowerCase().split("?")[0].split("#")[0];

  // The editor creates IFC wall-only preview artifacts whose filenames contain
  // the word "door" (for example *_door_<timestamp>_preview.ifc). They are
  // edited wall geometry, not door assets, and must never enter the GLB-door
  // hosting workflow.
  if (/\bwall\s+with\s+void\b/.test(identity)) return false;
  if (/\b(door\s*mat|doormat|doorstop|door\s*stop|doorbell)\b/.test(identity)) return false;

  // Classification is based first on the user-facing catalog identity. Use the
  // source basename only as a fallback for catalogs with a generic item name.
  if (/\bdoor\b|door[_-]/i.test(identity)) return true;
  const sourceName = source.split(/[\\/]/).pop() || "";
  if (/_preview\.ifc$/i.test(sourceName) || /wall[_ -]?with[_ -]?void/i.test(sourceName)) return false;
  return /\bdoor\b|door[_-]/i.test(sourceName);
}

function tagWalkablePortalNodes(root: GltfNode, item: FurnitureItem): void {
  if (!item.doorHostWallId) return;
  const extras = {
    hciWalkablePortal: true,
    hciPortalType: "door",
    hciPortalInstanceId: String(item.instanceId),
    hciDoorHostWallId: String(item.doorHostWallId),
  };
  const visit = (node: GltfNode) => {
    // Tag mesh-bearing nodes, not just the wrapper: flatten() in the visual
    // optimizer can remove transform-only parents, but mesh-node extras survive.
    if (node.getMesh()) node.setExtras({ ...(node.getExtras() || {}), ...extras });
    for (const child of node.listChildren()) visit(child);
  };
  root.setExtras({ ...(root.getExtras() || {}), ...extras });
  visit(root);
}

function warnAboutUnhostedDoorAssets(furniture: FurnitureItem[]): void {
  // This warning is specifically about catalog GLB doors that need compiler-
  // generated wall openings. Native IFC doors and wall-preview IFCs have their
  // own structural path and should not be counted as unhosted GLB doors.
  const candidates = furniture.filter((item) => isGlbFurnitureItem(item) && looksLikeDoorFurniture(item));
  const unhosted = candidates.filter((item) => !item.doorHostWallId);
  if (!unhosted.length) return;
  console.warn(
    `[compiler:doors] ${unhosted.length} door-like asset(s) have no doorHostWallId and therefore cannot create a physical wall opening: ${unhosted.map((item) => `${item.name || item.id} [${item.instanceId}]`).join(", ")}. Remove and re-place them on an IFC wall using the door wall-snap flow.`,
  );
}

function resolvePythonCommand(): string {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const command of candidates) {
    const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return command;
  }
  return candidates[0];
}

async function prepareStructuralIfcForHostedDoors(
  jobDirectory: string,
  inputIfcPath: string,
  furniture: FurnitureItem[],
  resolveGlbPath: (src: string) => string,
): Promise<{ inputPath: string; hostedDoors: HostedDoorSpec[]; appliedDoors: any[] }> {
  const hostedDoors = await collectHostedGlbDoors(furniture, resolveGlbPath, new NodeIO().registerExtensions(ALL_EXTENSIONS));
  if (!hostedDoors.length) return { inputPath: inputIfcPath, hostedDoors, appliedDoors: [] };

  const editorScript = path.join(ROOT_DIR, "..", "ifc_element_editor.py");
  if (!fs.existsSync(editorScript)) {
    throw new Error(`Hosted GLB doors require ifc_element_editor.py at ${editorScript}`);
  }

  const presentationDir = path.join(jobDirectory, "presentation");
  fs.mkdirSync(presentationDir, { recursive: true });
  const specsPath = path.join(presentationDir, "hosted_door_specs.json");
  const outputPath = path.join(presentationDir, "structural_with_hosted_door_openings.ifc");
  fs.writeFileSync(specsPath, JSON.stringify({ version: 1, doors: hostedDoors }, null, 2), "utf8");

  const command = resolvePythonCommand();
  const result = spawnSync(
    command,
    [editorScript, "apply-hosted-doors", "--input", inputIfcPath, "--output", outputPath, "--door-specs", specsPath],
    { encoding: "utf8", cwd: path.join(ROOT_DIR, "..") },
  );
  if (result.error) throw new Error(`Failed to launch hosted-door preparation: ${result.error.message}`);
  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`Hosted-door IFC preparation failed.${detail ? ` ${detail}` : ""}`);
  }

  let response: any;
  try {
    response = JSON.parse(String(result.stdout || "{}"));
  } catch {
    throw new Error(`Hosted-door preparation returned invalid JSON: ${String(result.stdout || "").trim()}`);
  }
  if (response?.error) throw new Error(response.error);

  for (const door of hostedDoors) {
    console.log(`[compiler:doors] ${door.instanceId}: opening ${door.dimensions.width.toFixed(3)}m W x ${door.dimensions.height.toFixed(3)}m H (asset bounds × instance scale).`);
  }
  console.log(`[compiler:doors] Physical portal preparation applied ${hostedDoors.length} GLB door opening(s).`);
  return { inputPath: outputPath, hostedDoors, appliedDoors: Array.isArray(response?.doors) ? response.doors : [] };
}

function toPresentationVec3(value: any): [number, number, number] | null {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [value.x, value.y, value.z]
      : null;
  if (!values || values.length < 3) return null;
  const result = values.slice(0, 3).map(Number);
  if (result.some((entry: number) => !Number.isFinite(entry))) return null;
  return [result[0], result[1], result[2]];
}

// RoomDetector currently derives room regions from wall-grid components, so its
// component centers can be several metres from a doorway. Do not bridge unrelated
// room regions across the house just because they lie on opposite sides of a wall.
const MAX_ROOM_CENTER_PORTAL_ASSOCIATION_DISTANCE_METERS = 5.0;

function roomCenterForPortalSide(
  rooms: any[],
  center: [number, number, number],
  normal: { x: number; z: number },
  side: 1 | -1,
  probeOffset: number,
): string | null {
  const probeX = center[0] + normal.x * probeOffset * side;
  const probeZ = center[2] + normal.z * probeOffset * side;
  const candidates = rooms
    .map((room: any) => {
      const roomCenter = toPresentationVec3(room?.center);
      if (!room?.id || !roomCenter) return null;
      const signedSideDistance = (roomCenter[0] - center[0]) * normal.x
        + (roomCenter[2] - center[2]) * normal.z;
      // A room center must genuinely lie on the sampled side of the wall.
      // Nearest-center-only inference often assigned both sides to the same
      // large room polygon, hiding valid GLB-door adjacency.
      if (signedSideDistance * side < 0.08) return null;
      return {
        id: String(room.id),
        distance: Math.hypot(roomCenter[0] - probeX, roomCenter[2] - probeZ),
        sideDistance: Math.abs(signedSideDistance),
      };
    })
    .filter(Boolean) as Array<{ id: string; distance: number; sideDistance: number }>;
  candidates.sort((a, b) => a.distance - b.distance || a.sideDistance - b.sideDistance);
  const nearest = candidates[0];
  // Keep associations local. The previous 12 m threshold could attach an
  // unrelated room across the building to the far side of an exterior or
  // internal portal, producing a plausible-looking but false graph edge.
  return nearest && nearest.distance <= MAX_ROOM_CENTER_PORTAL_ASSOCIATION_DISTANCE_METERS
    ? nearest.id
    : null;
}

function inferHostedPortalRooms(rooms: any[], hosted: HostedDoorSpec, applied: any) {
  const center = toPresentationVec3(applied?.doorPlacement?.position) ?? hosted.position;
  // IFC axes are Z-up. The hosted-door response is converted to the frontend
  // Y-up basis as (x, z, -y), so only IFC X/Y components become frontend X/Z.
  const rawAxis = applied?.hostPlacement?.thicknessAxis;
  let nx = Array.isArray(rawAxis) ? Number(rawAxis[0]) : 0;
  let nz = Array.isArray(rawAxis) ? -Number(rawAxis[1]) : 0;
  let norm = Math.hypot(nx, nz);
  if (!Number.isFinite(norm) || norm < 1e-5) {
    const yaw = Number(applied?.doorPlacement?.rotation?.[1] ?? 0) * Math.PI / 180;
    nx = -Math.sin(yaw);
    nz = Math.cos(yaw);
    norm = Math.hypot(nx, nz);
  }
  if (!Number.isFinite(norm) || norm < 1e-5) {
    return { roomA: null, roomB: null, center, normal: null };
  }
  nx /= norm;
  nz /= norm;
  const wallThickness = Number(applied?.hostPlacement?.wallThickness);
  const probeOffset = Math.max(0.45, (Number.isFinite(wallThickness) ? wallThickness : 0.2) * 0.5 + 0.3);
  const normal = { x: nx, z: nz };
  const roomA = roomCenterForPortalSide(rooms, center, normal, 1, probeOffset);
  const roomB = roomCenterForPortalSide(rooms, center, normal, -1, probeOffset);
  const resolvedRoomA = roomA && roomB && roomA === roomB ? null : roomA;
  const resolvedRoomB = roomA && roomB && roomA === roomB ? null : roomB;
  return {
    roomA: resolvedRoomA,
    roomB: resolvedRoomB,
    roomAssociationStatus: resolvedRoomA && resolvedRoomB
      ? "two-room-centers-within-threshold"
      : (resolvedRoomA || resolvedRoomB)
        ? "one-sided-or-exterior"
        : "no-confident-room-side",
    center,
    normal: [nx, 0, nz] as [number, number, number],
  };
}

function buildPresentationPortalManifest(
  roomArtifact: any,
  hostedDoors: HostedDoorSpec[],
  appliedDoors: any[],
) {
  const rawRooms = Array.isArray(roomArtifact?.rooms) ? roomArtifact.rooms : [];
  const rooms = rawRooms.map((room: any) => ({ ...room, center: toPresentationVec3(room?.center) }));
  const sourcePortals = Array.isArray(roomArtifact?.portals) ? roomArtifact.portals : [];
  const portals = sourcePortals.map((portal: any) => ({
    ...portal,
    center: toPresentationVec3(portal?.center),
    normal: toPresentationVec3(portal?.normal),
    physical: true,
    walkable: true,
  })).filter((portal: any) => Array.isArray(portal.center));

  const distanceXZ = (a: any, b: any) => {
    const av = toPresentationVec3(a);
    const bv = toPresentationVec3(b);
    return av && bv ? Math.hypot(av[0] - bv[0], av[2] - bv[2]) : Infinity;
  };
  for (const hosted of hostedDoors) {
    const applied = appliedDoors.find((entry: any) => String(entry?.instanceId || "") === hosted.instanceId) ?? null;
    const placement = toPresentationVec3(applied?.doorPlacement?.position) ?? hosted.position;
    const inferred = inferHostedPortalRooms(rooms, hosted, applied);
    const openingId = applied?.openingGlobalId ?? null;
    const match = portals.find((portal: any) =>
      (openingId && portal.openingGlobalId === openingId) ||
      (portal.hostWallId && portal.hostWallId === hosted.wallGlobalId && distanceXZ(portal.center, placement) < 0.45)
    );
    if (match) {
      match.type = "door";
      match.renderType = "glb";
      match.assetInstanceId = hosted.instanceId;
      match.assetId = hosted.assetId;
      match.hostWallId = hosted.wallGlobalId;
      match.center = placement;
      match.width = hosted.dimensions.width;
      match.height = hosted.dimensions.height;
      if (inferred.roomA && inferred.roomB && inferred.roomA !== inferred.roomB) {
        match.roomA = inferred.roomA;
        match.roomB = inferred.roomB;
      } else if (!(match.roomA && match.roomB && match.roomA !== match.roomB)) {
        match.roomA = null;
        match.roomB = null;
      }
      match.normal = inferred.normal ?? match.normal ?? null;
      match.walkable = true;
      match.roomAssociationStatus = inferred.roomAssociationStatus;
    } else {
      portals.push({
        id: `portal-${hosted.instanceId}`,
        type: "door",
        renderType: "glb",
        assetInstanceId: hosted.instanceId,
        assetId: hosted.assetId,
        hostWallId: hosted.wallGlobalId,
        center: placement,
        roomA: inferred.roomA,
        roomB: inferred.roomB,
        roomAssociationStatus: inferred.roomAssociationStatus,
        normal: inferred.normal,
        width: hosted.dimensions.width,
        height: hosted.dimensions.height,
        physical: true,
        walkable: true,
        source: "hosted-glb-fallback",
      });
    }
  }

  const adjacency: Record<string, string[]> = Object.fromEntries(rooms.map((room: any) => [String(room.id), []]));
  for (const room of rooms) room.portals = [];
  for (const portal of portals) {
    const pair = [portal.roomA, portal.roomB].filter((id: any) => Boolean(id && adjacency[String(id)]));
    for (const roomId of pair) {
      const room = rooms.find((candidate: any) => String(candidate.id) === String(roomId));
      if (room && !room.portals.includes(portal.id)) room.portals.push(portal.id);
    }
    if (pair.length === 2 && pair[0] !== pair[1]) {
      if (!adjacency[String(pair[0])].includes(String(pair[1]))) adjacency[String(pair[0])].push(String(pair[1]));
      if (!adjacency[String(pair[1])].includes(String(pair[0]))) adjacency[String(pair[1])].push(String(pair[0]));
    }
  }
  const connectedPortalCount = portals.filter((p: any) => p.roomA && p.roomB && p.roomA !== p.roomB).length;
  return {
    version: 3,
    coordinateSystem: "three-y-up-arrays",
    source: "compiled-physical-portals",
    rooms,
    portals,
    graph: {
      version: 1,
      nodeType: "detected-room",
      adjacency,
      edges: portals.filter((p: any) => p.roomA && p.roomB && p.roomA !== p.roomB).map((p: any) => ({
        id: `edge-${p.id}`, portalId: p.id, from: p.roomA, to: p.roomB,
        source: p.source || "hosted-glb-door", status: "pending-navmesh-validation",
      })),
      validation: "semantic-room-sides-inferred-from-room-center-half-planes; navigation-validation-pending",
    },
    stats: {
      roomCount: rooms.length,
      portalCount: portals.length,
      hostedGlbDoorCount: hostedDoors.length,
      connectedPortalCount,
      disconnectedPortalCount: Math.max(0, portals.length - connectedPortalCount),
      oneSidedPortalCount: portals.filter((p: any) => Boolean(p.roomA) !== Boolean(p.roomB)).length,
      unmappedPortalCount: portals.filter((p: any) => !p.roomA && !p.roomB).length,
      roomCenterAssociationDistanceLimitMeters: MAX_ROOM_CENTER_PORTAL_ASSOCIATION_DISTANCE_METERS,
    },
  };
}

export async function compileScene(
  options: CompileSceneOptions,
): Promise<void> {
  const { jobDirectory, assetsDirectory } = options;
  const performanceStartedAt = Date.now();
  const performanceStages: Record<string, number> = {};
  let performanceStageStartedAt = Date.now();
  const sourceAssetInfoByInstance = new Map<string, {
    name: string;
    assetId: string;
    sourceFormat: string;
    sourceFile: string;
    sourcePath: string;
    sourceBytes: number;
  }>();
  const assetProcessingMsByInstance = new Map<string, number>();

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
  performanceStages.projectStateReadMs = Date.now() - performanceStageStartedAt;
  performanceStageStartedAt = Date.now();

  const structuralEdits =
    projectState.structural_edits ?? {};
  const materials = projectState.materials ?? {};

  warnAboutUnhostedDoorAssets(projectState.furniture);
  const walkableHostedDoorCount = projectState.furniture.filter((item) => Boolean(item.doorHostWallId)).length;
  console.log(`[compiler:doors] Hosted door instances with wall metadata: ${walkableHostedDoorCount}`);
  const hostedDoorBuild = await prepareStructuralIfcForHostedDoors(
    jobDirectory,
    INPUT_IFC_PATH,
    projectState.furniture,
    resolveGlbPath,
  );
  performanceStages.structuralIfcAndHostedDoorPreparationMs = Date.now() - performanceStageStartedAt;
  performanceStageStartedAt = Date.now();
  const structuralIfcBytes = readFileAsUint8Array(hostedDoorBuild.inputPath);

  // Presentation room topology is generated from the same physical IFC that
  // feeds the structural GLB. Native IFC openings and compiled GLB-door
  // openings therefore share the same room/portal model. A failure here must
  // not prevent the visual render, but the artifact is strongly preferred for
  // a room-aware presentation runtime.
  const roomTopologyStartedAt = Date.now();
  try {
    const roomArtifact = await RoomDetector.run({
      jobDirectory,
      inputIfcPath: hostedDoorBuild.inputPath,
      outputPath: path.join(jobDirectory, "presentation_rooms.json"),
    });
    const portalManifest = buildPresentationPortalManifest(
      roomArtifact,
      hostedDoorBuild.hostedDoors,
      hostedDoorBuild.appliedDoors,
    );
    fs.writeFileSync(
      path.join(jobDirectory, "presentation_portals.json"),
      JSON.stringify(portalManifest, null, 2),
      "utf8",
    );
    console.log(
      `[compiler:portals] Rooms: ${portalManifest.stats.roomCount}; portals: ${portalManifest.stats.portalCount}; room-connected portals: ${portalManifest.stats.connectedPortalCount}.`,
    );
  } catch (error) {
    console.warn(
      `[compiler:rooms] Presentation room topology failed; continuing render - ${(error as Error).message}`,
    );
    fs.writeFileSync(
      path.join(jobDirectory, "presentation_portals.json"),
      JSON.stringify(buildPresentationPortalManifest({ rooms: [], portals: [] }, hostedDoorBuild.hostedDoors, hostedDoorBuild.appliedDoors), null, 2),
      "utf8",
    );
  } finally {
    performanceStages.roomTopologyMs = Date.now() - roomTopologyStartedAt;
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

  performanceStageStartedAt = Date.now();
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

    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const appliedHostedDoorByInstance = new Map<string, any>(
      hostedDoorBuild.appliedDoors
        .filter((entry: any) => entry?.instanceId)
        .map((entry: any) => [String(entry.instanceId), entry]),
    );

    for (const persistedItem of projectState.furniture) {
      const assetProcessingStartedAt = Date.now();
      const appliedHostedDoor = persistedItem.doorHostWallId
        ? appliedHostedDoorByInstance.get(String(persistedItem.instanceId))
        : null;
      const authoritativePosition = toPresentationVec3(appliedHostedDoor?.doorPlacement?.position);
      const authoritativeRotation = toPresentationVec3(appliedHostedDoor?.doorPlacement?.rotation);
      const item: FurnitureItem = authoritativePosition
        ? {
            ...persistedItem,
            position: authoritativePosition,
            rotation: authoritativeRotation ?? persistedItem.rotation,
            // Hosted-door world transform comes from the wall-host solver; a
            // stale persisted editor matrix must not override the snapped frame.
            matrix: undefined,
          }
        : persistedItem;
      if (authoritativePosition && Array.isArray(persistedItem.position)) {
        const delta = Math.hypot(
          Number(persistedItem.position[0]) - authoritativePosition[0],
          Number(persistedItem.position[1]) - authoritativePosition[1],
          Number(persistedItem.position[2]) - authoritativePosition[2],
        );
        if (delta > 0.015) {
          console.log(`[compiler:doors] Aligning visual door ${item.instanceId} to computed wall portal (delta ${delta.toFixed(3)} units).`);
        }
      }

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
          sourceAssetInfoByInstance.set(String(item.instanceId), {
            name: item.name || String(item.instanceId),
            assetId: String(item.id || ""),
            sourceFormat: "glb",
            sourceFile: path.basename(assetPath),
            sourcePath: path.resolve(assetPath),
            sourceBytes: fs.statSync(assetPath).size,
          });

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

          const isHostedDoor = Boolean(item.doorHostWallId);
          // Hosted doors keep their dedicated wall-opening normalization.
          // Regular catalog GLBs must use the same semantic pivot contract as
          // GLBAssetTransform in the editor.
          const catalogFurniturePivot = isHostedDoor
            ? null
            : getCatalogFurniturePivot(glbDoc, item);
          if (!isHostedDoor && !catalogFurniturePivot) {
            console.warn(
              `[compiler:glb-transform] ${item.instanceId}: source bounds unavailable; retaining the GLB source origin.`,
            );
          }
          const clonedRoot = doc.createNode(
            `${item.instanceId}_geometry`,
          );

          function cloneNode(
            srcNode: GltfNode,
            parentDst: GltfNode,
          ): void {
            // Tag mesh-bearing nodes with an explicit hosted-door marker.
            // NavMesh extraction cannot reliably infer instance identity from
            // parent/wrapper names after GLB serialization in the current pipeline.
            const sourceNodeName = srcNode.getName() || "unnamed";
            const destinationNodeName = isHostedDoor && srcNode.getMesh()
              ? `HCI_HOSTED_DOOR::${item.instanceId}::${sourceNodeName}`
              : sourceNodeName;
            const dstNode = doc.createNode(destinationNodeName);

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

          const hostedGeometryRoot = isHostedDoor
            ? buildHostedDoorGeometryRoot(glbDoc, doc, clonedRoot, item)
            : clonedRoot;
          const instanceWrapper = doc
            .createNode(item.instanceId)
            .addChild(hostedGeometryRoot);
          tagWalkablePortalNodes(instanceWrapper, item);

          applyMaterialToSubtree(
            clonedRoot,
            resolveItemMaterial(item, materials),
            doc,
            assetsDirectory,
          );

          const appliedPersistedMatrix =
            applyPersistedGlbTransform(
              instanceWrapper,
              item,
              isHostedDoor,
            );

          if (!appliedPersistedMatrix) {
            const placementItem: FurnitureItem = isHostedDoor
              ? { ...item, scale: [1, 1, 1] }
              : item;
            applyAuthoredTransform(
              instanceWrapper,
              placementItem,
              isHostedDoor ? null : catalogFurniturePivot,
              isHostedDoor,
              !isHostedDoor,
            );
          }

          scene.addChild(instanceWrapper);
          assetProcessingMsByInstance.set(String(item.instanceId), Date.now() - assetProcessingStartedAt);

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
          sourceAssetInfoByInstance.set(String(item.instanceId), {
            name: item.name || String(item.instanceId),
            assetId: String(item.id || ""),
            sourceFormat: "ifc",
            sourceFile: path.basename(assetPath),
            sourcePath: path.resolve(assetPath),
            sourceBytes: fs.statSync(assetPath).size,
          });

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
          tagWalkablePortalNodes(instanceWrapper, item);

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

          // Hosted GLB doors are normalized in the GLB path and keep their
          // bottom-center frame unchanged. Hosted IFC catalog doors do not
          // have that normalization metadata: extractGeometry bakes source IFC
          // placements into imported vertices, so apply the measured
          // bottom-center pivot to align the visible IFC door with its opening.
          // Structural replacement IFCs (including wall previews) retain their
          // native frame and must not be pivot-normalized here.
          const isHostedIfcCatalogDoor =
            Boolean(item.doorHostWallId) &&
            assetType !== AssetType.STRUCTURAL_REPLACEMENT;

          applyAuthoredTransform(
            instanceWrapper,
            item,
            pivot,
            assetType === AssetType.STRUCTURAL_REPLACEMENT,
            isHostedIfcCatalogDoor,
          );

          scene.addChild(instanceWrapper);
          assetProcessingMsByInstance.set(String(item.instanceId), Date.now() - assetProcessingStartedAt);

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

    let rawSceneMetrics: any = null;
    let sceneMetricCollectionError: string | null = null;
    const compiledAssetMetricsByInstance = new Map<string, any>();
    let topLevelSceneMetrics: Array<{ name: string; metrics: any }> = [];
    try {
      rawSceneMetrics = collectNodePerformanceMetrics(scene as any);
      topLevelSceneMetrics = scene.listChildren().map((node) => {
        const name = node.getName() || "unnamed";
        const metrics = collectNodePerformanceMetrics(node as any);
        if (name && name !== "IFC_Structure" && name !== "IFC_Structure_Frame") {
          compiledAssetMetricsByInstance.set(name, metrics);
        }
        return { name, metrics };
      });
    } catch (metricsError) {
      sceneMetricCollectionError = (metricsError as Error).message;
      console.warn(`[compiler:perf] Scene metric collection failed; continuing render - ${sceneMetricCollectionError}`);
    }
    const glbBuffer = await io.writeBinary(doc);

    fs.writeFileSync(
      RAW_GLB_PATH,
      Buffer.from(glbBuffer),
    );

    console.log(
      `[compiler] Wrote raw build GLB ${RAW_GLB_PATH} (${glbBuffer.byteLength} bytes)`,
    );
    performanceStages.sceneAssemblyAndRawExportMs = Date.now() - performanceStageStartedAt;
    performanceStageStartedAt = Date.now();

    if (hostedDoorBuild.hostedDoors.length) {
      fs.writeFileSync(
        path.join(jobDirectory, "hosted_door_portals.json"),
        JSON.stringify({
          version: 1,
          doors: hostedDoorBuild.appliedDoors,
          sourceSpecs: hostedDoorBuild.hostedDoors,
        }, null, 2),
        "utf8",
      );
    }

    // -----------------------------------------------------------
    // NAVIGATION FROM EXACT COMPILED GEOMETRY
    // -----------------------------------------------------------

    const navigationStartedAt = Date.now();
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
    performanceStages.navigationBuildMs = Date.now() - navigationStartedAt;

    // -----------------------------------------------------------
    // PRODUCTION VISUAL GLB
    // -----------------------------------------------------------

    const optimizationStartedAt = Date.now();
    let optimizationStats: any = null;
    try {
      optimizationStats = await optimizeGlb({
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
    performanceStages.visualOptimizationMs = Date.now() - optimizationStartedAt;

    if (!fs.existsSync(OUTPUT_GLB_PATH)) {
      throw new Error(
        `Production optimization completed without output.glb: ${OUTPUT_GLB_PATH}`,
      );
    }

    const structuralNode = topLevelSceneMetrics.find((entry) =>
      entry.name === "IFC_Structure" || entry.name === "IFC_Structure_Frame",
    );
    const assetReports = projectState.furniture.map((item) => {
      const instanceId = String(item.instanceId || "unknown");
      const source = sourceAssetInfoByInstance.get(instanceId) ?? null;
      const metrics = compiledAssetMetricsByInstance.get(instanceId) ?? null;
      const triangleCount = Number(metrics?.triangleCount ?? 0);
      const vertexCount = Number(metrics?.vertexCount ?? 0);
      const primitiveCount = Number(metrics?.primitiveCount ?? 0);
      const sourceBytes = Number(source?.sourceBytes ?? 0);
      const complexityTier = triangleCount >= 300000 || vertexCount >= 500000 || primitiveCount >= 250 || sourceBytes >= 20 * 1024 * 1024
        ? "heavy"
        : triangleCount >= 75000 || vertexCount >= 150000 || primitiveCount >= 80 || sourceBytes >= 5 * 1024 * 1024
          ? "medium"
          : "light";
      return {
        instanceId,
        name: item.name || instanceId,
        assetId: String(item.id || ""),
        sourceFormat: source?.sourceFormat ?? (String(item.src || "").toLowerCase().endsWith(".glb") ? "glb" : "ifc"),
        sourceFile: source?.sourceFile ?? path.basename(String(item.src || "")),
        sourceBytes: source?.sourceBytes ?? null,
        sourceAssetUniqueKey: source?.sourcePath ?? null,
        includedInScene: Boolean(metrics),
        status: metrics ? "mounted" : (source ? "source-found-but-not-mounted" : "source-not-resolved"),
        compileDurationMs: assetProcessingMsByInstance.get(instanceId) ?? null,
        complexityTier,
        metrics,
        scale: Array.isArray(item.scale) ? item.scale : null,
        doorHostWallId: item.doorHostWallId ?? null,
      };
    });
    const uniqueSourceFiles = new Map<string, number>();
    for (const asset of assetReports) {
      if (asset.sourceAssetUniqueKey && asset.sourceBytes != null && !uniqueSourceFiles.has(asset.sourceAssetUniqueKey)) {
        uniqueSourceFiles.set(asset.sourceAssetUniqueKey, asset.sourceBytes);
      }
    }
    const finalBytes = fs.statSync(OUTPUT_GLB_PATH).size;
    const navMeshPath = path.join(jobDirectory, "navigation_navmesh.bin");
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      jobId: path.basename(jobDirectory),
      purpose: "Phase 0 performance baseline; observational only, does not alter scene quality or navigation.",
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        glbSimplifyRatioRequested: Number(process.env.HCI_GLB_SIMPLIFY_RATIO) || 0.70,
        glbSimplifyErrorRequested: Number(process.env.HCI_GLB_SIMPLIFY_ERROR) || 0.001,
        glbMaxTextureSizeRequested: Number(process.env.HCI_GLB_MAX_TEXTURE_SIZE) || 2048,
        glbTextureQualityRequested: Number(process.env.HCI_GLB_TEXTURE_QUALITY) || 86,
      },
      sceneMetricCollectionError,
      totalCompileMs: Date.now() - performanceStartedAt,
      stageDurationsMs: performanceStages,
      sourceScene: {
        rawGlbBytes: glbBuffer.byteLength,
        rawGlbMiB: Number((glbBuffer.byteLength / (1024 * 1024)).toFixed(3)),
        metrics: rawSceneMetrics,
        structuralIfc: {
          sourceFile: path.basename(hostedDoorBuild.inputPath),
          sourceBytes: fs.existsSync(hostedDoorBuild.inputPath) ? fs.statSync(hostedDoorBuild.inputPath).size : null,
          compiledMetrics: structuralNode?.metrics ?? null,
        },
        mountedAssetInstances: assetReports.filter((asset) => asset.includedInScene).length,
        totalAssetInstancesInState: assetReports.length,
        missingAssetInstances: assetReports.filter((asset) => !asset.includedInScene).map((asset) => ({ instanceId: asset.instanceId, name: asset.name, status: asset.status })),
        uniqueSourceAssetCount: uniqueSourceFiles.size,
        uniqueSourceAssetBytes: Array.from(uniqueSourceFiles.values()).reduce((sum, bytes) => sum + bytes, 0),
      },
      productionGlb: {
        fileBytes: finalBytes,
        fileMiB: Number((finalBytes / (1024 * 1024)).toFixed(3)),
        optimizer: optimizationStats ?? readJsonIfPresent(OPTIMIZATION_REPORT_PATH),
      },
      navigation: {
        navMeshBytes: fs.existsSync(navMeshPath) ? fs.statSync(navMeshPath).size : null,
        metadata: readJsonIfPresent(path.join(jobDirectory, "navigation_meta.json")),
        connectivity: readJsonIfPresent(path.join(jobDirectory, "room_connectivity.json")),
        doorwayTraversability: readJsonIfPresent(path.join(jobDirectory, "doorway_traversability.json")),
      },
      assets: assetReports.map(({ sourceAssetUniqueKey, ...asset }) => asset),
      topAssetsByTriangleCount: assetReports
        .filter((asset) => asset.metrics)
        .sort((a, b) => Number(b.metrics?.triangleCount || 0) - Number(a.metrics?.triangleCount || 0))
        .slice(0, 10)
        .map((asset) => ({
          instanceId: asset.instanceId,
          name: asset.name,
          triangleCount: asset.metrics?.triangleCount ?? 0,
          vertexCount: asset.metrics?.vertexCount ?? 0,
          primitiveCount: asset.metrics?.primitiveCount ?? 0,
          materialCount: asset.metrics?.materialCount ?? 0,
          textureCount: asset.metrics?.textureCount ?? 0,
          sourceBytes: asset.sourceBytes,
          compileDurationMs: asset.compileDurationMs,
        })),
    };
    try {
      const performanceReportPath = writePerformanceReport(jobDirectory, report);
      console.log(`[compiler:perf] Wrote performance_report.json (${assetReports.length} asset instances; raw ${(glbBuffer.byteLength / (1024 * 1024)).toFixed(2)} MiB; final ${(finalBytes / (1024 * 1024)).toFixed(2)} MiB).`);
      console.log(`[compiler:perf] Report: ${performanceReportPath}`);
    } catch (reportError) {
      // Performance instrumentation must never fail a render.
      console.warn(`[compiler:perf] Failed to write optional performance report: ${(reportError as Error).message}`);
    }

    try {
      const presentationManifestPath = writePresentationManifest(jobDirectory);
      console.log(`[compiler:manifest] Wrote presentation_manifest.json: ${presentationManifestPath}`);
    } catch (manifestError) {
      // Presentation settings are defaults/metadata; they must never fail an otherwise valid render.
      console.warn(`[compiler:manifest] Could not write optional presentation manifest: ${(manifestError as Error).message}`);
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
