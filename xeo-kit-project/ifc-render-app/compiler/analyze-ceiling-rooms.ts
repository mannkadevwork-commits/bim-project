import * as path from "path";
import { CeilingAnalysisService } from "./ceiling/CeilingAnalysisService";

const jobDirectory = process.argv[2];
const inputIfcPath = process.argv[3];
const outputPath = process.argv[4];
const forceRebuild = process.argv[5] === "--force";
if (!jobDirectory || !inputIfcPath || !outputPath) {
  throw new Error("Usage: analyze-ceiling-rooms.ts <jobDirectory> <inputIfcPath> <outputPath> [--force]");
}
console.log = (...args: any[]) => console.error(...args);
console.info = (...args: any[]) => console.error(...args);
CeilingAnalysisService.run({
  jobDirectory: path.resolve(jobDirectory),
  inputIfcPath: path.resolve(inputIfcPath),
  outputPath: path.resolve(outputPath),
  forceRebuild,
}).then((analysis) => {
  process.stdout.write(JSON.stringify(analysis));
}).catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
