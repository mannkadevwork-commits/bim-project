import { LightMap } from '@xeokit/xeokit-sdk/src/viewer/scene/lights/LightMap';
import { ReflectionMap } from '@xeokit/xeokit-sdk/src/viewer/scene/lights/ReflectionMap';

const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const LIGHT_MAP_ID = 'hci-glb-studio-irradiance';
const REFLECTION_MAP_ID = 'hci-glb-studio-radiance';

/**
 * Installs a small, local studio image-based-lighting (IBL) setup for Xeokit's
 * PBR materials. The cube maps are served from the Vite public directory, so
 * the editor has no dependency on a third-party HDRI host or network request.
 *
 * This only adds scene lighting; it does not rewrite or replace the source GLB's
 * materials/textures. Non-PBR IFC materials continue using their current path.
 */
export function installGLBStudioLighting(viewer) {
  const scene = viewer?.scene;
  if (!scene) return null;

  const existingLightMap = scene.components?.[LIGHT_MAP_ID];
  const existingReflectionMap = scene.components?.[REFLECTION_MAP_ID];
  if (existingLightMap && existingReflectionMap) {
    return { lightMap: existingLightMap, reflectionMap: existingReflectionMap };
  }

  const baseUrl = String(import.meta.env?.BASE_URL || '/');
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const root = `${normalizedBase}assets/hci-glb-ibl`;
  const faceUrls = (prefix) => FACE_ORDER.map((face) => `${root}/${prefix}_${face}.png`);

  try {
    // CubeTexture defaults to LinearEncoding. The bundled pixels are authored
    // as linear intensity values, which is appropriate for lighting data.
    const lightMap = existingLightMap || new LightMap(scene, {
      id: LIGHT_MAP_ID,
      src: faceUrls('light'),
    });
    const reflectionMap = existingReflectionMap || new ReflectionMap(scene, {
      id: REFLECTION_MAP_ID,
      src: faceUrls('reflection'),
    });

    // Retain a stable handle for diagnostics. Viewer.destroy() owns these scene
    // components and will release their GPU resources during teardown.
    scene._hciGLBStudioLighting = { lightMap, reflectionMap };
    lightMap.on?.('error', (error) => {
      console.warn('[GLB Studio Lighting] Irradiance cube-map load issue:', error);
    });
    reflectionMap.on?.('error', (error) => {
      console.warn('[GLB Studio Lighting] Reflection cube-map load issue:', error);
    });

    return scene._hciGLBStudioLighting;
  } catch (error) {
    console.warn('[GLB Studio Lighting] Could not install local studio environment:', error?.message || error);
    return null;
  }
}
