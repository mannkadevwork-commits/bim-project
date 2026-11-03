import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const MODE_ORDER = ['day', 'evening', 'night'];
const FIXTURE_LIGHT_MODE_GAIN = { day: 0.42, evening: 1.0, night: 1.2 };
const MAX_FIXTURE_LIGHTS = 48;

function clampFixture(value, min, max) {
  const number = Number(value);
  return THREE.MathUtils.clamp(Number.isFinite(number) ? number : min, min, max);
}

function fixtureColorForTemperature(kelvin) {
  const temperature = clampFixture(kelvin, 2700, 6500);
  if (temperature <= 4000) {
    const factor = (temperature - 2700) / 1300;
    return new THREE.Color(1, 0.72 + factor * 0.20, 0.52 + factor * 0.30);
  }
  const factor = (temperature - 4000) / 2500;
  return new THREE.Color(1 - factor * 0.12, 0.92 + factor * 0.06, 0.82 + factor * 0.18);
}

function fixtureModeGain(mode) {
  return FIXTURE_LIGHT_MODE_GAIN[mode] ?? FIXTURE_LIGHT_MODE_GAIN.day;
}

const LIGHTING_MODES = {
  day: {
    label: 'Day',
    icon: '☀',
    // Restrained architectural daylight: preserve highlight detail and add shape to walls/furniture.
    background: 0xe2e9ef,
    environmentIntensity: 0.44,
    exposure: 0.90,
    hemisphere: { sky: 0xf4f7fb, ground: 0x51483f, intensity: 0.36 },
    key: { color: 0xffe9cc, intensity: 1.62, direction: [-0.50, 0.88, 0.46] },
    fill: { color: 0xc4d8ed, intensity: 0.24, direction: [0.64, 0.42, -0.60] },
    rim: { color: 0xf8fbff, intensity: 0.07, direction: [0.16, 0.54, -0.84] },
    practical: { intensity: 0.0, color: 0xffc98f },
  },
  evening: {
    label: 'Evening',
    icon: '◐',
    background: 0x48515f,
    environmentIntensity: 0.35,
    exposure: 0.88,
    hemisphere: { sky: 0xffd7b9, ground: 0x28262a, intensity: 0.30 },
    key: { color: 0xffb87f, intensity: 0.88, direction: [-0.46, 0.76, 0.48] },
    fill: { color: 0x9bbbe5, intensity: 0.20, direction: [0.58, 0.38, -0.66] },
    rim: { color: 0xffd1aa, intensity: 0.13, direction: [0.18, 0.55, -0.82] },
    practical: { intensity: 0.42, color: 0xffbb80 },
  },
  night: {
    label: 'Night',
    icon: '☾',
    background: 0x0b1420,
    environmentIntensity: 0.22,
    exposure: 0.78,
    hemisphere: { sky: 0x6881a4, ground: 0x151923, intensity: 0.16 },
    key: { color: 0x8db1e5, intensity: 0.26, direction: [-0.34, 0.86, 0.42] },
    fill: { color: 0x5d78a2, intensity: 0.12, direction: [0.62, 0.34, -0.70] },
    rim: { color: 0x7997c3, intensity: 0.07, direction: [0.12, 0.52, -0.86] },
    practical: { intensity: 0.70, color: 0xffaa69 },
  },
};

const PREPARED_MODES = Object.fromEntries(
  Object.entries(LIGHTING_MODES).map(([key, mode]) => [key, {
    ...mode,
    background: new THREE.Color(mode.background),
    hemisphereSky: new THREE.Color(mode.hemisphere.sky),
    hemisphereGround: new THREE.Color(mode.hemisphere.ground),
    keyColor: new THREE.Color(mode.key.color),
    fillColor: new THREE.Color(mode.fill.color),
    rimColor: new THREE.Color(mode.rim.color),
    practicalColor: new THREE.Color(mode.practical.color),
  }]),
);

function profile(mode) {
  return PREPARED_MODES[mode] || PREPARED_MODES.day;
}

function directionVector(direction, scale) {
  return new THREE.Vector3(...direction).normalize().multiplyScalar(scale);
}

