import * as THREE from 'three';

export const subjectDirectorMethods = {
  _buildPresentationSubjectIndex() {
    this.presentationSubjects = [];
    // Phase 13: lock the Guided presentation onto one meaningful visual subject
    // during the arrival shot so the camera behaves like a deliberate architectural
    // composition instead of continually re-solving the frame.
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;
    if (!this.model) return;

    const classifyByName = (name = '') => {
      const lower = String(name).toLowerCase();
      if (/(sofa|couch|chair|table|desk|bed|cabinet|wardrobe|shelf|shelving|counter|stool|bench|tv|television|coffee)/.test(lower)) return 'furniture';
      if (/(sink|toilet|bathtub|bath|shower|basin|hob|oven|fridge|refrigerator|appliance)/.test(lower)) return 'fixture';
      if (/(window|glazing|glass|door|sliding|opening)/.test(lower)) return 'opening';
      if (/(light|lamp|ceiling|pendant|fan|chandelier)/.test(lower)) return 'lighting';
      if (/(plant|decor|art|painting|mirror|rug|carpet|curtain)/.test(lower)) return 'decor';
      if (/(wall|floor|slab|ceiling|roof|column|beam|structural)/.test(lower)) return null;
      return 'object';
    };

    const inferGenericRole = (size, box) => {
      const unit = Math.max(this.metersPerUnit, 1e-6);
      const sx = size.x / unit;
      const sy = size.y / unit;
      const sz = size.z / unit;
      const footprintLong = Math.max(sx, sz);
      const footprintShort = Math.min(sx, sz);
      const centerY = box.getCenter(new THREE.Vector3()).y / unit;
      const baseY = box.min.y / unit;

      // Generic IFC/GLB node names can lose semantic labels during compilation.
      // Recover only high-confidence presentation roles from geometry; the physical
      // navigation system never consumes these inferred labels.
      // First reject obvious architectural envelope pieces so walls/floors cannot
      // win a subject contest merely because they have enormous bounding volumes.
      const looksLikeFloorOrSlab = sy <= 0.28 && footprintLong >= 2.5 && footprintShort >= 0.7;
      const looksLikeWallOrPartition = sy >= 1.7 && footprintShort <= 0.28 && footprintLong >= 1.4;
      const looksLikeTallArchitecturalStrip = sy >= 2.4 && footprintShort <= 0.18 && footprintLong >= 2.0;
      if (looksLikeFloorOrSlab || looksLikeWallOrPartition || looksLikeTallArchitecturalStrip) return null;

      // Door/window frames and similar thin architectural openings can be present
      // even when the compiler has flattened their semantic names to Geom_*.
      const looksLikeOpeningFrame = (
        footprintShort <= 0.16
        && footprintLong <= 4.2
        && sy >= 0.8
        && sy <= 2.6
        && baseY <= 0.2
      );
      const looksLikeOpening = (
        footprintShort <= 0.32
        && footprintLong <= 2.8
        && sy >= 0.45
        && sy <= 2.8
        && centerY >= 0.65
      );
      if (looksLikeOpeningFrame || looksLikeOpening) return 'opening';

      const looksLikeFurniture = (sy >= 0.28 && sy <= 1.35 && footprintLong >= 0.45 && footprintLong <= 4.5 && baseY <= 0.35);
      if (looksLikeFurniture) return 'furniture';

      const looksLikeLighting = (baseY >= 1.7 && sy <= 1.2 && footprintLong <= 2.2);
      if (looksLikeLighting) return 'lighting';

      return 'object';
    };

    const hierarchyFor = (role, size, box) => {
      const unit = Math.max(this.metersPerUnit, 1e-6);
      const volume = (size.x * size.y * size.z) / Math.pow(unit, 3);
      const maxDim = Math.max(size.x, size.y, size.z) / unit;
      const footprint = (size.x * size.z) / Math.pow(unit, 2);
      const centerY = box.getCenter(new THREE.Vector3()).y / unit;

      // Subject hierarchy is presentation-only. Primary subjects are things a
      // designer would plausibly feature in a room shot; secondary subjects support
      // the frame; background objects should never displace a strong primary.
      if (role === 'furniture') {
        if (maxDim >= 2.4 || footprint >= 2.2 || volume >= 1.6) return 'primary';
        return 'secondary';
      }
      if (role === 'fixture') return volume >= 0.08 ? 'primary' : 'secondary';
      if (role === 'opening') return maxDim >= 1.4 ? 'primary' : 'secondary';
      if (role === 'lighting') return centerY >= 2.0 && maxDim >= 0.25 ? 'secondary' : 'background';
      if (role === 'decor') return maxDim >= 0.35 ? 'secondary' : 'background';
      if (role === 'object') {
        if (footprint >= 2.5 && maxDim <= 2.0) return 'primary';
        if (maxDim >= 0.45) return 'secondary';
      }
      return 'background';
    };

    const hierarchyWeight = { primary: 1.0, secondary: 0.62, background: 0.26 };
    const rolePriority = { furniture: 5, fixture: 4.5, opening: 3.7, decor: 3.2, lighting: 2.8, object: 2.5 };

    this.model.traverse((obj) => {
      if (!obj.isMesh || !obj.visible) return;
      const name = obj.name || obj.parent?.name || '';
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(maxDim) || maxDim < 0.08) return;

      const namedRole = classifyByName(name);
      // A known architectural/structural name is an explicit exclusion. Do not
      // feed those meshes back through geometric inference or walls/floors could
      // become presentation subjects again.
      if (namedRole === null && /(wall|floor|slab|ceiling|roof|column|beam|structural)/i.test(String(name))) return;
      const role = namedRole || inferGenericRole(size, box);
      if (!role) return;

      const center = box.getCenter(new THREE.Vector3());
      const hierarchy = hierarchyFor(role, size, box);
      const importance = (rolePriority[role] || 2.5) * hierarchyWeight[hierarchy];
      this.presentationSubjects.push({
        object: obj,
        role,
        hierarchy,
        importance,
        center,
        size,
        radius: Math.max(maxDim * 0.5, 0.12 * Math.max(this.metersPerUnit, 1e-6)),
      });
    });

    // Strong subjects rise first, but keep enough secondary context for composition.
    // Background objects remain available as a last-resort architectural texture.
    this.presentationSubjects.sort((a, b) => {
      const scoreA = a.importance * a.radius;
      const scoreB = b.importance * b.radius;
      return scoreB - scoreA;
    });
    if (this.presentationSubjects.length > 80) this.presentationSubjects.length = 80;
  },

  _chooseGuidedShotSubject(referencePosition = this.position, candidateYaw = this.currentYaw) {
    if (!this.presentationSubjects.length) return null;
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const areaId = this._getGuidedPresentationAreaId();
    const eye = new THREE.Vector3(
      referencePosition.x,
      referencePosition.y + this.eyeHeight * unit + this.heightOffset * unit,
      referencePosition.z,
    );
    const forward = new THREE.Vector3(-Math.sin(candidateYaw), 0, -Math.cos(candidateYaw));
    const maxDistance = this.guidedShotType === 'detail' ? 5.2 * unit : 8.5 * unit;
    const avoidId = this.guidedShotSubjectId;
    const roleWeightByShot = {
      hero: { furniture: 5.0, fixture: 3.9, opening: 3.6, decor: 3.0, lighting: 2.5, object: 2.1 },
      reveal: { opening: 6.0, furniture: 4.4, fixture: 3.6, decor: 3.0, lighting: 2.4, object: 2.0 },
      detail: { fixture: 6.2, decor: 5.7, furniture: 4.0, lighting: 3.3, opening: 2.7, object: 2.3 },
      axis: { opening: 5.1, furniture: 4.7, fixture: 3.6, decor: 2.8, lighting: 2.5, object: 2.2 },
      transition: { opening: 4.0, furniture: 3.5, fixture: 2.8, decor: 2.4, lighting: 2.1, object: 1.8 },
    };
    const priority = roleWeightByShot[this.guidedShotType] || roleWeightByShot.hero;
    const candidates = [];

    for (const subject of this.presentationSubjects) {
      if (!subject?.object || !subject.object.visible) continue;
      if (avoidId && subject.object.uuid === avoidId) continue;

      const to = subject.center.clone().sub(referencePosition);
      to.y = 0;
      const distance = to.length();
      if (!Number.isFinite(distance) || distance < 0.55 * unit || distance > maxDistance) continue;

      const direction = to.normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(forward.dot(direction), -1, 1));
      const maxAngle = this.guidedShotType === 'detail' ? 58 : 72;
      if (angle > THREE.MathUtils.degToRad(maxAngle)) continue;

      if (areaId && subject.object.userData?.walkAreaId && subject.object.userData.walkAreaId !== areaId) continue;

      const target = subject.center.clone();
      target.y = THREE.MathUtils.clamp(
        target.y,
        referencePosition.y + (this.guidedShotType === 'detail' ? 0.55 : 0.35) * unit,
        referencePosition.y + 2.5 * unit,
      );
      const toTarget = target.clone().sub(eye);
      const targetDistance = toTarget.length();
      if (this.model && targetDistance > 1e-6) {
        this.raycaster.set(eye, toTarget.normalize());
        const hit = this.raycaster.intersectObject(this.model, true)[0];
        if (hit && hit.object !== subject.object && hit.distance < targetDistance - 0.08 * unit) continue;
      }

      const angleQuality = 1 - angle / THREE.MathUtils.degToRad(maxAngle);
      const distanceMeters = distance / unit;
      const distanceQuality = this.guidedShotType === 'detail'
        ? THREE.MathUtils.clamp(1 - Math.abs(distanceMeters - 2.4) / 2.8, 0, 1)
        : THREE.MathUtils.clamp(1 - distance / maxDistance, 0, 1);
      const sizeQuality = THREE.MathUtils.clamp(Math.log1p(subject.radius / unit * 3) * 0.55, 0, 1.3);
      const roleWeight = priority[subject.role] || 2.0;
      const hierarchyWeight = subject.hierarchy === 'primary' ? 1.28
        : subject.hierarchy === 'secondary' ? 0.86
          : 0.48;
      const importanceBonus = THREE.MathUtils.clamp((subject.importance || roleWeight) / 5.5, 0, 1.25);
      const axisDepthBonus = this.guidedShotType === 'axis'
        ? THREE.MathUtils.clamp(distanceMeters / 7, 0, 1)
        : 0;
      const heroScaleBonus = this.guidedShotType === 'hero' ? sizeQuality * 0.45 : 0;
      const detailProximityBonus = this.guidedShotType === 'detail'
        ? THREE.MathUtils.clamp(1 - distanceMeters / 4.8, 0, 1) * 1.7
        : 0;

      const score = hierarchyWeight * roleWeight * (
        0.65
        + angleQuality * 1.75
        + distanceQuality * 0.85
        + sizeQuality * 0.5
      ) + importanceBonus * 0.85 + axisDepthBonus + heroScaleBonus + detailProximityBonus;

      candidates.push({ subject, score, angle, distance, target });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.subject || null;
  },

  _yawToGuidedSubject(referencePosition = this.position, subject = this.guidedShotSubject) {
    if (!subject?.center) return null;
    const dx = subject.center.x - referencePosition.x;
    const dz = subject.center.z - referencePosition.z;
    if (Math.hypot(dx, dz) < 0.15 * Math.max(this.metersPerUnit, 0.000001)) return null;
    return Math.atan2(-dx, -dz);
  },

  _visualSubjectScore(referencePosition = this.position, candidateYaw = this.currentYaw) {
    if (!this.presentationSubjects.length) return 0;
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const origin = new THREE.Vector3(referencePosition.x, referencePosition.y, referencePosition.z);
    const eye = new THREE.Vector3(
      origin.x,
      origin.y + this.eyeHeight * unit + this.heightOffset * unit,
      origin.z,
    );
    const forward = new THREE.Vector3(-Math.sin(candidateYaw), 0, -Math.cos(candidateYaw));
    const maxDistance = 8.5 * unit;
    let score = 0;
    let visibleSubjects = 0;

    for (const subject of this.presentationSubjects) {
      const to = subject.center.clone().sub(origin);
      to.y = 0;
      const distance = to.length();
      if (!Number.isFinite(distance) || distance < 0.75 * unit || distance > maxDistance) continue;
      const direction = to.normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(forward.dot(direction), -1, 1));
      if (angle > THREE.MathUtils.degToRad(68)) continue;

      const target = subject.center.clone();
      target.y = THREE.MathUtils.clamp(
        target.y,
        origin.y + 0.35 * unit,
        origin.y + 2.6 * unit,
      );
      const toTarget = target.clone().sub(eye);
      const targetDistance = toTarget.length();
      if (this.model && targetDistance > 1e-6) {
        this.raycaster.set(eye, toTarget.normalize());
        const hit = this.raycaster.intersectObject(this.model, true)[0];
        if (hit && hit.object !== subject.object && hit.distance < targetDistance - 0.08 * unit) continue;
      }

      const angleQuality = 1 - angle / THREE.MathUtils.degToRad(68);
      const distanceQuality = THREE.MathUtils.clamp(1 - distance / maxDistance, 0, 1);
      const sizeQuality = THREE.MathUtils.clamp(Math.log1p(subject.radius / unit * 3) * 0.55, 0, 1.3);
      const roleWeight = subject.role === 'furniture' ? 1.35
        : subject.role === 'fixture' ? 1.2
        : subject.role === 'opening' ? 0.95
        : subject.role === 'decor' ? 0.82
        : subject.role === 'lighting' ? 0.65
        : 0.55;
      const hierarchyWeight = subject.hierarchy === 'primary' ? 1.28
        : subject.hierarchy === 'secondary' ? 0.86
          : 0.48;

      score += roleWeight * hierarchyWeight * (0.7 + angleQuality * 1.7 + distanceQuality * 0.8 + sizeQuality * 0.5);
      visibleSubjects += 1;
      if (visibleSubjects >= 8) break;
    }

    return score;
  }
};
