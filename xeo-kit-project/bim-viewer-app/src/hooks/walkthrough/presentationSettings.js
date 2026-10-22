/**
 * Shared HCI presentation-settings contract, v1.
 * The compiler writes the same shape to presentation_manifest.json; browser
 * preferences are stored per rendered job and never mutate source geometry.
 */
export const PRESENTATION_SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_PRESENTATION_SETTINGS = {
  schemaVersion: PRESENTATION_SETTINGS_SCHEMA_VERSION,
  appearance: {
    lightingPreset: 'day',
    exposureMultiplier: 1,
    environmentMultiplier: 1,
    toneMapping: 'agx',
  },
  camera: {
    overviewFov: 60,
    guidedFov: 78,
    exploreFov: 78,
    immersiveFov: 72,
    eyeHeightMeters: 1.68,
    guidedEyeHeightMeters: 1.72,
    heightOffsetMeters: 0,
    lookSensitivity: 0.0048,
  },
  quality: {
    mode: 'auto',
  },
  interface: {
    showFloorMap: true,
  },
};

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

export function normalizePresentationSettings(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const appearance = raw.appearance && typeof raw.appearance === 'object' ? raw.appearance : {};
  const camera = raw.camera && typeof raw.camera === 'object' ? raw.camera : {};
  const quality = raw.quality && typeof raw.quality === 'object' ? raw.quality : {};
  const interfaceSettings = raw.interface && typeof raw.interface === 'object' ? raw.interface : {};

  const lightingPreset = ['day', 'evening', 'night'].includes(appearance.lightingPreset)
    ? appearance.lightingPreset : DEFAULT_PRESENTATION_SETTINGS.appearance.lightingPreset;
  const toneMapping = ['agx', 'aces', 'neutral'].includes(appearance.toneMapping)
    ? appearance.toneMapping : DEFAULT_PRESENTATION_SETTINGS.appearance.toneMapping;
  const qualityMode = ['auto', 'performance', 'balanced', 'high'].includes(quality.mode)
    ? quality.mode : DEFAULT_PRESENTATION_SETTINGS.quality.mode;

  return {
    schemaVersion: PRESENTATION_SETTINGS_SCHEMA_VERSION,
    appearance: {
      lightingPreset,
      exposureMultiplier: clamp(appearance.exposureMultiplier, 0.75, 1.25, DEFAULT_PRESENTATION_SETTINGS.appearance.exposureMultiplier),
      environmentMultiplier: clamp(appearance.environmentMultiplier, 0.5, 1.5, DEFAULT_PRESENTATION_SETTINGS.appearance.environmentMultiplier),
      toneMapping,
    },
    camera: {
      overviewFov: clamp(camera.overviewFov, 45, 75, DEFAULT_PRESENTATION_SETTINGS.camera.overviewFov),
      guidedFov: clamp(camera.guidedFov, 50, 88, DEFAULT_PRESENTATION_SETTINGS.camera.guidedFov),
      exploreFov: clamp(camera.exploreFov, 55, 95, DEFAULT_PRESENTATION_SETTINGS.camera.exploreFov),
      immersiveFov: clamp(camera.immersiveFov, 50, 88, DEFAULT_PRESENTATION_SETTINGS.camera.immersiveFov),
      eyeHeightMeters: clamp(camera.eyeHeightMeters, 1.4, 1.9, DEFAULT_PRESENTATION_SETTINGS.camera.eyeHeightMeters),
      guidedEyeHeightMeters: clamp(camera.guidedEyeHeightMeters, 1.5, 1.95, DEFAULT_PRESENTATION_SETTINGS.camera.guidedEyeHeightMeters),
      heightOffsetMeters: clamp(camera.heightOffsetMeters, -0.15, 0.35, DEFAULT_PRESENTATION_SETTINGS.camera.heightOffsetMeters),
      lookSensitivity: clamp(camera.lookSensitivity, 0.0015, 0.009, DEFAULT_PRESENTATION_SETTINGS.camera.lookSensitivity),
    },
    quality: { mode: qualityMode },
    interface: { showFloorMap: interfaceSettings.showFloorMap !== false },
  };
}

