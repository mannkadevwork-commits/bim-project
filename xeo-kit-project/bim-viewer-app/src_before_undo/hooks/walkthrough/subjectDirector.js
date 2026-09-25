import * as THREE from 'three';

const SQ_EPSILON = 1e-8;

const ROLE_WEIGHT_BY_SHOT = {
  hero: {
    furniture: 5.0,
    fixture: 3.9,
    opening: 3.6,
    decor: 3.0,
    lighting: 2.5,
    object: 2.1,
  },
  reveal: {
    opening: 6.0,
    furniture: 4.4,
    fixture: 3.6,
    decor: 3.0,
    lighting: 2.4,
    object: 2.0,
  },
  detail: {
    fixture: 6.2,
    decor: 5.7,
    furniture: 4.0,
    lighting: 3.3,
    opening: 2.7,
    object: 2.3,
  },
  axis: {
    opening: 5.1,
    furniture: 4.7,
    fixture: 3.6,
    decor: 2.8,
    lighting: 2.5,
    object: 2.2,
  },
  transition: {
    opening: 4.0,
    furniture: 3.5,
    fixture: 2.8,
    decor: 2.4,
    lighting: 2.1,
    object: 1.8,
  },
};

const CLASSIFICATION_PATTERNS = [
  ['furniture', /(sofa|couch|chair|table|desk|bed|cabinet|wardrobe|shelf|shelving|counter|stool|bench|tv|television|coffee)/],
  ['fixture', /(sink|toilet|bathtub|bath|shower|basin|hob|oven|fridge|refrigerator|appliance)/],
  ['opening', /(window|glazing|glass|door|sliding|opening)/],
  ['lighting', /(light|lamp|ceiling|pendant|fan|chandelier)/],
  ['decor', /(plant|decor|art|painting|mirror|rug|carpet|curtain)/],
];

const hierarchyWeight = {
  primary: 1.0,
  secondary: 0.62,
  background: 0.26,
};

const rolePriority = {
  furniture: 5,
  fixture: 4.5,
  opening: 3.7,
  decor: 3.2,
  lighting: 2.8,
  object: 2.5,
};

function classifyByName(name = '') {
  const lower = String(name).toLowerCase();

  for (const [role, pattern] of CLASSIFICATION_PATTERNS) {
    if (pattern.test(lower)) return role;
  }

  if (/(wall|floor|slab|ceiling|roof|column|beam|structural)/.test(lower)) {
    return null;
  }

  return 'object';
}

function inferGenericRole(size, box, unit) {
  const sx = size.x / unit;
  const sy = size.y / unit;
  const sz = size.z / unit;
  const long = Math.max(sx, sz);
  const short = Math.min(sx, sz);
  const centerY = box.getCenter(_sharedCenter).y / unit;
  const baseY = box.min.y / unit;

  const looksLikeFloorOrSlab =
    sy <= 0.28 &&
    long >= 2.5 &&
    short >= 0.7;

  const looksLikeWallOrPartition =
    sy >= 1.7 &&
    short <= 0.28 &&
    long >= 1.4;

  const looksLikeTallArchitecturalStrip =
    sy >= 2.4 &&
    short <= 0.18 &&
    long >= 2.0;

  if (
    looksLikeFloorOrSlab ||
    looksLikeWallOrPartition ||
    looksLikeTallArchitecturalStrip
  ) {
    return null;
  }

  const looksLikeOpeningFrame =
    short <= 0.16 &&
    long <= 4.2 &&
    sy >= 0.8 &&
    sy <= 2.6 &&
    baseY <= 0.2;

  const looksLikeOpening =
    short <= 0.32 &&
    long <= 2.8 &&
    sy >= 0.45 &&
    sy <= 2.8 &&
    centerY >= 0.65;

  if (looksLikeOpeningFrame || looksLikeOpening) {
    return 'opening';
  }

  const looksLikeFurniture =
    sy >= 0.28 &&
    sy <= 1.35 &&
    long >= 0.45 &&
    long <= 4.5 &&
    baseY <= 0.35;

  if (looksLikeFurniture) return 'furniture';

  const looksLikeLighting =
    baseY >= 1.7 &&
    sy <= 1.2 &&
    long <= 2.2;

  if (looksLikeLighting) return 'lighting';

  return 'object';
}

