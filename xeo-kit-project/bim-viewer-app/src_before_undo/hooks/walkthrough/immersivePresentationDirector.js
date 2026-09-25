const PRESENTATION_ENTRY_LOCK_MS = 650;

export const immersivePresentationDirectorMethods = {
  _resetImmersivePresentationState() {
    this.immersivePresentationActive = false;
    this.immersivePresentationLabel = null;
    this.immersivePresentationKind = null;
    this.immersivePresentationStartedAt = 0;
  },

  _findImmersivePresentationDestination() {
    const current = this._getDestinationPresentation?.(this.activeHotspotId);
    if (current && current.destinationKind !== 'internal') return current;

    const destinations = this._getCustomerFacingDestinations?.() || [];
    if (!destinations.length || !this.position) return null;

    let best = null;
    for (const destination of destinations) {
      const x = Number(destination.position?.[0]);
      const z = Number(destination.position?.[2]);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const distance = Math.hypot(x - this.position.x, z - this.position.z);
      const kindBonus = destination.destinationKind === 'primary' ? 0.45 : 0.0;
      const score = distance - kindBonus;
      if (!best || score < best.score) best = { destination, score };
    }
    return best?.destination || null;
  },

  enterImmersivePresentation(options = {}) {
    if (this.viewMode !== 'walk') return false;
    if (this.immersivePresentationActive && this.immersive360Active) return true;

    const destination = this._findImmersivePresentationDestination();
    const started = this.setImmersive360(true, {
      autoRotate: options.autoRotate === undefined ? true : Boolean(options.autoRotate),
      preserveGuidedTour: Boolean(options.preserveGuidedTour),
      autoSpeed: options.autoSpeed,
    });
    if (!started) return false;

    const kind = options.smartTour ? 'smart-720' : (destination?.destinationKind || null);
    const label = destination?.presentationLabel
      || destination?.areaLabel
      || destination?.label
      || 'Architectural view';

    this.immersivePresentationActive = true;
    this.immersivePresentationLabel = label;
    this.immersivePresentationKind = kind;
    this.immersivePresentationStartedAt = performance.now();

    // Give the viewer a short, quiet entry lock so the 360 composition settles
    // before the presentation controls become visually dominant.
    this.lookLocked = true;
    this.onState?.({ type: 'look-lock', locked: true });
    this.onState?.({
      type: 'immersive-presentation',
      active: true,
      label,
      kind,
      entryLockMs: PRESENTATION_ENTRY_LOCK_MS,
      autoRotate: this.immersive360AutoRotate,
    });
    this._emitImmersiveSceneState?.();
    return true;
  },

  exitImmersivePresentation() {
    const wasActive = this.immersivePresentationActive || this.immersive360Active;
    this._resetImmersivePresentationState();
    if (this.immersive360Active) this.setImmersive360(false);
    if (wasActive) {
      this.onState?.({ type: 'immersive-presentation', active: false });
    }
    return wasActive;
  },

  resetImmersivePresentationView() {
    if (!this.immersive360Active) return false;
    const ok = this.resetImmersive360View?.();
    if (ok) {
      this.immersivePresentationStartedAt = performance.now();
      this.onState?.({
        type: 'immersive-presentation',
        active: true,
        label: this.immersivePresentationLabel,
        kind: this.immersivePresentationKind,
        reset: true,
      });
    }
    return Boolean(ok);
  },
};
