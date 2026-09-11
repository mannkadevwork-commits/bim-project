const HERO_ENDING_SETTLE_MS = 2200;
const HERO_ENDING_HOLD_MS = 9000;

export const heroEndingDirectorMethods = {
  _resetGuidedHeroEnding() {
    this.guidedHeroEndingActive = false;
    this.guidedHeroEndingStartedAt = 0;
    this.guidedHeroEndingUntil = 0;
  },

  _startGuidedHeroEnding(referencePosition = this.position) {
    if (this.walkMode !== 'guided' || !this.query || this.guidedHeroEndingActive) return false;

    const now = performance.now();
    const current = this.hotspots.find((hotspot) => hotspot?.id === this.activeHotspotId)
      || this.hotspots.find((hotspot) => hotspot?.areaId === this.guidedTourLastAreaId);

    this.guidedHeroEndingActive = true;
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = true;
    this.guidedShotType = 'hero';
    this._recordGuidedShotType?.('hero');
    this.guidedApproachActive = false;
    this.guidedRevealActive = false;
    this.arrivalSettleUntil = 0;

    const preferredYaw = Number.isFinite(this.currentYaw) ? this.currentYaw : 0;
    const composition = this._findBestGuidedComposition?.(
      referencePosition,
      this.lastMoveDirection,
      preferredYaw,
    );
    const baseYaw = Number.isFinite(composition?.yaw) ? composition.yaw : preferredYaw;

    // Reuse the same validated subject/frame pipeline as ordinary Hero shots.
    // The ending differs only in pacing and framing persistence.
    const subject = this._chooseGuidedShotSubject?.(referencePosition, baseYaw) || null;
    this.guidedShotSubject = subject;
    this.guidedShotSubjectId = subject?.object?.uuid || null;
    const frame = this._chooseGuidedFrame?.(referencePosition, subject, baseYaw) || null;
    const targetYaw = Number.isFinite(frame?.yaw)
      ? this._angleLerp(baseYaw, frame.yaw, 0.82)
      : baseYaw;
    const targetPitch = Number.isFinite(frame?.pitch) ? frame.pitch : this.guidedPitch;

    this.guidedFrameQuality = frame?.quality || 0;
    this.guidedFrameTargetOffsetX = frame?.targetOffsetX || 0;
    this.guidedFrameTargetOffsetY = frame?.targetOffsetY || 0;
    this.guidedArrivalStartYaw = this.currentYaw;
    this.guidedArrivalTargetYaw = targetYaw;
    this.guidedArrivalStartPitch = this.currentPitch;
    this.guidedArrivalTargetPitch = targetPitch;
    this.guidedArrivalSettleStartedAt = now;
    this.guidedArrivalSettleDurationMs = HERO_ENDING_SETTLE_MS;
    this.arrivalSettleUntil = now + HERO_ENDING_SETTLE_MS;
    this.guidedShotSubjectUntil = now + HERO_ENDING_SETTLE_MS + HERO_ENDING_HOLD_MS;
    this.guidedCompositionYaw = this.currentYaw;
    this.guidedCompositionTargetYaw = targetYaw;
    this.guidedYawCenter = this.currentYaw;
    this.targetYaw = this.currentYaw;
    this.targetPitch = this.currentPitch;
    this.guidedPanPhase = 0;
    this.guidedLastCompositionAt = now;
    this.guidedHeroEndingStartedAt = now;
    this.guidedHeroEndingUntil = now + HERO_ENDING_SETTLE_MS + HERO_ENDING_HOLD_MS;

    this.onState?.({
      type: 'hero-ending',
      active: true,
      hotspotId: current?.id || this.activeHotspotId || null,
      areaId: current?.areaId || this.guidedTourLastAreaId || null,
      durationMs: HERO_ENDING_SETTLE_MS + HERO_ENDING_HOLD_MS,
    });
    return true;
  },

  _updateGuidedHeroEnding(now = performance.now()) {
    if (!this.guidedHeroEndingActive) return false;
    if (this.guidedManualActive || this.guidedPointerDown) {
      this._resetGuidedHeroEnding();
      this.guidedTourAdvanceLock = false;
      this.onState?.({ type: 'hero-ending', active: false, interrupted: true });
      return false;
    }

    if (now >= this.guidedHeroEndingUntil) {
      this._resetGuidedHeroEnding();
      this.guidedTourAdvanceLock = false;
      this.onState?.({ type: 'hero-ending', active: false });
      this.onState?.({ type: 'tour-complete' });
      return false;
    }
    return true;
  },
};
