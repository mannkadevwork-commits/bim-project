export const shotDirectorMethods = {
  _chooseGuidedShotType(referencePosition = this.position) {
    const active = this.hotspots.find((hotspot) => hotspot?.id === this.activeHotspotId);
    const role = this._getHotspotRole(active);
    const transition = this.guidedTransitionKind;
    const areaId = this._getGuidedPresentationAreaId();
    const unit = Math.max(this.metersPerUnit, 0.000001);

    if (transition === 'room-entry' || transition === 'room-crossing' || role === 'room-entrance') {
      return this.guidedShotHistory[0] === 'reveal' ? 'hero' : 'reveal';
    }
    if (role === 'transition') return 'transition';

    const nearby = this.presentationSubjects
      .filter((subject) => subject?.object?.visible)
      .map((subject) => {
        const dx = subject.center.x - referencePosition.x;
        const dz = subject.center.z - referencePosition.z;
        const distance = Math.hypot(dx, dz) / unit;
        const sameArea = !areaId
          || !subject.object.userData?.walkAreaId
          || subject.object.userData.walkAreaId === areaId;
        return { subject, distance, sameArea };
      })
      .filter((entry) => entry.sameArea && Number.isFinite(entry.distance) && entry.distance >= 0.45 && entry.distance <= 7.5);

    const furnitureCount = nearby.filter((entry) => entry.subject.role === 'furniture').length;
    const detailCount = nearby.filter((entry) => entry.subject.role === 'fixture' || entry.subject.role === 'decor').length;
    const openingCount = nearby.filter((entry) => entry.subject.role === 'opening').length;
    const strongDetail = nearby.find((entry) =>
      (entry.subject.role === 'fixture' || entry.subject.role === 'decor')
      && entry.distance <= 3.6
      && entry.subject.radius / unit <= 2.0,
    );

    if (strongDetail && detailCount >= 1 && furnitureCount === 0) return 'detail';
    if (role === 'viewpoint') return openingCount ? 'axis' : 'hero';
    if (role === 'room-center' && furnitureCount > 0) return 'hero';
    if (openingCount > 0 && furnitureCount === 0) return 'reveal';

    return this.guidedShotHistory[0] === 'hero' ? 'axis' : 'hero';
  },

  _recordGuidedShotType(shotType) {
    if (!shotType) return;
    this.guidedShotHistory = [shotType, ...this.guidedShotHistory.filter((item) => item !== shotType)].slice(0, 3);
  }
};
