import { PointLight } from '@xeokit/xeokit-sdk/src/viewer/scene/lights/PointLight.js';

const LIGHT_ID_PREFIX = 'hci_fixture_point_light_';
// Xeokit's PointLight is a scene component, not an emissive material on the
// fixture. Keep its values bounded and update its position without destroying
// and recreating the component on every render tick.
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : min));
const MAX_INTENSITY = 0.55;

const colorForTemperature = (kelvin) => {
  const t = clamp(kelvin, 2700, 6500);
  if (t <= 4000) {
    const f = (t - 2700) / 1300;
    return [1, 0.72 + f * 0.20, 0.52 + f * 0.30];
  }
  const f = (t - 4000) / 2500;
  return [1 - f * 0.12, 0.92 + f * 0.06, 0.82 + f * 0.18];
};

const getEmitterPosition = (model) => {
  const aabb = model?.aabb;
  if (!aabb || aabb.length < 6 || !Array.from(aabb).slice(0, 6).every(Number.isFinite)) return null;
  const height = Math.max(0.05, aabb[4] - aabb[1]);
  // The fixture's lower/front side faces the room in the viewer's Y-up frame.
  return [
    (aabb[0] + aabb[3]) / 2,
    aabb[1] + Math.min(height * 0.18, 0.10),
    (aabb[2] + aabb[5]) / 2,
  ];
};

/** Owns one world-space PointLight per placed lighting fixture. */
export const createLightFixtureController = (viewer) => {
  const scene = viewer?.scene;
  const liveLights = new Map();
  if (!scene) return { setEnabled: () => false, setSettings: () => false, sync: () => {}, destroy: () => {} };

  const destroyLight = (modelId) => {
    const entry = liveLights.get(modelId);
    if (!entry) return;
    try { entry.light?.destroy(); } catch (_) {}
    liveLights.delete(modelId);
  };

  const syncModel = (model) => {
    const meta = model?._assetMeta;
    if (!model?.id || meta?.isLightFixture !== true || meta?.lightEnabled !== true) {
      if (model?.id) destroyLight(model.id);
      return;
    }
    const position = getEmitterPosition(model);
    if (!position) {
      destroyLight(model.id);
      return;
    }

    const intensity = clamp(meta.lightIntensity ?? 0.12, 0, MAX_INTENSITY);
    const temperature = clamp(meta.lightTemperature ?? 4000, 2700, 6500);
    const color = colorForTemperature(temperature);
    const signature = `${intensity.toFixed(3)}:${temperature}`;
    let entry = liveLights.get(model.id);

    if (entry && entry.signature !== signature) {
      // Keep component IDs unique while replacing changed settings.
      destroyLight(model.id);
      entry = null;
    }

    if (!entry) {
      const safeId = `${LIGHT_ID_PREFIX}${String(model.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      try {
        const light = new PointLight(scene, {
          id: safeId,
          pos: position,
          color,
          intensity,
          // Broader attenuation than the old near-source-heavy setup prevents
          // a single luminaire from washing out the entire room/ceiling.
          constantAttenuation: 1.0,
          linearAttenuation: 0.35,
          quadraticAttenuation: 0.12,
          space: 'world',
          castsShadow: false,
        });
        entry = { light, signature };
        liveLights.set(model.id, entry);
      } catch (error) {
        console.warn('[Lighting] Could not create a point light for fixture:', model.id, error);
      }
    } else {
      const current = Array.from(entry.light?.pos || []);
      if (current.length !== 3 || position.some((value, axis) => Math.abs(value - current[axis]) > 0.002)) {
        try { entry.light.pos = position; } catch (_) {}
      }
    }
  };

  const sync = () => {
    const models = Object.values(scene.models || {});
    const seen = new Set();
    models.forEach((model) => {
      if (model?._assetMeta?.isLightFixture === true) seen.add(model.id);
      syncModel(model);
    });
    Array.from(liveLights.keys()).forEach((modelId) => {
      if (!seen.has(modelId) || !scene.models?.[modelId]) destroyLight(modelId);
    });
  };

  scene.on('tick', sync);
  sync();
  return {
    setEnabled(model, enabled) {
      if (!model?._assetMeta || model._assetMeta.isLightFixture !== true) return false;
      model._assetMeta.lightEnabled = !!enabled;
      syncModel(model);
      return enabled ? liveLights.has(model.id) : !liveLights.has(model.id);
    },
    setSettings(model, settings = {}) {
      if (!model?._assetMeta || model._assetMeta.isLightFixture !== true) return false;
      if (settings.intensity !== undefined) model._assetMeta.lightIntensity = clamp(settings.intensity, 0, MAX_INTENSITY);
      if (settings.temperature !== undefined) model._assetMeta.lightTemperature = clamp(settings.temperature, 2700, 6500);
      syncModel(model);
      return true;
    },
    sync,
    destroy() {
      try { scene.off('tick', sync); } catch (_) {}
      Array.from(liveLights.keys()).forEach(destroyLight);
    },
  };
};
