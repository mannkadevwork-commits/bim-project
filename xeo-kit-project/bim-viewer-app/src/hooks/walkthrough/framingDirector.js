import * as THREE from 'three';

const SHOT_FRAMING = {
  hero: {
    targetX: 0.12,
    targetY: 0.08,
    radiusBias: 1.0,
    minDistance: 2.7,
    maxDistance: 7.8,
  },
  reveal: {
    targetX: 0.06,
    targetY: 0.04,
    radiusBias: 0.95,
    minDistance: 2.8,
    maxDistance: 7.6,
  },
  detail: {
    targetX: 0.16,
    targetY: 0.02,
    radiusBias: 0.72,
    minDistance: 1.45,
    maxDistance: 4.8,
  },
  axis: {
    targetX: 0.04,
    targetY: 0.05,
    radiusBias: 0.92,
    minDistance: 3.0,
    maxDistance: 8.5,
  },
  transition: {
    targetX: 0.0,
    targetY: 0.03,
    radiusBias: 0.9,
    minDistance: 2.6,
    maxDistance: 7.5,
  },
};

const clamp01 = (value) =>
  THREE.MathUtils.clamp(value, 0, 1);

const DEG = Math.PI / 180;

/**
 * Guided camera performance overrides.
 *
 * The original Guided implementation repeatedly called:
 *   Raycaster.intersectObject(model, true)
 *
 * from composition scoring, subject scoring, hotspot visibility and wall
 * detection. With thousands of mesh nodes this can consume the entire browser
 * main thread. These implementations use the already-validated hotspot data
 * and the cached presentation-subject index instead.
 */
