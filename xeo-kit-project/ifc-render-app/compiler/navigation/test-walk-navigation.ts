import * as path from "path";
import { WalkNavigationPipeline } from "./WalkNavigationPipeline";

const jobDirectory = process.argv[2];
if (!jobDirectory) {
  console.error("Usage: npx tsx compiler/navigation/test-walk-navigation.ts .\\jobs\\<jobId>");
  process.exit(1);
}

const outputGlbPath = path.join(jobDirectory, "output.glb");

WalkNavigationPipeline.run(outputGlbPath, jobDirectory)
  .then(() => {
    console.log(`[WalkNavigationTest] Success: ${jobDirectory}`);
  })
  .catch((error) => {
    console.error(`[WalkNavigationTest] Failed: ${(error as Error).stack || (error as Error).message}`);
    process.exit(1);
  });
