import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';
import { Texture } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/Texture';
import { LinearFilter } from '@xeokit/xeokit-sdk/src/viewer/scene/constants/constants';

const MODEL_ID = 'main_structure';
const EPSILON = 0.0008;

function finiteVector3(v) {
  return Array.isArray(v) && v.length >= 3 && v.every((n) => Number.isFinite(n));
}

function normalizeDefinition(definition) {
  const kind = ['fabric', 'texture'].includes(definition?.kind) ? definition.kind : null;
  const src = definition?.textureSrc || definition?.texture?.src || null;
  return {
    kind,
    src,
    rgb: Array.isArray(definition?.rgb) ? definition.rgb : [1, 1, 1],
    repeat: Array.isArray(definition?.repeat)
      ? definition.repeat
      : Array.isArray(definition?.texture?.repeat)
        ? definition.texture.repeat
        : [2, 2],
    roughness: Number.isFinite(definition?.roughness) ? definition.roughness : 0.8,
  };
}

function transformPoint(m, x, y, z) {
  return [
    x * m[0] + y * m[4] + z * m[8] + m[12],
    x * m[1] + y * m[5] + z * m[9] + m[13],
    x * m[2] + y * m[6] + z * m[10] + m[14],
  ];
}

function transformNormal(m, x, y, z) {
  let nx = x * m[0] + y * m[4] + z * m[8];
  let ny = x * m[1] + y * m[5] + z * m[9];
  let nz = x * m[2] + y * m[6] + z * m[10];
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  return [nx, ny, nz];
}

function chooseProjection(meanNormal) {
  const ax = Math.abs(meanNormal[0]);
  const ay = Math.abs(meanNormal[1]);
  const az = Math.abs(meanNormal[2]);
  if (ay >= ax && ay >= az) return [0, 2]; // floor/ceiling: X/Z
  if (ax >= az) return [2, 1]; // wall facing X: Z/Y
  return [0, 1]; // wall facing Z: X/Y
}

function projectCoordinate(point, axisA, axisB, bounds, repeat) {
  const aMin = bounds[axisA];
  const aSize = Math.max(bounds[axisA + 3] - aMin, 1e-5);
  const bMin = bounds[axisB];
  const bSize = Math.max(bounds[axisB + 3] - bMin, 1e-5);
  return [
    ((point[axisA] - aMin) / aSize) * repeat[0],
    (1 - (point[axisB] - bMin) / bSize) * repeat[1],
  ];
}

export class NativeIFCMaterialController {
  constructor(viewer) {
    this.viewer = viewer;
    this.ifcAPI = null;
    this.ifcModelID = null;
    this.sourceModelID = MODEL_ID;
    this.ifcOpenedHere = false;
    this.overlays = new Map();
    this.geometryCache = new Map();
  }

  setSource(ifcAPI, ifcData, modelID = MODEL_ID) {
    this.clearSource();
    if (!ifcAPI || !ifcData) return;
    this.ifcAPI = ifcAPI;
    this.sourceModelID = modelID;
    this.ifcModelID = this.ifcAPI.OpenModel(new Uint8Array(ifcData));
    this.ifcOpenedHere = true;
  }

  clearSource() {
    this.clearAll();
    this.geometryCache.clear();
    if (this.ifcOpenedHere && this.ifcAPI && this.ifcModelID != null) {
      try { this.ifcAPI.CloseModel(this.ifcModelID); } catch (_) {}
    }
    this.ifcModelID = null;
    this.ifcOpenedHere = false;
    this.ifcAPI = null;
  }

  isNativeTarget(targetId) {
    const entity = this.viewer?.scene?.objects?.[targetId];
    return !!(entity && entity.model?.id === this.sourceModelID);
  }

