import * as path from "path";
import { RoomDetector } from "./RoomDetector";

const jobDirectory = process.argv[2];
if (!jobDirectory) {
  console.error("Usage: npx tsx compiler/navigation/test-room-detector.ts <jobDirectory>");
  process.exit(1);
}

RoomDetector.run({ jobDirectory: path.resolve(jobDirectory) })
  .then((result) => {
    const candidateDoors = result.diagnostics?.doors?.filter((door) => door.portalCandidate).length ?? 0;
    const failedDoors = result.diagnostics?.doors?.length ?? 0;
    console.log(
      `[RoomDetectorTest] Success: rooms=${result.rooms.length}, portals=${result.portals.length}, ` +
      `doorPortalCandidates=${candidateDoors}/${failedDoors}`,
    );
  })
  .catch((error) => {
    console.error(`[RoomDetectorTest] Failed: ${(error as Error).stack || (error as Error).message}`);
    process.exit(1);
  });
