import * as path from "path";
import { RoomAnalysisService } from "./room-analysis/RoomAnalysisService";

const jobDirectory = process.argv[2];
const inputIfcPath = process.argv[3];
const outputPath = process.argv[4];
const debugOutputPath = process.argv[5];
const forceRebuild = process.argv.includes("--force");

if (!jobDirectory || !inputIfcPath || !outputPath) {
  throw new Error("Usage: analyze-room-selection.ts <jobDirectory> <inputIfcPath> <outputPath> [debugOutputPath] [--force]");
}

// The endpoint expects one JSON response on stdout. WebIFC diagnostics belong
// on stderr so logging can never corrupt the API payload.
console.log = (...args: any[]) => console.error(...args);
console.info = (...args: any[]) => console.error(...args);

RoomAnalysisService.run({
  jobDirectory: path.resolve(jobDirectory),
  inputIfcPath: path.resolve(inputIfcPath),
  outputPath: path.resolve(outputPath),
  debugOutputPath: debugOutputPath ? path.resolve(debugOutputPath) : undefined,
  forceRebuild,
}).then((analysis) => {
  process.stdout.write(JSON.stringify(analysis));
}).catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