  async loadImage(src) {
    const response = await fetch(src, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`Material texture request failed (${response.status})`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error(`Material asset is not an image (${blob.type})`);
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = url;
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error(`Unable to decode material texture: ${src}`));
      });
      if (!image.naturalWidth || !image.naturalHeight) throw new Error(`Invalid material image: ${src}`);
      return { image, url };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  getNativeGeometry(globalId, repeat, surface = null) {
    const expressIdValue = this.ifcAPI?.GetExpressIdFromGuid(this.ifcModelID, globalId);
    const expressID = Number(expressIdValue);
    if (!Number.isFinite(expressID) || expressID <= 0) return null;

    let raw = this.geometryCache.get(globalId);
    if (!raw) {
      const rawVertices = [];
      const rawNormals = [];
      const rawIndices = [];
      const maxBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

      this.ifcAPI.StreamMeshes(this.ifcModelID, [expressID], (flatMesh) => {
        const geometries = flatMesh?.geometries;
        if (!geometries) return;
        for (let i = 0; i < geometries.size(); i++) {
          const placed = geometries.get(i);
          const geometry = this.ifcAPI.GetGeometry(this.ifcModelID, placed.geometryExpressID);
          try {
            const vertexData = this.ifcAPI.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            const indexData = this.ifcAPI.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
            const base = rawVertices.length;
            const m = Array.from(placed.flatTransformation || [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);

            for (let v = 0; v < vertexData.length / 6; v++) {
              const p = transformPoint(m, vertexData[v * 6], vertexData[v * 6 + 1], vertexData[v * 6 + 2]);
              const n = transformNormal(m, vertexData[v * 6 + 3], vertexData[v * 6 + 4], vertexData[v * 6 + 5]);
              rawVertices.push(p);
              rawNormals.push(n);
              maxBounds[0] = Math.min(maxBounds[0], p[0]);
              maxBounds[1] = Math.min(maxBounds[1], p[1]);
              maxBounds[2] = Math.min(maxBounds[2], p[2]);
              maxBounds[3] = Math.max(maxBounds[3], p[0]);
              maxBounds[4] = Math.max(maxBounds[4], p[1]);
              maxBounds[5] = Math.max(maxBounds[5], p[2]);
            }
            for (let j = 0; j < indexData.length; j++) rawIndices.push(base + indexData[j]);
          } finally {
            try { geometry.delete(); } catch (_) {}
          }
        }
      });

      if (!rawVertices.length || !rawIndices.length) return null;

      const center = [
        (maxBounds[0] + maxBounds[3]) * 0.5,
        (maxBounds[1] + maxBounds[4]) * 0.5,
        (maxBounds[2] + maxBounds[5]) * 0.5,
      ];
      const size = [
        maxBounds[3] - maxBounds[0],
        maxBounds[4] - maxBounds[1],
        maxBounds[5] - maxBounds[2],
      ];

      // For axis-aligned IFC wall profiles, the two real wall surfaces are on
      // the smallest horizontal dimension (the wall thickness axis). This is
      // deliberately geometric: triangle winding/normals can vary by exporter.
      const thicknessAxis = size[0] <= size[2] ? 0 : 2;
      const thickness = Math.max(size[thicknessAxis], 1e-5);
      raw = { rawVertices, rawNormals, rawIndices, maxBounds, center, size, thicknessAxis, thickness };
      this.geometryCache.set(globalId, raw);
    }

    const { rawVertices, rawNormals, rawIndices, maxBounds, center, size, thicknessAxis, thickness } = raw;
    const positions = [];
    const normals = [];
    const points = [];

    let modelCenter = center;
    let modelBounds = maxBounds;
    const model = this.viewer?.scene?.models?.[this.sourceModelID];
    if (model?.aabb?.length >= 6) {
      modelBounds = model.aabb;
      modelCenter = [(modelBounds[0] + modelBounds[3]) * 0.5, (modelBounds[1] + modelBounds[4]) * 0.5, (modelBounds[2] + modelBounds[5]) * 0.5];
    }

    const isWallSurfaceRequest = !!surface;
    const axisMin = maxBounds[thicknessAxis];
    const axisMax = maxBounds[thicknessAxis + 3];
    const axisMid = (axisMin + axisMax) * 0.5;
    const sideTolerance = Math.max(thickness * 0.12, 0.002);

    // Determine which physical wall face is the building-facing side from the
    // wall center, not from triangle normal winding. This fixes front/back walls
    // whose normals are inconsistently wound by the IFC exporter.
    const toBuilding = modelCenter[thicknessAxis] - center[thicknessAxis];
    const interiorIsMinSide = toBuilding <= 0;
    const interiorCoordinate = interiorIsMinSide ? axisMin : axisMax;

    // Base fallback for a non-scoped material: preserve the entire wall geometry.
    if (!isWallSurfaceRequest) {
      for (let i = 0; i < rawIndices.length; i += 3) {
        const ia = rawIndices[i], ib = rawIndices[i + 1], ic = rawIndices[i + 2];
        const tri = [rawVertices[ia], rawVertices[ib], rawVertices[ic]];
        const e1 = [tri[1][0]-tri[0][0], tri[1][1]-tri[0][1], tri[1][2]-tri[0][2]];
        const e2 = [tri[2][0]-tri[0][0], tri[2][1]-tri[0][1], tri[2][2]-tri[0][2]];
        const fn = [
          e1[1]*e2[2] - e1[2]*e2[1],
          e1[2]*e2[0] - e1[0]*e2[2],
          e1[0]*e2[1] - e1[1]*e2[0],
        ];
        const len = Math.hypot(...fn) || 1;
        const normal = [fn[0]/len, fn[1]/len, fn[2]/len];
        for (const [index, normalIndex] of [[ia, ia], [ib, ib], [ic, ic]]) {
          const p = rawVertices[index];
          const n = rawNormals[normalIndex];
          positions.push(p[0] + n[0]*EPSILON, p[1] + n[1]*EPSILON, p[2] + n[2]*EPSILON);
          normals.push(...n);
          points.push(p);
        }
      }
    } else {
      for (let i = 0; i < rawIndices.length; i += 3) {
        const ia = rawIndices[i], ib = rawIndices[i + 1], ic = rawIndices[i + 2];
        const p0 = rawVertices[ia], p1 = rawVertices[ib], p2 = rawVertices[ic];
        const e1 = [p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]];
        const e2 = [p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2]];
        const fn = [
          e1[1]*e2[2] - e1[2]*e2[1],
          e1[2]*e2[0] - e1[0]*e2[2],
          e1[0]*e2[1] - e1[1]*e2[0],
        ];
        const fl = Math.hypot(...fn);
        if (!fl) continue;
        const horizontalNormal = Math.hypot(fn[0], fn[2]) / fl;
        if (horizontalNormal < 0.65) continue;

        const triCenterAxis = (p0[thicknessAxis] + p1[thicknessAxis] + p2[thicknessAxis]) / 3;
        const distFromMid = Math.abs(triCenterAxis - axisMid);
        if (distFromMid < Math.max(thickness * 0.25, sideTolerance)) continue;

        const isMinSide = Math.abs(triCenterAxis - axisMin) <= Math.abs(triCenterAxis - axisMax);
        const isInterior = isMinSide === interiorIsMinSide;
        const wanted = surface === 'interior' ? isInterior : !isInterior;
        if (!wanted) continue;

        for (const index of [ia, ib, ic]) {
          const p = rawVertices[index];
          const n = rawNormals[index];
          positions.push(p[0] + n[0]*EPSILON, p[1] + n[1]*EPSILON, p[2] + n[2]*EPSILON);
          normals.push(...n);
          points.push(p);
        }
      }
    }

    if (!positions.length) return null;

    // Projection uses the selected surface bounds where possible so texture
    // mapping remains stable and does not stretch across the opposite wall side.
    const selectedBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    points.forEach((p) => {
      selectedBounds[0] = Math.min(selectedBounds[0], p[0]);
      selectedBounds[1] = Math.min(selectedBounds[1], p[1]);
      selectedBounds[2] = Math.min(selectedBounds[2], p[2]);
      selectedBounds[3] = Math.max(selectedBounds[3], p[0]);
      selectedBounds[4] = Math.max(selectedBounds[4], p[1]);
      selectedBounds[5] = Math.max(selectedBounds[5], p[2]);
    });

    const representativeNormal = [0, 0, 0];
    for (let i = 0; i < normals.length; i += 3) {
      representativeNormal[0] += normals[i];
      representativeNormal[1] += normals[i + 1];
      representativeNormal[2] += normals[i + 2];
    }
    const representativeLength = Math.hypot(...representativeNormal) || 1;
    representativeNormal[0] /= representativeLength;
    representativeNormal[1] /= representativeLength;
    representativeNormal[2] /= representativeLength;

    const [axisA, axisB] = chooseProjection(representativeNormal);
    const uvs = [];
    for (let i = 0; i < positions.length; i += 3) {
      const p = [positions[i], positions[i + 1], positions[i + 2]];
      const uv = projectCoordinate(p, axisA, axisB, selectedBounds, repeat);
      uvs.push(uv[0], uv[1]);
    }

    const indices = Array.from({ length: positions.length / 3 }, (_, i) => i);
    return { positions, normals, uvs, indices };
  }

  destroyOverlay(targetId) {
    const entries = this.overlays.get(targetId);
    if (!entries) return;
    const list = Array.isArray(entries) ? entries : [entries];
    list.forEach((entry) => {
      try { entry.mesh.destroy(); } catch (_) {}
      try { entry.material.destroy(); } catch (_) {}
      if (entry.texture) {
        try { entry.texture.destroy(); } catch (_) {}
      }
      if (entry.url) URL.revokeObjectURL(entry.url);
    });
    this.overlays.delete(targetId);
  }

  clearAll() {
    for (const targetId of [...this.overlays.keys()]) this.destroyOverlay(targetId);
  }

  async _createOverlay(targetId, definition, surface = null) {
    const repeat = Array.isArray(definition.repeat) ? definition.repeat : [2, 2];
    const geometryData = this.getNativeGeometry(targetId, repeat, surface);
    if (!geometryData) return null;

    let texture = null;
    let loadedUrl = null;
    let material;
    if (definition.kind === 'fabric' || definition.kind === 'texture') {
      const textureSrc = definition.textureSrc || definition.texture?.src;
      if (!textureSrc) return null;
      const loaded = await this.loadImage(textureSrc);
      loadedUrl = loaded.url;
      texture = new Texture(this.viewer.scene, {
        image: loaded.image,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
      });
      material = new PhongMaterial(this.viewer.scene, {
        diffuse: [1, 1, 1],
        diffuseMap: texture,
        emissive: [0, 0, 0],
        shininess: Math.max(8, Math.round((1 - (definition.roughness ?? 0.8)) * 100)),
        backfaces: true,
      });
    } else {
      material = new PhongMaterial(this.viewer.scene, {
        diffuse: Array.isArray(definition.rgb) ? definition.rgb : [1, 1, 1],
        emissive: [0, 0, 0],
        shininess: Math.max(8, Math.round((1 - (definition.roughness ?? 0.8)) * 100)),
        backfaces: true,
      });
    }

    const mesh = new Mesh(this.viewer.scene, {
      id: `hci_native_mat_${targetId}_${surface || 'all'}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      geometry: new ReadableGeometry(this.viewer.scene, {
        primitive: 'triangles',
        positions: geometryData.positions,
        normals: geometryData.normals,
        uv: geometryData.uvs,
        indices: geometryData.indices,
      }),
      material,
      pickable: false,
      collidable: false,
      visible: true,
    });

    return { mesh, material, texture, url: loadedUrl };
  }

  async apply(targetId, definition) {
    if (!this.isNativeTarget(targetId)) return { handled: false, applied: false };

    if (!this.ifcAPI || this.ifcModelID == null) {
      console.warn('[NativeMaterial] IFC source context is not ready');
      return { handled: true, applied: false };
    }

    const scope = ['interior', 'exterior', 'both'].includes(definition?.surfaceScope)
      ? definition.surfaceScope
      : null;
    const isScopedState = definition?.surfaceScope === 'scoped' && definition?.surfaces;

    // Scoped wall material path: create a separate, slightly offset overlay for
    // each selected wall side. This works for colors as well as fabric/texture.
    if (scope || isScopedState) {
      this.destroyOverlay(targetId);
      const requested = isScopedState
        ? ['interior', 'exterior'].filter((side) => definition.surfaces?.[side])
        : (scope === 'both' ? ['interior', 'exterior'] : [scope]);
      const entries = [];
      try {
        for (const surface of requested) {
          const surfaceDefinition = isScopedState
            ? { ...definition.surfaces[surface], surfaceScope: null }
            : { ...definition, surfaceScope: null };
          const entry = await this._createOverlay(targetId, surfaceDefinition, surface);
          if (entry) entries.push(entry);
        }
      } catch (error) {
        entries.forEach((entry) => {
          try { entry.mesh.destroy(); } catch (_) {}
          try { entry.material.destroy(); } catch (_) {}
          if (entry.texture) { try { entry.texture.destroy(); } catch (_) {} }
          if (entry.url) URL.revokeObjectURL(entry.url);
        });
        console.warn('[NativeMaterial] Scoped wall material failed:', error);
        return { handled: true, applied: false };
      }

      if (!entries.length) return { handled: true, applied: false };
      this.overlays.set(targetId, entries);
      return { handled: true, applied: true };
    }

    const kind = definition?.kind;
    if (!['fabric', 'texture'].includes(kind)) {
      this.destroyOverlay(targetId);
      return { handled: true, applied: false };
    }

    const entry = await this._createOverlay(targetId, definition, null);
    if (!entry) return { handled: true, applied: false };
    this.destroyOverlay(targetId);
    this.overlays.set(targetId, [entry]);
    return { handled: true, applied: true };
  }

}
