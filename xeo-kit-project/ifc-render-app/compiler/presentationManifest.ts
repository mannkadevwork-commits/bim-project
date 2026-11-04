import * as fs from "fs";
import * as path from "path";

/** Versioned defaults consumed by every client-facing presentation mode. */
export const DEFAULT_PRESENTATION_SETTINGS = {
  schemaVersion: 2,
  appearance: {
    lightingPreset: "night",
    exposureMultiplier: 1,
    environmentMultiplier: 1,
    toneMapping: "agx",
  },
  camera: {
    overviewFov: 60,
    guidedFov: 88,
    exploreFov: 90,
    immersiveFov: 88,
    eyeHeightMeters: 1.68,
    guidedEyeHeightMeters: 1.72,
    heightOffsetMeters: 0.2,
    lookSensitivity: 0.0048,
  },
  quality: { mode: "high" },
  interface: { showFloorMap: true },
};

export function writePresentationManifest(jobDirectory: string) {
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    jobId: path.basename(jobDirectory),
    runtime: {
      visualScene: "output.glb",
      navigationMesh: "navigation_navmesh.bin",
      navigationSurface: "navigation_surface.json",
      hotspots: "walk_hotspots.json",
      rooms: "presentation_rooms.json",
      portals: "presentation_portals.json",
      roomGraph: "presentation_room_graph.json",
    },
    settings: DEFAULT_PRESENTATION_SETTINGS,
    userPreferences: {
      storage: "browser-local-per-job",
      persistToSourceProject: false,
    },
  };
  const destination = path.join(jobDirectory, "presentation_manifest.json");
  fs.writeFileSync(destination, JSON.stringify(manifest, null, 2), "utf8");
  return destination;
}
