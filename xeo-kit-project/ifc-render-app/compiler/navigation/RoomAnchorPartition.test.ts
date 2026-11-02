import test from "node:test";
import assert from "node:assert/strict";
import { partitionFloorByRoomAnchors } from "./RoomAnchorPartition";

function makeGrid(width: number, height: number, cellSize: number, minX = 0, minY = 0) {
  return {
    minX, minY, cellSize, width, height,
    floor: new Uint8Array(width * height).fill(1),
    blocked: new Uint8Array(width * height),
    room: new Int32Array(width * height).fill(-1),
  };
}

test("partitions adjacent rooms through a doorway while respecting wall barriers", () => {
  const grid = makeGrid(20, 12, 0.25);
  // Internal wall is a hard barrier except for a two-cell doorway.
  for (let j = 0; j < grid.height; j++) {
    if (j === 5 || j === 6) continue;
    grid.blocked[j * grid.width + 10] = 1;
  }

  const result = partitionFloorByRoomAnchors(grid, [
    { key: "a", label: "Living Room", x: 1, y: 1.5 },
    { key: "b", label: "Bedroom", x: 4, y: 1.5 },
  ]);

  if (!result) throw new Error("Expected a two-room partition.");
  assert.equal(result.components.length, 2);
  assert.equal(result.coverageRatio, 1);
  assert.equal(result.anchorByComponent.get(0)?.label, "Living Room");
  assert.equal(result.anchorByComponent.get(1)?.label, "Bedroom");

  const leftCell = Math.floor(1 / grid.cellSize) + Math.floor(1.5 / grid.cellSize) * grid.width;
  const rightCell = Math.floor(4 / grid.cellSize) + Math.floor(1.5 / grid.cellSize) * grid.width;
  assert.equal(grid.room[leftCell], 0);
  assert.equal(grid.room[rightCell], 1);
});

test("uses all nine semantic IFC anchors from the supplied 3-BHK fixture", () => {
  const grid = makeGrid(64, 44, 0.25, 0, -10);
  const rawAnchors = [
    ["living", "Living Room", 3.90, 4.85],
    ["dining", "Dining Area", 8.18, 2.35],
    ["bedroom2", "Bedroom 2", 3.38, 7.95],
    ["kitchen", "Kitchen", 6.25, 8.55],
    ["master", "Master Bedroom", 12.35, 7.45],
    ["bedroom3", "Bedroom 3", 12.75, 3.75],
    ["bath", "Common Bathroom", 6.90, 5.95],
    ["ensuite", "Master Ensuite", 12.40, 6.08],
    ["circulation", "Main Circulation", 8.68, 4.05],
  ] as const;

  const result = partitionFloorByRoomAnchors(grid, rawAnchors.map(([key, label, x, rawY]) => ({
    key, label, x, y: -rawY,
  })));

  if (!result) throw new Error("Expected nine anchored room regions.");
  assert.equal(result.components.length, 9);
  assert.equal(result.resolvedAnchors.length, 9);
  assert.ok(result.coverageRatio > 0.99);
  assert.deepEqual(
    result.components.map((component) => result.anchorByComponent.get(component.id)?.label).sort(),
    rawAnchors.map((anchor) => anchor[1]).sort(),
  );
});

test("does not create semantic rooms from a single usable seed", () => {
  const grid = makeGrid(10, 10, 0.25);
  grid.room.fill(23);
  const result = partitionFloorByRoomAnchors(grid, [
    { key: "a", label: "Living Room", x: 1, y: 1 },
    { key: "b", label: "Out of bounds", x: 100, y: 100 },
  ]);
  assert.equal(result, null);
  assert.ok(grid.room.every((value) => value === 23), "failed partition must leave legacy room labels untouched");
});
