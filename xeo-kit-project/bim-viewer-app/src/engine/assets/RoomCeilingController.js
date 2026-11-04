import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh.js';
import { Node } from '@xeokit/xeokit-sdk/src/viewer/scene/nodes/Node.js';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry.js';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial.js';
import { Texture } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/Texture.js';
import { sRGBEncoding } from '@xeokit/xeokit-sdk/src/viewer/scene/constants/constants.js';
import { ShapeUtils, Vector2 } from 'three';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const DEFAULT_FINISH = '#F3F1EB';
const DEFAULT_WOOD = '#A77B4A';
const MIN_RING_AREA_M2 = 0.01;
const MIN_OPENING_AREA_M2 = 0.0005;
const toRgb = (hex) => {
  const value = String(hex || DEFAULT_FINISH).replace('#', '');
  const safe = /^[0-9a-f]{6}$/i.test(value) ? value : 'F3F1EB';
  return [0, 2, 4].map((i) => parseInt(safe.slice(i, i + 2), 16) / 255);
};
const safeId = (value) => String(value || 'room').replace(/[^a-zA-Z0-9_-]/g, '_');
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function normalizeRing(source, label, minimumArea = MIN_RING_AREA_M2) {
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
  if (!Number.isFinite(area) || area < minimumArea) {
    throw new Error(`${label} is too small or degenerate (area ${Number.isFinite(area) ? area.toFixed(6) : 'invalid'} m²; minimum ${minimumArea.toFixed(6)} m²).`);
  }
  return cleaned;
}

function circleOpening(opening) {
  const x = finite(opening?.x, NaN);
  const z = finite(opening?.z, NaN);
  const radius = finite(opening?.radius, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0.025 || radius > 1.5) {
    throw new Error('A ceiling circle opening must have a valid centre and a radius between 25 mm and 1.5 m.');
  }
  const segments = Math.max(16, Math.min(64, Math.round(finite(opening?.segments, 32))));
  return Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return { x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius };
  });
}

function normalizeOpening(opening, index) {
  if (Array.isArray(opening)) return normalizeRing(opening, `Ceiling opening ${index + 1}`, MIN_OPENING_AREA_M2);
  if (Array.isArray(opening?.polygon)) return normalizeRing(opening.polygon, `Ceiling opening ${index + 1}`, MIN_OPENING_AREA_M2);
  if (opening?.type === 'circle' || Number.isFinite(Number(opening?.radius))) {
    return normalizeRing(circleOpening(opening), `Ceiling opening ${index + 1}`, MIN_OPENING_AREA_M2);
  }
  throw new Error(`Ceiling opening ${index + 1} has an unsupported shape.`);
}

function resolveFinish(design) {
  const finish = design?.finish && typeof design.finish === 'object' ? design.finish : {};
  const kind = ['color', 'fabric', 'texture'].includes(finish.kind) ? finish.kind : 'color';
  const textureSource = finish.texture?.src || finish.textureSrc || finish.textureUrl || null;
  const textureUrl = !textureSource ? null : /^https?:\/\//i.test(String(textureSource))
    ? String(textureSource)
    : `${API_BASE_URL.replace(/\/$/, '')}/${String(textureSource).replace(/^\//, '')}`;
  const repeatSource = Array.isArray(finish.texture?.repeat) ? finish.texture.repeat : finish.repeat;
  const repeat = [0, 1].map((index) => Math.max(0.05, Math.min(100, finite(repeatSource?.[index], 2))));
  const color = finish.color || design?.color || DEFAULT_FINISH;
  const rgb = Array.isArray(finish.rgb) && finish.rgb.length >= 3
    ? finish.rgb.slice(0, 3).map((value) => Math.max(0, Math.min(1, finite(value, 1))))
    : toRgb(color);
  return {
    kind,
    color,
    rgb,
    textureUrl: kind === 'color' ? null : textureUrl,
    repeat,
    roughness: Math.max(0, Math.min(1, finite(finish.roughness, 0.86))),
    metallic: Math.max(0, Math.min(1, finite(finish.metallic, 0))),
  };
}

const createGeometryBuilder = (bounds) => ({ positions: [], normals: [], uvs: [], indices: [], bounds });

