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
    if (!this.camera || !projection) return false;
    if (projection !== 'perspective' && projection !== 'ortho') return false;

    // Preserve the current framing when switching projections.
    const eye = [...this.camera.eye];
    const look = [...this.camera.look];
    const up = [...this.camera.up];

    if (projection === 'ortho') {
      const dx = eye[0] - look[0];
      const dy = eye[1] - look[1];
      const dz = eye[2] - look[2];
      const distance = Math.max(Math.hypot(dx, dy, dz), 0.001);
      const fov = Number(this.camera.perspective?.fov || 50);
      const fovRadians = (fov * Math.PI) / 180;
      const projectedHeight = distance * 2 * Math.tan(fovRadians / 2);
      this.camera.ortho.scale = Math.max(projectedHeight, 0.001);
    }

    try {
      this.camera.projection = projection;
    } catch (error) {
      // Keep the flight path as the compatibility fallback for xeokit builds
    }

    if (this.flight) {
      this.flight.flyTo({
        eye,
        look,
        up,
        projection,
        duration,
        fit: false,
      });
    }
    return true;
  }

  zoom(direction = 1, duration = 0.2) {
    if (!this.camera) return false;
    const factor = direction > 0 ? 0.82 : 1.22;

    if (this.camera.projection === 'ortho') {
      const current = Number(this.camera.ortho?.scale);
      if (!Number.isFinite(current)) return false;
      this.camera.ortho.scale = Math.max(current * factor, 0.001);
      return true;
    }

    const eye = [...this.camera.eye];
    const look = [...this.camera.look];
    const up = [...this.camera.up];

    const vx = eye[0] - look[0];
    const vy = eye[1] - look[1];
    const vz = eye[2] - look[2];
    const distance = Math.hypot(vx, vy, vz);

    if (!Number.isFinite(distance) || distance < 0.001) return false;

    const nextEye = [
      look[0] + vx * factor,
      look[1] + vy * factor,
      look[2] + vz * factor,
    ];

    this.flight?.flyTo({
      eye: nextEye,
      look,
      up,
      projection: 'perspective',
      duration,
      fit: false,
    });
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

  /**
   * Smooth pointer-targeted zoom for the xeokit canvas.
   * Picks the 3-D point under the cursor and dollies the camera toward/away
   * from it so the scene zooms into the cursor rather than the look-at centre.
   *
   * @param {number} wheelDelta  - raw wheel deltaY (positive = zoom out)
   * @param {[number,number]} canvasPos - [x, y] in canvas pixels
   */
  zoomToPointer(wheelDelta, canvasPos) {
    if (!this.viewer || !this.camera) return;

    const scene = this.viewer.scene;
    const camera = this.camera;

    // Pick the world-space point under the cursor (surface or entity centre).
    const pick = scene.pick({ canvasPos, pickSurface: true });
    const target = pick?.worldPos
      ? pick.worldPos
      : [...camera.look];

    const eye = camera.eye;
    const dx = eye[0] - target[0];
    const dy = eye[1] - target[1];
    const dz = eye[2] - target[2];
    const dist = Math.hypot(dx, dy, dz) || 1;

    // Zoom speed scales with distance so it feels consistent at any depth.
    const zoomSpeed = dist * 0.0008;
    const factor = wheelDelta > 0
      ? 1 + Math.min(wheelDelta, 200) * zoomSpeed   // zoom out
      : 1 - Math.min(-wheelDelta, 200) * zoomSpeed; // zoom in

    const minDist = 0.05;
    const newDist = Math.max(dist * factor, minDist);
    const scale = newDist / dist;

    camera.eye = [
      target[0] + dx * scale,
      target[1] + dy * scale,
      target[2] + dz * scale,
    ];

    // For ortho projection also scale the ortho frustum width.
    if (camera.projection === 'ortho' && camera.ortho) {
      camera.ortho.scale = (camera.ortho.scale || 1) * factor;
    }
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

  restore(snapshot, duration = 0.6) {
    if (!this.camera || !snapshot) return false;

    this.flight?.flyTo({
      eye: snapshot.eye,
      look: snapshot.look,
      up: snapshot.up,
      projection: snapshot.projection || 'perspective',
      duration,
      fit: false,
    });

    if (snapshot.projection === 'ortho' && Number.isFinite(snapshot.orthoScale)) {
      this.camera.ortho.scale = snapshot.orthoScale;
    }
    if (snapshot.projection === 'perspective' && Number.isFinite(snapshot.fov)) {
      this.camera.perspective.fov = snapshot.fov;
    }
    return true;
  }

  reset(duration = 0.55) {
    return this.fitScene(duration);
  }
}

export const CAMERA_PRESETS = ['top', 'front', 'back', 'right', 'left', 'iso'];