function hierarchyFor(role, size, box, unit) {
  const volume =
    (size.x * size.y * size.z) /
    Math.pow(unit, 3);

  const maxDim =
    Math.max(size.x, size.y, size.z) / unit;

  const footprint =
    (size.x * size.z) /
    Math.pow(unit, 2);

  const centerY =
    box.getCenter(_sharedCenter).y / unit;

  if (role === 'furniture') {
    return maxDim >= 2.4 ||
      footprint >= 2.2 ||
      volume >= 1.6
      ? 'primary'
      : 'secondary';
  }

  if (role === 'fixture') {
    return volume >= 0.08 ? 'primary' : 'secondary';
  }

  if (role === 'opening') {
    return maxDim >= 1.4 ? 'primary' : 'secondary';
  }

  if (role === 'lighting') {
    return centerY >= 2.0 && maxDim >= 0.25
      ? 'secondary'
      : 'background';
  }

  if (role === 'decor') {
    return maxDim >= 0.35 ? 'secondary' : 'background';
  }

  if (role === 'object') {
    if (footprint >= 2.5 && maxDim <= 2.0) {
      return 'primary';
    }

    if (maxDim >= 0.45) {
      return 'secondary';
    }
  }

  return 'background';
}

const _sharedCenter = new THREE.Vector3();

