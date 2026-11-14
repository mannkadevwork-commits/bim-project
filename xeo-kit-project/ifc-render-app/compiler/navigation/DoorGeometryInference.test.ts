import assert from "node:assert/strict";
import test from "node:test";
import { findInteriorDoorSideSamples, inferDoorWallMatch, type DoorGeometrySeed, type WallGeometryCandidate } from "./DoorGeometryInference";

const door: DoorGeometrySeed = {
  sourceFile: "input.ifc",
  expressId: 1514,
  globalId: "door-guid",
  name: "Bedroom door",
  placementOrigin: { x: 0, y: 0 },
  widthAxis: { x: 1, y: 0 },
  widthMeters: 0.9,
  heightMeters: 2.12,
};

const wall: WallGeometryCandidate = {
  key: "wall-a",
  sourceFile: "input.ifc",
  expressId: 100,
  globalId: "wall-guid",
  name: "Partition wall",
  // A wall segment ends at the left jamb. The door opening occupies x=[0,0.9].
  points: [
    { x: -2, y: -0.10 }, { x: -0.02, y: -0.10 },
    { x: -0.02, y: 0.10 }, { x: -2, y: 0.10 },
  ],
  center: { x: -1.01, y: 0 },
  minY: 0,
  maxY: 2.8,
  sizeX: 1.98,
  sizeY: 0.2,
};

test("finds the opening center from IFC placement origin and OverallWidth", () => {
  const result = inferDoorWallMatch(door, [wall], { floorElevation: 0 });
  assert.ok(result.match);
  assert.deepEqual(result.match.center, { x: 0.45, y: 0 });
  assert.equal(result.match.alignment, 1);
  assert.ok(result.match.wallThickness >= 0.19 && result.match.wallThickness <= 0.21);
  assert.equal(result.match.sealPolygon.length, 4);
});

test("rejects a nearby wall whose long axis is not aligned with door width", () => {
  const perpendicular: WallGeometryCandidate = {
    ...wall,
    points: [
      { x: 0.35, y: -2 }, { x: 0.55, y: -2 },
      { x: 0.55, y: 2 }, { x: 0.35, y: 2 },
    ],
  };
  const result = inferDoorWallMatch(door, [perpendicular], { floorElevation: 0 });
  assert.equal(result.match, null);
  assert.equal(result.failureReason, "no-wall-parallel-to-door-width");
});

test("rejects a door too far from any wall segment even when orientations match", () => {
  const distant = { ...wall, points: wall.points.map((p) => ({ x: p.x, y: p.y + 1.5 })), center: { x: -1.01, y: 1.5 } };
  const result = inferDoorWallMatch(door, [distant], { floorElevation: 0 });
  assert.equal(result.match, null);
});

test("only accepts a pre-seal pair when both sides are walkable", () => {
  const accepted = findInteriorDoorSideSamples(
    { x: 0, y: 0 }, { x: 0, y: 1 }, 0.2,
    (p) => Math.abs(p.y) > 0.25,
  );
  assert.ok(accepted);
  const rejected = findInteriorDoorSideSamples(
    { x: 0, y: 0 }, { x: 0, y: 1 }, 0.2,
    (p) => p.y > 0.25,
  );
  assert.equal(rejected, null);
});

test("resolves two different semantic IFC spaces on opposite sides of an internal door", async () => {
  const { resolveDistinctSemanticAnchorSides } = await import("./DoorGeometryInference");
  const result = resolveDistinctSemanticAnchorSides(
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: 0.5 },
    { x: 0, y: -0.5 },
    [
      { key: "living-room", x: 0.2, y: 2 },
      { key: "bedroom", x: 0.2, y: -2 },
    ],
  );
  assert.deepEqual(result, { sideAKey: "living-room", sideBKey: "bedroom", distinct: true });
});

test("rejects exterior or ambiguous doors when one side has no semantic room anchor", async () => {
  const { resolveDistinctSemanticAnchorSides } = await import("./DoorGeometryInference");
  const result = resolveDistinctSemanticAnchorSides(
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: 0.5 },
    { x: 0, y: -0.5 },
    [{ key: "living-room", x: 0.2, y: 2 }],
  );
  assert.deepEqual(result, { sideAKey: "living-room", sideBKey: null, distinct: false });
});

test("rejects a door whose two side samples resolve to the same semantic space", async () => {
  const { resolveDistinctSemanticAnchorSides } = await import("./DoorGeometryInference");
  const result = resolveDistinctSemanticAnchorSides(
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: 0.5 },
    { x: 0, y: -0.5 },
    [
      { key: "same-room", x: 0, y: 2 },
      { key: "same-room", x: 0, y: -2 },
    ],
  );
  assert.equal(result.distinct, false);
});
