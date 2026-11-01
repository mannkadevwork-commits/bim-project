import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh.js';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry.js';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial.js';
import { ShapeUtils, Vector2 } from 'three';

const DEFAULT_FINISH = '#F3F1EB';
const toRgb = (hex) => {
  const value = String(hex || DEFAULT_FINISH).replace('#', '');
  const safe = /^[0-9a-f]{6}$/i.test(value) ? value : 'F3F1EB';
  return [0, 2, 4].map((i) => parseInt(safe.slice(i, i + 2), 16) / 255);
};
const safeId = (value) => String(value || 'room').replace(/[^a-zA-Z0-9_-]/g, '_');
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function normalizeRing(source, label) {
  if (!Array.isArray(source)) throw new Error(`${label} boundary is missing.`);
  const points = source.map((point) => ({ x: finite(point?.x, NaN), z: finite(point?.z, NaN) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  const cleaned = points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    return !previous || Math.hypot(point.x - previous.x, point.z - previous.z) > 0.0005;
  });
  if (cleaned.length > 2 && Math.hypot(cleaned[0].x - cleaned[cleaned.length - 1].x, cleaned[0].z - cleaned[cleaned.length - 1].z) < 0.0005) cleaned.pop();
  if (cleaned.length < 3) throw new Error(`${label} must contain at least three distinct points.`);
  const area = Math.abs(ShapeUtils.area(cleaned.map((point) => new Vector2(point.x, point.z))));
  if (!Number.isFinite(area) || area < 0.01) throw new Error(`${label} is too small or degenerate.`);
  return cleaned;
}

function resolveDesignGeometryFields(design) {
  const sourceBoundary = design?.boundary && Array.isArray(design.boundary.outer)
    ? design.boundary
    : { outer: design?.polygon || [], holes: [] };
  const outer = normalizeRing(sourceBoundary.outer, 'Ceiling outer boundary');
  const holes = (Array.isArray(sourceBoundary.holes) ? sourceBoundary.holes : [])
    .map((ring, index) => normalizeRing(ring, `Ceiling opening ${index + 1}`));
  const elevation = design?.elevation && typeof design.elevation === 'object' ? design.elevation : {};
  const bottomY = finite(elevation.finishedBottomY, finite(design?.elevation, NaN));
  const thickness = Math.max(0.025, Math.min(0.25, finite(elevation.thickness, finite(design?.thickness, 0.05))));
  if (!Number.isFinite(bottomY)) throw new Error('Ceiling finished elevation is invalid.');
  return {
    rings: [outer, ...holes],
    bottomY,
    topY: bottomY + thickness,
    thickness,
    color: design?.finish?.color || design?.color || DEFAULT_FINISH,
  };
}

function buildCeilingGeometry(design) {
  const { rings, bottomY, topY } = resolveDesignGeometryFields(design);
  const outer = rings[0].map((point) => new Vector2(point.x, point.z));
  const holes = rings.slice(1).map((ring) => ring.map((point) => new Vector2(point.x, point.z)));
  const triangles = ShapeUtils.triangulateShape(outer, holes);
  if (!triangles.length) throw new Error('Could not triangulate this room boundary and its openings.');
  const flatPoints = rings.flat();
  const positions = [];
  const normals = [];
  const indices = [];

  const pushTriangle = (a, b, c, wantedNormalY = null) => {
    let [pa, pb, pc] = [a, b, c];
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    if (wantedNormalY != null && ny * wantedNormalY < 0) {
      [pb, pc] = [pc, pb];
      nx = -nx; ny = -ny; nz = -nz;
    }
    const length = Math.hypot(nx, ny, nz) || 1;
    const normal = [nx / length, ny / length, nz / length];
    const base = positions.length / 3;
    for (const point of [pa, pb, pc]) {
      positions.push(point[0], point[1], point[2]);
      normals.push(...normal);
    }
    indices.push(base, base + 1, base + 2);
  };

  triangles.forEach(([ia, ib, ic]) => {
    const a = flatPoints[ia], b = flatPoints[ib], c = flatPoints[ic];
    if (!a || !b || !c) throw new Error('Ceiling triangulation returned an invalid vertex index.');
    // The lower face is the visible underside used for ceiling-mounted fixtures.
    pushTriangle([a.x, bottomY, a.z], [b.x, bottomY, b.z], [c.x, bottomY, c.z], -1);
    pushTriangle([a.x, topY, a.z], [b.x, topY, b.z], [c.x, topY, c.z], 1);
  });

  // Extrude every boundary loop. Inner loops are the sides of real openings,
  // not solid fill; their side faces keep the slab visually closed around shafts.
  rings.forEach((ring) => {
    ring.forEach((a, index) => {
      const b = ring[(index + 1) % ring.length];
      const aBottom = [a.x, bottomY, a.z], bBottom = [b.x, bottomY, b.z];
      const aTop = [a.x, topY, a.z], bTop = [b.x, topY, b.z];
      pushTriangle(aBottom, bBottom, bTop);
      pushTriangle(aBottom, bTop, aTop);
    });
  });
  return { positions, normals, indices };
}

function meshSignature(design) {
  return JSON.stringify({
    boundary: design.boundary || null,
    polygon: design.polygon || null,
    elevation: design.elevation,
    thickness: design.thickness,
    finish: design.finish || null,
    color: design.color,
    visible: design.visible,
  });
}

/**
 * Owns the lifecycle of authored room ceilings and a temporary preview mesh.
 * Committed meshes are stable by ceiling ID; preview never enters project state.
 */
export const createRoomCeilingController = (viewer) => {
  const scene = viewer?.scene;
  const entries = new Map();
  let previewEntry = null;
  if (!scene) return { sync: () => {}, preview: () => {}, clearPreview: () => {}, destroy: () => {} };

  const destroyEntry = (entry) => {
    if (!entry) return;
    try { entry.mesh?.destroy(); } catch (_) {}
    try { entry.geometry?.destroy(); } catch (_) {}
    try { entry.material?.destroy(); } catch (_) {}
  };

  const createEntry = (design, { preview = false } = {}) => {
    const geometryData = buildCeilingGeometry(design);
    const geometry = new ReadableGeometry(scene, {
      primitive: 'triangles',
      positions: geometryData.positions,
      normals: geometryData.normals,
      indices: geometryData.indices,
    });
    const material = new PhongMaterial(scene, {
      diffuse: preview ? [1, 0.49, 0.19] : toRgb(design?.finish?.color || design?.color),
      emissive: preview ? [0.18, 0.045, 0.008] : [0, 0, 0],
      alpha: preview ? 0.38 : 1,
      alphaMode: preview ? 'blend' : 'opaque',
      shininess: 10,
      backfaces: true,
    });
    const id = preview ? 'hci_room_ceiling_preview' : `hci_room_ceiling_${safeId(design.id)}`;
    const mesh = new Mesh(scene, {
      id,
      geometry,
      material,
      pickable: !preview,
      collidable: false,
      visible: true,
    });
    mesh._hciRoomCeiling = {
      id: design.id || null,
      roomId: design.roomId || null,
      componentKind: 'ceiling',
      surfaceRole: 'underside',
      preview,
    };
    return { mesh, geometry, material, signature: meshSignature(design) };
  };

  const sync = (ceilings = []) => {
    const next = new Map((Array.isArray(ceilings) ? ceilings : []).filter((item) => item?.id).map((item) => [String(item.id), item]));
    for (const id of Array.from(entries.keys())) if (!next.has(id)) {
      destroyEntry(entries.get(id));
      entries.delete(id);
    }
    for (const [id, design] of next) {
      const signature = meshSignature(design);
      const current = entries.get(id);
      if (current?.signature === signature) {
        current.mesh.visible = design.visible !== false;
        continue;
      }
      destroyEntry(current);
      try {
        const entry = createEntry(design);
        entry.mesh.visible = design.visible !== false;
        entries.set(id, entry);
      } catch (error) {
        entries.delete(id);
        console.warn('[CeilingDesigner] Could not create room ceiling:', id, error);
      }
    }
  };

  const clearPreview = () => {
    if (!previewEntry) return;
    destroyEntry(previewEntry);
    previewEntry = null;
  };

  const preview = (design) => {
    clearPreview();
    if (!design) return false;
    try {
      previewEntry = createEntry({ ...design, id: 'preview', visible: true }, { preview: true });
      return true;
    } catch (error) {
      console.warn('[CeilingDesigner] Could not build ceiling preview:', error);
      return false;
    }
  };

  return {
    sync,
    preview,
    clearPreview,
    destroy() {
      clearPreview();
      for (const entry of entries.values()) destroyEntry(entry);
      entries.clear();
    },
  };
};