export const subjectDirectorMethods = {
  /**
   * Build the semantic visual-subject index once after GLB load.
   *
   * This intentionally does the expensive Box3 work only once. Runtime Guided
   * camera decisions operate on the cached scalar/bounds data and never walk the
   * entire render tree.
   */
  _buildPresentationSubjectIndex() {
    this.presentationSubjects = [];
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;

    if (!this.model) return;

    const unit = Math.max(
      this.metersPerUnit,
      1e-6,
    );

    this.model.traverse((object) => {
      if (!object.isMesh || !object.visible) {
        return;
      }

      const name =
        object.name ||
        object.parent?.name ||
        '';

      const box =
        new THREE.Box3().setFromObject(object);

      if (box.isEmpty()) return;

      const size =
        box.getSize(new THREE.Vector3());

      const maxDim =
        Math.max(
          size.x,
          size.y,
          size.z,
        );

      if (
        !Number.isFinite(maxDim) ||
        maxDim < 0.08
      ) {
        return;
      }

      const namedRole =
        classifyByName(name);

      if (
        namedRole === null &&
        /(wall|floor|slab|ceiling|roof|column|beam|structural)/i.test(
          String(name),
        )
      ) {
        return;
      }

      const role =
        namedRole ||
        inferGenericRole(
          size,
          box,
          unit,
        );

      if (!role) return;

      const center =
        box.getCenter(
          new THREE.Vector3(),
        );

      const hierarchy =
        hierarchyFor(
          role,
          size,
          box,
          unit,
        );

      const importance =
        (rolePriority[role] || 2.5) *
        hierarchyWeight[hierarchy];

      this.presentationSubjects.push({
        object,
        role,
        hierarchy,
        importance,

        // Preserve the original director contract so shotDirector and other
        // presentation code can still access center/size/radius.
        center: center.clone(),
        size: size.clone(),

        // Cached scalar values are used by the hot runtime path to avoid
        // allocating Vector3 objects repeatedly.
        x: center.x,
        y: center.y,
        z: center.z,

        sizeX: size.x,
        sizeY: size.y,
        sizeZ: size.z,

        radius: Math.max(
          maxDim * 0.5,
          0.12 * unit,
        ),
      });
    });

    this.presentationSubjects.sort(
      (a, b) =>
        (b.importance * b.radius) -
        (a.importance * a.radius),
    );

    // Guided camera only needs a small set of meaningful design subjects.
    if (this.presentationSubjects.length > 60) {
      this.presentationSubjects.length = 60;
    }
  },

  /**
   * Cheap subject selection:
   * no Raycaster,
   * no scene traversal,
   * no Box3 allocation.
   */
  _chooseGuidedShotSubject(
    referencePosition = this.position,
    candidateYaw = this.currentYaw,
  ) {
    if (!this.presentationSubjects.length) {
      return null;
    }

    const unit =
      Math.max(
        this.metersPerUnit,
        0.000001,
      );

    const areaId =
      this._getGuidedPresentationAreaId();

    const forwardX =
      -Math.sin(candidateYaw);

    const forwardZ =
      -Math.cos(candidateYaw);

    const maxDistance =
      (this.guidedShotType === 'detail'
        ? 5.2
        : 8.5) * unit;

    const avoidId =
      this.guidedShotSubjectId;

    const priority =
      ROLE_WEIGHT_BY_SHOT[
        this.guidedShotType
      ] ||
      ROLE_WEIGHT_BY_SHOT.hero;

    let bestSubject = null;
    let bestScore = -Infinity;

    for (
      const subject of this.presentationSubjects
    ) {
      if (
        !subject?.object ||
        !subject.object.visible
      ) {
        continue;
      }

      if (
        avoidId &&
        subject.object.uuid === avoidId
      ) {
        continue;
      }

      if (
        areaId &&
        subject.object.userData?.walkAreaId &&
        subject.object.userData.walkAreaId !== areaId
      ) {
        continue;
      }

      const dx =
        subject.x -
        referencePosition.x;

      const dz =
        subject.z -
        referencePosition.z;

      const distanceSq =
        dx * dx +
        dz * dz;

      if (
        distanceSq < 0.55 * 0.55 * unit * unit ||
        distanceSq > maxDistance * maxDistance
      ) {
        continue;
      }

      const distance =
        Math.sqrt(distanceSq);

      const invDistance =
        distance > 1e-6
          ? 1 / distance
          : 0;

      const directionX =
        dx * invDistance;

      const directionZ =
        dz * invDistance;

      const dot =
        forwardX * directionX +
        forwardZ * directionZ;

      const maxAngleDeg =
        this.guidedShotType === 'detail'
          ? 58
          : 72;

      const minDot =
        Math.cos(
          THREE.MathUtils.degToRad(
            maxAngleDeg,
          ),
        );

      if (dot < minDot) {
        continue;
      }

      const angleQuality =
        THREE.MathUtils.clamp(
          (dot - minDot) /
            Math.max(
              1 - minDot,
              1e-6,
            ),
          0,
          1,
        );

      const distanceMeters =
        distance / unit;

      const distanceQuality =
        this.guidedShotType === 'detail'
          ? THREE.MathUtils.clamp(
              1 -
                Math.abs(
                  distanceMeters - 2.4,
                ) /
                  2.8,
              0,
              1,
            )
          : THREE.MathUtils.clamp(
              1 -
                distance /
                  maxDistance,
              0,
              1,
            );

      const sizeQuality =
        THREE.MathUtils.clamp(
          Math.log1p(
            (subject.radius / unit) * 3,
          ) * 0.55,
          0,
          1.3,
        );

      const roleWeight =
        priority[subject.role] || 2.0;

      const hWeight =
        subject.hierarchy === 'primary'
          ? 1.28
          : subject.hierarchy === 'secondary'
            ? 0.86
            : 0.48;

      const importanceBonus =
        THREE.MathUtils.clamp(
          (subject.importance ||
            roleWeight) /
            5.5,
          0,
          1.25,
        );

      const axisDepthBonus =
        this.guidedShotType === 'axis'
          ? THREE.MathUtils.clamp(
              distanceMeters / 7,
              0,
              1,
            )
          : 0;

      const heroScaleBonus =
        this.guidedShotType === 'hero'
          ? sizeQuality * 0.45
          : 0;

      const detailBonus =
        this.guidedShotType === 'detail'
          ? THREE.MathUtils.clamp(
              1 -
                distanceMeters /
                  4.8,
              0,
              1,
            ) * 1.7
          : 0;

      const score =
        hWeight *
          roleWeight *
          (0.65 +
            angleQuality * 1.75 +
            distanceQuality * 0.85 +
            sizeQuality * 0.5) +
        importanceBonus * 0.85 +
        axisDepthBonus +
        heroScaleBonus +
        detailBonus;

      if (score > bestScore) {
        bestScore = score;
        bestSubject = subject;
      }
    }

    return bestSubject;
  },

  _yawToGuidedSubject(
    referencePosition = this.position,
    subject = this.guidedShotSubject,
  ) {
    if (!subject) return null;

    const dx =
      subject.x -
      referencePosition.x;

    const dz =
      subject.z -
      referencePosition.z;

    if (
      Math.hypot(dx, dz) <
      0.15 *
        Math.max(
          this.metersPerUnit,
          0.000001,
        )
    ) {
      return null;
    }

    return Math.atan2(
      -dx,
      -dz,
    );
  },

  /**
   * Cheap visual score used by framingDirector.
   *
   * Occlusion is intentionally not tested here. Occlusion raycasts against a
   * 7k-mesh model were the dominant CPU cost during Guided composition.
   * The selected subject is already filtered using distance/angle/semantic role.
   */
  _visualSubjectScore(
    referencePosition = this.position,
    candidateYaw = this.currentYaw,
  ) {
    if (!this.presentationSubjects.length) {
      return 0;
    }

    const unit =
      Math.max(
        this.metersPerUnit,
        0.000001,
      );

    const forwardX =
      -Math.sin(candidateYaw);

    const forwardZ =
      -Math.cos(candidateYaw);

    const maxDistance =
      8.5 * unit;

    let score = 0;

    for (
      const subject of this.presentationSubjects
    ) {
      const dx =
        subject.x -
        referencePosition.x;

      const dz =
        subject.z -
        referencePosition.z;

      const distanceSq =
        dx * dx +
        dz * dz;

      if (
        distanceSq <
          0.75 * 0.75 * unit * unit ||
        distanceSq >
          maxDistance * maxDistance
      ) {
        continue;
      }

      const distance =
        Math.sqrt(distanceSq);

      const invDistance =
        distance > 1e-6
          ? 1 / distance
          : 0;

      const directionX =
        dx * invDistance;

      const directionZ =
        dz * invDistance;

      const dot =
        forwardX * directionX +
        forwardZ * directionZ;

      const minDot =
        Math.cos(
          THREE.MathUtils.degToRad(
            68,
          ),
        );

      if (dot < minDot) {
        continue;
      }

      const angleQuality =
        THREE.MathUtils.clamp(
          (dot - minDot) /
            Math.max(
              1 - minDot,
              1e-6,
            ),
          0,
          1,
        );

      const distanceQuality =
        THREE.MathUtils.clamp(
          1 -
            distance /
              maxDistance,
          0,
          1,
        );

      const sizeQuality =
        THREE.MathUtils.clamp(
          Math.log1p(
            (subject.radius / unit) * 3,
          ) * 0.55,
          0,
          1.3,
        );

      const roleWeight =
        subject.role === 'furniture'
          ? 1.35
          : subject.role === 'fixture'
            ? 1.2
            : subject.role === 'opening'
              ? 0.95
              : subject.role === 'decor'
                ? 0.82
                : subject.role === 'lighting'
                  ? 0.65
                  : 0.55;

      const hWeight =
        subject.hierarchy === 'primary'
          ? 1
          : subject.hierarchy === 'secondary'
            ? 0.65
            : 0.25;

      score +=
        hWeight *
        roleWeight *
        (0.4 +
          angleQuality * 1.4 +
          distanceQuality * 0.5 +
          sizeQuality * 0.4);
    }

    return score;
  },
};
