import assert from "node:assert/strict";
import test from "node:test";
import { createDoorGapClosureFootprint, reconstructRoomsFromWallFootprints } from "./RoomPlanarGraph";

function wallSegment(id: string, x1: number, y1: number, x2: number, y2: number, thickness = 0.2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const nx = -dy / length;
  const ny = dx / length;
  const offsetX = nx * thickness * 0.5;
  const offsetY = ny * thickness * 0.5;
  return {
    id,
    points: [
      { x: x1 + offsetX, y: y1 + offsetY },
      { x: x2 + offsetX, y: y2 + offsetY },
      { x: x2 - offsetX, y: y2 - offsetY },
      { x: x1 - offsetX, y: y1 - offsetY },
    ],
  };
}

function rectangularShell(width = 6, height = 5) {
  return [
    wallSegment("bottom", 0, 0, width, 0),
    wallSegment("right", width, 0, width, height),
    wallSegment("top", width, height, 0, height),
    wallSegment("left", 0, height, 0, 0),
  ];
}

test("reconstructs one enclosed physical room from four walls", () => {
  const result = reconstructRoomsFromWallFootprints({ walls: rectangularShell() });
  assert.equal(result.faces.length, 1);
  assert.ok(Math.abs(result.faces[0].areaM2 - 27.84) < 0.08);
  assert.equal(result.faces[0].boundaryWallIds.length, 4);
});

test("splits a shell into two physical rooms at an internal partition", () => {
  const result = reconstructRoomsFromWallFootprints({
    walls: [...rectangularShell(), wallSegment("partition", 3, 0, 3, 5)],
  });
  assert.equal(result.faces.length, 2);
  assert.ok(result.faces.every((face) => face.areaM2 > 13 && face.areaM2 < 14));
});

test("extracts four bounded faces at a genuine wall crossing", () => {
  const result = reconstructRoomsFromWallFootprints({
    walls: [
      ...rectangularShell(),
      wallSegment("vertical-partition", 3, 0, 3, 5),
      wallSegment("horizontal-partition", 0, 2.5, 6, 2.5),
    ],
  });
  assert.equal(result.faces.length, 4);
});

test("preserves concave L-shaped wall boundaries instead of convexifying them", () => {
  const walls = [
    wallSegment("bottom", 0, 0, 4, 0),
    wallSegment("right", 4, 0, 4, 2),
    wallSegment("shelf", 4, 2, 2, 2),
    wallSegment("inner", 2, 2, 2, 4),
    wallSegment("top", 2, 4, 0, 4),
    wallSegment("left", 0, 4, 0, 0),
  ];
  const result = reconstructRoomsFromWallFootprints({ walls });
  assert.equal(result.faces.length, 1);
  assert.ok(result.faces[0].areaM2 < 12, "an L room should be much smaller than its 16 m² convex hull");
});

test("associates multiple IFC labels with one open-plan room without inventing a partition", () => {
  const result = reconstructRoomsFromWallFootprints({
    walls: rectangularShell(),
    semanticSpaces: [
      { key: "living-guid", label: "Living Area", x: 1.7, y: 2.4, globalId: "living-guid" },
      { key: "dining-guid", label: "Dining Area", x: 4.2, y: 2.4, globalId: "dining-guid" },
    ],
  });
  assert.equal(result.faces.length, 1);
  assert.deepEqual(result.faces[0].semanticSpaces.map((space) => space.label).sort(), ["Dining Area", "Living Area"]);
  assert.equal(result.unmatchedSemanticSpaces.length, 0);
});

test("joins a wall endpoint to a nearby perpendicular wall without raster snapping", () => {
  const walls = [
    wallSegment("bottom", 0, 0, 5.9, 0),
    wallSegment("right", 6, 0.1, 6, 5),
    wallSegment("top", 6, 5, 0, 5),
    wallSegment("left", 0, 5, 0, 0),
  ];
  const result = reconstructRoomsFromWallFootprints({ walls });
  assert.equal(result.faces.length, 1);
});

