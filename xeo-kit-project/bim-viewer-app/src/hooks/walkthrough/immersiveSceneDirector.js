const SCENE_ENTRY_SETTLE_GRACE_MS = 120;

export const immersiveSceneDirectorMethods = {
  _resetImmersiveSceneState() {
    this.immersiveSceneIndex = 0;
    this.immersiveSceneTotal = 0;
    this.immersiveSceneLabel = null;
    this.immersiveSceneCanPrev = false;
    this.immersiveSceneCanNext = false;
    this.immersiveSceneSwitching = false;
    this.immersiveScenePendingId = null;
    this.immersiveScenePendingIndex = -1;
  },

  _getImmersiveSceneDestinations() {
    const customerFacing = this._getCustomerFacingDestinations?.() || [];
    return customerFacing
      .filter((destination) => Array.isArray(destination?.position) && destination?.id)
      .slice()
      .sort((a, b) => {
        const orderA = Number.isFinite(Number(a.displayOrder)) ? Number(a.displayOrder) : 9999;
        const orderB = Number.isFinite(Number(b.displayOrder)) ? Number(b.displayOrder) : 9999;
        if (orderA !== orderB) return orderA - orderB;
        return String(a.areaId || '').localeCompare(String(b.areaId || ''));
      });
  },

  _getImmersiveSceneIndexForCurrent(destinations = this._getImmersiveSceneDestinations()) {
    if (!destinations.length) return -1;
    const activeIndex = destinations.findIndex((destination) => destination.id === this.activeHotspotId);
    if (activeIndex >= 0) return activeIndex;

    if (!this.position) return 0;
    let bestIndex = 0;
    let bestDistance = Infinity;
    destinations.forEach((destination, index) => {
      const x = Number(destination.position?.[0]);
      const z = Number(destination.position?.[2]);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      const distance = Math.hypot(x - this.position.x, z - this.position.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  },

  _immersiveSceneLabel(destination) {
    return this._getDestinationPresentation?.(destination?.id)?.presentationLabel
      || destination?.areaLabel
      || destination?.label
      || 'Presentation scene';
  },

  _emitImmersiveSceneState(options = {}) {
    const destinations = this._getImmersiveSceneDestinations();
    const fallbackIndex = this._getImmersiveSceneIndexForCurrent(destinations);
    const index = this.immersiveScenePendingIndex >= 0
      ? this.immersiveScenePendingIndex
      : Math.max(0, fallbackIndex);
    const destination = destinations[index] || destinations[fallbackIndex] || null;

    this.immersiveSceneIndex = destinations.length ? index + 1 : 0;
    this.immersiveSceneTotal = destinations.length;
    this.immersiveSceneLabel = destination ? this._immersiveSceneLabel(destination) : null;
    this.immersiveSceneCanPrev = index > 0;
    this.immersiveSceneCanNext = index >= 0 && index < destinations.length - 1;
    this.immersiveSceneSwitching = Boolean(options.switching ?? this.immersiveSceneSwitching);

    this.onState?.({
      type: 'immersive-scene',
      index: this.immersiveSceneIndex,
      total: this.immersiveSceneTotal,
      label: this.immersiveSceneLabel,
      canPrev: this.immersiveSceneCanPrev,
      canNext: this.immersiveSceneCanNext,
      switching: this.immersiveSceneSwitching,
      targetId: this.immersiveScenePendingId,
    });
  },

  _clearImmersiveSceneSwitch(reason = 'cancelled') {
    const wasSwitching = this.immersiveSceneSwitching || this.immersiveScenePendingId;
    this.immersiveSceneSwitching = false;
    this.immersiveScenePendingId = null;
    this.immersiveScenePendingIndex = -1;
    if (wasSwitching) {
      this.onState?.({ type: 'immersive-scene', switching: false, reason });
    }
    return Boolean(wasSwitching);
  },

  switchImmersiveScene(direction = 1) {
    if (
      !this.immersivePresentationActive ||
      !this.immersive360Active ||
      this.smart720Active ||
      this.viewMode !== 'walk' ||
      this.walkMode !== 'guided'
    ) return false;

    const step = Number(direction) < 0 ? -1 : 1;
    const destinations = this._getImmersiveSceneDestinations();
    if (destinations.length < 2) return false;

    const currentIndex = this._getImmersiveSceneIndexForCurrent(destinations);
    const nextIndex = currentIndex + step;
    const nextDestination = destinations[nextIndex];
    if (!nextDestination || nextIndex < 0 || nextIndex >= destinations.length) return false;

    this.immersiveScenePendingId = nextDestination.id;
    this.immersiveScenePendingIndex = nextIndex;
    this.immersiveSceneSwitching = true;
    this.guidedTourAdvanceLock = true;

    const targetLabel = this._immersiveSceneLabel(nextDestination);
    this.onState?.({
      type: 'immersive-scene',
      index: nextIndex + 1,
      total: destinations.length,
      label: targetLabel,
      canPrev: nextIndex > 0,
      canNext: nextIndex < destinations.length - 1,
      switching: true,
      targetId: nextDestination.id,
      phase: 'traveling',
    });

    this.exitImmersivePresentation?.();
    const started = this.navigateToHotspot(nextDestination, { preserveImmersiveScene: true });
    if (started && typeof started.then === 'function') {
      started.then((ok) => {
        if (!ok) this._clearImmersiveSceneSwitch('destination-unavailable');
      }).catch(() => this._clearImmersiveSceneSwitch('destination-error'));
    } else if (!started) {
      this._clearImmersiveSceneSwitch('destination-unavailable');
    }

    return true;
  },

  _updateImmersiveSceneSwitch(now = performance.now()) {
    if (!this.immersiveSceneSwitching || !this.immersiveScenePendingId) return false;
    if (this.smart720Active) {
      this._clearImmersiveSceneSwitch('smart-720');
      return false;
    }
    if (this.path || this.directTravel) return true;
    if (this.activeHotspotId !== this.immersiveScenePendingId) return true;
    if (now < this.arrivalSettleUntil + SCENE_ENTRY_SETTLE_GRACE_MS) return true;

    const targetId = this.immersiveScenePendingId;
    const targetIndex = this.immersiveScenePendingIndex;
    this.immersiveSceneSwitching = false;
    this.immersiveScenePendingId = null;
    this.immersiveScenePendingIndex = -1;
    this.guidedTourAdvanceLock = false;

    const entered = this.enterImmersivePresentation?.({
      autoRotate: true,
      preserveGuidedTour: true,
    });
    if (!entered) {
      this.onState?.({
        type: 'immersive-scene',
        index: targetIndex + 1,
        total: this._getImmersiveSceneDestinations().length,
        label: this.activeHotspotId || targetId,
        switching: false,
        phase: 'arrived',
      });
      return false;
    }

    this.onState?.({
      type: 'immersive-scene',
      index: targetIndex + 1,
      total: this._getImmersiveSceneDestinations().length,
      label: this.immersivePresentationLabel,
      canPrev: targetIndex > 0,
      canNext: targetIndex < this._getImmersiveSceneDestinations().length - 1,
      switching: false,
      phase: 'presenting',
      targetId,
    });
    return true;
  },
};
