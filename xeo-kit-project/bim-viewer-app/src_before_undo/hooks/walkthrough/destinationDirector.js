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
  _buildDestinationPresentation(
    hotspots = this.hotspots || [],
  ) {
    const byArea = new Map();

    const records = hotspots
      .filter(
        (hotspot) =>
          hotspot?.id &&
          Array.isArray(
            hotspot.position,
          ),
      )
      .map((hotspot) => {
        const role =
          this._getHotspotRole(
            hotspot,
          );

        const areaId =
          hotspot.areaId || null;

        let kind =
          PRESENTATION_KIND.INTERNAL;

        if (
          role === 'room-center'
        ) {
          kind =
            PRESENTATION_KIND.PRIMARY;
        } else if (
          role === 'viewpoint'
        ) {
          kind =
            PRESENTATION_KIND.OPTIONAL;
        }

        const record = {
          ...hotspot,
          destinationKind:
            kind,
          presentationRole:
            role,
          presentationLabel:
            this._destinationPresentationLabel(
              hotspot,
              role,
              kind,
            ),
          presentationPriority:
            ROLE_PRIORITY[
              role
            ] ?? 9,
          showInMap:
            kind !==
            PRESENTATION_KIND.INTERNAL,
          showInScene:
            kind !==
            PRESENTATION_KIND.INTERNAL,
          showInGuidedTour:
            kind !==
            PRESENTATION_KIND.INTERNAL,
          allowDirectNavigation:
            true,
        };

        if (areaId) {
          if (!byArea.has(areaId)) {
            byArea.set(
              areaId,
              [],
            );
          }

          byArea
            .get(areaId)
            .push(record);
        }

        return record;
      });

    for (
      const areaRecords of
        byArea.values()
    ) {
      if (
        areaRecords.some(
          (record) =>
            record.destinationKind ===
            PRESENTATION_KIND.PRIMARY,
        )
      ) {
        continue;
      }

      const fallback = [
        ...areaRecords,
      ]
        .filter(
          (record) =>
            record.presentationRole !==
              'transition' &&
            record.presentationRole !==
              'walkpoint',
        )
        .sort((a, b) =>
          this._compareDestinationRecords(
            a,
            b,
          ),
        )[0];

      if (!fallback) continue;

      fallback.destinationKind =
        PRESENTATION_KIND.PRIMARY;

      fallback.showInMap = true;
      fallback.showInScene = true;
      fallback.showInGuidedTour =
        true;

      fallback.presentationLabel =
        this._destinationPresentationLabel(
          fallback,
          fallback.presentationRole,
          PRESENTATION_KIND.PRIMARY,
        );
    }

    const primary = records
      .filter(
        (record) =>
          record.destinationKind ===
          PRESENTATION_KIND.PRIMARY,
      )
      .sort((a, b) =>
        this._compareDestinationRecords(
          a,
          b,
        ),
      );

    const optional = records
      .filter(
        (record) =>
          record.destinationKind ===
          PRESENTATION_KIND.OPTIONAL,
      )
      .sort((a, b) =>
        this._compareDestinationRecords(
          a,
          b,
        ),
      );

    const internal = records
      .filter(
        (record) =>
          record.destinationKind ===
          PRESENTATION_KIND.INTERNAL,
      )
      .sort((a, b) =>
        this._compareDestinationRecords(
          a,
          b,
        ),
      );

    this.destinationPresentation = {
      version: 1,
      primary,
      optional,
      internal,
      presentationHotspots: [
        ...primary,
        ...optional,
      ],
      byId: new Map(
        records.map(
          (record) => [
            record.id,
            record,
          ],
        ),
      ),
    };

    return this.destinationPresentation;
  },

  _destinationPresentationLabel(
    hotspot,
    role,
    kind,
  ) {
    const areaLabel =
      hotspot?.areaLabel || '';

    if (
      kind ===
      PRESENTATION_KIND.PRIMARY
    ) {
      return (
        areaLabel ||
        hotspot?.label ||
        'Room'
      );
    }

    if (
      kind ===
      PRESENTATION_KIND.OPTIONAL
    ) {
      return areaLabel
        ? `${areaLabel} · View`
        : hotspot?.label ||
            'Viewpoint';
    }

    if (role === 'room-entrance') {
      return areaLabel
        ? `${areaLabel} · Entrance`
        : 'Room entrance';
    }

    return (
      hotspot?.label ||
      'Navigation point'
    );
  },

  _compareDestinationRecords(
    a,
    b,
  ) {
    const orderA =
      Number.isFinite(
        Number(a?.displayOrder),
      )
        ? Number(a.displayOrder)
        : 9999;

    const orderB =
      Number.isFinite(
        Number(b?.displayOrder),
      )
        ? Number(b.displayOrder)
        : 9999;

    return (
      orderA - orderB ||
      (Number(b?.score) || 0) -
        (Number(a?.score) || 0) ||
      String(a?.id || '').localeCompare(
        String(b?.id || ''),
      )
    );
  },

  _getDestinationPresentation(
    hotspotOrId,
  ) {
    const id =
      typeof hotspotOrId === 'string'
        ? hotspotOrId
        : hotspotOrId?.id;

    return id
      ? this.destinationPresentation?.byId?.get(
          id,
        ) || null
      : null;
  },

  _getDestinationKind(
    hotspotOrId,
  ) {
    return (
      this._getDestinationPresentation(
        hotspotOrId,
      )?.destinationKind ||
      (typeof hotspotOrId === 'object'
        ? hotspotOrId?.destinationKind
        : null) ||
      PRESENTATION_KIND.INTERNAL
    );
  },

  _isCustomerFacingDestination(
    hotspotOrId,
  ) {
    return (
      this._getDestinationKind(
        hotspotOrId,
      ) !== PRESENTATION_KIND.INTERNAL
    );
  },

  _getCustomerFacingDestinations() {
    return (
      this.destinationPresentation
        ?.presentationHotspots ||
      []
    );
  },

  /**
   * Guided tour destination selection is intentionally split into two stages:
   *
   * 1. Cheap geometry/semantic ranking for every hotspot.
   * 2. NavMesh path validation for only the best few candidates.
   *
   * The old implementation ran computePath() for every candidate each time a
   * Guided decision was made. That is unnecessary when the user-visible choice
   * can be narrowed first.
   */
  _chooseNextGuidedTourDestination() {
    if (
      !this.guidedTourArmed ||
      !this.query ||
      !this.hotspots?.length
    ) {
      return null;
    }

    const current =
      this.hotspots.find(
        (hotspot) =>
          hotspot.id ===
          this.activeHotspotId,
      );

    const currentRole =
      current
        ? this._getHotspotRole(
            current,
          )
        : this.guidedTourLastRole ||
          'room-center';

    const currentAreaId =
      current?.areaId ||
      this.guidedTourLastAreaId ||
      null;

    const candidates = [];

    for (
      const hotspot of
        this.hotspots
    ) {
      if (
        !hotspot?.id ||
        !Array.isArray(
          hotspot.position,
        )
      ) {
        continue;
      }

      if (
        hotspot.id ===
          this.activeHotspotId ||
        this.guidedTourVisitedHotspots.has(
          hotspot.id,
        )
      ) {
        continue;
      }

      const role =
        this._getHotspotRole(
          hotspot,
        );

      if (
        role === 'walkpoint' ||
        role === 'transition'
      ) {
        continue;
      }

      if (
        !this._isCustomerFacingDestination(
          hotspot,
        )
      ) {
        continue;
      }

      // Hotspots were already validated during load. Do not call
      // _hasCameraClearance() here.
      const dx =
        Number(hotspot.position[0]) -
        this.position.x;

      const dz =
        Number(hotspot.position[2]) -
        this.position.z;

      const distance =
        Math.hypot(dx, dz);

      if (
        !Number.isFinite(
          distance,
        )
      ) {
        continue;
      }

      const unit =
        Math.max(
          this.metersPerUnit,
          1e-6,
        );

      const distanceMeters =
        distance / unit;

      if (
        distanceMeters < 0.9 ||
        distanceMeters > 18
      ) {
        continue;
      }

      const sameArea =
        Boolean(
          currentAreaId &&
            hotspot.areaId &&
            hotspot.areaId ===
              currentAreaId,
        );

      const newArea =
        Boolean(
          hotspot.areaId &&
            !this.guidedTourVisitedAreas.has(
              hotspot.areaId,
            ),
        );

      let score = 0;

      const rolePriority =
        this._tourRolePriority(
          currentRole,
          role,
        );

      score +=
        (3 - rolePriority) *
        2.2;

      score += sameArea
        ? 2.4
        : 0;

      score += newArea
        ? 5.0
        : 0;

      score +=
        role === 'room-center'
          ? 2.1
          : role === 'viewpoint'
            ? 1.4
            : 0.4;

      score -=
        Math.min(
          distanceMeters,
          12,
        ) * 0.17;

      if (
        currentRole ===
          'room-center' &&
        role === 'viewpoint' &&
        sameArea
      ) {
        score += 2.4;
      }

      if (
        currentRole ===
          'viewpoint' &&
        role ===
          'room-entrance'
      ) {
        score += 2.7;
      }

      if (
        currentRole ===
          'room-entrance' &&
        role ===
          'room-center' &&
        sameArea
      ) {
        score += 3.1;
      }

      if (
        role === 'room-center' &&
        newArea
      ) {
        score += 2.0;
      }

      candidates.push({
        hotspot,
        score,
        distance,
        distanceMeters,
        sameArea,
        newArea,
      });
    }

    candidates.sort(
      (a, b) => {
        if (
          Math.abs(
            b.score - a.score,
          ) > 0.12
        ) {
          return (
            b.score - a.score
          );
        }

        if (
          a.newArea !==
          b.newArea
        ) {
          return a.newArea
            ? -1
            : 1;
        }

        return (
          a.distanceMeters -
          b.distanceMeters
        );
      },
    );

    // Only the best few candidates need actual path validation.
    const topCandidates =
      candidates.slice(0, 3);

    let bestReachable = null;

    for (
      const candidate of
        topCandidates
    ) {
      const point =
        this._closestWalkPoint(
          candidate.hotspot.position,
          0.9,
        );

      if (!point) continue;

      const result =
        this.query.computePath(
          {
            x: this.position.x,
            y: this.position.y,
            z: this.position.z,
          },
          point,
          {
            filter: this.filter,
            maxStraightPathSize: 96,
            maxPathSize: 96,
          },
        );

      if (
        !result?.success ||
        !result.path?.length
      ) {
        continue;
      }

      bestReachable = {
        ...candidate,
        point,
      };

      break;
    }

    if (!bestReachable) {
      return null;
    }

    const newRoomAlternative =
      candidates.find(
        (candidate) =>
          candidate.newArea &&
          candidate.distanceMeters <=
            bestReachable.distanceMeters +
              5,
      );

    if (
      newRoomAlternative &&
      bestReachable.sameArea &&
      bestReachable.score <
        newRoomAlternative.score +
          1.6
    ) {
      // Validate only this alternative when it exists.
      const point =
        this._closestWalkPoint(
          newRoomAlternative.hotspot.position,
          0.9,
        );

      if (point) {
        const result =
          this.query.computePath(
            {
              x: this.position.x,
              y: this.position.y,
              z: this.position.z,
            },
            point,
            {
              filter: this.filter,
              maxStraightPathSize: 96,
              maxPathSize: 96,
            },
          );

        if (
          result?.success &&
          result.path?.length
        ) {
          return {
            ...newRoomAlternative,
            point,
          };
        }
      }
    }

    return bestReachable;
  },

  /**
   * The original method is called from _syncCamera() every animation frame.
   * Make the guard cheap on normal frames, and run the expensive selection only
   * when a tour decision is actually due.
   */
  _advanceGuidedTour(
    now = performance.now(),
  ) {
    if (this.smart720Active) {
      return this._updateSmart720Tour(
        now,
      );
    }

    if (
      this.walkMode !==
        'guided' ||
      !this.guidedTourArmed ||
      this.guidedTourAdvanceLock ||
      this.arrivalSettleUntil >
        now ||
      this.path ||
      this.directTravel ||
      now <
        this.guidedTourNextAt
    ) {
      return false;
    }

    const decisionInterval =
      500;

    if (
      now -
        (this.guidedTourLastDecisionAt ||
          0) <
        decisionInterval
    ) {
      return false;
    }

    this.guidedTourLastDecisionAt =
      now;

    const next =
      this._chooseNextGuidedTourDestination();

    if (!next) {
      if (
        this._startGuidedHeroEnding?.(
          this.position,
        )
      ) {
        return true;
      }

      this.guidedTourArmed =
        false;
      this.guidedTourNextAt = 0;
      this.guidedTourAdvanceLock =
        false;

      this.onState?.({
        type: 'tour-complete',
      });

      return false;
    }

    this.guidedTourAdvanceLock =
      true;

    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;

    this._armGuidedTourForHotspot(
      next.hotspot,
    );

    const started =
      this.travelTo(
        next.point,
        next.hotspot.label ||
          'Next destination',
      );

    if (!started) {
      this.guidedTourAdvanceLock =
        false;
    }

    if (started) {
      this.onState?.({
        type: 'tour-advance',
        hotspotId:
          next.hotspot.id,
        areaId:
          next.hotspot.areaId ||
          null,
        role:
          this._getHotspotRole(
            next.hotspot,
          ),
        distanceMeters:
          Number(
            next.distanceMeters.toFixed(
              2,
            ),
          ),
      });
    }

    return started;
  },
};