function nodeAndMaterialName(obj, material) {
  const parts = [material?.name, obj?.name];
  let parent = obj?.parent;
  let depth = 0;
  while (parent && depth < 4) {
    parts.push(parent.name);
    parent = parent.parent;
    depth += 1;
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function classifyMesh(obj, material) {
  const text = nodeAndMaterialName(obj, material);
  if (/(window|glazing|glass|mirror|translucent)/.test(text) || (material?.transparent && material.opacity < 0.96)) return 'glass';
  if (/(chrome|stainless|steel|aluminium|aluminum|brass|metal|iron|copper|handle|hinge|rail)/.test(text)) return 'metal';
  if (/(fabric|linen|velvet|upholstery|cushion|curtain|carpet|rug|mattress)/.test(text)) return 'fabric';
  if (/(wood|timber|oak|walnut|teak|plywood|veneer|door wood|door leaf)/.test(text)) return 'wood';
  if (/(floor|tile|marble|granite|stone|slab|concrete|ceramic|porcelain)/.test(text)) return 'floor';
  if (/(wall|ceiling|plaster|drywall|gypsum|paint)/.test(text)) return 'wall';
  if (/(chair|sofa|bed|table|desk|wardrobe|cabinet|tv|sink|basin|wc|toilet|shower|lamp|light|plant|decor|appliance|counter|furniture)/.test(text)) return 'furniture';

  // IFC exports often use generic names (Geom_18_0, Mat_18_0). Use world-space
  // proportions only as a conservative fallback; never recolour authored meshes.
  try {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const horizontalSpan = Math.max(size.x, size.z);
    const thinSpan = Math.min(size.x, size.z);
    if (size.y <= 0.16 && size.x > 0.7 && size.z > 0.7) return 'floor';
    if (size.y > 1.2 && thinSpan < 0.32 && horizontalSpan > 0.6) return 'wall';
  } catch {
    // Geometry bounds are optional metadata; leave the mesh in the neutral profile.
  }
  return 'structure';
}

function clamp(value, min, max) {
  return THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0.8, min, max);
}

function roughnessFor(kind, current) {
  const base = Number.isFinite(current) ? current : 0.82;
  // Preserve plausible authoring values while preventing obviously unsuitable
  // material response (e.g. opaque IFC walls behaving like polished metal).
  switch (kind) {
    case 'glass': return clamp(base, 0.12, 0.34);
    case 'metal': return clamp(base, 0.24, 0.56);
    case 'wood': return clamp(base, 0.48, 0.84);
    case 'fabric': return clamp(base, 0.78, 0.98);
    case 'floor': return clamp(base, 0.48, 0.92);
    case 'wall': return clamp(base, 0.76, 0.98);
    case 'furniture': return clamp(base, 0.52, 0.92);
    default: return clamp(base, 0.70, 0.98);
  }
}

function metalnessFor(kind, current) {
  const base = Number.isFinite(current) ? current : 0;
  if (kind === 'metal') return clamp(base < 0.25 ? 0.65 : base, 0.35, 1.0);
  // Real wood, fabric, plaster, stone and glass are non-metal PBR surfaces.
  return 0;
}

function environmentIntensityFor(kind) {
  switch (kind) {
    case 'metal': return 1.05;
    case 'glass': return 0.82;
    case 'wood': return 0.78;
    case 'floor': return 0.68;
    case 'fabric': return 0.58;
    case 'wall': return 0.60;
    case 'furniture': return 0.78;
    default: return 0.66;
  }
}

// GLTFLoader has already decoded and assigned authored PBR maps. Do not then
// replace their source roughness/metalness factors with name-based heuristics;
// those factors multiply the texture channels and can materially change the
// artist-authored finish. Keep the semantic fallback for simple untextured IFC
// exports, where names and proportions are the only available material clues.
function hasAuthoredPbrTextures(material) {
  return [
    'map',
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'aoMap',
    'emissiveMap',
    'alphaMap',
    'lightMap',
  ].some((key) => material?.[key]?.isTexture === true);
}

function isAuthoredGlbObject(object) {
  let current = object;
  while (current) {
    if (current.userData?.hciAssetFormat === 'glb' || current.userData?.hciAssetFormat === 'gltf') {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function inferGlbAssetFormat(item) {
  const explicit = String(item?.assetFormat || item?.fileType || item?.file_type || '').trim().toLowerCase();
  if (explicit === 'glb' || explicit === 'gltf') return explicit;
  const source = String(item?.src || item?.url || '').split(/[?#]/)[0].toLowerCase();
  return source.endsWith('.glb') ? 'glb' : (source.endsWith('.gltf') ? 'gltf' : null);
}

function markAuthoredGlbSubtrees(model, furnitureItems) {
  const glbItems = (Array.isArray(furnitureItems) ? furnitureItems : [])
    .filter((item) => inferGlbAssetFormat(item));
  const missingInstanceIds = [];
  let markedMeshCount = 0;

  glbItems.forEach((item) => {
    const instanceId = String(item?.instanceId || '');
    if (!instanceId) return;
    const root = model.getObjectByName?.(instanceId);
    if (!root) {
      missingInstanceIds.push(instanceId);
      return;
    }
    root.traverse((object) => {
      object.userData = object.userData || {};
      object.userData.hciAssetFormat = 'glb';
      object.userData.hciAssetInstanceId = instanceId;
      if (!object.isMesh) return;
      markedMeshCount += 1;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (!material) return;
        material.userData = material.userData || {};
        material.userData.hciAssetFormat = 'glb';
        material.userData.hciAssetInstanceId = instanceId;
      });
    });
  });

  if (glbItems.length) {
    console.info('[Walkthrough][GLB] Preserving authored PBR materials:', {
      assetCount: glbItems.length,
      markedMeshCount,
      missingInstanceIds,
    });
  }
}

export class LightingDirector {
  constructor({ scene, renderer, onChange }) {
    this.scene = scene;
    this.renderer = renderer;
    this.onChange = onChange;
    // Shared presentation settings scale the selected lighting preset consistently
    // across overview, guided, explore and immersive views.
    this.presentationOverrides = { exposureMultiplier: 1, environmentMultiplier: 1 };

    this.mode = 'day';
    this.targetMode = 'day';
    this.transitionSeconds = 0.75;
    this.transitionElapsed = this.transitionSeconds;

    this.model = null;
    this.modelCenter = new THREE.Vector3();
    this.modelSize = new THREE.Vector3(12, 3, 12);
    this.roomAnchors = [];
    this.fixtureLightSources = [];
    this.fixtureSceneUnitsPerMeter = 1;

    this.pmremGenerator = null;
    this.environmentScene = null;
    this.environmentRenderTarget = null;
    this.staticShadowPrepared = false;

    this.hemisphere = new THREE.HemisphereLight(PREPARED_MODES.day.hemisphereSky, PREPARED_MODES.day.hemisphereGround, 0.36);
    this.keyLight = new THREE.DirectionalLight(PREPARED_MODES.day.keyColor, 1.62);
    this.fillLight = new THREE.DirectionalLight(PREPARED_MODES.day.fillColor, 0.24);
    this.rimLight = new THREE.DirectionalLight(PREPARED_MODES.day.rimColor, 0.07);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.radius = 3.5;
    this.keyLight.shadow.bias = -0.00008;
    this.keyLight.shadow.normalBias = 0.010;
    this.keyLight.shadow.camera.near = 0.1;
    this.keyLight.shadow.camera.far = 80;

    this.practicalLights = [];
    this._maxPracticalLights = 4;

    this.scene.add(this.hemisphere, this.keyLight, this.fillLight, this.rimLight);
    this._createEnvironment();
    this._applyInstant('day', { refreshShadows: false });
  }

  _createEnvironment() {
    try {
      this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
      this.environmentScene = new RoomEnvironment();
      this.environmentRenderTarget = this.pmremGenerator.fromScene(this.environmentScene, 0.035);
      this.scene.environment = this.environmentRenderTarget.texture;
      if ('environmentIntensity' in this.scene) {
        this.scene.environmentIntensity = PREPARED_MODES.day.environmentIntensity;
      }
    } catch (error) {
      console.warn('[Walkthrough][Lighting] Environment setup failed; direct lights remain active.', error);
      this.environmentRenderTarget?.dispose?.();
      this.environmentRenderTarget = null;
      this.environmentScene = null;
      this.pmremGenerator?.dispose?.();
      this.pmremGenerator = null;
    }
  }

  attachModel(model, furnitureItems = []) {
    this.model = model;
    model.updateMatrixWorld(true);
    // Resolve stable GLB instance wrapper names from project_state.json as a
    // fallback for renderers/optimizers that do not preserve glTF extras.
    markAuthoredGlbSubtrees(model, furnitureItems);
    const box = new THREE.Box3().setFromObject(model);
    if (!box.isEmpty()) {
      box.getCenter(this.modelCenter);
      box.getSize(this.modelSize);
    }

    model.traverse((obj) => {
      if (!obj.isMesh) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      const primaryMaterial = materials.find(Boolean) || null;
      const kind = classifyMesh(obj, primaryMaterial);
      obj.receiveShadow = kind !== 'glass';
      obj.castShadow = kind !== 'glass';

      materials.forEach((material) => {
        if (!material) return;
        const materialKind = classifyMesh(obj, material);
        const preserveGlbMaterial = isAuthoredGlbObject(obj)
          || material.userData?.hciAssetFormat === 'glb'
          || material.userData?.hciAssetFormat === 'gltf';

        // Catalogue GLBs arrive with artist-authored glTF PBR factors and maps.
        // Keep base colour, roughness, metalness, normal/occlusion maps, alpha,
        // clearcoat, sheen and transmission intact. The room's key/fill lights
        // and environment provide illumination; name-based IFC heuristics must
        // not rewrite an imported furniture material.
        if (preserveGlbMaterial) return;

        if ('envMapIntensity' in material) {
          material.envMapIntensity = environmentIntensityFor(materialKind);
        }
        const preserveAuthoredPbr = hasAuthoredPbrTextures(material);
        if (!preserveAuthoredPbr && 'roughness' in material) {
          material.roughness = roughnessFor(materialKind, material.roughness);
        }
        if (!preserveAuthoredPbr && 'metalness' in material) {
          material.metalness = metalnessFor(materialKind, material.metalness);
        }
        // IFC exports often have generic material names and no texture maps;
        // retain the semantic fallback only for those structural materials.
        material.needsUpdate = true;
      });
    });

    // Higher shadow resolution for typical apartments, but stay at 1024 for
    // very large scenes to avoid an outsized shadow-map cost.
    const span = Math.max(this.modelSize.x, this.modelSize.y, this.modelSize.z);
    const shadowResolution = span <= 24 ? 2048 : 1024;
    if (this.keyLight.shadow.mapSize.x !== shadowResolution || this.keyLight.shadow.mapSize.y !== shadowResolution) {
      // The renderer may have allocated the default shadow target before the
      // GLB finished loading. Dispose it so the new map resolution takes effect.
      this.keyLight.shadow.map?.dispose?.();
      this.keyLight.shadow.map = null;
    }
    this.keyLight.shadow.mapSize.set(shadowResolution, shadowResolution);
    this.keyLight.shadow.camera.updateProjectionMatrix();

    this._refreshLightRig();
    this._rebuildPracticalLights();

    // Static scene: build the shadow map once and freeze it. Camera motion does not
    // cause shadow rendering work every frame.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.staticShadowPrepared = true;
  }

  setLightFixtures(furniture, metersPerUnit = 1) {
    const physicalMetersPerUnit = Number(metersPerUnit);
    // WalkNavigationPipeline's physicalMetersPerUnit is the number of GLB
    // scene units occupied by one physical metre (it multiplies metric radii,
    // heights and sample distances by this value). Use the same convention for
    // fixture-light offsets and falloff distances.
    this.fixtureSceneUnitsPerMeter = Number.isFinite(physicalMetersPerUnit) && physicalMetersPerUnit > 0
      ? physicalMetersPerUnit
      : 1;
    this.fixtureLightSources = (Array.isArray(furniture) ? furniture : [])
      .filter((item) => item && (item.isLightFixture === true || String(item.assetCategory || '').toLowerCase() === 'lighting'))
      .map((item) => {
        const instanceId = String(item.instanceId || item.id || '');
        const persistedPosition = Array.isArray(item.position) ? item.position.slice(0, 3).map(Number) : [];
        if (persistedPosition.length !== 3 || !persistedPosition.every(Number.isFinite)) return null;

        // The saved position is the asset's placement/contact target (usually
        // its bottom-centre pivot), not necessarily the bulb/emitter location.
        // The compiler preserves each instance under a node named instanceId;
        // use its final world-space bounds to mirror the editor's AABB-based
        // emitter placement. Fall back to the persisted target for legacy GLBs
        // whose node name could not be resolved.
        let position = [...persistedPosition];
        const fixtureNode = instanceId ? this.model?.getObjectByName?.(instanceId) : null;
        if (fixtureNode) {
          fixtureNode.updateWorldMatrix?.(true, true);
          const bounds = new THREE.Box3().setFromObject(fixtureNode);
          if (!bounds.isEmpty()) {
            const size = bounds.getSize(new THREE.Vector3());
            position = [
              (bounds.min.x + bounds.max.x) * 0.5,
              bounds.min.y + Math.min(Math.max(size.y, 0.05 * this.fixtureSceneUnitsPerMeter) * 0.18, 0.10 * this.fixtureSceneUnitsPerMeter),
              (bounds.min.z + bounds.max.z) * 0.5,
            ];
          }
        } else {
          position[1] -= 0.045 * this.fixtureSceneUnitsPerMeter;
        }

        return {
          instanceId,
          position,
          enabled: item.lightEnabled === true,
          intensity: clampFixture(item.lightIntensity ?? 0.30, 0, 0.55),
          temperature: clampFixture(item.lightTemperature ?? 4000, 2700, 6500),
        };
      })
      .filter(Boolean);
    this._rebuildPracticalLights();
  }

  setRoomAnchors(areas) {
    this.roomAnchors = Array.isArray(areas)
      ? areas
          .filter((area) => Array.isArray(area?.center) && area.center.length >= 3)
          .slice(0, 8)
          .map((area) => ({
            id: area.id || area.label || `room-${this.roomAnchors.length + 1}`,
            center: new THREE.Vector3(Number(area.center[0]), Number(area.center[1]), Number(area.center[2])),
          }))
      : [];
    this._rebuildPracticalLights();
  }

  _refreshLightRig() {
    const span = Math.max(this.modelSize.x, this.modelSize.z, 8);
    const shadowSpan = span * 0.62;
    const keyDistance = Math.max(span * 2.0, 17);
    const fillDistance = Math.max(span * 1.7, 13);
    const rimDistance = Math.max(span * 1.5, 12);
    const current = profile(this.targetMode);

    this.keyLight.position.copy(this.modelCenter).add(directionVector(current.key.direction, keyDistance));
    this.fillLight.position.copy(this.modelCenter).add(directionVector(current.fill.direction, fillDistance));
    this.rimLight.position.copy(this.modelCenter).add(directionVector(current.rim.direction, rimDistance));

    this.keyLight.shadow.camera.left = -shadowSpan;
    this.keyLight.shadow.camera.right = shadowSpan;
    this.keyLight.shadow.camera.top = shadowSpan;
    this.keyLight.shadow.camera.bottom = -shadowSpan;
    this.keyLight.shadow.camera.far = Math.max(42, span * 3.8);
    this.keyLight.shadow.camera.updateProjectionMatrix();
    this.keyLight.target.position.copy(this.modelCenter);
    this.scene.add(this.keyLight.target);
  }

  _rebuildPracticalLights() {
    if (!this.model) return;

    this.practicalLights.forEach((light) => {
      this.scene.remove(light);
      light.dispose?.();
    });
    this.practicalLights = [];

    const sceneUnitsPerMeter = Math.max(this.fixtureSceneUnitsPerMeter || 1, 0.000001);
    const coveredRoomIds = new Set();

    // Remember which rooms have authored fixtures even when a fixture is switched
    // off. Otherwise the generic room-centre practical would make an explicitly
    // disabled light appear to remain on in the walkthrough.
    this.fixtureLightSources.forEach((source) => {
      let nearest = null;
      let nearestDistance = Infinity;
      for (const anchor of this.roomAnchors) {
        const distance = Math.hypot(anchor.center.x - source.position[0], anchor.center.z - source.position[2]);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = anchor;
        }
      }
      if (nearest && nearestDistance <= 7.0 * sceneUnitsPerMeter) coveredRoomIds.add(nearest.id);
    });

    this.fixtureLightSources
      .filter((source) => source.enabled && source.intensity > 0)
      .slice(0, MAX_FIXTURE_LIGHTS)
      .forEach((source) => {
        const baseColor = fixtureColorForTemperature(source.temperature);
        // Editor fixture intensity is intentionally conservative (0..0.55).
        // Convert it to a modest Three.js point-light scale. Position already
        // comes from the final fixture AABB when that node is present.
        const baseIntensity = (source.intensity / 0.55) * 3.0;
        const light = new THREE.PointLight(baseColor, 0, 5.8 * sceneUnitsPerMeter, 2.0);
        light.position.set(source.position[0], source.position[1], source.position[2]);
        light.castShadow = false;
        light.userData.hciFixtureLight = true;
        light.userData.hciFixtureId = source.instanceId;
        light.userData.hciFixtureBaseIntensity = baseIntensity;
        light.userData.hciFixtureBaseColor = baseColor.clone();
        this.scene.add(light);
        this.practicalLights.push(light);
      });

    // Keep the existing ambient practical-light fallback for rooms without a
    // catalogue fixture. A room containing an authored fixture is controlled by
    // that fixture's on/off and brightness settings instead.
    const fallbackAnchors = this.fixtureLightSources.length
      ? this.roomAnchors.filter((anchor) => !coveredRoomIds.has(anchor.id))
      : this.roomAnchors;
    fallbackAnchors.slice(0, this._maxPracticalLights).forEach((anchor) => {
      const floorY = this.modelCenter.y - (this.modelSize.y * 0.5);
      const fixtureY = floorY + THREE.MathUtils.clamp(this.modelSize.y * 0.78, 2.25, 2.85);
      const light = new THREE.PointLight(PREPARED_MODES.day.practicalColor, 0, 5.8, 2.0);
      light.position.set(anchor.center.x, fixtureY, anchor.center.z);
      light.castShadow = false;
      light.userData.hciPractical = true;
      this.scene.add(light);
      this.practicalLights.push(light);
    });

    this._applyPracticalIntensity(profile(this.mode));
  }

  _applyPracticalIntensity(currentProfile) {
    this.practicalLights.forEach((light) => {
      if (light.userData?.hciFixtureLight) {
        light.color.copy(light.userData.hciFixtureBaseColor || currentProfile.practicalColor);
        light.intensity = Number(light.userData.hciFixtureBaseIntensity || 0) * fixtureModeGain(this.mode);
        return;
      }
      light.color.copy(currentProfile.practicalColor);
      light.intensity = currentProfile.practical.intensity;
    });
  }

  _applyInstant(mode, { refreshShadows = true } = {}) {
    const current = profile(mode);
    this.mode = mode;
    this.targetMode = mode;
    this.transitionElapsed = this.transitionSeconds;

    this.scene.background.copy(current.background);
    if ('environmentIntensity' in this.scene) this.scene.environmentIntensity = current.environmentIntensity * this.presentationOverrides.environmentMultiplier;
    this.renderer.toneMappingExposure = current.exposure * this.presentationOverrides.exposureMultiplier;

    this.hemisphere.color.copy(current.hemisphereSky);
    this.hemisphere.groundColor.copy(current.hemisphereGround);
    this.hemisphere.intensity = current.hemisphere.intensity;

    this.keyLight.color.copy(current.keyColor);
    this.keyLight.intensity = current.key.intensity;
    this.fillLight.color.copy(current.fillColor);
    this.fillLight.intensity = current.fill.intensity;
    this.rimLight.color.copy(current.rimColor);
    this.rimLight.intensity = current.rim.intensity;
    this._applyPracticalIntensity(current);
    this._refreshLightRig();

    if (refreshShadows && this.staticShadowPrepared) this.renderer.shadowMap.needsUpdate = true;
  }


  setPresentationOverrides(overrides = {}) {
    const exposureMultiplier = Number(overrides.exposureMultiplier);
    const environmentMultiplier = Number(overrides.environmentMultiplier);
    this.presentationOverrides = {
      exposureMultiplier: THREE.MathUtils.clamp(Number.isFinite(exposureMultiplier) ? exposureMultiplier : 1, 0.75, 1.25),
      environmentMultiplier: THREE.MathUtils.clamp(Number.isFinite(environmentMultiplier) ? environmentMultiplier : 1, 0.5, 1.5),
    };
    // Apply immediately to the currently visible profile while preserving any
    // in-progress interpolation between Day / Evening / Night.
    const current = profile(this.mode);
    if ('environmentIntensity' in this.scene) {
      this.scene.environmentIntensity = current.environmentIntensity * this.presentationOverrides.environmentMultiplier;
    }
    this.renderer.toneMappingExposure = current.exposure * this.presentationOverrides.exposureMultiplier;
    this.onChange?.(this.getState());
  }

  setMode(mode, { immediate = false } = {}) {
    const next = Object.prototype.hasOwnProperty.call(LIGHTING_MODES, mode) ? mode : 'day';
    if (next === this.targetMode && !immediate) return next;
    this.targetMode = next;

    if (immediate) {
      this._applyInstant(next);
    } else {
      this.transitionElapsed = 0;
      this.onChange?.(this.getState());
    }
    return next;
  }

  cycle() {
    const index = MODE_ORDER.indexOf(this.targetMode);
    return this.setMode(MODE_ORDER[(index + 1) % MODE_ORDER.length]);
  }

  getState() {
    const p = profile(this.targetMode);
    return { mode: this.mode, targetMode: this.targetMode, label: p.label, icon: p.icon };
  }

  update(dt) {
    if (this.transitionElapsed >= this.transitionSeconds) return;

    this.transitionElapsed = Math.min(
      this.transitionSeconds,
      this.transitionElapsed + Math.max(dt, 0.001),
    );

    const linearT = THREE.MathUtils.clamp(this.transitionElapsed / this.transitionSeconds, 0, 1);
    const t = linearT * linearT * (3 - 2 * linearT);
    const from = profile(this.mode);
    const to = profile(this.targetMode);

    this.scene.background.lerpColors(from.background, to.background, t);
    if ('environmentIntensity' in this.scene) {
      this.scene.environmentIntensity = THREE.MathUtils.lerp(from.environmentIntensity, to.environmentIntensity, t) * this.presentationOverrides.environmentMultiplier;
    }
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(from.exposure, to.exposure, t) * this.presentationOverrides.exposureMultiplier;
    this.hemisphere.color.lerpColors(from.hemisphereSky, to.hemisphereSky, t);
    this.hemisphere.groundColor.lerpColors(from.hemisphereGround, to.hemisphereGround, t);
    this.hemisphere.intensity = THREE.MathUtils.lerp(from.hemisphere.intensity, to.hemisphere.intensity, t);
    this.keyLight.color.lerpColors(from.keyColor, to.keyColor, t);
    this.keyLight.intensity = THREE.MathUtils.lerp(from.key.intensity, to.key.intensity, t);
    this.fillLight.color.lerpColors(from.fillColor, to.fillColor, t);
    this.fillLight.intensity = THREE.MathUtils.lerp(from.fill.intensity, to.fill.intensity, t);
    this.rimLight.color.lerpColors(from.rimColor, to.rimColor, t);
    this.rimLight.intensity = THREE.MathUtils.lerp(from.rim.intensity, to.rim.intensity, t);

    this.practicalLights.forEach((light) => {
      if (light.userData?.hciFixtureLight) {
        light.color.copy(light.userData.hciFixtureBaseColor || to.practicalColor);
        const gain = THREE.MathUtils.lerp(fixtureModeGain(this.mode), fixtureModeGain(this.targetMode), t);
        light.intensity = Number(light.userData.hciFixtureBaseIntensity || 0) * gain;
        return;
      }
      light.color.lerpColors(from.practicalColor, to.practicalColor, t);
      light.intensity = THREE.MathUtils.lerp(from.practical.intensity, to.practical.intensity, t);
    });

    if (linearT >= 1) {
      this.mode = this.targetMode;
      this._applyInstant(this.mode);
      this.onChange?.(this.getState());
    }
  }

  dispose() {
    this.keyLight.target?.parent?.remove(this.keyLight.target);
    this.practicalLights.forEach((light) => this.scene.remove(light));
    this.practicalLights = [];
    this.scene.remove(this.hemisphere, this.keyLight, this.fillLight, this.rimLight);
    this.environmentRenderTarget?.dispose?.();
    this.environmentScene?.dispose?.();
    this.pmremGenerator?.dispose?.();
    this.environmentRenderTarget = null;
    this.environmentScene = null;
    this.pmremGenerator = null;
  }
}

export { LIGHTING_MODES, MODE_ORDER };
