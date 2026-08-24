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

  getNativeGeometry(globalId, repeat) {
    const expressIdValue = this.ifcAPI?.GetExpressIdFromGuid(this.ifcModelID, globalId);
    const expressID = Number(expressIdValue);
    if (!Number.isFinite(expressID) || expressID <= 0) return null;

    const positions = [];
    const normals = [];
    const indices = [];
    const worldPoints = [];
    const worldNormals = [];
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
          const base = positions.length / 3;
          const m = Array.from(placed.flatTransformation || [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);

          for (let v = 0; v < vertexData.length / 6; v++) {
            const p = transformPoint(m, vertexData[v * 6], vertexData[v * 6 + 1], vertexData[v * 6 + 2]);
            const n = transformNormal(m, vertexData[v * 6 + 3], vertexData[v * 6 + 4], vertexData[v * 6 + 5]);
            worldPoints.push(p);
            worldNormals.push(n);
            positions.push(p[0] + n[0] * EPSILON, p[1] + n[1] * EPSILON, p[2] + n[2] * EPSILON);
            normals.push(n[0], n[1], n[2]);
            maxBounds[0] = Math.min(maxBounds[0], p[0]);
            maxBounds[1] = Math.min(maxBounds[1], p[1]);
            maxBounds[2] = Math.min(maxBounds[2], p[2]);
            maxBounds[3] = Math.max(maxBounds[3], p[0]);
            maxBounds[4] = Math.max(maxBounds[4], p[1]);
            maxBounds[5] = Math.max(maxBounds[5], p[2]);
          }

          for (let j = 0; j < indexData.length; j++) indices.push(base + indexData[j]);
        } finally {
          try { geometry.delete(); } catch (_) {}
        }
      }
    });

    if (!positions.length || !indices.length) return null;

    const meanNormal = [0, 0, 0];
    worldNormals.forEach(n => { meanNormal[0] += n[0]; meanNormal[1] += n[1]; meanNormal[2] += n[2]; });
    const nLen = Math.hypot(...meanNormal) || 1;
    meanNormal[0] /= nLen; meanNormal[1] /= nLen; meanNormal[2] /= nLen;

    const [axisA, axisB] = chooseProjection(meanNormal);
    const uvs = [];
    worldPoints.forEach((p) => {
      const uv = projectCoordinate(p, axisA, axisB, maxBounds, repeat);
      uvs.push(uv[0], uv[1]);
    });

    return { positions, normals, uvs, indices };
  }

  destroyOverlay(targetId) {
    const entry = this.overlays.get(targetId);
    if (!entry) return;
    try { entry.mesh.destroy(); } catch (_) {}
    try { entry.material.destroy(); } catch (_) {}
    if (entry.texture) {
      try { entry.texture.destroy(); } catch (_) {}
    }
    if (entry.url) URL.revokeObjectURL(entry.url);
    this.overlays.delete(targetId);
  }

  clearAll() {
    for (const targetId of [...this.overlays.keys()]) this.destroyOverlay(targetId);
  }

  async apply(targetId, definition) {
    if (!this.isNativeTarget(targetId)) return { handled: false, applied: false };

    const kind = definition?.kind;
    if (!['fabric', 'texture'].includes(kind)) {
      this.destroyOverlay(targetId);
      return { handled: true, applied: false };
    }

    if (!this.ifcAPI || this.ifcModelID == null) {
      console.warn('[NativeMaterial] IFC source context is not ready');
      return { handled: true, applied: false };
    }

    const textureSrc = definition.textureSrc || definition.texture?.src;
    if (!textureSrc) return { handled: true, applied: false };

    const repeat = Array.isArray(definition.repeat) ? definition.repeat : [2, 2];
    const geometryData = this.getNativeGeometry(targetId, repeat);
    if (!geometryData) {
      console.warn('[NativeMaterial] No source geometry found for', targetId);
      return { handled: true, applied: false };
    }

    this.destroyOverlay(targetId);

    const loaded = await this.loadImage(textureSrc);
    const texture = new Texture(this.viewer.scene, {
      image: loaded.image,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    const material = new PhongMaterial(this.viewer.scene, {
      diffuse: [1, 1, 1],
      diffuseMap: texture,
      emissive: [0, 0, 0],
      shininess: Math.max(8, Math.round((1 - (definition.roughness ?? 0.8)) * 100)),
      backfaces: true,
    });
    const mesh = new Mesh(this.viewer.scene, {
      id: `hci_native_mat_${targetId}_${Date.now()}`,
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

    this.overlays.set(targetId, { mesh, material, texture, url: loaded.url });
    return { handled: true, applied: true };
  }
}
