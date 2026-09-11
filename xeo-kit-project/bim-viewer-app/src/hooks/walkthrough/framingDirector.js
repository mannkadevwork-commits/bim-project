import * as THREE from 'three';

const SHOT_FRAMING = {
  hero: { targetX: 0.12, targetY: 0.08, radiusBias: 1.0, minDistance: 2.7, maxDistance: 7.8 },
  reveal: { targetX: 0.06, targetY: 0.04, radiusBias: 0.95, minDistance: 2.8, maxDistance: 7.6 },
  detail: { targetX: 0.16, targetY: 0.02, radiusBias: 0.72, minDistance: 1.45, maxDistance: 4.8 },
  axis: { targetX: 0.04, targetY: 0.05, radiusBias: 0.92, minDistance: 3.0, maxDistance: 8.5 },
  transition: { targetX: 0.0, targetY: 0.03, radiusBias: 0.9, minDistance: 2.6, maxDistance: 7.5 },
};

const clamp01 = (v) => THREE.MathUtils.clamp(v, 0, 1);

export const framingDirectorMethods = {
  _chooseGuidedFrame(referencePosition = this.position, subject = this.guidedShotSubject, fallbackYaw = this.currentYaw) {
    const shot = SHOT_FRAMING[this.guidedShotType] || SHOT_FRAMING.hero;
    const unit = Math.max(this.metersPerUnit, 1e-6);
    const eye = new THREE.Vector3(
      referencePosition.x,
      referencePosition.y + this.eyeHeight * unit + this.heightOffset * unit,
      referencePosition.z,
    );

    if (!subject?.center) {
      return {
        yaw: Number.isFinite(fallbackYaw) ? fallbackYaw : 0,
        pitch: this.guidedPitch,
        quality: 0,
        targetOffsetX: 0,
        targetOffsetY: 0,
      };
    }

    const subjectToCamera = subject.center.clone().sub(referencePosition);
    subjectToCamera.y = 0;
    const distance = subjectToCamera.length();
    if (!Number.isFinite(distance) || distance < 0.25 * unit) {
      return { yaw: fallbackYaw, pitch: this.guidedPitch, quality: 0, targetOffsetX: 0, targetOffsetY: 0 };
    }

    const bearing = Math.atan2(-subjectToCamera.x, -subjectToCamera.z);
    const fovHalf = THREE.MathUtils.degToRad(this.fov * 0.5);
    const horizontalOffset = Math.atan(shot.targetX * Math.tan(fovHalf));
    const candidateYaws = [
      bearing - horizontalOffset,
      bearing,
      bearing + horizontalOffset,
    ];

    const subjectHeight = Math.max(subject.size?.y || subject.radius * 2, 0.25 * unit);
    const subjectCenterY = subject.center.y;
    const desiredEyeTargetY = subjectCenterY + shot.targetY * subjectHeight;
    const verticalAngle = Math.atan2(desiredEyeTargetY - eye.y, Math.max(distance, 0.25 * unit));
    const targetPitch = THREE.MathUtils.clamp(-verticalAngle, -0.22, 0.16);

    let best = null;
    for (const yaw of candidateYaws) {
      const composition = this._evaluateGuidedFrameCandidate(referencePosition, subject, yaw, eye, unit, shot);
      if (!best || composition.score > best.score) best = { ...composition, yaw };
    }

    return {
      yaw: best?.yaw ?? bearing,
      pitch: targetPitch,
      quality: best?.score ?? 0,
      targetOffsetX: shot.targetX,
      targetOffsetY: shot.targetY,
    };
  },

  _evaluateGuidedFrameCandidate(referencePosition, subject, yaw, eye, unit, shot) {
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const toSubject = subject.center.clone().sub(referencePosition);
    toSubject.y = 0;
    const distance = toSubject.length();
    if (!(distance > 0)) return { score: -Infinity };
    toSubject.normalize();

    const angle = Math.acos(THREE.MathUtils.clamp(forward.dot(toSubject), -1, 1));
    const centered = clamp01(1 - angle / THREE.MathUtils.degToRad(42));
    const distanceMeters = distance / unit;
    const idealDistance = THREE.MathUtils.clamp(
      (shot.minDistance + shot.maxDistance) * 0.5,
      1.2,
      8.0,
    );
    const distanceQuality = clamp01(1 - Math.abs(distanceMeters - idealDistance) / Math.max(idealDistance, 1));
    const sizeFit = clamp01(
      (shot.radiusBias * 2.5 * unit - subject.radius) / Math.max(shot.radiusBias * 2.5 * unit, 1e-6) + 0.35,
    );

    // Negative space: reward useful content on the opposite side of the frame,
    // while strongly penalizing a second large subject directly behind/over the hero.
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    let secondaryScore = 0;
    let obstructionPenalty = 0;
    for (const candidate of this.presentationSubjects) {
      if (!candidate?.object?.visible || candidate.object === subject.object) continue;
      const delta = candidate.center.clone().sub(referencePosition);
      delta.y = 0;
      const d = delta.length();
      if (!(d > 0.7 * unit && d <= 8.5 * unit)) continue;
      const direction = delta.normalize();
      const angleToFrame = Math.acos(THREE.MathUtils.clamp(forward.dot(direction), -1, 1));
      if (angleToFrame > THREE.MathUtils.degToRad(78)) continue;
      const lateral = right.dot(direction);
      const weight = candidate.hierarchy === 'primary' ? 1.0 : candidate.hierarchy === 'secondary' ? 0.6 : 0.25;
      const proximity = clamp01(1 - d / (8.5 * unit));
      if (lateral < -0.12) secondaryScore += weight * (0.35 + proximity * 0.65);
      if (Math.abs(lateral) < 0.08 && angleToFrame < THREE.MathUtils.degToRad(16)) {
        obstructionPenalty += weight * clamp01(1 - d / (5.5 * unit));
      }
    }

    const wallSafety = this._headingWallGuardScore(referencePosition, yaw);
    const wallPenalty = wallSafety < -this.guidedWallDominancePenalty
      ? 1.5
      : wallSafety < 0 ? 0.35 : 0;
    const blankWallPenalty = Math.max(0, -this._visualSubjectScore(referencePosition, yaw)) * 0.12;
    const framingScore = centered * 2.6 + distanceQuality * 1.2 + sizeFit * 1.1
      + secondaryScore * 0.75 - obstructionPenalty * 1.1 - wallPenalty - blankWallPenalty;

    return { score: framingScore };
  },

  _guidedFramePitchForSubject(referencePosition = this.position, subject = this.guidedShotSubject) {
    return this._chooseGuidedFrame(referencePosition, subject, this.currentYaw).pitch;
  },
};