test("uses valid explicit IfcSpace body geometry when there is no closed wall graph", () => {
  const result = reconstructRoomsFromWallFootprints({
    walls: [],
    semanticSpaces: [{
      key: "explicit-room",
      label: "Explicit Study",
      x: Number.NaN,
      y: Number.NaN,
      hasGeometryRepresentation: true,
      explicitPolygon: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 0, y: 3 },
      ],
    }],
  });
  assert.equal(result.faces.length, 1);
  assert.equal(result.faces[0].geometrySource, "ifc-space-body-envelope");
  assert.equal(result.faces[0].semanticSpaces[0].label, "Explicit Study");
});

test("keeps a small explicit semantic zone inside one physical wall-bounded room", () => {
  const result = reconstructRoomsFromWallFootprints({
    walls: rectangularShell(),
    semanticSpaces: [{
      key: "reading-zone",
      label: "Reading Zone",
      x: 1.3,
      y: 1.3,
      hasGeometryRepresentation: true,
      explicitPolygon: [
        { x: 0.8, y: 0.8 },
        { x: 2.0, y: 0.8 },
        { x: 2.0, y: 2.0 },
        { x: 0.8, y: 2.0 },
      ],
    }],
  });
  assert.equal(result.faces.length, 1);
  assert.equal(result.faces[0].geometrySource, "wall-face-reconstruction");
  assert.equal(result.faces[0].semanticSpaces[0].label, "Reading Zone");
  assert.ok(result.faces[0].areaM2 > 25);
});


test("keeps two rooms separate across an IFC door opening using a temporary graph closure", () => {
  const shell = rectangularShell();
  const hostPartition = wallSegment("host-partition-reference", 3, 0, 3, 5);
  const wallFragments = [
    wallSegment("partition-lower", 3, 0, 3, 2.2),
    wallSegment("partition-upper", 3, 3.0, 3, 5),
  ];
  const closure = createDoorGapClosureFootprint(
    hostPartition,
    { x: 3, y: 2.6 },
    0.8,
    "door-gap:entry-1",
  );
  assert.ok(closure, "hosted door geometry should produce a closure segment");
  const withoutDoorClosure = reconstructRoomsFromWallFootprints({ walls: [...shell, ...wallFragments] });
  assert.equal(withoutDoorClosure.faces.length, 0, "the unsealed opening leaves the partition graph open");
  const withDoorClosure = reconstructRoomsFromWallFootprints({ walls: [...shell, ...wallFragments, closure!] });
  assert.equal(withDoorClosure.faces.length, 2, "the door closure restores separate physical room faces");
});

test("does not replace a concave wall-derived room with a convex IfcSpace body envelope", () => {
  const walls = [
    wallSegment("bottom", 0, 0, 4, 0),
    wallSegment("right", 4, 0, 4, 2),
    wallSegment("shelf", 4, 2, 2, 2),
    wallSegment("inner", 2, 2, 2, 4),
    wallSegment("top", 2, 4, 0, 4),
    wallSegment("left", 0, 4, 0, 0),
  ];
  const result = reconstructRoomsFromWallFootprints({
    walls,
    semanticSpaces: [{
      key: "l-space",
      label: "L-shaped Study",
      x: 1.6,
      y: 1.6,
      hasGeometryRepresentation: true,
      // Deliberately rectangular: this represents the existing collector's
      // convex envelope, not the exact L-shaped room outline.
      explicitPolygon: [
        { x: 0.1, y: 0.1 },
        { x: 3.8, y: 0.1 },
        { x: 3.8, y: 3.8 },
        { x: 0.1, y: 3.8 },
      ],
    }],
  });
  assert.equal(result.faces.length, 1);
  assert.equal(result.faces[0].geometrySource, "wall-face-reconstruction");
  assert.ok(result.faces[0].areaM2 < 12, "the concave wall face must remain authoritative");
});
