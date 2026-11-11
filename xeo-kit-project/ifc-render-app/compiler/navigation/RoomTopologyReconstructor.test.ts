import test from "node:test";
import assert from "node:assert/strict";
import { reconstructRoomsFromWallTopology } from "./RoomTopologyReconstructor";
import type { RoomFloorGrid, RoomFootprintAnchor, RoomPlanPoint } from "./RoomFootprintReconstructor";

function createGrid(widthMeters: number, heightMeters: number, cellSize = 0.05): RoomFloorGrid {
  const width = Math.round(widthMeters / cellSize);
  const height = Math.round(heightMeters / cellSize);
  const floor = new Uint8Array(width * height);
  floor.fill(1);
  return {
    minX: 0,
    minY: 0,
    cellSize,
    width,
    height,
    floor,
    blocked: new Uint8Array(width * height),
    room: new Int32Array(width * height).fill(-1),
  };
}

function blockRect(grid: RoomFloorGrid, minX: number, minY: number, maxX: number, maxY: number): void {
  for (let j = 0; j < grid.height; j++) {
    const y = grid.minY + (j + 0.5) * grid.cellSize;
    if (y < minY || y > maxY) continue;
    for (let i = 0; i < grid.width; i++) {
      const x = grid.minX + (i + 0.5) * grid.cellSize;
      if (x >= minX && x <= maxX) grid.blocked[j * grid.width + i] = 1;
    }
  }
}

const threeBhkAnchors: RoomFootprintAnchor[] = [
  { key: "living", label: "Living Room", x: 3.90, y: 4.85 },
  { key: "dining", label: "Dining Area", x: 8.18, y: 2.35 },
  { key: "bedroom-2", label: "Bedroom 2", x: 3.38, y: 7.95 },
  { key: "kitchen", label: "Kitchen", x: 6.25, y: 8.55 },
  { key: "master-bedroom", label: "Master Bedroom", x: 12.35, y: 7.45 },
  { key: "bedroom-3", label: "Bedroom 3", x: 12.75, y: 3.75 },
  { key: "common-bath", label: "Common Bathroom", x: 6.90, y: 5.95 },
  { key: "master-ensuite", label: "Master Ensuite", x: 12.40, y: 6.08 },
  { key: "circulation", label: "Main Circulation", x: 8.68, y: 4.05 },
];

function createThreeBhkTopologyGrid(): RoomFloorGrid {
  const grid = createGrid(14, 11);
  // Interior walls reconstructed from the supplied 3_BHK IFC's rectangular
  // wall extrusions. Door-lintel footprints close doorway gaps for room identity.
  const walls: Array<[number, number, number, number]> = [
    // Exterior shell (window/entry gaps are also sealed by sill/header/lintel
    // geometry in the source IFC; the fixture uses continuous shell faces).
    [0, 0, 14, 0.18],
    [0, 10.82, 14, 11],
    [0, 0, 0.18, 11],
    [13.82, 0, 14, 11],
    [0.18, 6.55, 4.15, 6.70],   // Bedroom 2 south wall + door lintel
    [4.15, 6.55, 8.20, 6.70],   // Kitchen / common-bath partition + lintel
    [9.20, 6.55, 13.82, 6.70],  // Master bedroom / ensuite + lintel
    [9.20, 4.50, 13.82, 4.65],  // Bedroom 3 north wall + lintel
    [4.00, 6.70, 4.15, 10.82],  // Bedroom 2 / kitchen
    [7.60, 6.70, 7.75, 10.82],  // Kitchen / circulation
    [9.20, 6.70, 9.35, 10.82],  // Master bedroom west + door lintel
    [9.20, 0.18, 9.35, 4.65],   // Bedroom 3 west
    [6.00, 4.55, 6.15, 6.55],  // Common bathroom west
    [8.05, 4.55, 8.20, 6.55],  // Common bathroom east
    [6.00, 4.40, 8.20, 4.55],  // Common bathroom south + door lintel
  ];
  for (const wall of walls) blockRect(grid, ...wall);
  return grid;
}