export const framingDirectorMethods = {
  _getGuidedVisibleHotspots(
    referencePosition = this.position,
    yaw = this.currentYaw,
    maxDistanceMeters =
      this.guidedCompositionLookaheadMeters,
  ) {
    if (!this.hotspots?.length) {
      return [];
    }

    const unit =
      Math.max(
        this.metersPerUnit,
        0.000001,
      );

    const maxDistance =
      maxDistanceMeters * unit;

    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);

    const presentationAreaId =
      this._getGuidedPresentationAreaId();

    const allowCrossArea =
      this.guidedTransitionKind === 'room-entry' ||
      this.guidedTransitionKind === 'room-crossing';

    const visible = [];

    for (
      const hotspot of this.hotspots
    ) {
      if (
        !hotspot?.position ||
        hotspot.position.length < 3
      ) {
        continue;
      }

      if (
        presentationAreaId &&
        hotspot.areaId &&
        hotspot.areaId !==
          presentationAreaId &&
        !allowCrossArea
      ) {
        continue;
      }

      const dx =
        Number(hotspot.position[0]) -
        referencePosition.x;

      const dz =
        Number(hotspot.position[2]) -
        referencePosition.z;

      const distanceSq =
        dx * dx + dz * dz;

      if (
        distanceSq <
          0.65 * 0.65 * unit * unit ||
        distanceSq >
          maxDistance * maxDistance
      ) {
        continue;
      }

      const distance =
        Math.sqrt(distanceSq);

      const inverseDistance =
        distance > 1e-6
          ? 1 / distance
          : 0;

      const directionX =
        dx * inverseDistance;

      const directionZ =
        dz * inverseDistance;

      const dot =
        forwardX * directionX +
        forwardZ * directionZ;

      const angle =
        Math.acos(
          THREE.MathUtils.clamp(
            dot,
            -1,
            1,
          ),
        );

      if (angle > 82 * DEG) {
        continue;
      }

      visible.push({
        hotspot,
        distance,
        angle,
        target: {
          x: Number(hotspot.position[0]),
          y: Number(hotspot.position[1]),
          z: Number(hotspot.position[2]),
        },
        direction: {
          x: directionX,
          y: 0,
          z: directionZ,
        },
      });
    }

    return visible;
  },

  /**
   * The renderer already performs normal view-frustum culling. Wall safety is
   * a presentation hint, not a navigation authority, so it must never launch
   * three full-model raycasts on every camera update.
   */
  _headingWallGuardScore() {
    return 0;
  },

  _scoreGuidedHeading(
    referencePosition = this.position,
    candidateYaw = this.currentYaw,
    incomingDirection = this.lastMoveDirection,
  ) {
    const visible =
      this._getGuidedVisibleHotspots(
        referencePosition,
        candidateYaw,
        this.guidedCompositionLookaheadMeters,
      );

    const unit =
      Math.max(
        this.metersPerUnit,
        0.000001,
      );

    let score =
      this._visualSubjectScore(
        referencePosition,
        candidateYaw,
      ) * 0.72;

    const incomingX =
      Number(incomingDirection?.x) || 0;

    const incomingZ =
      Number(incomingDirection?.z) || 0;

    const incomingLength =
      Math.hypot(
        incomingX,
        incomingZ,
      );

    const hasIncoming =
      incomingLength > 1e-8;

    const normalizedIncomingX =
      hasIncoming
        ? incomingX / incomingLength
        : 0;

    const normalizedIncomingZ =
      hasIncoming
        ? incomingZ / incomingLength
        : 0;

    const presentationAreaId =
      this._getGuidedPresentationAreaId();

    for (
      const item of visible
    ) {
      const proximity =
        THREE.MathUtils.clamp(
          1 -
            item.distance /
              (this.guidedCompositionLookaheadMeters *
                unit),
          0,
          1,
        );

      const centered =
        1 -
        THREE.MathUtils.clamp(
          item.angle /
            (75 * DEG),
          0,
          1,
        );

      const forwardBonus =
        hasIncoming
          ? Math.max(
              0,
              normalizedIncomingX *
                  item.direction.x +
                normalizedIncomingZ *
                  item.direction.z,
            )
          : 0;

      const role =
        this._getHotspotRole(
          item.hotspot,
        );

      const sameSpaceBonus =
        presentationAreaId &&
        item.hotspot.areaId ===
          presentationAreaId
          ? 1.35
          : 0;

      const roleBonus =
        role === 'room-center'
          ? 0.9
          : role === 'viewpoint'
            ? 0.75
            : role === 'room-entrance'
              ? 0.45
              : role === 'transition'
                ? 0.25
                : 0.1;

      score +=
        1.8 +
        proximity * 1.4 +
        centered * 1.2 +
        forwardBonus * 0.55 +
        roleBonus +
        sameSpaceBonus;
    }

    return {
      score,
      visible,
    };
  },

  _findBestGuidedComposition(
    referencePosition = this.position,
    incomingDirection =
      this.lastMoveDirection,
    preferredYaw = this.currentYaw,
  ) {
    const offsets = [
      -60,
      -40,
      -20,
      0,
      20,
      40,
      60,
    ];

    let best = null;
    let current = null;

    for (
      const offsetDeg of offsets
    ) {
      const yaw =
        preferredYaw +
        offsetDeg * DEG;

      const evaluation =
        this._scoreGuidedHeading(
          referencePosition,
          yaw,
          incomingDirection,
        );

      const candidate = {
        yaw,
        score:
          evaluation.score,
        visible:
          evaluation.visible,
      };

      if (
        Math.abs(offsetDeg) <= 20
      ) {
        if (
          !current ||
          candidate.score > current.score
        ) {
          current = candidate;
        }
      }

      if (
        !best ||
        candidate.score > best.score
      ) {
        best = candidate;
      }
    }

    if (!best) {
      return null;
    }

    // Stability rule: avoid a large camera rotation for a tiny score gain.
    if (
      current &&
      best.score <
        current.score * 1.12
    ) {
      return {
        yaw: current.yaw,
        score: current.score,
      };
    }

    return {
      yaw: best.yaw,
      score: best.score,
    };
  },

  _refreshPresentationDestinations(
    referencePosition = this.position,
    yaw = this.currentYaw,
  ) {
    this.presentationHotspotIds.clear();
    this.presentationHotspotScores.clear();

    if (!this.hotspots?.length) {
      return;
    }

    const unit =
      Math.max(
        this.metersPerUnit,
        0.000001,
      );

    const forwardX =
      -Math.sin(yaw);

    const forwardZ =
      -Math.cos(yaw);

    const candidates = [];

    for (
      const hotspot of this.hotspots
    ) {
      if (
        !hotspot?.id ||
        !Array.isArray(
          hotspot.position,
        ) ||
        hotspot.position.length < 3
      ) {
        continue;
      }

      const dx =
        Number(hotspot.position[0]) -
        referencePosition.x;

      const dz =
        Number(hotspot.position[2]) -
        referencePosition.z;

      const distance =
        Math.hypot(dx, dz);

      if (
        !Number.isFinite(
          distance,
        ) ||
        distance <
          0.5 * unit ||
        distance >
          this.presentationMaxDistanceMeters *
            unit
      ) {
        continue;
      }

      const inverseDistance =
        distance > 1e-6
          ? 1 / distance
          : 0;

      const directionX =
        dx * inverseDistance;

      const directionZ =
        dz * inverseDistance;

      const dot =
        forwardX * directionX +
        forwardZ * directionZ;

      const angle =
        Math.acos(
          THREE.MathUtils.clamp(
            dot,
            -1,
            1,
          ),
        );

      if (angle > 78 * DEG) {
        continue;
      }

      // Hotspots have already passed the expensive camera-clearance and
      // walkability checks during load. Do not repeat them from the frame loop.

      const proximity =
        THREE.MathUtils.clamp(
          1 -
            distance /
              (this.presentationMaxDistanceMeters *
                unit),
          0,
          1,
        );

      const centered =
        1 -
        angle /
          (78 * DEG);

      const role =
        this._getHotspotRole(
          hotspot,
        );

      const roleBonus =
        role === 'room-center'
          ? 1.4
          : role === 'viewpoint'
            ? 1.15
            : role === 'room-entrance'
              ? 0.85
              : role === 'transition'
                ? 0.55
                : 0.2;

      candidates.push({
        hotspot,
        angle,
        score:
          proximity * 2.2 +
          centered * 2.0 +
          (Number(
            hotspot.score,
          ) || 0) *
            0.15 +
          roleBonus,
      });
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score,
    );

    const minSeparation =
      this.presentationMinSeparationDeg *
      DEG;

    const selected = [];

    for (
      const candidate of candidates
    ) {
      const separated =
        selected.every(
          (previous) => {
            const delta =
              Math.atan2(
                Math.sin(
                  candidate.angle -
                    previous.angle,
                ),
                Math.cos(
                  candidate.angle -
                    previous.angle,
                ),
              );

            return (
              Math.abs(delta) >=
              minSeparation
            );
          },
        );

      if (!separated) continue;

      selected.push(candidate);

      this.presentationHotspotIds.add(
        candidate.hotspot.id,
      );

      this.presentationHotspotScores.set(
        candidate.hotspot.id,
        candidate.score,
      );

      if (
        selected.length >=
        this.presentationMaxVisible
      ) {
        break;
      }
    }
  },

  _chooseGuidedFrame(
    referencePosition = this.position,
    subject = this.guidedShotSubject,
    fallbackYaw = this.currentYaw,
  ) {
    const shot =
      SHOT_FRAMING[
        this.guidedShotType
      ] ||
      SHOT_FRAMING.hero;

    const unit =
      Math.max(
        this.metersPerUnit,
        1e-6,
      );

    const eyeY =
      referencePosition.y +
      this.eyeHeight * unit +
      this.heightOffset * unit;

    if (!subject) {
      return {
        yaw:
          Number.isFinite(
            fallbackYaw,
          )
            ? fallbackYaw
            : 0,
        pitch:
          this.guidedPitch,
        quality: 0,
        targetOffsetX: 0,
        targetOffsetY: 0,
      };
    }

    const dx =
      subject.x -
      referencePosition.x;

    const dz =
      subject.z -
      referencePosition.z;

    const distance =
      Math.hypot(dx, dz);

    if (
      !Number.isFinite(
        distance,
      ) ||
      distance <
        0.25 * unit
    ) {
      return {
        yaw: fallbackYaw,
        pitch: this.guidedPitch,
        quality: 0,
        targetOffsetX: 0,
        targetOffsetY: 0,
      };
    }

    const bearing =
      Math.atan2(-dx, -dz);

    const fovHalf =
      THREE.MathUtils.degToRad(
        this.fov * 0.5,
      );

    const horizontalOffset =
      Math.atan(
        shot.targetX *
          Math.tan(fovHalf),
      );

    const candidateYaws = [
      bearing -
        horizontalOffset,
      bearing,
      bearing +
        horizontalOffset,
    ];

    const subjectHeight =
      Math.max(
        subject.sizeY ||
          subject.radius * 2,
        0.25 * unit,
      );

    const desiredEyeTargetY =
      subject.y +
      shot.targetY *
        subjectHeight;

    const verticalAngle =
      Math.atan2(
        desiredEyeTargetY -
          eyeY,
        Math.max(
          distance,
          0.25 * unit,
        ),
      );

    const targetPitch =
      THREE.MathUtils.clamp(
        -verticalAngle,
        -0.22,
        0.16,
      );

    let best = null;

    for (
      const yaw of candidateYaws
    ) {
      const evaluation =
        this._evaluateGuidedFrameCandidate(
          referencePosition,
          subject,
          yaw,
          unit,
          shot,
        );

      if (
        !best ||
        evaluation.score >
          best.score
      ) {
        best = {
          ...evaluation,
          yaw,
        };
      }
    }

    return {
      yaw:
        best?.yaw ??
        bearing,
      pitch:
        targetPitch,
      quality:
        best?.score ?? 0,
      targetOffsetX:
        shot.targetX,
      targetOffsetY:
        shot.targetY,
    };
  },

  _evaluateGuidedFrameCandidate(
    referencePosition,
    subject,
    yaw,
    unit,
    shot,
  ) {
    const forwardX =
      -Math.sin(yaw);

    const forwardZ =
      -Math.cos(yaw);

    const dx =
      subject.x -
      referencePosition.x;

    const dz =
      subject.z -
      referencePosition.z;

    const distance =
      Math.hypot(dx, dz);

    if (!(distance > 0)) {
      return {
        score: -Infinity,
      };
    }

    const inverseDistance =
      1 / distance;

    const toX =
      dx * inverseDistance;

    const toZ =
      dz * inverseDistance;

    const dot =
      forwardX * toX +
      forwardZ * toZ;

    const centered =
      clamp01(
        (dot -
          Math.cos(
            42 * DEG,
          )) /
          Math.max(
            1 -
              Math.cos(
                42 * DEG,
              ),
            1e-6,
          ),
      );

    const distanceMeters =
      distance / unit;

    const idealDistance =
      THREE.MathUtils.clamp(
        (shot.minDistance +
          shot.maxDistance) *
          0.5,
        1.2,
        8.0,
      );

    const distanceQuality =
      clamp01(
        1 -
          Math.abs(
            distanceMeters -
              idealDistance,
          ) /
            Math.max(
              idealDistance,
              1,
            ),
      );

    const sizeFit =
      clamp01(
        (shot.radiusBias *
          2.5 *
          unit -
          subject.radius) /
          Math.max(
            shot.radiusBias *
              2.5 *
              unit,
            1e-6,
          ) +
          0.35,
      );

    // Use cached subjects for context. No model raycasts.
    const rightX =
      Math.cos(yaw);

    const rightZ =
      -Math.sin(yaw);

    let contextScore = 0;
    let obstructionPenalty = 0;

    const maxContextDistance =
      8.5 * unit;

    for (
      const candidate of
        this.presentationSubjects ||
        []
    ) {
      if (
        !candidate ||
        !candidate.object?.visible ||
        candidate.object ===
          subject.object
      ) {
        continue;
      }

      const cdx =
        candidate.x -
        referencePosition.x;

      const cdz =
        candidate.z -
        referencePosition.z;

      const d =
        Math.hypot(
          cdx,
          cdz,
        );

      if (
        d <=
          0.7 * unit ||
        d >
          maxContextDistance
      ) {
        continue;
      }

      const inv =
        1 / d;

      const dirX =
        cdx * inv;

      const dirZ =
        cdz * inv;

      const contextDot =
        forwardX * dirX +
        forwardZ * dirZ;

      const contextAngle =
        Math.acos(
          THREE.MathUtils.clamp(
            contextDot,
            -1,
            1,
          ),
        );

      if (
        contextAngle >
        78 * DEG
      ) {
        continue;
      }

      const lateral =
        rightX * dirX +
        rightZ * dirZ;

      const weight =
        candidate.hierarchy ===
        'primary'
          ? 1
          : candidate.hierarchy ===
              'secondary'
            ? 0.6
            : 0.25;

      const proximity =
        clamp01(
          1 -
            d /
              maxContextDistance,
        );

      if (lateral < -0.12) {
        contextScore +=
          weight *
          (0.35 +
            proximity * 0.65);
      }

      if (
        Math.abs(lateral) <
          0.08 &&
        contextAngle <
          16 * DEG
      ) {
        obstructionPenalty +=
          weight *
          clamp01(
            1 -
              d /
                (5.5 *
                  unit),
          );
      }
    }

    const framingScore =
      centered * 2.6 +
      distanceQuality * 1.2 +
      sizeFit * 1.1 +
      contextScore * 0.75 -
      obstructionPenalty * 1.1;

    return {
      score: framingScore,
    };
  },

  _guidedFramePitchForSubject(
    referencePosition = this.position,
    subject = this.guidedShotSubject,
  ) {
    return this._chooseGuidedFrame(
      referencePosition,
      subject,
      this.currentYaw,
    ).pitch;
  },
};
