import * as fs from "node:fs";
import * as path from "node:path";
import * as THREE from "three";
import { Primitive as GltfPrimitive } from "@gltf-transform/core";
import type { Buffer as GltfBuffer, Document, Node as GltfNode, Scene as GltfScene, Material as GltfMaterial } from "@gltf-transform/core";

type Point2 = { x: number; z: number };
type Point3 = [number, number, number];
type SceneScale = { x?: number; y?: number; z?: number };
type UVBounds = { minX: number; minY: number; minZ: number; sizeX: number; sizeY: number; sizeZ: number };
type GeometryBuilder = { positions: number[]; normals: number[]; uvs: number[]; indices: number[]; bounds: UVBounds };

type CeilingFinish = {
  kind?: "color" | "fabric" | "texture";
  color?: string;
  rgb?: [number, number, number];
  texture?: { id?: string; name?: string; src?: string; repeat?: [number, number] } | null;
  textureSrc?: string;
  repeat?: [number, number];
  roughness?: number;
  metallic?: number;
};

interface CeilingDesign {
  id?: string;
  roomId?: string;
  label?: string;
  visible?: boolean;
  profileType?: "flat" | "cove" | "timber-slats";
  boundary?: { outer?: Point2[]; holes?: Point2[][] };
  polygon?: Point2[];
  openings?: Array<any>;
  elevation?: number | { finishedBottomY?: number; thickness?: number; unit?: string };
  thickness?: number;
  finish?: CeilingFinish;
  color?: string;
}

export interface CeilingCompileSummary {
  created: number;
  skipped: number;
  triangleCount: number;
}

const DEFAULT_COLOR = "#F3F1EB";
const DEFAULT_WOOD = "#A77B4A";
const MIN_RING_AREA_M2 = 0.01;
// Recessed downlights commonly use 50–100 mm diameter cut-outs.
// Keep a separate, smaller threshold for authored openings; room footprints
// still use MIN_RING_AREA_M2 so tiny/degenerate rooms remain rejected.
const MIN_OPENING_AREA_M2 = 0.0005;
const MIN_POINT_DISTANCE_M = 0.0005;

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeId(value: unknown, fallback: string): string {
  const normalized = String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized.slice(0, 72) || fallback;
}

function normalizeRing(source: unknown, label: string, minimumArea = MIN_RING_AREA_M2): Point2[] {
  if (!Array.isArray(source)) throw new Error(`${label} is missing.`);
  const points = source
    .map((point: any) => ({ x: finite(point?.x, Number.NaN), z: finite(point?.z, Number.NaN) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));

  const cleaned = points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    return !previous || Math.hypot(point.x - previous.x, point.z - previous.z) > MIN_POINT_DISTANCE_M;
  });

  if (cleaned.length > 2) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.hypot(first.x - last.x, first.z - last.z) < MIN_POINT_DISTANCE_M) cleaned.pop();
  }
  if (cleaned.length < 3) throw new Error(`${label} must contain at least three distinct points.`);

  const area = Math.abs(THREE.ShapeUtils.area(cleaned.map((point) => new THREE.Vector2(point.x, point.z))));
  if (!Number.isFinite(area) || area < minimumArea) {
    throw new Error(`${label} is too small or degenerate (area ${Number.isFinite(area) ? area.toFixed(6) : "invalid"} m²; minimum ${minimumArea.toFixed(6)} m²).`);
  }
  return cleaned;
}

function circleOpening(opening: any): Point2[] {
  const x = finite(opening?.x, Number.NaN);
  const z = finite(opening?.z, Number.NaN);
  const radius = finite(opening?.radius, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0.025 || radius > 1.5) {
    throw new Error("A circular ceiling opening must have a valid centre and a radius between 25 mm and 1.5 m.");
  }
  const segments = Math.max(16, Math.min(64, Math.round(finite(opening?.segments, 32))));
  return Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return { x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius };
  });
}