export function mergePresentationSettings(base, patch) {
  const safeBase = base && typeof base === 'object' ? base : DEFAULT_PRESENTATION_SETTINGS;
  const safePatch = patch && typeof patch === 'object' ? patch : {};
  return normalizePresentationSettings({
    ...safeBase,
    ...safePatch,
    appearance: { ...(safeBase.appearance || {}), ...(safePatch.appearance || {}) },
    camera: { ...(safeBase.camera || {}), ...(safePatch.camera || {}) },
    quality: { ...(safeBase.quality || {}), ...(safePatch.quality || {}) },
    interface: { ...(safeBase.interface || {}), ...(safePatch.interface || {}) },
  });
}

export function resolveQualityProfile(mode, environment = {}) {
  const navigatorLike = environment.navigator || (typeof navigator !== 'undefined' ? navigator : {});
  const windowLike = environment.window || (typeof window !== 'undefined' ? window : {});
  let resolvedMode = mode;
  if (!['performance', 'balanced', 'high'].includes(resolvedMode)) {
    const cores = Number(navigatorLike.hardwareConcurrency || 8);
    const memory = Number(navigatorLike.deviceMemory || 8);
    resolvedMode = (cores <= 4 || memory <= 4) ? 'performance' : 'balanced';
  }

  const profiles = {
    performance: { mode: resolvedMode, pixelRatioCap: 0.9, shadowsEnabled: false },
    balanced: { mode: resolvedMode, pixelRatioCap: 1.25, shadowsEnabled: true },
    high: { mode: resolvedMode, pixelRatioCap: 1.6, shadowsEnabled: true },
  };
  const profile = profiles[resolvedMode] || profiles.balanced;
  const devicePixelRatio = Number(windowLike.devicePixelRatio || 1);
  return {
    ...profile,
    devicePixelRatio,
    effectivePixelRatio: Math.max(0.65, Math.min(devicePixelRatio, profile.pixelRatioCap)),
  };
}

export function presentationSettingsStorageKey(jobId) {
  return `hci:presentation-settings:v${PRESENTATION_SETTINGS_SCHEMA_VERSION}:${String(jobId || 'default')}`;
}

export async function loadPresentationSettings(jobId, apiBaseUrl) {
  let manifest = null;
  try {
    if (jobId && apiBaseUrl) {
      const base = String(apiBaseUrl).replace(/\/$/, '');
      const response = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}/presentation_manifest.json`, { cache: 'no-store' });
      if (response.ok) manifest = await response.json();
    }
  } catch (error) {
    console.warn('[HCI Presentation] Manifest unavailable; using local defaults.', error);
  }

  let stored = null;
  try {
    const serialized = localStorage.getItem(presentationSettingsStorageKey(jobId));
    if (serialized) stored = JSON.parse(serialized);
  } catch (error) {
    console.warn('[HCI Presentation] Saved preferences could not be read.', error);
  }

  const manifestCamera = manifest?.settings?.camera || manifest?.defaults?.camera || {};
  const fromManifest = normalizePresentationSettings(manifest?.settings || manifest?.defaults || {});
  // Schema-v1 manifests were generated with guidedFov=72. They contain defaults,
  // not a user's actual preference (preferences live in localStorage), so upgrade
  // that legacy default for existing jobs. A saved browser preference still wins.
  if (!stored && Number(manifestCamera.guidedFov) === 72) {
    fromManifest.camera.guidedFov = DEFAULT_PRESENTATION_SETTINGS.camera.guidedFov;
  }
  // This app auto-saved v1 defaults on first load, so older browsers may also
  // have 72 persisted without a deliberate slider change. Upgrade that legacy
  // default only; all other saved preferences remain untouched.
  if (stored && Number(stored?.camera?.guidedFov) === 72) {
    stored.camera.guidedFov = DEFAULT_PRESENTATION_SETTINGS.camera.guidedFov;
  }
  const settings = stored ? mergePresentationSettings(fromManifest, stored) : fromManifest;
  return { settings, manifest, source: stored ? 'saved-preferences' : manifest ? 'manifest-defaults' : 'built-in-defaults' };
}

export function savePresentationSettings(jobId, settings) {
  try {
    localStorage.setItem(presentationSettingsStorageKey(jobId), JSON.stringify(normalizePresentationSettings(settings)));
    return true;
  } catch (error) {
    console.warn('[HCI Presentation] Preferences could not be saved in this browser.', error);
    return false;
  }
}
