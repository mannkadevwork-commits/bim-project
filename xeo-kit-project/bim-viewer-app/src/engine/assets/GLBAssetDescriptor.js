/**
 * Reads the authored GLB/GLTF scene graph and computes a stable placement
 * descriptor in the asset's own glTF scene space.
 *
 * Why this exists:
 * - xeokit's model.aabb is a world-space bounding box, not an authored local
 *   asset bound.
 * - GLBs from DCC tools may contain root matrices, nested transforms, unit
 *   conversion and axis-conversion nodes.
 * - The editor must not use a post-import/world AABB as a local pivot.
 *
 * The descriptor intentionally does not modify the source GLB. It gives the
 * runtime placement layer a deterministic pivot and dimensions while keeping
 * the original material/geometry intact.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const EPSILON = 1e-10;

const descriptorCache = new Map();

const finite = (value, fallback = 0) => (
  Number.isFinite(Number(value)) ? Number(value) : fallback
);

const vec3 = (value, fallback = [0, 0, 0]) => {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  return value.map((entry, index) => finite(entry, fallback[index]));
};

const identity4 = () => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

// Column-major 4x4 multiplication: out = a * b.
const mul4 = (a, b) => {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let k = 0; k < 4; k += 1) {
        value += a[k * 4 + row] * b[col * 4 + k];
      }
      out[col * 4 + row] = value;
    }
  }
  return out;
};

const translation4 = (t) => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  t[0], t[1], t[2], 1,
];

const quatToMat4 = (q) => {
  const [x, y, z, w] = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    0, 0, 0, 1,
  ];
};

const trs4 = (node) => {
  if (Array.isArray(node?.matrix) && node.matrix.length === 16) {
    return node.matrix.map(Number);
  }

  const t = vec3(node?.translation, [0, 0, 0]);
  const q = vec3Quat(node?.rotation, [0, 0, 0, 1]);
  const s = vec3(node?.scale, [1, 1, 1]);
  const rotation = quatToMat4(q);

  // Scale the rotation basis columns.
  rotation[0] *= s[0]; rotation[1] *= s[0]; rotation[2] *= s[0];
  rotation[4] *= s[1]; rotation[5] *= s[1]; rotation[6] *= s[1];
  rotation[8] *= s[2]; rotation[9] *= s[2]; rotation[10] *= s[2];
  rotation[12] = t[0];
  rotation[13] = t[1];
  rotation[14] = t[2];
  return rotation;
};

const vec3Quat = (value, fallback) => {
  if (!Array.isArray(value) || value.length !== 4) return [...fallback];
  const q = value.map(Number);
  if (!q.every(Number.isFinite)) return [...fallback];
  return q;
};

const transformPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

const corners = (min, max) => [
  [min[0], min[1], min[2]], [max[0], min[1], min[2]],
  [min[0], max[1], min[2]], [max[0], max[1], min[2]],
  [min[0], min[1], max[2]], [max[0], min[1], max[2]],
  [min[0], max[1], max[2]], [max[0], max[1], max[2]],
];

const expandBounds = (bounds, point) => {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
};

const readGLB = (arrayBuffer) => {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 20) {
    throw new Error('Invalid GLB buffer.');
  }

  const view = new DataView(arrayBuffer);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);

  if (magic !== GLB_MAGIC) throw new Error('Not a GLB file.');
  if (version !== GLB_VERSION) throw new Error(`Unsupported GLB version ${version}.`);
  if (totalLength > arrayBuffer.byteLength) throw new Error('Truncated GLB buffer.');

  let offset = 12;
  let gltf = null;
  let bin = null;

  while (offset + 8 <= totalLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;

    if (chunkEnd > arrayBuffer.byteLength) throw new Error('Invalid GLB chunk bounds.');
    const chunk = arrayBuffer.slice(chunkStart, chunkEnd);

    if (chunkType === JSON_CHUNK) {
      const text = new TextDecoder().decode(new Uint8Array(chunk)).replace(/\u0000+$/, '').trim();
      gltf = JSON.parse(text);
    } else if (chunkType === BIN_CHUNK) {
      bin = chunk;
    }

    offset = chunkEnd;
  }

  if (!gltf) throw new Error('GLB JSON chunk missing.');
  return { gltf, bin };
};

const componentInfo = (componentType) => {
  switch (componentType) {
    case 5120: return { size: 1, reader: 'getInt8' };
    case 5121: return { size: 1, reader: 'getUint8' };
    case 5122: return { size: 2, reader: 'getInt16' };
    case 5123: return { size: 2, reader: 'getUint16' };
    case 5125: return { size: 4, reader: 'getUint32' };
    case 5126: return { size: 4, reader: 'getFloat32' };
    default: return null;
  }
};

const typeComponentCount = (type) => {
  switch (type) {
    case 'SCALAR': return 1;
    case 'VEC2': return 2;
    case 'VEC3': return 3;
    case 'VEC4': return 4;
    case 'MAT2': return 4;
    case 'MAT3': return 9;
    case 'MAT4': return 16;
    default: return 0;
  }
};

const getAccessorBounds = (gltf, bin, accessorIndex) => {
  const accessor = gltf.accessors?.[accessorIndex];
  if (!accessor || accessor.type !== 'VEC3') return null;

  if (Array.isArray(accessor.min) && Array.isArray(accessor.max)) {
    return { min: vec3(accessor.min), max: vec3(accessor.max) };
  }

  if (!bin) return null;
  const viewDef = gltf.bufferViews?.[accessor.bufferView];
  const component = componentInfo(accessor.componentType);
  const count = Number(accessor.count) || 0;
  if (!viewDef || !component || !count) return null;

  const components = typeComponentCount(accessor.type);
  if (components !== 3) return null;

  const stride = Number(viewDef.byteStride) || component.size * components;
  const accessorOffset = Number(accessor.byteOffset) || 0;
  const baseOffset = (Number(viewDef.byteOffset) || 0) + accessorOffset;
  const dv = new DataView(bin);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < count; i += 1) {
    const vertexOffset = baseOffset + i * stride;
    for (let axis = 0; axis < 3; axis += 1) {
      const offset = vertexOffset + axis * component.size;
      if (offset + component.size > dv.byteLength) return null;
      const reader = dv[component.reader];
      const value = component.size === 1
        ? reader.call(dv, offset)
        : reader.call(dv, offset, true);
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }

  if (![...min, ...max].every(Number.isFinite)) return null;
  return { min, max };
};

/**
 * Inspect a GLB and return bounds/pivot in glTF scene space.
 */
