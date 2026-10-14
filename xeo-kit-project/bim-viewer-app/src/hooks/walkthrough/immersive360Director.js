import * as THREE from 'three';
const IMMERSIVE_360_SPEED_RAD_PER_SEC = 0.038;
const IMMERSIVE_360_MANUAL_RESUME_DELAY_MS = 3200;
const IMMERSIVE_360_MANUAL_VELOCITY_DAMPING = 6.8;

export const immersive360DirectorMethods = {
  _resetImmersive360State() {
    this.immersive360Active = false;
    this.immersive360AutoRotate = true;
    this.immersive360ManualActive = false;
    this.immersive360ManualUntil = 0;
    this.immersive360PointerDown = null;
    this.immersive360LastPointer = null;
    this.immersive360PointerDragging = false;
    this.immersive360YawVelocity = 0;
    this.immersive360AutoSpeedRadPerSec = IMMERSIVE_360_SPEED_RAD_PER_SEC;
  },

  _findImmersivePresentationOrigin() {
    if (!this.position) return null;

    const unit = Math.max(this.metersPerUnit || 1, 1e-6);
    const currentPoint = [this.position.x, this.position.y, this.position.z];
    const currentOpenSpace = Number(this._presentationOpenSpaceScore?.(currentPoint) || 0);

    // Most room-entry positions are already fine. Only move when the current
    // camera is clearly cramped; this prevents a distracting teleport during
    // normal presentation entry while rescuing wall/furniture-adjacent shots.
    if (currentOpenSpace >= 0.55) return null;

    const activeAreaId = this._getGuidedPresentationAreaId?.() || null;
    const entries = [...(this.safeAnchorById?.entries?.() || [])]
      .map(([id, entry]) => ({ id, ...entry }))
      .filter((entry) => entry?.point && entry?.hotspot);

    if (!entries.length) return null;

    const sameArea = activeAreaId
      ? entries.filter((entry) => entry.hotspot?.areaId === activeAreaId)
      : entries;
    const candidates = sameArea.length ? sameArea : entries;

    let best = null;
    for (const candidate of candidates) {
      const openness = Number(candidate.openness || 0);
      if (openness < 0.8) continue;
      const distanceMeters = Math.hypot(
        candidate.point.x - this.position.x,
        candidate.point.z - this.position.z,
      ) / unit;
      if (distanceMeters > 6.0) continue;

      const roleBonus = candidate.role === 'room-center' ? 1.35
        : candidate.role === 'viewpoint' ? 1.15
        : candidate.role === 'room-entrance' ? 0.7
        : 0.25;
      const score = openness * 2.4 + roleBonus - distanceMeters * 0.12;
      if (!best || score > best.score) best = { ...candidate, score };
    }

    return best?.point || null;
  },

  _moveToImmersivePresentationOrigin(point) {
    if (!point || !this.position) return false;
    this.position.set(point.x, point.y, point.z);
    this.currentPolyRef = point.polyRef || this.currentPolyRef;
    this.lastMovementPosition.copy(this.position);
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity?.set?.(0, 0, 0);
    this.velocity?.set?.(0, 0, 0);
    this.directTravel = null;
    this._rememberNearestSafeAnchor?.(this.position, 'presentation');
    return true;
  },

  setImmersive360(active, options = {}) {
    const next = Boolean(active);
    if (next === this.immersive360Active) return next;

    if (next) {
      if (this.viewMode !== 'walk') {
        this.onState?.({ type: 'immersive-360', active: false, reason: 'walk-required' });
        return false;
      }

      // 360 presentation is a stationary viewing state. It never creates a
      // navigation destination and never competes with physical locomotion.
      this.stopTravel();
      if (!options.preserveGuidedTour) {
        this.guidedTourArmed = false;
        this.guidedTourNextAt = 0;
        this.guidedTourAdvanceLock = false;
      }
      this._resetGuidedHeroEnding?.();
      this.arrivalSettleUntil = 0;
      this.guidedApproachActive = false;
      this.guidedRevealActive = false;
      this.guidedArrivalSettleStartedAt = 0;
      this.guidedManualActive = false;
      this.guidedPointerDown = null;
      this.guidedLastPointer = null;
      this.guidedPointerDragging = false;
      this.guidedYawVelocity = 0;

      const best = this._findBestGuidedComposition?.(
        this.position,
        this.lastMoveDirection,
        this.currentYaw,
      );
      const startYaw = Number.isFinite(best?.yaw) ? best.yaw : this.currentYaw;
      this.currentYaw = startYaw;
      this.targetYaw = startYaw;
      this.guidedCompositionYaw = startYaw;
      this.guidedCompositionTargetYaw = startYaw;
      const presentationOrigin = this._findImmersivePresentationOrigin?.();
      if (presentationOrigin) {
        this._moveToImmersivePresentationOrigin?.(presentationOrigin);
      }

      const composed = this._findBestGuidedComposition?.(
        this.position,
        this.lastMoveDirection,
        this.currentYaw,
      );
      const composedYaw = Number.isFinite(composed?.yaw) ? composed.yaw : startYaw;
      this.currentYaw = composedYaw;
      this.targetYaw = composedYaw;
      this.guidedCompositionYaw = composedYaw;
      this.guidedCompositionTargetYaw = composedYaw;
      this.guidedYawCenter = composedYaw;
      this.guidedPitch = Number.isFinite(this.guidedPitch) ? this.guidedPitch : -0.085;
      this.currentPitch = this.guidedPitch;
      this.targetPitch = this.guidedPitch;
      this.guidedPanPhase = 0;

      this.immersive360Active = true;
      this.immersive360AutoRotate = options.autoRotate === undefined ? true : Boolean(options.autoRotate);
      this.immersive360AutoSpeedRadPerSec = Number.isFinite(options.autoSpeed)
        ? Math.max(0.005, Number(options.autoSpeed))
        : IMMERSIVE_360_SPEED_RAD_PER_SEC;
      this.immersive360ManualActive = false;
      this.immersive360ManualUntil = 0;
      this.immersive360PointerDown = null;
      this.immersive360LastPointer = null;
      this.immersive360PointerDragging = false;
      this.immersive360YawVelocity = 0;
      this.lookLocked = true;

      this.onState?.({
        type: 'immersive-360',
        active: true,
        autoRotate: this.immersive360AutoRotate,
      });
      this.onState?.({ type: 'look-lock', locked: true });
      this._syncCamera();
      return true;
    }

    this.immersive360Active = false;
    this.immersive360ManualActive = false;
    this.immersive360ManualUntil = 0;
    this.immersive360PointerDown = null;
    this.immersive360LastPointer = null;
    this.immersive360PointerDragging = false;
    this.immersive360YawVelocity = 0;
    this.guidedManualActive = false;
    this.guidedManualYawUntil = 0;
    this.guidedYawCenter = this.currentYaw;
    this.guidedCompositionYaw = this.currentYaw;
    this.guidedCompositionTargetYaw = this.currentYaw;
    this.guidedLastCompositionAt = performance.now();
    this.guidedPanPhase = 0;

    if (this.walkMode === 'guided') {
      this.lookLocked = true;
      this.targetPitch = this.guidedPitch;
    } else {
      this.lookLocked = false;
    }

    this.onState?.({ type: 'immersive-360', active: false });
    this.onState?.({ type: 'look-lock', locked: this.lookLocked });
    return false;
  },

  resetImmersive360View() {
    if (!this.immersive360Active) return false;
    const best = this._findBestGuidedComposition?.(
      this.position,
      this.lastMoveDirection,
      this.currentYaw,
    );
    const yaw = Number.isFinite(best?.yaw) ? best.yaw : this.currentYaw;
    this.currentYaw = yaw;
    this.targetYaw = yaw;
    this.guidedCompositionYaw = yaw;
    this.guidedCompositionTargetYaw = yaw;
    this.guidedYawCenter = yaw;
    this.guidedPanPhase = 0;
    this.targetPitch = this.guidedPitch;
    this.currentPitch = this.guidedPitch;
    this.immersive360ManualActive = false;
    this.immersive360ManualUntil = performance.now() + 500;
    this.immersive360YawVelocity = 0;
    this._syncCamera?.();
    return true;
  },

  setImmersive360AutoRotate(value) {
    this.immersive360AutoRotate = Boolean(value);
    if (this.immersive360AutoRotate) {
      this.immersive360ManualUntil = performance.now() + 700;
    }
    this.onState?.({
      type: 'immersive-360',
      active: this.immersive360Active,
      autoRotate: this.immersive360AutoRotate,
    });
  },

  _beginImmersive360Pointer(event) {
    if (!this.immersive360Active) return false;
    if (this.smart720Active) this.cancelSmart720Tour?.('manual-look');
    const now = performance.now();
    this.immersive360PointerDown = { x: event.clientX, y: event.clientY };
    this.immersive360LastPointer = { x: event.clientX, y: event.clientY, t: now };
    this.immersive360PointerDragging = false;
    this.immersive360ManualActive = true;
    this.immersive360ManualUntil = now + IMMERSIVE_360_MANUAL_RESUME_DELAY_MS;
    this.immersive360YawVelocity = 0;
    this.renderer.domElement.setPointerCapture?.(event.pointerId);
    return true;
  },

  _moveImmersive360Pointer(event) {
    if (!this.immersive360Active || !this.immersive360PointerDown || !this.immersive360LastPointer) return false;
    const now = performance.now();
    const totalDx = event.clientX - this.immersive360PointerDown.x;
    const totalDy = event.clientY - this.immersive360PointerDown.y;
    if (Math.hypot(totalDx, totalDy) < 4) return true;

    this.immersive360PointerDragging = true;
    const dx = event.clientX - this.immersive360LastPointer.x;
    const dtMs = Math.max(8, now - this.immersive360LastPointer.t);
    this.immersive360LastPointer = { x: event.clientX, y: event.clientY, t: now };

    const yawDelta = dx * (this.lookSensitivity * 0.82);
    this.targetYaw -= yawDelta;
    this.immersive360YawVelocity = THREE.MathUtils.clamp(
      -yawDelta / (dtMs / 1000),
      -1.8,
      1.8,
    );
    this.targetPitch = this.guidedPitch;
    this.immersive360ManualUntil = now + IMMERSIVE_360_MANUAL_RESUME_DELAY_MS;
    return true;
  },

  _endImmersive360Pointer(event) {
    if (!this.immersive360Active) return false;
    const wasDragging = this.immersive360PointerDragging;
    this.immersive360PointerDown = null;
    this.immersive360LastPointer = null;
    this.immersive360PointerDragging = false;
    this.immersive360ManualActive = wasDragging;
    this.immersive360ManualUntil = performance.now() + IMMERSIVE_360_MANUAL_RESUME_DELAY_MS;
    this.renderer.domElement.releasePointerCapture?.(event.pointerId);
    return true;
  },

  _cancelImmersive360Pointer(event) {
    if (!this.immersive360Active) return false;
    const wasDragging = this.immersive360PointerDragging;
    this.immersive360PointerDown = null;
    this.immersive360LastPointer = null;
    this.immersive360PointerDragging = false;
    this.immersive360ManualActive = wasDragging;
    this.immersive360ManualUntil = performance.now() + IMMERSIVE_360_MANUAL_RESUME_DELAY_MS;
    this.renderer.domElement.releasePointerCapture?.(event.pointerId);
    return true;
  },

  _updateImmersive360(now, dt) {
    if (!this.immersive360Active) return;

    if (this.immersive360ManualActive) {
      if (this.immersive360PointerDown == null && Math.abs(this.immersive360YawVelocity) > 0.0005) {
        this.targetYaw += this.immersive360YawVelocity * dt * 0.18;
        this.immersive360YawVelocity *= Math.exp(-IMMERSIVE_360_MANUAL_VELOCITY_DAMPING * dt);
      }

      if (this.immersive360PointerDown == null && now >= this.immersive360ManualUntil) {
        this.immersive360ManualActive = false;
        this.immersive360YawVelocity = 0;
        this.immersive360ManualUntil = now + 500;
      }
    }

    if (!this.immersive360ManualActive && this.immersive360AutoRotate) {
      this.targetYaw += (this.immersive360AutoSpeedRadPerSec || IMMERSIVE_360_SPEED_RAD_PER_SEC) * dt;
    }

    this.targetPitch = this.guidedPitch;
  },
};
