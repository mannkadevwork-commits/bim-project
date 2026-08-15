// math.ts
// Zero-dependency math utilities for IFC -> GLB pivot correction and rotation conversion.
// Uses only native Math operations to keep the backend compiler lightweight.

import type { Node, Mesh, Primitive } from '@gltf-transform/core';

/** Simple mutable AABB accumulator, stride-3 friendly. */
interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

function createEmptyAABB(): AABB {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

/**
 * Expands an AABB in-place using a raw, tightly-packed Float32Array of
 * vertex positions (stride 3: x, y, z, x, y, z, ...).
 */
function expandAABBFromPositions(aabb: AABB, positions: Float32Array): void {
  const len = positions.length;

  for (let i = 0; i < len; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];

    if (x < aabb.minX) aabb.minX = x;
    if (x > aabb.maxX) aabb.maxX = x;
    if (y < aabb.minY) aabb.minY = y;
    if (y > aabb.maxY) aabb.maxY = y;
    if (z < aabb.minZ) aabb.minZ = z;
    if (z > aabb.maxZ) aabb.maxZ = z;
  }
}

/**
 * Accumulates the AABB contribution of every primitive on a single Mesh.
 */
function accumulateMeshAABB(aabb: AABB, mesh: Mesh): void {
  const primitives: Primitive[] = mesh.listPrimitives();

  for (const primitive of primitives) {
    const positionAccessor = primitive.getAttribute('POSITION');
    if (!positionAccessor) continue;

    const positions = positionAccessor.getArray();
    if (!positions || positions.length === 0) continue;

    // Accessor arrays are typically Float32Array for POSITION per glTF spec,
    // but we coerce defensively in case of quantized/normalized accessors
    // that have already been dequantized by gltf-transform.
    expandAABBFromPositions(
      aabb,
      positions instanceof Float32Array ? positions : Float32Array.from(positions)
    );
  }
}

/**
 * Computes the bottom-center pivot offset for a glTF Node, matching the
 * frontend's "bottom-center" placement convention.
 *
 * Traverses the node's own Mesh (if any) plus the Meshes of its direct
 * children, reads raw POSITION data from every primitive's accessor, and
 * derives a local-space AABB. The returned offset represents where the
 * node's origin would need to sit so that rotation/scale (which always
 * pivot around [0,0,0] in glTF/WebGL) happens around the object's true
 * visual center on X/Z and its true floor line on Y.
 *
 * IMPORTANT: This intentionally operates in LOCAL (pre-transform) mesh
 * space. Computing it from world-space positions would be circular, since
 * the offset is meant to inform the translation that precedes rotation.
 *
 * @param node A @gltf-transform/core Node object.
 * @returns [centerX, bottomY, centerZ] pivot offset tuple.
 */
export function computeAssetPivotOffset(node: Node): [number, number, number] {
  const aabb = createEmptyAABB();

  // 1. The node's own mesh, if present.
  const ownMesh = node.getMesh();
  if (ownMesh) {
    accumulateMeshAABB(aabb, ownMesh);
  }

  // 2. Direct children only, per spec (non-recursive beyond one level).
  const children: Node[] = node.listChildren();
  for (const child of children) {
    const childMesh = child.getMesh();
    if (childMesh) {
      accumulateMeshAABB(aabb, childMesh);
    }
  }

  // Guard: no geometry found anywhere in scope. Return a zero offset
  // rather than propagating Infinity/-Infinity into the pipeline.
  if (!isFinite(aabb.minX) || !isFinite(aabb.maxX)) {
    return [0, 0, 0];
  }

  const centerX = (aabb.minX + aabb.maxX) / 2;
  const bottomY = aabb.minY;
  const centerZ = (aabb.minZ + aabb.maxZ) / 2;

  return [centerX, bottomY, centerZ];
}

/**
 * Converts Euler angles in degrees [X, Y, Z] to a glTF-compliant
 * Quaternion [x, y, z, w], using intrinsic XYZ rotation order —
 * matching three.js's default `Euler` order and standard WebGL/glTF
 * authoring convention.
 *
 * Composition order: q = qX * qY * qZ (X applied first, then Y, then Z,
 * each relative to the rotated frame of the previous step).
 *
 * @param eulerDegrees [x, y, z] rotation in degrees.
 * @returns [x, y, z, w] normalized quaternion.
 */
export function eulerToQuaternion(
  eulerDegrees: [number, number, number]
): [number, number, number, number] {
  const DEG_TO_RAD = Math.PI / 180;

  const x = eulerDegrees[0] * DEG_TO_RAD;
  const y = eulerDegrees[1] * DEG_TO_RAD;
  const z = eulerDegrees[2] * DEG_TO_RAD;

  const halfX = x / 2;
  const halfY = y / 2;
  const halfZ = z / 2;

  const c1 = Math.cos(halfX);
  const c2 = Math.cos(halfY);
  const c3 = Math.cos(halfZ);
  const s1 = Math.sin(halfX);
  const s2 = Math.sin(halfY);
  const s3 = Math.sin(halfZ);

  // Intrinsic XYZ composition (matches three.js Quaternion.setFromEuler, 'XYZ').
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;

  // Defensive re-normalization to guard against floating point drift,
  // since glTF requires unit quaternions for valid rotation nodes.
  const length = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);

  if (length === 0) {
    return [0, 0, 0, 1];
  }

  return [qx / length, qy / length, qz / length, qw / length];
}