test("3_BHK wall topology resolves all nine semantic spaces into physical faces and open-plan zones", () => {
  const grid = createThreeBhkTopologyGrid();
  const result = reconstructRoomsFromWallTopology({
    floorPolygon: [
      { x: 0, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 11 }, { x: 0, y: 11 },
    ],
    anchors: threeBhkAnchors,
    grid,
    maxAnchorSnapMeters: 0.35,
  });

  assert.equal(result.regions.length, 9);
  assert.equal(result.resolvedAnchors.length, 9);
  assert.equal(result.physicalComponentCount, 6);
  assert.equal(result.openPlanComponentCount, 1);
  assert.equal(result.unanchoredComponentCount, 0);
  assert.equal(result.method, "ifc-wall-topology-components-and-open-zones-v1");
  assert.ok(result.coverageRatio > 0.98);

  const areas = new Map(result.regions.map((region) => [region.anchor.label, region.areaM2]));
  const expectedNames = [
    "Living Room", "Dining Area", "Bedroom 2", "Kitchen", "Master Bedroom",
    "Bedroom 3", "Common Bathroom", "Master Ensuite", "Main Circulation",
  ];
  assert.deepEqual(Array.from(areas.keys()).sort(), [...expectedNames].sort());
  const areaRanges: Record<string, [number, number]> = {
    "Living Room": [30, 38],
    "Dining Area": [11, 16],
    "Bedroom 2": [14, 18],
    "Kitchen": [12, 17],
    "Master Bedroom": [17, 21],
    "Bedroom 3": [17, 22],
    "Common Bathroom": [3, 5],
    "Master Ensuite": [5, 9],
    "Main Circulation": [10, 16],
  };
  for (const [name, [minimum, maximum]] of Object.entries(areaRanges)) {
    const area = areas.get(name) || 0;
    assert.ok(area >= minimum && area <= maximum, `${name} area ${area.toFixed(2)} m² outside expected range`);
  }
  const physicalFaces = result.regions.filter((region) => region.source === "ifc-wall-topology-face-v1");
  const logicalZones = result.regions.filter((region) => region.source === "ifc-open-plan-semantic-zone-v1");
  assert.equal(physicalFaces.length, 5);
  assert.equal(logicalZones.length, 4);

  const assignedCells = result.regions.flatMap((region) => region.cells);
  assert.equal(new Set(assignedCells).size, assignedCells.length, "Room regions must not overlap");
});

test("unanchored disconnected floor islands stay unassigned instead of jumping across walls", () => {
  const grid = createGrid(8, 4, 0.1);
  blockRect(grid, 3.9, 0, 4.1, 4);
  const result = reconstructRoomsFromWallTopology({
    floorPolygon: [
      { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 4 }, { x: 0, y: 4 },
    ],
    anchors: [{ key: "left", label: "Left Room", x: 1.5, y: 2 }],
    grid,
    maxAnchorSnapMeters: 0.25,
  });

  assert.equal(result.regions.length, 1);
  assert.equal(result.unanchoredComponentCount, 1);
  assert.ok(result.coverageRatio < 0.6);
  assert.ok(result.warnings.some((warning) => warning.includes("left unassigned")));
});

test("no semantic anchors never creates a fake whole-floor room", () => {
  const grid = createGrid(3, 3, 0.1);
  const result = reconstructRoomsFromWallTopology({
    floorPolygon: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }],
    anchors: [],
    grid,
  });
  assert.equal(result.regions.length, 0);
  assert.equal(result.method, "none");
});

test("a door-lintel seal separates adjacent rooms while an open doorway remains one connected face", () => {
  const createDoorGrid = (sealDoor: boolean) => {
    const grid = createGrid(6, 4, 0.1);
    // A vertical wall has a doorway gap between y=1.5 m and y=2.0 m.
    blockRect(grid, 2.9, 0, 3.1, 1.5);
    blockRect(grid, 2.9, 2.0, 3.1, 4);
    // The named IFC door-lintel footprint is temporarily rasterized into the
    // room topology mask, closing the gap for architectural room identity.
    if (sealDoor) blockRect(grid, 2.9, 1.5, 3.1, 2.0);
    return grid;
  };
  const floorPolygon: RoomPlanPoint[] = [
    { x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 },
  ];
  const anchors: RoomFootprintAnchor[] = [
    { key: "left", label: "Left Room", x: 1.5, y: 2 },
    { key: "right", label: "Right Room", x: 4.5, y: 2 },
  ];
  const open = reconstructRoomsFromWallTopology({ floorPolygon, anchors, grid: createDoorGrid(false), maxAnchorSnapMeters: 0.25 });
  const sealed = reconstructRoomsFromWallTopology({ floorPolygon, anchors, grid: createDoorGrid(true), maxAnchorSnapMeters: 0.25 });
  assert.equal(open.physicalComponentCount, 1);
  assert.equal(open.openPlanComponentCount, 1);
  assert.equal(sealed.physicalComponentCount, 2);
  assert.equal(sealed.openPlanComponentCount, 0);
  assert.ok(sealed.regions.every((region) => region.source === "ifc-wall-topology-face-v1"));
});

