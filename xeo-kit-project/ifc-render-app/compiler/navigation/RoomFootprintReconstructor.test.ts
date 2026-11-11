import assert from "node:assert/strict";
import test from "node:test";
import {
  gridCellCenter,
  pointInPlanPolygon,
  polygonArea,
  resolveRoomSeeds,
  type RoomFloorGrid,
  type RoomFootprintAnchor,
  type RoomPlanPoint,
} from "./RoomFootprintReconstructor";

function createGrid(minX: number, minY: number, width: number, height: number, cellSize = 0.1): RoomFloorGrid {
  const size = width * height;
  const floor = new Uint8Array(size);
  floor.fill(1);
  return {
    minX, minY, width, height, cellSize, floor,
    blocked: new Uint8Array(size),
    room: new Int32Array(size).fill(-1),
  };
}

test("IFC Z-up placements resolve into viewer X/Z coordinates", () => {
  const grid = createGrid(0, -4, 100, 50);
  const floor: RoomPlanPoint[] = [
    { x: 0, y: -4 }, { x: 10, y: -4 }, { x: 10, y: 1 }, { x: 0, y: 1 },
  ];
  const anchors: RoomFootprintAnchor[] = [
    { key: "a", label: "Room A", x: 2, y: -1, sourceX: 2, sourceY: 1 },
    { key: "b", label: "Room B", x: 8, y: -2, sourceX: 8, sourceY: 2 },
  ];
  const result = resolveRoomSeeds(anchors, floor, grid, 0.25);
  assert.equal(result.seeds.length, 2);
  assert.equal(result.mappingId, "viewer-world-xz");
  assert.ok(Math.abs(result.seeds[0].point.y + 1) < 1e-9);
  assert.ok(Math.abs(result.seeds[1].point.y + 2) < 1e-9);
});

test("anchor resolver refuses a semantic point several metres outside the floor", () => {
  const grid = createGrid(0, 0, 50, 50);
  const floor: RoomPlanPoint[] = [
    { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 },
  ];
  const result = resolveRoomSeeds([
    { key: "far", label: "Far Room", x: 20, y: 20 },
  ], floor, grid, 0.25);
  assert.equal(result.seeds.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("No generic whole-floor room")));
});

test("plan geometry primitives preserve area and containment", () => {
  const rectangle: RoomPlanPoint[] = [
    { x: 1, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 4 }, { x: 1, y: 4 },
  ];
  assert.equal(polygonArea(rectangle), 8);
  assert.equal(pointInPlanPolygon({ x: 3, y: 3 }, rectangle), true);
  assert.equal(pointInPlanPolygon({ x: 8, y: 3 }, rectangle), false);
  const grid = createGrid(1, 2, 40, 20);
  const center = gridCellCenter(grid, 0);
  assert.deepEqual(center, { x: 1.05, y: 2.05 });
});


test("viewer-frame anchors take precedence over stale/raw IFC coordinates", () => {
  const grid = createGrid(0, -4, 100, 50);
  const floor: RoomPlanPoint[] = [
    { x: 0, y: -4 }, { x: 10, y: -4 }, { x: 10, y: 1 }, { x: 0, y: 1 },
  ];
  const anchors: RoomFootprintAnchor[] = [
    { key: "living", label: "Living Room", x: 2.0, y: -1.0, sourceX: 202.0, sourceY: 101.0 },
    { key: "bed", label: "Bedroom", x: 8.0, y: -2.0, sourceX: 208.0, sourceY: 102.0 },
  ];
  const result = resolveRoomSeeds(anchors, floor, grid, 0.25);
  assert.equal(result.mappingId, "viewer-world-xz");
  assert.equal(result.seeds.length, 2);
  assert.ok(Math.abs(result.seeds[0].point.x - 2.0) < 1e-9);
  assert.ok(Math.abs(result.seeds[0].point.y + 1.0) < 1e-9);
});

test("IFC source coordinates are used only when viewer coordinates are unavailable", () => {
  const grid = createGrid(0, -4, 100, 50);
  const floor: RoomPlanPoint[] = [
    { x: 0, y: -4 }, { x: 10, y: -4 }, { x: 10, y: 1 }, { x: 0, y: 1 },
  ];
  const anchors: RoomFootprintAnchor[] = [
    { key: "source-only", label: "Source-only room", x: Number.NaN, y: Number.NaN, sourceX: 3.0, sourceY: 1.5 },
  ];
  const result = resolveRoomSeeds(anchors, floor, grid, 0.25);
  assert.equal(result.mappingId, "ifc-z-up-to-viewer-xz");
  assert.equal(result.seeds.length, 1);
  assert.ok(Math.abs(result.seeds[0].point.x - 3.0) < 1e-9);
  assert.ok(Math.abs(result.seeds[0].point.y + 1.5) < 1e-9);
});