function normalizeOpening(opening: any, index: number): Point2[] {
  if (Array.isArray(opening)) return normalizeRing(opening, `Ceiling opening ${index + 1}`, MIN_OPENING_AREA_M2);
  if (Array.isArray(opening?.polygon)) return normalizeRing(opening.polygon, `Ceiling opening ${index + 1}`, MIN_OPENING_AREA_M2);
  if (opening?.type === "circle" || Number.isFinite(Number(opening?.radius))) {
    return normalizeRing(circleOpening(opening), `Ceiling opening ${index + 1}`, MIN_OPENING_AREA_M2);
  }
  throw new Error(`Ceiling opening ${index + 1} has an unsupported shape.`);
}

function colorFactor(value: string): [number, number, number] {
  const clean = String(value || DEFAULT_COLOR).trim().replace(/^#/, "");
  const expanded = /^[0-9a-f]{3}$/i.test(clean)
    ? clean.split("").map((part) => `${part}${part}`).join("")
    : clean;
  const hex = /^[0-9a-f]{6}$/i.test(expanded) ? expanded : DEFAULT_COLOR.slice(1);
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function resolveDesign(design: CeilingDesign, index: number, sceneScale: Required<SceneScale>) {
  const sourceBoundary = design?.boundary && Array.isArray(design.boundary.outer)
    ? design.boundary
    : { outer: design?.polygon || [], holes: [] };

  const outer = normalizeRing(sourceBoundary.outer, `Ceiling ${index + 1} outer boundary`);
  const boundaryHoles = (Array.isArray(sourceBoundary.holes) ? sourceBoundary.holes : [])
    .map((ring, ringIndex) => normalizeRing(ring, `Ceiling ${index + 1} boundary opening ${ringIndex + 1}`));
  const authoredHoles = (Array.isArray(design.openings) ? design.openings : [])
    .filter((opening) => opening?.enabled !== false)
    .map(normalizeOpening);

  const elevation = design.elevation && typeof design.elevation === "object" ? design.elevation : {};
  const bottomY = finite((elevation as any).finishedBottomY, finite(design.elevation, Number.NaN));
  const thickness = Math.max(0.025, Math.min(0.25, finite((elevation as any).thickness, finite(design.thickness, 0.05))));
  if (!Number.isFinite(bottomY)) throw new Error(`Ceiling ${index + 1} has an invalid finished elevation.`);

  const finish = design.finish || {};
  const repeatSource = Array.isArray(finish.texture?.repeat) ? finish.texture.repeat : finish.repeat;
  const finishKind = ["color", "fabric", "texture"].includes(String(finish.kind)) ? finish.kind : "color";
  const textureSource = finish.texture?.src || finish.textureSrc || undefined;
  const profileType = (["flat", "cove", "timber-slats"] as const).includes(design.profileType as any)
    ? design.profileType as "flat" | "cove" | "timber-slats"
    : "flat";

  return {
    id: safeId(design.id || design.roomId, `room_${index + 1}`),
    label: String(design.label || design.roomId || design.id || `Room ${index + 1}`),
    rings: [outer, ...boundaryHoles, ...authoredHoles],
    bottomY,
    topY: bottomY + thickness,
    thickness,
    scale: sceneScale,
    color: finish.color || design.color || DEFAULT_COLOR,
    rgb: Array.isArray(finish.rgb) && finish.rgb.length >= 3
      ? finish.rgb.slice(0, 3).map((value) => Math.max(0, Math.min(1, finite(value, 1)))) as [number, number, number]
      : colorFactor(finish.color || design.color || DEFAULT_COLOR),
    finishKind,
    textureSource: finishKind === "color" ? undefined : textureSource,
    repeat: [0, 1].map((index) => Math.max(0.05, Math.min(100, finite(repeatSource?.[index], 2)))) as [number, number],
    roughness: Math.max(0, Math.min(1, finite(finish.roughness, 0.86))),
    metallic: Math.max(0, Math.min(1, finite(finish.metallic, 0))),
    profileType,
  };
}

function createBuilder(bounds: UVBounds): GeometryBuilder {
  return { positions: [], normals: [], uvs: [], indices: [], bounds };
}

function pushTriangle(
  builder: GeometryBuilder,
  a: Point3,
  b: Point3,
  c: Point3,
  scale: Required<SceneScale>,
  wantedNormalY: number | null = null,
): void {
  const transform = (point: Point3): Point3 => [point[0] * scale.x, point[1] * scale.y, point[2] * scale.z];
  const pa = transform(a);
  let pb = transform(b);
  let pc = transform(c);
  const normalFor = () => {
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  let normal = normalFor();
  if (wantedNormalY !== null && normal[1] * wantedNormalY < 0) {
    [pb, pc] = [pc, pb];
    normal = normalFor();
  }
  const length = Math.hypot(...normal);
  if (!Number.isFinite(length) || length < 1e-10) return;
  normal = normal.map((value) => value / length);
  const base = builder.positions.length / 3;
  for (const point of [pa, pb, pc]) {
    builder.positions.push(point[0], point[1], point[2]);
    builder.normals.push(normal[0], normal[1], normal[2]);
    // Box-projected UVs keep the same selected finish visible on the upper
    // face, room-facing underside and vertical reveal faces around openings.
    const bounds = builder.bounds;
    if (Math.abs(normal[1]) >= Math.abs(normal[0]) && Math.abs(normal[1]) >= Math.abs(normal[2])) {
      builder.uvs.push((point[0] - bounds.minX) / bounds.sizeX, (point[2] - bounds.minZ) / bounds.sizeZ);
    } else if (Math.abs(normal[0]) >= Math.abs(normal[2])) {
      builder.uvs.push((point[2] - bounds.minZ) / bounds.sizeZ, (point[1] - bounds.minY) / bounds.sizeY);
    } else {
      builder.uvs.push((point[0] - bounds.minX) / bounds.sizeX, (point[1] - bounds.minY) / bounds.sizeY);
    }
  }
  builder.indices.push(base, base + 1, base + 2);
}

function addQuad(
  builder: GeometryBuilder,
  a: Point3,
  b: Point3,
  c: Point3,
  d: Point3,
  scale: Required<SceneScale>,
  wantedNormalY: number | null = null,
): void {
  pushTriangle(builder, a, b, c, scale, wantedNormalY);
  pushTriangle(builder, a, c, d, scale, wantedNormalY);
}

function addBoxSegment(
  builder: GeometryBuilder,
  start: [number, number],
  end: [number, number],
  yBottom: number,
  yTop: number,
  width: number,
  scale: Required<SceneScale>,
): void {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const length = Math.hypot(dx, dz);
  if (length < 0.02) return;
  const tx = dx / length, tz = dz / length;
  const halfWidth = width / 2;
  const sx = start[0] - tx * halfWidth, sz = start[1] - tz * halfWidth;
  const ex = end[0] + tx * halfWidth, ez = end[1] + tz * halfWidth;
  const px = -tz * halfWidth, pz = tx * halfWidth;
  const a = [sx + px, sz + pz], b = [ex + px, ez + pz];
  const c = [ex - px, ez - pz], d = [sx - px, sz - pz];
  const point = (p: number[], y: number): Point3 => [p[0], y, p[1]];
  addQuad(builder, point(a, yTop), point(b, yTop), point(c, yTop), point(d, yTop), scale, 1);
  addQuad(builder, point(d, yBottom), point(c, yBottom), point(b, yBottom), point(a, yBottom), scale, -1);
  addQuad(builder, point(a, yBottom), point(a, yTop), point(b, yTop), point(b, yBottom), scale);
  addQuad(builder, point(b, yBottom), point(b, yTop), point(c, yTop), point(c, yBottom), scale);
  addQuad(builder, point(c, yBottom), point(c, yTop), point(d, yTop), point(d, yBottom), scale);
  addQuad(builder, point(d, yBottom), point(d, yTop), point(a, yTop), point(a, yBottom), scale);
}

function scanlineIntervals(ring: Point2[], z: number): Array<[number, number]> {
  const intersections: number[] = [];
  ring.forEach((a, index) => {
    const b = ring[(index + 1) % ring.length];
    if ((a.z <= z && b.z > z) || (b.z <= z && a.z > z)) {
      intersections.push(a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x));
    }
  });
  intersections.sort((a, b) => a - b);
  const intervals: Array<[number, number]> = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    if (intersections[index + 1] - intersections[index] > 0.08) intervals.push([intersections[index], intersections[index + 1]]);
  }
  return intervals;
}

function subtractIntervals(base: Array<[number, number]>, cuts: Array<[number, number]>): Array<[number, number]> {
  let remaining = base.map(([start, end]) => [start, end] as [number, number]);
  cuts.forEach(([cutStart, cutEnd]) => {
    const next: Array<[number, number]> = [];
    remaining.forEach(([start, end]) => {
      if (cutEnd <= start || cutStart >= end) {
        next.push([start, end]);
        return;
      }
      if (cutStart > start + 0.04) next.push([start, Math.min(cutStart, end)]);
      if (cutEnd < end - 0.04) next.push([Math.max(cutEnd, start), end]);
    });
    remaining = next;
  });
  return remaining;
}

function buildCeilingGeometry(
  rings: Point2[][],
  bottomY: number,
  topY: number,
  scale: Required<SceneScale>,
  profileType: "flat" | "cove" | "timber-slats",
) {
  const outer = rings[0].map((point) => new THREE.Vector2(point.x, point.z));
  const holes = rings.slice(1).map((ring) => ring.map((point) => new THREE.Vector2(point.x, point.z)));
  const triangles = THREE.ShapeUtils.triangulateShape(outer, holes);
  if (!triangles.length) throw new Error("Could not triangulate the room boundary and its ceiling openings.");

  const flatPoints = rings.flat();
  const minX = Math.min(...rings[0].map((point) => point.x));
  const maxX = Math.max(...rings[0].map((point) => point.x));
  const minZ = Math.min(...rings[0].map((point) => point.z));
  const maxZ = Math.max(...rings[0].map((point) => point.z));
  const minY = bottomY - 0.045;
  const uvBounds: UVBounds = {
    minX: minX * scale.x,
    minY: minY * scale.y,
    minZ: minZ * scale.z,
    sizeX: Math.max(0.01, (maxX - minX) * scale.x),
    sizeY: Math.max(0.05, (topY - minY) * scale.y),
    sizeZ: Math.max(0.01, (maxZ - minZ) * scale.z),
  };
  const main = createBuilder(uvBounds);
  triangles.forEach(([ia, ib, ic]) => {
    const a = flatPoints[ia], b = flatPoints[ib], c = flatPoints[ic];
    if (!a || !b || !c) throw new Error("Ceiling triangulation returned an invalid vertex index.");
    pushTriangle(main, [a.x, bottomY, a.z], [b.x, bottomY, b.z], [c.x, bottomY, c.z], scale, -1);
    pushTriangle(main, [a.x, topY, a.z], [b.x, topY, b.z], [c.x, topY, c.z], scale, 1);
  });

  rings.forEach((ring) => {
    ring.forEach((a, index) => {
      const b = ring[(index + 1) % ring.length];
      addQuad(main, [a.x, bottomY, a.z], [b.x, bottomY, b.z], [b.x, topY, b.z], [a.x, topY, a.z], scale);
    });
  });

  const profile = createBuilder(uvBounds);
  if (profileType === "cove") {
    // Separate warm emissive reveal strip around the perimeter.
    rings[0].forEach((point, index) => {
      const next = rings[0][(index + 1) % rings[0].length];
      addBoxSegment(profile, [point.x, point.z], [next.x, next.z], bottomY - 0.022, bottomY - 0.004, 0.026, scale);
    });
  } else if (profileType === "timber-slats") {
    const minZ = Math.min(...rings[0].map((point) => point.z));
    const maxZ = Math.max(...rings[0].map((point) => point.z));
    const minX = Math.min(...rings[0].map((point) => point.x));
    const maxX = Math.max(...rings[0].map((point) => point.x));
    const spacing = 0.18;
    const slatWidth = 0.035;
    const firstZ = Math.ceil((minZ + 0.06) / spacing) * spacing;
    for (let z = firstZ; z < maxZ - 0.04; z += spacing) {
      let intervals = scanlineIntervals(rings[0], z);
      rings.slice(1).forEach((hole) => { intervals = subtractIntervals(intervals, scanlineIntervals(hole, z)); });
      intervals.forEach(([start, end]) => {
        const x1 = Math.max(minX, start), x2 = Math.min(maxX, end);
        if (x2 - x1 > 0.12) addBoxSegment(profile, [x1, z], [x2, z], bottomY - 0.045, bottomY - 0.012, slatWidth, scale);
      });
    }
  }

  if (!main.positions.length || !main.indices.length) throw new Error("Ceiling triangulation produced no renderable faces.");
  return { main, profile, triangleCount: main.indices.length / 3 + profile.indices.length / 3 };
}

function mimeForTexture(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function createPrimitive(
  doc: Document,
  buffer: GltfBuffer,
  nodeName: string,
  geometry: GeometryBuilder,
  material: GltfMaterial,
) {
  if (!geometry.indices.length) return null;
  const primitive = doc.createPrimitive()
    .setMode(GltfPrimitive.Mode.TRIANGLES)
    .setAttribute("POSITION", doc.createAccessor(`${nodeName}_POSITION`)
      .setType("VEC3")
      .setArray(new Float32Array(geometry.positions))
      .setBuffer(buffer))
    .setAttribute("NORMAL", doc.createAccessor(`${nodeName}_NORMAL`)
      .setType("VEC3")
      .setArray(new Float32Array(geometry.normals))
      .setBuffer(buffer))
    .setAttribute("TEXCOORD_0", doc.createAccessor(`${nodeName}_TEXCOORD_0`)
      .setType("VEC2")
      .setArray(new Float32Array(geometry.uvs))
      .setBuffer(buffer))
    .setIndices(doc.createAccessor(`${nodeName}_INDICES`)
      .setType("SCALAR")
      .setArray(new Uint32Array(geometry.indices))
      .setBuffer(buffer));
  primitive.setMaterial(material);
  return primitive;
}

function createCeilingMaterial(
  doc: Document,
  nodeName: string,
  resolved: ReturnType<typeof resolveDesign>,
  textureResolver?: (source: string) => string | null,
  applyTextureRepeat?: (material: GltfMaterial, repeat: [number, number]) => void,
): GltfMaterial {
  const material = doc.createMaterial(`${nodeName}_Material`)
    .setBaseColorFactor([resolved.rgb[0], resolved.rgb[1], resolved.rgb[2], 1])
    .setMetallicFactor(resolved.metallic)
    .setRoughnessFactor(resolved.roughness)
    .setDoubleSided(true);

  if (resolved.textureSource && resolved.finishKind !== "color") {
    const texturePath = textureResolver?.(resolved.textureSource) || null;
    if (texturePath && fs.existsSync(texturePath)) {
      const texture = doc.createTexture(`${nodeName}_BaseColorTexture`)
        .setMimeType(mimeForTexture(texturePath))
        .setImage(fs.readFileSync(texturePath));
      material
        .setBaseColorFactor([1, 1, 1, 1])
        .setBaseColorTexture(texture);
      applyTextureRepeat?.(material, resolved.repeat);
    } else {
      console.warn(`[compiler:ceiling] Texture finish could not be resolved for ${resolved.label}; using its base colour instead (${resolved.textureSource}).`);
    }
  }
  return material;
}

/**
 * Adds saved room-ceiling slabs to the visual GLB scene.
 * Call this only after WalkNavigationPipeline has consumed the structural/furniture GLB,
 * so overhead slabs and fixture cut-outs never contaminate walkable navigation geometry.
 */
export function appendAuthoredCeilings(
  doc: Document,
  buffer: GltfBuffer,
  scene: GltfScene,
  sourceDesigns: unknown,
  sceneScaleInput?: SceneScale,
  textureResolver?: (source: string) => string | null,
  applyTextureRepeat?: (material: GltfMaterial, repeat: [number, number]) => void,
): CeilingCompileSummary {
  const designs = Array.isArray(sourceDesigns) ? sourceDesigns as CeilingDesign[] : [];
  const sceneScale: Required<SceneScale> = {
    x: finite(sceneScaleInput?.x, 1) > 0 ? finite(sceneScaleInput?.x, 1) : 1,
    y: finite(sceneScaleInput?.y, 1) > 0 ? finite(sceneScaleInput?.y, 1) : 1,
    z: finite(sceneScaleInput?.z, 1) > 0 ? finite(sceneScaleInput?.z, 1) : 1,
  };

  const summary: CeilingCompileSummary = { created: 0, skipped: 0, triangleCount: 0 };
  let group: GltfNode | null = null;

  designs.forEach((design, index) => {
    if (!design || typeof design !== "object" || design.visible === false) return;
    try {
      const resolved = resolveDesign(design, index, sceneScale);
      const geometry = buildCeilingGeometry(resolved.rings, resolved.bottomY, resolved.topY, resolved.scale, resolved.profileType);
      const nodeName = `HCI_Ceiling_${resolved.id}`;
      const material = createCeilingMaterial(doc, nodeName, resolved, textureResolver, applyTextureRepeat);
      const mainPrimitive = createPrimitive(doc, buffer, `${nodeName}_Main`, geometry.main, material);
      if (!mainPrimitive) throw new Error("Ceiling main surface has no triangles.");

      const mesh = doc.createMesh(`${nodeName}_Mesh`).addPrimitive(mainPrimitive);
      const node = doc.createNode(nodeName).setMesh(mesh);
      if (!group) group = doc.createNode("HCI_Authored_Ceilings");
      group.addChild(node);

      if (geometry.profile.indices.length) {
        const profileName = `${nodeName}_${resolved.profileType}`;
        const profileMaterial = resolved.profileType === "cove"
          ? doc.createMaterial(`${profileName}_Material`)
              .setBaseColorFactor([1, 0.82, 0.62, 1])
              .setEmissiveFactor([0.40, 0.28, 0.16])
              .setMetallicFactor(0)
              .setRoughnessFactor(0.35)
              .setDoubleSided(true)
          : resolved.profileType === "timber-slats"
            ? doc.createMaterial(`${profileName}_Material`)
                .setBaseColorFactor([...colorFactor(DEFAULT_WOOD), 1])
                .setMetallicFactor(0)
                .setRoughnessFactor(0.62)
                .setDoubleSided(true)
            : material;
        const profilePrimitive = createPrimitive(doc, buffer, profileName, geometry.profile, profileMaterial);
        if (profilePrimitive) {
          const profileMesh = doc.createMesh(`${profileName}_Mesh`).addPrimitive(profilePrimitive);
          node.addChild(doc.createNode(profileName).setMesh(profileMesh));
        }
      }

      summary.created += 1;
      summary.triangleCount += geometry.triangleCount;
      console.log(`[compiler:ceiling] Added ${resolved.label}: ${geometry.triangleCount} triangle(s), ${resolved.rings.length - 1} opening loop(s), profile=${resolved.profileType}.`);
    } catch (error) {
      summary.skipped += 1;
      console.warn(`[compiler:ceiling] Skipping invalid ceiling ${design?.id || `#${index + 1}`}: ${(error as Error)?.message || String(error)}`);
    }
  });

  if (group && summary.created > 0) scene.addChild(group);
  return summary;
}