function pushTriangle(builder, a, b, c, wantedNormalY = null) {
  let pa = [...a], pb = [...b], pc = [...c];
  const getNormal = () => {
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  let normal = getNormal();
  if (wantedNormalY != null && normal[1] * wantedNormalY < 0) {
    [pb, pc] = [pc, pb];
    normal = getNormal();
  }
  const length = Math.hypot(...normal) || 1;
  normal = normal.map((value) => value / length);
  const base = builder.positions.length / 3;
  for (const point of [pa, pb, pc]) {
    builder.positions.push(point[0], point[1], point[2]);
    builder.normals.push(normal[0], normal[1], normal[2]);
    // Box projection gives the horizontal ceiling faces X/Z UVs and the
    // vertical reveal faces a horizontal/height projection. This is what lets
    // colour, fabric and tile finishes cover both slab faces and the edges.
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

function addQuad(builder, a, b, c, d, wantedNormalY = null) {
  pushTriangle(builder, a, b, c, wantedNormalY);
  pushTriangle(builder, a, c, d, wantedNormalY);
}

function addBoxSegment(builder, start, end, yBottom, yTop, width) {
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
  const point = (p, y) => [p[0], y, p[1]];
  addQuad(builder, point(a, yTop), point(b, yTop), point(c, yTop), point(d, yTop), 1);
  addQuad(builder, point(d, yBottom), point(c, yBottom), point(b, yBottom), point(a, yBottom), -1);
  addQuad(builder, point(a, yBottom), point(a, yTop), point(b, yTop), point(b, yBottom));
  addQuad(builder, point(b, yBottom), point(b, yTop), point(c, yTop), point(c, yBottom));
  addQuad(builder, point(c, yBottom), point(c, yTop), point(d, yTop), point(d, yBottom));
  addQuad(builder, point(d, yBottom), point(d, yTop), point(a, yTop), point(a, yBottom));
}

function scanlineIntervals(ring, z) {
  const intersections = [];
  ring.forEach((a, index) => {
    const b = ring[(index + 1) % ring.length];
    if ((a.z <= z && b.z > z) || (b.z <= z && a.z > z)) {
      intersections.push(a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x));
    }
  });
  intersections.sort((a, b) => a - b);
  const intervals = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    if (intersections[index + 1] - intersections[index] > 0.08) intervals.push([intersections[index], intersections[index + 1]]);
  }
  return intervals;
}

function subtractIntervals(baseIntervals, cutIntervals) {
  let remaining = baseIntervals.map(([start, end]) => [start, end]);
  cutIntervals.forEach(([cutStart, cutEnd]) => {
    const next = [];
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

function buildCeilingGeometry(design) {
  const sourceBoundary = design?.boundary && Array.isArray(design.boundary.outer)
    ? design.boundary
    : { outer: design?.polygon || [], holes: [] };
  const outer = normalizeRing(sourceBoundary.outer, 'Ceiling outer boundary');
  const boundaryHoles = (Array.isArray(sourceBoundary.holes) ? sourceBoundary.holes : [])
    .map((ring, index) => normalizeRing(ring, `Ceiling boundary opening ${index + 1}`));
  const authoredHoles = (Array.isArray(design?.openings) ? design.openings : [])
    .filter((opening) => opening?.enabled !== false)
    .map(normalizeOpening);
  const rings = [outer, ...boundaryHoles, ...authoredHoles];
  const elevation = design?.elevation && typeof design.elevation === 'object' ? design.elevation : {};
  const bottomY = finite(elevation.finishedBottomY, finite(design?.elevation, NaN));
  const thickness = Math.max(0.025, Math.min(0.25, finite(elevation.thickness, finite(design?.thickness, 0.05))));
  if (!Number.isFinite(bottomY)) throw new Error('Ceiling finished elevation is invalid.');
  const topY = bottomY + thickness;
  const minX = Math.min(...outer.map((point) => point.x));
  const maxX = Math.max(...outer.map((point) => point.x));
  const minZ = Math.min(...outer.map((point) => point.z));
  const maxZ = Math.max(...outer.map((point) => point.z));
  const uvBounds = {
    minX, minZ, minY: bottomY - 0.045,
    sizeX: Math.max(0.01, maxX - minX),
    sizeZ: Math.max(0.01, maxZ - minZ),
    sizeY: Math.max(0.05, topY - (bottomY - 0.045)),
  };
  const main = createGeometryBuilder(uvBounds);
  const outerPoints = outer.map((point) => new Vector2(point.x, point.z));
  const holePoints = rings.slice(1).map((ring) => ring.map((point) => new Vector2(point.x, point.z)));
  const triangles = ShapeUtils.triangulateShape(outerPoints, holePoints);
  if (!triangles.length) throw new Error('Could not triangulate this room boundary and its openings.');
  const flatPoints = rings.flat();

  triangles.forEach(([ia, ib, ic]) => {
    const a = flatPoints[ia], b = flatPoints[ib], c = flatPoints[ic];
    if (!a || !b || !c) throw new Error('Ceiling triangulation returned an invalid vertex index.');
    pushTriangle(main, [a.x, bottomY, a.z], [b.x, bottomY, b.z], [c.x, bottomY, c.z], -1);
    pushTriangle(main, [a.x, topY, a.z], [b.x, topY, b.z], [c.x, topY, c.z], 1);
  });

  // Extrude every room boundary and void loop. The same finish/UV projection is
  // used on these reveal faces, not only on the top and room-facing underside.
  rings.forEach((ring) => {
    ring.forEach((a, index) => {
      const b = ring[(index + 1) % ring.length];
      const aBottom = [a.x, bottomY, a.z], bBottom = [b.x, bottomY, b.z];
      const aTop = [a.x, topY, a.z], bTop = [b.x, topY, b.z];
      addQuad(main, aBottom, bBottom, bTop, aTop);
    });
  });

  const profileType = ['flat', 'cove', 'timber-slats'].includes(design?.profileType) ? design.profileType : 'flat';
  const profile = createGeometryBuilder(uvBounds);
  if (profileType === 'cove') {
    // A slim warm cove reveal follows the room perimeter. It is separate from
    // the slab finish so it can use an emissive strip material in both renderers.
    outer.forEach((point, index) => {
      const next = outer[(index + 1) % outer.length];
      addBoxSegment(profile, [point.x, point.z], [next.x, next.z], bottomY - 0.022, bottomY - 0.004, 0.026);
    });
  } else if (profileType === 'timber-slats') {
    const minZ = Math.min(...outer.map((point) => point.z));
    const maxZ = Math.max(...outer.map((point) => point.z));
    const minX = Math.min(...outer.map((point) => point.x));
    const maxX = Math.max(...outer.map((point) => point.x));
    const spacing = 0.18;
    const slatWidth = 0.035;
    const firstZ = Math.ceil((minZ + 0.06) / spacing) * spacing;
    for (let z = firstZ; z < maxZ - 0.04; z += spacing) {
      let intervals = scanlineIntervals(outer, z);
      rings.slice(1).forEach((hole) => { intervals = subtractIntervals(intervals, scanlineIntervals(hole, z)); });
      intervals.forEach(([start, end]) => {
        const x1 = Math.max(minX, start), x2 = Math.min(maxX, end);
        if (x2 - x1 > 0.12) {
          addBoxSegment(profile, [x1, z], [x2, z], bottomY - 0.045, bottomY - 0.012, slatWidth);
        }
      });
    }
  }

  return { main, profile, profileType, bottomY, topY, thickness, rings };
}

function meshSignature(design) {
  return JSON.stringify({
    boundary: design.boundary || null,
    polygon: design.polygon || null,
    openings: design.openings || [],
    elevation: design.elevation,
    thickness: design.thickness,
    finish: design.finish || null,
    color: design.color,
    profileType: design.profileType || 'flat',
    visible: design.visible,
  });
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`Unable to load ceiling finish texture: ${src}`));
  image.src = src;
});

/** Owns authored room ceilings and temporary preview meshes. Texture loading is
 * asynchronous and generation-guarded so stale material requests cannot replace
 * a newer colour/texture selection during rapid UI changes or Undo/Redo. */
export const createRoomCeilingController = (viewer) => {
  const scene = viewer?.scene;
  const entries = new Map();
  let entryGeneration = 0;
  let previewGeneration = 0;
  let previewEntry = null;
  if (!scene) return { sync: () => Promise.resolve(0), preview: () => false, clearPreview: () => {}, destroy: () => {} };

  const destroyEntry = (entry) => {
    if (!entry) return;
    const meshes = [entry.mesh, ...(entry.profileMeshes || [])].filter(Boolean);
    // Detach children first so destroying the model root cannot leave stale
    // scene.objects entries or destroy resources before we release them.
    meshes.forEach((mesh) => {
      try { entry.root?.removeChild?.(mesh); } catch (_) {}
      try { mesh.destroy(); } catch (_) {}
    });
    try { entry.root?.destroy?.(); } catch (_) {}
    const geometries = [entry.geometry, ...(entry.profileGeometries || [])].filter(Boolean);
    geometries.forEach((geometry) => { try { geometry.destroy(); } catch (_) {} });
    const materials = [...new Set([entry.material, ...(entry.profileMaterials || [])].filter(Boolean))];
    materials.forEach((material) => {
      const texture = material?._hciTextureMap || material?.diffuseMap;
      try { texture?.destroy?.(); } catch (_) {}
      try { material.destroy?.(); } catch (_) {}
    });
  };

  const createEntry = async (design, { preview = false } = {}) => {
    const geometryData = buildCeilingGeometry(design);
    const finish = resolveFinish(design);
    let texture = null;
    if (finish.textureUrl) {
      try {
        const image = await loadImage(finish.textureUrl);
        texture = new Texture(scene, { image, encoding: sRGBEncoding, scale: finish.repeat });
      } catch (error) {
        console.warn('[CeilingDesigner] Finish texture could not be loaded; using its base colour:', error);
      }
    }

    const diffuse = texture ? [1, 1, 1] : finish.rgb;
    const material = new PhongMaterial(scene, {
      diffuse,
      ...(texture ? { diffuseMap: texture } : {}),
      emissive: [0, 0, 0],
      alpha: preview ? 0.98 : 1,
      alphaMode: 'opaque',
      shininess: Math.max(8, Math.round((1 - finish.roughness) * 100)),
      backfaces: true,
    });
    if (texture) material._hciTextureMap = texture;

    const geometry = new ReadableGeometry(scene, {
      primitive: 'triangles',
      positions: geometryData.main.positions,
      normals: geometryData.main.normals,
      uv: geometryData.main.uvs,
      indices: geometryData.main.indices,
    });
    const id = preview ? 'hci_room_ceiling_preview' : `hci_room_ceiling_${safeId(design.id)}`;
    // A Mesh created directly under Scene is only a component; it is not part
    // of the renderable scene graph. Register a model Node and attach every
    // ceiling surface to it, with each visible Mesh registered as an object.
    // This is required for xeokit's renderer, visible-object tracking and picks.
    const root = new Node(scene, {
      id: `${id}_model`,
      isModel: true,
      visible: true,
      pickable: false,
      collidable: false,
      clippable: false,
    });
    const mesh = new Mesh(scene, {
      id,
      parent: root,
      isObject: true,
      geometry,
      material,
      pickable: !preview,
      collidable: false,
      clippable: false,
      culled: false,
      visible: true,
    });
    mesh._hciRoomCeiling = {
      id: design.id || null,
      roomId: design.roomId || null,
      componentKind: 'ceiling',
      surfaceRole: 'underside',
      openingCount: geometryData.rings.length - 1,
      profileType: geometryData.profileType,
      preview,
    };
    root._hciRoomCeiling = { ...mesh._hciRoomCeiling, componentKind: 'ceiling-model' };

    const profileMeshes = [];
    const profileGeometries = [];
    const profileMaterials = [];
    if (geometryData.profile.indices.length) {
      const profileGeometry = new ReadableGeometry(scene, {
        primitive: 'triangles',
        positions: geometryData.profile.positions,
        normals: geometryData.profile.normals,
        uv: geometryData.profile.uvs,
        indices: geometryData.profile.indices,
      });
      const profileMaterial = geometryData.profileType === 'cove'
        ? new PhongMaterial(scene, {
            diffuse: [1, 0.82, 0.62],
            emissive: [0.35, 0.25, 0.14],
            shininess: 4,
            backfaces: true,
          })
        : geometryData.profileType === 'timber-slats'
          ? new PhongMaterial(scene, {
              diffuse: toRgb(DEFAULT_WOOD),
              emissive: [0, 0, 0],
              shininess: 12,
              backfaces: true,
            })
          : material;
      const profileMesh = new Mesh(scene, {
        id: `${id}_${geometryData.profileType}`,
        parent: root,
        isObject: true,
        geometry: profileGeometry,
        material: profileMaterial,
        // The profile is decorative; the main underside remains the fixture
        // placement surface and owns the ceiling's pick metadata.
        pickable: false,
        collidable: false,
        clippable: false,
        culled: false,
        visible: true,
      });
      profileMesh._hciRoomCeiling = { ...mesh._hciRoomCeiling, componentKind: geometryData.profileType };
      profileMeshes.push(profileMesh);
      profileGeometries.push(profileGeometry);
      if (profileMaterial !== material) profileMaterials.push(profileMaterial);
    }

    // Do not report success merely because Component construction completed.
    // Confirm that xeokit registered a scene model and drawable object with
    // non-empty geometry and finite world bounds.
    const meshAabb = Array.from(mesh.aabb || []);
    const validAabb = meshAabb.length === 6 && meshAabb.every(Number.isFinite)
      && meshAabb[3] > meshAabb[0] && meshAabb[4] > meshAabb[1] && meshAabb[5] > meshAabb[2];
    const entry = {
      root, mesh, geometry, material, texture, profileMeshes, profileGeometries, profileMaterials,
      signature: meshSignature(design),
      diagnostics: { modelId: root.id, objectId: mesh.id, triangleCount: mesh.numTriangles, aabb: meshAabb },
    };
    if (scene.models?.[root.id] !== root) {
      destroyEntry(entry);
      throw new Error(`Ceiling model root was not registered in xeokit scene.models (${root.id}).`);
    }
    if (scene.objects?.[mesh.id] !== mesh || mesh.numTriangles < 1 || !validAabb) {
      destroyEntry(entry);
      throw new Error(`Ceiling surface was not registered as a drawable scene object (${mesh.id}); triangles=${mesh.numTriangles}, aabb=${meshAabb.join(',')}.`);
    }

    return entry;
  };

  const sync = (ceilings = []) => {
    const next = new Map((Array.isArray(ceilings) ? ceilings : [])
      .filter((item) => item?.id && (Array.isArray(item.boundary?.outer) || Array.isArray(item.polygon)))
      .map((item) => [String(item.id), item]));
    const pending = [];

    // Remove stale committed ceilings first. Preview meshes are owned separately
    // and are never allowed to replace a committed room ceiling.
    for (const id of Array.from(entries.keys())) {
      if (!next.has(id)) {
        const current = entries.get(id);
        if (current?.token) current.token.cancelled = true;
        destroyEntry(current?.entry);
        entries.delete(id);
      }
    }

    for (const [id, design] of next) {
      const signature = meshSignature(design);
      const current = entries.get(id);
      if (current?.signature === signature) {
        if (current.entry) {
          current.entry.root.visible = design.visible !== false;
          [current.entry.mesh, ...(current.entry.profileMeshes || [])]
            .forEach((mesh) => { mesh.visible = design.visible !== false; });
        } else if (current.ready) {
          pending.push(current.ready);
        }
        continue;
      }

      if (current?.token) current.token.cancelled = true;
      destroyEntry(current?.entry);
      const token = { id: ++entryGeneration, cancelled: false };
      const record = { signature, token, entry: null, ready: null };
      entries.set(id, record);

      record.ready = createEntry(design).then((entry) => {
        const latest = entries.get(id);
        if (!latest || latest.token !== token || token.cancelled) {
          destroyEntry(entry);
          return null;
        }
        latest.entry = entry;
        entry.root.visible = design.visible !== false;
        [entry.mesh, ...(entry.profileMeshes || [])]
          .forEach((mesh) => { mesh.visible = design.visible !== false; });
        console.info('[CeilingDesigner] Committed room ceiling is registered in the render scene:', {
          id,
          roomId: design.roomId || null,
          openingCount: (entry.mesh?._hciRoomCeiling?.openingCount) || 0,
          profileType: design.profileType || 'flat',
          ...entry.diagnostics,
          visible: entry.root.visible && entry.mesh.visible && !entry.mesh.culled,
        });
        return entry;
      }).catch((error) => {
        const latest = entries.get(id);
        if (latest?.token === token) entries.delete(id);
        console.error('[CeilingDesigner] Could not create room ceiling:', id, error);
        throw error;
      });
      pending.push(record.ready);
    }

    // Callers that apply a design can await this promise before removing the
    // live preview. Scene-state effects may call sync without awaiting it.
    return Promise.all(pending).then(() => next.size);
  };

  const clearPreview = () => {
    previewGeneration += 1;
    destroyEntry(previewEntry);
    previewEntry = null;
  };

  const preview = (design) => {
    clearPreview();
    if (!design) return false;
    const token = previewGeneration;
    void createEntry({ ...design, id: 'preview', visible: true }, { preview: true }).then((entry) => {
      if (token !== previewGeneration) {
        destroyEntry(entry);
        return;
      }
      previewEntry = entry;
    }).catch((error) => {
      console.warn('[CeilingDesigner] Could not build room ceiling preview:', error);
    });
    return true;
  };

  return {
    sync,
    preview,
    clearPreview,
    destroy() {
      clearPreview();
      for (const current of entries.values()) {
        if (current?.token) current.token.cancelled = true;
        destroyEntry(current?.entry);
      }
      entries.clear();
    },
  };
};
