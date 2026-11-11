import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh.js';
import { Node } from '@xeokit/xeokit-sdk/src/viewer/scene/nodes/Node.js';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry.js';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial.js';
import { ShapeUtils, Vector2 } from 'three';

const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const safeId = (value) => String(value || 'room')
  .replace(/[^a-zA-Z0-9_-]/g, '_')
  .slice(0, 100) || 'room';

const normalizeRing = (points) => (Array.isArray(points) ? points : [])
  .map((point) => ({ x: finite(point?.x, NaN), z: finite(point?.z, NaN) }))
  .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));

function buildRoomGeometry(scene, room) {
  const outer = normalizeRing(room?.boundary?.outer);
  const holes = (Array.isArray(room?.boundary?.holes) ? room.boundary.holes : [])
    .map(normalizeRing)
    .filter((ring) => ring.length >= 3);
  if (outer.length < 3) throw new Error('Room boundary must contain at least three valid points.');

  const outerPoints = outer.map((point) => new Vector2(point.x, point.z));
  const holePoints = holes.map((ring) => ring.map((point) => new Vector2(point.x, point.z)));
  const triangles = ShapeUtils.triangulateShape(outerPoints, holePoints);
  if (!triangles.length) throw new Error('Room boundary could not be triangulated.');

  const flat = [outer, ...holes].flat();
  const floorY = finite(room.floorY, 0) + 0.018;
  const positions = [];
  const normals = [];
  const uv = [];
  flat.forEach((point) => {
    positions.push(point.x, floorY, point.z);
    normals.push(0, 1, 0);
    uv.push(point.x, point.z);
  });
  const indices = triangles.flatMap((triangle) => triangle);
  return { positions, normals, uv, indices, floorY };
}

/**
 * Creates transparent, pickable floor-footprint overlays for detected rooms.
 * They are selection surfaces only: they never replace or mutate IFC geometry.
 */
export const createRoomSelectionController = (viewer) => {
  const scene = viewer?.scene;
  const entries = new Map();
  let selectedRoomId = null;
  if (!scene) {
    return { sync: () => 0, setSelectedRoom: () => {}, getRoom: () => null, destroy: () => {} };
  }

  const applyStyle = (entry, selected) => {
    if (!entry?.material) return;
    entry.material.diffuse = selected ? [0.08, 0.58, 0.82] : [0.12, 0.55, 0.78];
    entry.material.emissive = selected ? [0.025, 0.18, 0.28] : [0, 0, 0];
    entry.material.alpha = selected ? 0.25 : 0.012;
    entry.material.alphaMode = 'blend';
    entry.material.edges = true;
    entry.material.edgeColor = [0.12, 0.72, 0.96];
    entry.material.edgeAlpha = selected ? 0.98 : 0.24;
    entry.material.edgeWidth = selected ? 2.6 : 1.15;
    entry.mesh.highlighted = false;
  };

  const destroyEntry = (entry) => {
    if (!entry) return;
    try { entry.root?.removeChild?.(entry.mesh); } catch (_) {}
    try { entry.mesh?.destroy?.(); } catch (_) {}
    try { entry.root?.destroy?.(); } catch (_) {}
    try { entry.geometry?.destroy?.(); } catch (_) {}
    try { entry.material?.destroy?.(); } catch (_) {}
  };

  const createEntry = (room) => {
    const geometryData = buildRoomGeometry(scene, room);
    const geometry = new ReadableGeometry(scene, {
      primitive: 'triangles',
      positions: geometryData.positions,
      normals: geometryData.normals,
      uv: geometryData.uv,
      indices: geometryData.indices,
    });
    const material = new PhongMaterial(scene, {
      diffuse: [0.12, 0.55, 0.78],
      emissive: [0, 0, 0],
      alpha: 0.012,
      alphaMode: 'blend',
      shininess: 4,
      backfaces: true,
      edges: true,
      edgeColor: [0.12, 0.72, 0.96],
      edgeAlpha: 0.24,
      edgeWidth: 1.15,
    });
    const id = `hci_room_selection_${safeId(room.id)}`;
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
      pickable: true,
      collidable: false,
      clippable: false,
      culled: false,
      visible: true,
    });
    mesh._hciRoomSelection = { roomId: String(room.id), componentKind: 'room-selection-surface' };
    root._hciRoomSelection = { roomId: String(room.id), componentKind: 'room-selection-model' };
    const entry = { room, root, mesh, geometry, material };
    applyStyle(entry, String(room.id) === selectedRoomId);
    return entry;
  };

  const sync = (rooms) => {
    for (const entry of entries.values()) destroyEntry(entry);
    entries.clear();
    (Array.isArray(rooms) ? rooms : []).forEach((room) => {
      if (!room?.id || !Array.isArray(room?.boundary?.outer) || room.boundary.outer.length < 3) return;
      try {
        entries.set(String(room.id), createEntry(room));
      } catch (error) {
        console.warn(`[RoomSelection] Skipped room ${room?.label || room?.id}:`, error?.message || error);
      }
    });
    if (selectedRoomId && !entries.has(selectedRoomId)) selectedRoomId = null;
    return entries.size;
  };

  const setSelectedRoom = (roomId) => {
    selectedRoomId = roomId ? String(roomId) : null;
    for (const [id, entry] of entries.entries()) applyStyle(entry, id === selectedRoomId);
  };

  return {
    sync,
    setSelectedRoom,
    getRoom: (roomId) => entries.get(String(roomId))?.room || null,
    destroy() {
      for (const entry of entries.values()) destroyEntry(entry);
      entries.clear();
      selectedRoomId = null;
    },
  };
};
