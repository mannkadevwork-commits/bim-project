const PRESETS = {
  top: { direction: [0, 1, 0], up: [0, 0, -1], projection: 'ortho' },
  front: { direction: [0, 0, 1], up: [0, 1, 0], projection: 'perspective' },
  back: { direction: [0, 0, -1], up: [0, 1, 0], projection: 'perspective' },
  right: { direction: [1, 0, 0], up: [0, 1, 0], projection: 'perspective' },
  left: { direction: [-1, 0, 0], up: [0, 1, 0], projection: 'perspective' },
  iso: { direction: [1, 0.85, 1], up: [0, 1, 0], projection: 'perspective' },
};

const normalize = ([x, y, z]) => {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
};

const getBoundsCenterAndRadius = (aabb) => {
  if (!aabb || aabb.length < 6) return null;
  const center = [
    (aabb[0] + aabb[3]) / 2,
    (aabb[1] + aabb[4]) / 2,
    (aabb[2] + aabb[5]) / 2,
  ];
  const radius = Math.max(
    Math.hypot(aabb[3] - aabb[0], aabb[4] - aabb[1], aabb[5] - aabb[2]) / 2,
    1,
  );
  return { center, radius };
};

const getTarget = (viewer, targetId, isAsset = false) => {
  if (!viewer || !targetId) return null;
  return isAsset ? viewer.scene.models?.[targetId] : viewer.scene.objects?.[targetId];
};

export class CameraManager {
  constructor(viewer) {
    this.viewer = viewer;
    this.flight = viewer?.cameraFlight;
    this.camera = viewer?.camera;
    this.control = viewer?.cameraControl;
    this.defaultDuration = 0.45;

    if (this.flight) {
      this.flight.duration = this.defaultDuration;
      this.flight.fit = true;
    }
  }

  setOrbit() {
    if (!this.control) return;
    this.control.navMode = 'orbit';
    this.control.active = true;
    this.control.followPointer = true;
    this.control.smartPivot = true;
  }

  fitScene(duration = this.defaultDuration) {
    if (!this.viewer?.scene || !this.flight) return false;
    this.flight.flyTo({
      aabb: this.viewer.scene.aabb,
      projection: 'perspective',
      duration,
      fit: true,
    });
    return true;
  }

  focus(targetId, isAsset = false, duration = this.defaultDuration) {
    const target = getTarget(this.viewer, targetId, isAsset);
    if (!target || !this.flight) return false;
    this.flight.flyTo({
      aabb: target.aabb,
      projection: this.camera?.projection || 'perspective',
      duration,
      fit: true,
      fitFOV: 42,
    });
    return true;
  }

  setProjection(projection, duration = this.defaultDuration) {
    if (!this.flight || !projection) return false;
    this.flight.flyTo({ projection, duration });
    return true;
  }

  preset(name, duration = 0.55) {
    if (!this.viewer?.scene || !this.flight) return false;
    const preset = PRESETS[name];
    if (!preset) return false;

    const fit = getBoundsCenterAndRadius(this.viewer.scene.aabb);
    if (!fit) return false;

    const direction = normalize(preset.direction);
    const distance = fit.radius * 2.25;
    const eye = [
      fit.center[0] + direction[0] * distance,
      fit.center[1] + direction[1] * distance,
      fit.center[2] + direction[2] * distance,
    ];

    this.flight.flyTo({
      eye,
      look: fit.center,
      up: preset.up,
      projection: preset.projection,
      duration,
      fit: false,
      orthoScale: fit.radius * 2.15,
    });
    return true;
  }

  getProjection() {
    return this.camera?.projection || 'perspective';
  }

  snapshot() {
    if (!this.camera) return null;
    return {
      eye: [...this.camera.eye],
      look: [...this.camera.look],
      up: [...this.camera.up],
      projection: this.camera.projection,
      orthoScale: this.camera.ortho?.scale,
      fov: this.camera.perspective?.fov,
    };
  }
}

export const CAMERA_PRESETS = ['top', 'front', 'back', 'right', 'left', 'iso'];
