const SMART_720_SWEEP_DURATION_MS = 11800;
const SMART_720_AUTO_SPEED_RAD_PER_SEC = (Math.PI * 2) / (SMART_720_SWEEP_DURATION_MS / 1000);
const SMART_720_TRAVEL_SETTLE_MS = 750;

export const smart720TourDirectorMethods = {
  _resetSmart720TourState() {
    this.smart720Active = false;
    this.smart720Phase = 'idle';
    this.smart720VisitedAreas = new Set();
    this.smart720StopIndex = 0;
    this.smart720TotalStops = 0;
    this.smart720CurrentLabel = null;
    this.smart720CurrentAreaId = null;
    this.smart720SweepStartedAt = 0;
    this.smart720NextTravelAt = 0;
    this.smart720OfferAvailable = false;
    this.smart720ProgrammaticTravel = false;
  },

  _isSmart720PrimaryDestination(hotspot) {
    if (!hotspot?.id) return false;
    const destination = this._getDestinationPresentation?.(hotspot.id);
    if (destination?.destinationKind === 'primary') return true;
    return this._getHotspotRole(hotspot) === 'room-center';
  },

  _countSmart720Areas() {
    const areas = new Set();
    for (const hotspot of this.hotspots || []) {
      if (!hotspot?.areaId || !this._isCustomerFacingDestination?.(hotspot)) continue;
      areas.add(hotspot.areaId);
    }
    return areas.size;
  },

  _updateSmart720Offer() {
    const available = Boolean(
      this.viewMode === 'walk' &&
      this.walkMode === 'guided' &&
      !this.smart720Active &&
      !this.immersive360Active &&
      !this.path &&
      !this.directTravel &&
      this.guidedTourArmed &&
      this.activeHotspotId &&
      performance.now() >= this.arrivalSettleUntil &&
      this._countSmart720Areas() >= 2,
    );
    if (available === this.smart720OfferAvailable) return;
    this.smart720OfferAvailable = available;
    this.onState?.({ type: 'smart-720-offer', available });
  },

  _findSmart720Destination() {
    if (!this.query || !this.hotspots?.length) return null;

    const current = this.hotspots.find((hotspot) => hotspot?.id === this.activeHotspotId);
    const candidates = [];
    const unvisitedAreas = new Set();

    for (const hotspot of this.hotspots) {
      if (!hotspot?.id || !hotspot.areaId || !Array.isArray(hotspot.position)) continue;
      if (this.smart720VisitedAreas.has(hotspot.areaId)) continue;
      if (!this._isCustomerFacingDestination?.(hotspot)) continue;
      if (!this._hasCameraClearance(hotspot.position)) continue;
      unvisitedAreas.add(hotspot.areaId);

      const point = this._closestWalkPoint(hotspot.position, 0.45);
      if (!point) continue;
      const result = this.query.computePath(
        { x: this.position.x, y: this.position.y, z: this.position.z },
        point,
        { filter: this.filter, maxStraightPathSize: 256, maxPathSize: 256 },
      );
      if (!result?.success || !result.path?.length) continue;

      let pathLength = 0;
      let previous = this.position;
      for (const p of result.path) {
        pathLength += Math.hypot(p.x - previous.x, p.z - previous.z);
        previous = p;
      }
      const distanceMeters = pathLength / Math.max(this.metersPerUnit, 1e-6);
      if (!Number.isFinite(distanceMeters) || distanceMeters < 0.7 || distanceMeters > 20) continue;

      const isPrimary = this._isSmart720PrimaryDestination(hotspot);
      const displayOrder = Number(hotspot.displayOrder) || 999;
      let score = isPrimary ? 7 : 2.4;
      score -= Math.min(distanceMeters, 16) * 0.12;
      score -= Math.min(displayOrder, 50) * 0.002;
      if (current?.areaId && hotspot.areaId !== current.areaId) score += 1.2;
      candidates.push({ hotspot, point, score, distanceMeters, isPrimary });
    }

    candidates.sort((a, b) => b.score - a.score || a.distanceMeters - b.distanceMeters);
    const bestPrimary = candidates.find((candidate) => candidate.isPrimary);
    return bestPrimary || candidates[0] || null;
  },

  _smart720DestinationLabel(hotspot) {
    return this._getDestinationPresentation?.(hotspot?.id)?.presentationLabel
      || hotspot?.areaLabel
      || hotspot?.label
      || 'Next room';
  },

  _beginSmart720Presentation(now = performance.now()) {
    if (!this.smart720Active || this.smart720Phase !== 'presentation') return false;
    const destination = this.hotspots.find((hotspot) => hotspot?.id === this.activeHotspotId);
    if (!destination) return false;

    this.smart720SweepStartedAt = now;
    this.smart720CurrentLabel = this._smart720DestinationLabel(destination);
    this.smart720CurrentAreaId = destination.areaId || null;
    this.onState?.({
      type: 'smart-720-tour',
      active: true,
      phase: 'presentation',
      stopIndex: this.smart720StopIndex,
      totalStops: this.smart720TotalStops,
      label: this.smart720CurrentLabel,
      areaId: this.smart720CurrentAreaId,
    });

    const entered = this.enterImmersivePresentation?.({
      autoRotate: true,
      preserveGuidedTour: true,
      autoSpeed: SMART_720_AUTO_SPEED_RAD_PER_SEC,
      smartTour: true,
      presentationDurationMs: SMART_720_SWEEP_DURATION_MS,
    });
    if (!entered) {
      this.cancelSmart720Tour('presentation-failed');
      return false;
    }
    return true;
  },

  startSmart720Tour() {
    if (
      this.viewMode !== 'walk' ||
      this.walkMode !== 'guided' ||
      this.smart720Active ||
      this.immersive360Active ||
      !this.activeHotspotId ||
      this.path ||
      this.directTravel
    ) return false;

    const current = this.hotspots.find((hotspot) => hotspot?.id === this.activeHotspotId);
    if (!current) return false;

    this.smart720Active = true;
    this.smart720Phase = 'presentation';
    this.smart720VisitedAreas = new Set();
    this.smart720StopIndex = 1;
    this.smart720TotalStops = this._countSmart720Areas();
    this.smart720CurrentLabel = this._smart720DestinationLabel(current);
    this.smart720CurrentAreaId = current.areaId || null;
    this.smart720SweepStartedAt = 0;
    this.smart720NextTravelAt = 0;
    this.smart720OfferAvailable = false;
    this.smart720ProgrammaticTravel = false;

    // Session-local traversal memory only. This is deliberately not persistent
    // room-completion state: it exists only for this 720 presentation.
    this.guidedTourArmed = true;
    this.guidedTourAdvanceLock = false;
    this.guidedTourVisitedHotspots.clear();
    this.guidedTourVisitedAreas.clear();
    this.guidedTourLastVisitedHotspotId = current.id;
    this.guidedTourLastAreaId = current.areaId || null;
    this.guidedTourLastRole = this._getHotspotRole(current);
    this.guidedTourVisitedHotspots.add(current.id);
    if (current.areaId) this.guidedTourVisitedAreas.add(current.areaId);

    this.onState?.({
      type: 'smart-720-tour',
      active: true,
      phase: 'presentation',
      stopIndex: 1,
      totalStops: this.smart720TotalStops,
      label: this.smart720CurrentLabel,
      areaId: this.smart720CurrentAreaId,
    });
    this._beginSmart720Presentation(performance.now());
    return true;
  },

  cancelSmart720Tour(reason = 'manual') {
    if (!this.smart720Active) return false;

    const wasPresenting = this.immersivePresentationActive || this.immersive360Active;
    this.smart720Active = false;
    this.smart720Phase = 'idle';
    this.smart720SweepStartedAt = 0;
    this.smart720NextTravelAt = 0;
    this.smart720ProgrammaticTravel = false;
    this.smart720OfferAvailable = false;

    if (wasPresenting) {
      this.exitImmersivePresentation?.();
    } else {
      this.setImmersive360?.(false);
    }

    this.guidedTourAdvanceLock = false;
    this.onState?.({ type: 'smart-720-tour', active: false, cancelled: true, reason });
    this.onState?.({ type: 'smart-720-offer', available: false });
    return true;
  },

  _finishSmart720Tour() {
    if (!this.smart720Active) return false;
    this.smart720Active = false;
    this.smart720Phase = 'complete';
    this.smart720ProgrammaticTravel = false;
    this.smart720OfferAvailable = false;
    this.guidedTourArmed = false;
    this.guidedTourAdvanceLock = true;
    this.exitImmersivePresentation?.();
    this.onState?.({
      type: 'smart-720-tour',
      active: false,
      completed: true,
      stopIndex: this.smart720StopIndex,
      totalStops: this.smart720TotalStops,
    });
    this._startGuidedHeroEnding?.(this.position);
    return true;
  },

  _startSmart720NextTravel(now = performance.now()) {
    const next = this._findSmart720Destination();
    if (!next) return this._finishSmart720Tour();

    this.smart720StopIndex += 1;
    this.smart720CurrentLabel = this._smart720DestinationLabel(next.hotspot);
    this.smart720CurrentAreaId = next.hotspot.areaId || null;
    this.smart720Phase = 'traveling';
    this.smart720ProgrammaticTravel = true;
    this.guidedTourAdvanceLock = true;
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;
    this._armGuidedTourForHotspot(next.hotspot);
    // Keep session-local room memory in the Smart 720 layer.
    if (next.hotspot.areaId) this.smart720VisitedAreas.add(next.hotspot.areaId);
    const started = this.travelTo(next.point, next.hotspot.label || 'Next room');
    this.smart720ProgrammaticTravel = false;
    if (!started) {
      this.guidedTourAdvanceLock = false;
      return this._finishSmart720Tour();
    }
    this.onState?.({
      type: 'smart-720-tour',
      active: true,
      phase: 'traveling',
      stopIndex: this.smart720StopIndex,
      totalStops: this.smart720TotalStops,
      label: this.smart720CurrentLabel,
      areaId: this.smart720CurrentAreaId,
      distanceMeters: Number(next.distanceMeters.toFixed(2)),
      at: now,
    });
    return true;
  },

  _updateSmart720Tour(now = performance.now()) {
    if (!this.smart720Active) return false;

    if (this.smart720Phase === 'presentation') {
      if (!this.immersive360Active) {
        this._beginSmart720Presentation(now);
        return true;
      }
      if (this.immersive360PointerDown || this.immersive360ManualActive) {
        this.cancelSmart720Tour('manual-look');
        return false;
      }
      if (now - this.smart720SweepStartedAt >= SMART_720_SWEEP_DURATION_MS) {
        this.exitImmersivePresentation?.();
        this.smart720Phase = 'travel-delay';
        this.smart720NextTravelAt = now + SMART_720_TRAVEL_SETTLE_MS;
        this.guidedTourAdvanceLock = false;
        return true;
      }
      return true;
    }

    if (this.smart720Phase === 'traveling') {
      if (this.path || this.directTravel) return true;
      if (now < this.arrivalSettleUntil) return true;
      this.smart720Phase = 'presentation';
      this._beginSmart720Presentation(now);
      return true;
    }

    if (this.smart720Phase === 'travel-delay') {
      if (now < this.smart720NextTravelAt || this.path || this.directTravel) return true;
      this._startSmart720NextTravel(now);
      return true;
    }

    return true;
  },
};
