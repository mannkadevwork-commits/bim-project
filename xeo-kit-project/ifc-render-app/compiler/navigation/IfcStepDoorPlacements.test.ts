import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readIfcStepDoorPlacements } from "./IfcStepSpaceFootprints";

 test("reads nested IfcDoor placements and converts Z-up plan coordinates to viewer X/Z", () => {
  const filePath = path.join(os.tmpdir(), `ifc-door-placement-${process.pid}.ifc`);
  const step = [
    "#1=IFCCARTESIANPOINT((6.25,0.07,0.0));",
    "#2=IFCDIRECTION((0.0,0.0,1.0));",
    "#3=IFCDIRECTION((1.0,0.0,0.0));",
    "#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);",
    "#5=IFCLOCALPLACEMENT($,#4);",
    "#6=IFCDOOR('door-guid',$,'Main entrance',$,$,#5,$,$,2.12,1.0,$,$,$);",
  ].join("\n");
  fs.writeFileSync(filePath, step, "utf8");
  try {
    const result = readIfcStepDoorPlacements(filePath, 1);
    const door = result.doors.get(6);
    assert.ok(door);
    assert.deepEqual(door.placementOrigin, { x: 6.25, y: -0.07 });
    assert.deepEqual(door.openingCenter, { x: 6.75, y: -0.07 });
    assert.equal(door.localWidthAxis.x, 1);
    assert.ok(Math.abs(door.localWidthAxis.y) < 1e-12);
    assert.equal(door.widthMeters, 1);
    assert.equal(door.heightMeters, 2.12);
    assert.equal(door.globalId, "door-guid");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
