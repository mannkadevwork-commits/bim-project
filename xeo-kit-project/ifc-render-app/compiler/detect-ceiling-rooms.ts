import * as path from "path";
import { RoomDetector } from "./navigation/RoomDetector";

const jobDirectory = process.argv[2];
const inputIfcPath = process.argv[3];
const outputPath = process.argv[4];
if (!jobDirectory || !inputIfcPath || !outputPath) {
  throw new Error("Usage: detect-ceiling-rooms.ts <jobDirectory> <inputIfcPath> <outputPath>");
}
console.log = (...args: any[]) => console.error(...args);
console.info = (...args: any[]) => console.error(...args);
RoomDetector.run({ jobDirectory, inputIfcPath, outputPath })
  .then((artifact) => {
    process.stdout.write(JSON.stringify({
      rooms: artifact.rooms,
      floorElevation: artifact.floorElevation,
      warnings: artifact.warnings,
      coordinateSystem: artifact.coordinateSystem,
      stats: artifact.stats,
    }));
  })
  .catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
