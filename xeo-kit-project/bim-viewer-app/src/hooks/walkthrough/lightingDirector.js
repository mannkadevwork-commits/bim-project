import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const MODE_ORDER = ['day', 'evening', 'night'];

const LIGHTING_MODES = {
  day: {
    label: 'Day',
    icon: '☀',
    background: 0xd9e1e7,
    environmentIntensity: 0.68,
    exposure: 0.93,
    hemisphere: { sky: 0xf4f8fb, ground: 0x59636d, intensity: 0.60 },
    key: { color: 0xfff1dc, intensity: 1.60, direction: [-0.50, 0.88, 0.46] },
    fill: { color: 0xbdd4ee, intensity: 0.28, direction: [0.64, 0.42, -0.60] },
    rim: { color: 0xffffff, intensity: 0.12, direction: [0.16, 0.54, -0.84] },
    practical: { intensity: 0.0, color: 0xffc98f },
  },
  evening: {
    label: 'Evening',
    icon: '◐',
    background: 0x4c5868,
    environmentIntensity: 0.52,
    exposure: 0.92,
    hemisphere: { sky: 0xffcfa6, ground: 0x252d38, intensity: 0.44 },
    key: { color: 0xffb36f, intensity: 1.02, direction: [-0.46, 0.76, 0.48] },
    fill: { color: 0x8eaed8, intensity: 0.25, direction: [0.58, 0.38, -0.66] },
    rim: { color: 0xffd1aa, intensity: 0.20, direction: [0.18, 0.55, -0.82] },
    practical: { intensity: 0.32, color: 0xffb978 },
  },
  night: {
    label: 'Night',
    icon: '☾',
    background: 0x08111d,
    environmentIntensity: 0.30,
    exposure: 0.82,
    hemisphere: { sky: 0x607da5, ground: 0x111822, intensity: 0.18 },
    key: { color: 0x87aee8, intensity: 0.38, direction: [-0.34, 0.86, 0.42] },
    fill: { color: 0x526c98, intensity: 0.12, direction: [0.62, 0.34, -0.70] },
    rim: { color: 0x6f8fbe, intensity: 0.11, direction: [0.12, 0.52, -0.86] },
    practical: { intensity: 0.82, color: 0xffa15d },
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

function classifyMesh(obj) {
  const text = `${obj.name || ''} ${obj.parent?.name || ''}`.toLowerCase();
  if (/(window|glazing|glass|mirror)/.test(text)) return 'glass';
  if (/(metal|steel|chrome|handle|rail)/.test(text)) return 'metal';
  if (/(chair|sofa|bed|table|desk|wardrobe|cabinet|tv|sink|basin|wc|toilet|shower|lamp|light|plant|decor|appliance|counter|furniture)/.test(text)) return 'furniture';
  return 'structure';
}

function roughnessFor(kind, current) {
  const base = Number.isFinite(current) ? current : 0.8;
  if (kind === 'glass') return Math.min(base, 0.24);
  if (kind === 'metal') return Math.min(base, 0.42);
  if (kind === 'furniture') return Math.min(base, 0.62);
  return Math.min(base, 0.74);
}

export class LightingDirector {
  constructor({ scene, renderer, onChange }) {
    this.scene = scene;
    this.renderer = renderer;
    this.onChange = onChange;

    this.mode = 'day';
    this.targetMode = 'day';
    this.transitionSeconds = 0.75;
    this.transitionElapsed = this.transitionSeconds;

    this.model = null;
    this.modelCenter = new THREE.Vector3();
    this.modelSize = new THREE.Vector3(12, 3, 12);
    this.roomAnchors = [];

    this.pmremGenerator = null;
    this.environmentScene = null;
    this.environmentRenderTarget = null;
    this.staticShadowPrepared = false;

    this.hemisphere = new THREE.HemisphereLight(PREPARED_MODES.day.hemisphereSky, PREPARED_MODES.day.hemisphereGround, 0.60);
    this.keyLight = new THREE.DirectionalLight(PREPARED_MODES.day.keyColor, 1.60);
    this.fillLight = new THREE.DirectionalLight(PREPARED_MODES.day.fillColor, 0.28);
    this.rimLight = new THREE.DirectionalLight(PREPARED_MODES.day.rimColor, 0.12);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.bias = -0.00010;
    this.keyLight.shadow.normalBias = 0.014;
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

  attachModel(model) {
    this.model = model;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    if (!box.isEmpty()) {
      box.getCenter(this.modelCenter);
      box.getSize(this.modelSize);
    }

    model.traverse((obj) => {
      if (!obj.isMesh) return;
      const kind = classifyMesh(obj);
      obj.receiveShadow = true;
      obj.castShadow = kind !== 'glass';

      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      materials.forEach((material) => {
        if (!material) return;
        if ('envMapIntensity' in material) {
          material.envMapIntensity = kind === 'structure' ? 0.88 : 1.05;
        }
        if ('roughness' in material) {
          material.roughness = roughnessFor(kind, material.roughness);
        }
        if (kind === 'glass' && 'metalness' in material) {
          material.metalness = Math.min(material.metalness, 0.02);
        }
        material.needsUpdate = true;
      });
    });

    this._refreshLightRig();
    this._rebuildPracticalLights();

    // Static scene: build the shadow map once and freeze it. Camera motion does not
    // cause shadow rendering work every frame.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.staticShadowPrepared = true;
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

    const usable = this.roomAnchors.slice(0, this._maxPracticalLights);
    if (!usable.length) return;

    const floorY = this.modelCenter.y - (this.modelSize.y * 0.5);
    const fixtureY = floorY + THREE.MathUtils.clamp(this.modelSize.y * 0.78, 2.25, 2.85);

    usable.forEach((anchor) => {
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
    if ('environmentIntensity' in this.scene) this.scene.environmentIntensity = current.environmentIntensity;
    this.renderer.toneMappingExposure = current.exposure;

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
      this.scene.environmentIntensity = THREE.MathUtils.lerp(from.environmentIntensity, to.environmentIntensity, t);
    }
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(from.exposure, to.exposure, t);
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
