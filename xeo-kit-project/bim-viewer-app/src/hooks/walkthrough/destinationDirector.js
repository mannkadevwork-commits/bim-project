const PRESENTATION_KIND = Object.freeze({
  PRIMARY: 'primary',
  OPTIONAL: 'optional',
  INTERNAL: 'internal',
});

const ROLE_PRIORITY = Object.freeze({
  'room-center': 0,
  viewpoint: 1,
  'room-entrance': 2,
  transition: 3,
  walkpoint: 4,
});

export const destinationDirectorMethods = {
  _buildDestinationPresentation(hotspots = this.hotspots || []) {
    const byArea = new Map();
    const records = hotspots
      .filter((hotspot) => hotspot?.id && Array.isArray(hotspot.position))
      .map((hotspot) => {
        const role = this._getHotspotRole(hotspot);
        const areaId = hotspot.areaId || null;
        let kind = PRESENTATION_KIND.INTERNAL;
        if (role === 'room-center') kind = PRESENTATION_KIND.PRIMARY;
        else if (role === 'viewpoint') kind = PRESENTATION_KIND.OPTIONAL;

        const record = {
          ...hotspot,
          destinationKind: kind,
          presentationRole: role,
          presentationLabel: this._destinationPresentationLabel(hotspot, role, kind),
          presentationPriority: ROLE_PRIORITY[role] ?? 9,
          showInMap: kind !== PRESENTATION_KIND.INTERNAL,
          showInScene: kind !== PRESENTATION_KIND.INTERNAL,
          showInGuidedTour: kind !== PRESENTATION_KIND.INTERNAL,
          allowDirectNavigation: true,
        };
        if (areaId) {
          if (!byArea.has(areaId)) byArea.set(areaId, []);
          byArea.get(areaId).push(record);
        }
        return record;
      });

    // Legacy jobs may lack room-center records. Promote one stable non-internal
    // destination per semantic area so the customer still gets a room-level stop.
    for (const areaRecords of byArea.values()) {
      if (areaRecords.some((record) => record.destinationKind === PRESENTATION_KIND.PRIMARY)) continue;
      const fallback = [...areaRecords]
        .filter((record) => record.presentationRole !== 'transition' && record.presentationRole !== 'walkpoint')
        .sort((a, b) => this._compareDestinationRecords(a, b))[0];
      if (!fallback) continue;
      fallback.destinationKind = PRESENTATION_KIND.PRIMARY;
      fallback.showInMap = true;
      fallback.showInScene = true;
      fallback.showInGuidedTour = true;
      fallback.presentationLabel = this._destinationPresentationLabel(
        fallback,
        fallback.presentationRole,
        PRESENTATION_KIND.PRIMARY,
      );
    }

    const primary = records
      .filter((record) => record.destinationKind === PRESENTATION_KIND.PRIMARY)
      .sort((a, b) => this._compareDestinationRecords(a, b));
    const optional = records
      .filter((record) => record.destinationKind === PRESENTATION_KIND.OPTIONAL)
      .sort((a, b) => this._compareDestinationRecords(a, b));
    const internal = records
      .filter((record) => record.destinationKind === PRESENTATION_KIND.INTERNAL)
      .sort((a, b) => this._compareDestinationRecords(a, b));

    this.destinationPresentation = {
      version: 1,
      primary,
      optional,
      internal,
      presentationHotspots: [...primary, ...optional],
      byId: new Map(records.map((record) => [record.id, record])),
    };

    return this.destinationPresentation;
  },

  _destinationPresentationLabel(hotspot, role, kind) {
    const areaLabel = hotspot?.areaLabel || '';
    if (kind === PRESENTATION_KIND.PRIMARY) return areaLabel || hotspot?.label || 'Room';
    if (kind === PRESENTATION_KIND.OPTIONAL) {
      return areaLabel ? `${areaLabel} · View` : hotspot?.label || 'Viewpoint';
    }
    if (role === 'room-entrance') return areaLabel ? `${areaLabel} · Entrance` : 'Room entrance';
    return hotspot?.label || 'Navigation point';
  },

  _compareDestinationRecords(a, b) {
    const orderA = Number.isFinite(Number(a?.displayOrder)) ? Number(a.displayOrder) : 9999;
    const orderB = Number.isFinite(Number(b?.displayOrder)) ? Number(b.displayOrder) : 9999;
    return orderA - orderB
      || (Number(b?.score) || 0) - (Number(a?.score) || 0)
      || String(a?.id || '').localeCompare(String(b?.id || ''));
  },

  _getDestinationPresentation(hotspotOrId) {
    const id = typeof hotspotOrId === 'string' ? hotspotOrId : hotspotOrId?.id;
    return id ? this.destinationPresentation?.byId?.get(id) || null : null;
  },

  _getDestinationKind(hotspotOrId) {
    return this._getDestinationPresentation(hotspotOrId)?.destinationKind
      || (typeof hotspotOrId === 'object' ? hotspotOrId?.destinationKind : null)
      || PRESENTATION_KIND.INTERNAL;
  },

  _isCustomerFacingDestination(hotspotOrId) {
    return this._getDestinationKind(hotspotOrId) !== PRESENTATION_KIND.INTERNAL;
  },

  _getCustomerFacingDestinations() {
    return this.destinationPresentation?.presentationHotspots || [];
  },
};