export const inspectGLBSource = async (srcUrl) => {
  const cacheKey = String(srcUrl || '');
  if (!cacheKey) throw new Error('Cannot inspect GLB without a source URL.');
  if (descriptorCache.has(cacheKey)) return descriptorCache.get(cacheKey);

  const promise = (async () => {
    const response = await fetch(cacheKey, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`GLB inspection fetch failed (${response.status}).`);
    const buffer = await response.arrayBuffer();
    const { gltf, bin } = readGLB(buffer);
    const sceneIndex = Number.isInteger(gltf.scene) ? gltf.scene : 0;
    const scene = gltf.scenes?.[sceneIndex];
    if (!scene?.nodes?.length) throw new Error('GLB scene contains no root nodes.');

    const bounds = {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    };

    const visited = new Set();
    const walk = (nodeIndex, parentMatrix) => {
      if (visited.has(nodeIndex)) return;
      visited.add(nodeIndex);

      const node = gltf.nodes?.[nodeIndex];
      if (!node) return;
      const worldMatrix = mul4(parentMatrix, trs4(node));

      if (Number.isInteger(node.mesh)) {
        const mesh = gltf.meshes?.[node.mesh];
        for (const primitive of mesh?.primitives || []) {
          const positionAccessor = primitive?.attributes?.POSITION;
          if (!Number.isInteger(positionAccessor)) continue;
          const localBounds = getAccessorBounds(gltf, bin, positionAccessor);
          if (!localBounds) continue;
          for (const point of corners(localBounds.min, localBounds.max)) {
            expandBounds(bounds, transformPoint(worldMatrix, point));
          }
        }
      }

      for (const child of node.children || []) walk(child, worldMatrix);
    };

    for (const rootNode of scene.nodes) walk(rootNode, identity4());

    if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) {
      throw new Error('GLB geometry bounds could not be computed.');
    }

    const dimensions = [
      Math.max(0, bounds.max[0] - bounds.min[0]),
      Math.max(0, bounds.max[1] - bounds.min[1]),
      Math.max(0, bounds.max[2] - bounds.min[2]),
    ];

    const center = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];

    return {
      version: 1,
      sourceType: 'glb',
      coordinateSpace: 'gltf-scene',
      upAxis: 'Y',
      units: 'meters',
      bounds,
      center,
      pivotModes: {
        center,
        bottomCenter: [center[0], bounds.min[1], center[2]],
      },
      dimensions,
      bytes: buffer.byteLength,
      nodeCount: Array.isArray(gltf.nodes) ? gltf.nodes.length : 0,
      meshCount: Array.isArray(gltf.meshes) ? gltf.meshes.length : 0,
      materialCount: Array.isArray(gltf.materials) ? gltf.materials.length : 0,
    };
  })();

  descriptorCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    descriptorCache.delete(cacheKey);
    throw error;
  }
};

export const clearGLBDescriptorCache = () => descriptorCache.clear();
