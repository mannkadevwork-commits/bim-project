import test from "node:test";
import assert from "node:assert/strict";
import { associateRoomAnchorsWithFloorLevel } from "./RoomLevelAssociation";

const floor = [
  { x: 0, y: 0 }, { x: 14, y: 0 }, { x: 14, y: -11 }, { x: 0, y: -11 },
];
const spaces = [
  [44, "Living Room", 3.9, -4.85],
  [60, "Dining Area", 8.18, -2.35],
  [76, "Bedroom 2", 3.38, -7.95],
  [92, "Kitchen", 6.25, -8.55],
  [108, "Master Bedroom", 12.35, -7.45],
  [124, "Bedroom 3", 12.75, -3.75],
  [140, "Common Bathroom", 6.9, -5.95],
  [156, "Master Ensuite", 12.4, -6.08],
  [172, "Main Circulation", 8.68, -4.05],
].map(([id, label, x, y]) => ({
  key: String(id), label: String(label), x: Number(x), y: Number(y),
  elevationY: 0, storeyExpressId: 35, storeyName: "Ground Floor - 3BHK", storeyElevation: 0,
}));

test("3_BHK: all nine spaces associate with the only floor through IfcRelAggregates despite 1m slab datum offset", () => {
  const result = associateRoomAnchorsWithFloorLevel({
    anchors: spaces,
    storeys: [{ expressId: 35, name: "Ground Floor - 3BHK", elevation: 0 }],
    levels: [{ elevationY: 1 }],
    floorPolygon: floor,
  });
  assert.equal(result.anchors.length, 9);
  assert.equal(result.method, "ifc-spatial-storey-single-level");
  assert.deepEqual(result.selectedStoreyExpressIds, [35]);
  assert.equal(result.medianDatumOffsetMeters, 1);
  assert.equal(result.excludedCount, 0);
  assert.match(result.warning || "", /different vertical datum/);
});

test("multiple storeys map by ordered storey/level relationship", () => {
  const anchors = [
    { ...spaces[0], storeyExpressId: 35, elevationY: 0 },
    { ...spaces[1], storeyExpressId: 60, elevationY: 3 },
  ];
  const storeys = [
    { expressId: 35, name: "Ground", elevation: 0 },
    { expressId: 60, name: "First", elevation: 3 },
  ];
  const levels = [{ elevationY: 1 }, { elevationY: 4 }];
  const ground = associateRoomAnchorsWithFloorLevel({ anchors, storeys, levels, selectedLevelIndex: 0, floorPolygon: floor });
  const first = associateRoomAnchorsWithFloorLevel({ anchors, storeys, levels, selectedLevelIndex: 1, floorPolygon: floor });
  assert.deepEqual(ground.anchors.map((item) => item.label), [spaces[0].label]);
  assert.deepEqual(first.anchors.map((item) => item.label), [spaces[1].label]);
  assert.equal(ground.method, "ifc-spatial-storey-ordinal");
});

test("a single level without storey relationships uses plan containment, not placement elevation", () => {
  const unassigned = spaces.map(({ storeyExpressId: _storeyExpressId, storeyName: _storeyName, storeyElevation: _storeyElevation, ...item }) => item);
  const result = associateRoomAnchorsWithFloorLevel({
    anchors: unassigned,
    storeys: [],
    levels: [{ elevationY: 1 }],
    floorPolygon: floor,
  });
  assert.equal(result.anchors.length, 9);
  assert.equal(result.method, "single-level-plan-containment");
});

test("spaces outside the selected level footprint are not assigned", () => {
  const result = associateRoomAnchorsWithFloorLevel({
    anchors: [...spaces, { ...spaces[0], key: "outside", label: "Outside", x: 24, y: -4.5 }],
    storeys: [{ expressId: 35, name: "Ground", elevation: 0 }],
    levels: [{ elevationY: 1 }],
    floorPolygon: floor,
  });
  assert.equal(result.anchors.length, 9);
  assert.equal(result.excludedCount, 1);
});

test("single storey retains plan-contained semantic spaces missing an explicit containment link", () => {
  const anchors = [
    { ...spaces[0], storeyExpressId: 35 },
    { ...spaces[1], storeyExpressId: null, storeyName: null, storeyElevation: null },
  ];
  const result = associateRoomAnchorsWithFloorLevel({
    anchors,
    storeys: [{ expressId: 35, name: "Ground Floor - 3BHK", elevation: 0 }],
    levels: [{ elevationY: 1 }],
    floorPolygon: floor,
  });
  assert.deepEqual(result.anchors.map((anchor) => anchor.label), [spaces[0].label, spaces[1].label]);
});
