import assert from "node:assert/strict";
import test from "node:test";
import { ROOM_ANCHOR_PARTITION_RETIRED } from "./RoomAnchorPartition";

test("legacy room-anchor partitioner is intentionally retired", () => {
  assert.equal(ROOM_ANCHOR_PARTITION_RETIRED, true);
});
