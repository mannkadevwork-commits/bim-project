import {
  HOME_TOUR_CAMERA_PITCH,
  HOME_TOUR_CRUISE_SPEED_MPS,
  HOME_TOUR_FIXED_FOV_DEGREES,
  HOME_TOUR_HERO_REVEAL_MS,
  HOME_TOUR_LOOK_AHEAD_METERS,
  HOME_TOUR_PRESENTATION_BASE_PITCH,
  HOME_TOUR_ROUTE_REQUEST_TIMEOUT_MS,
  HOME_TOUR_SWEEP_SAMPLE_COUNT,
  resolveHomeTourSubjectZone,
  HOME_TOUR_TOP_REVEAL_PITCH,
  advanceHomeTourPolyline,
  buildHomeTourPresentationShot,
  buildLocalHomeTourRoute,
  getHomeTourExpectedAreas,
  homeTourLookAheadDirection,
  isHomeTourRouteComplete,
  homeTourRevealPose,
  homeTourRoomSweepPose,
  homeTourPausedCameraPose,
  selectHomeTourCompositionHeading,
  homeTourYawFromDirection,
} from './homeTourPlan.js';

const finitePoint = (point) => {
  const values = Array.isArray(point) ? point : [point?.x, point?.y, point?.z];
  return values.length >= 3 && values.slice(0, 3).every((value) => Number.isFinite(Number(value)))
    ? { x: Number(values[0]), y: Number(values[1]), z: Number(values[2]) }
    : null;
};

const distance3D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export const homeTourDirectorMethods = {
  _resetHomeTourState() {
    this.homeTourActive = false;
    this.homeTourPhase = 'idle';
    this.homeTourStops = [];
    this.homeTourStopIndex = 0;
    this.homeTourTotalStops = 0;
    this.homeTourCurrentStop = null;
    this.homeTourMotion = null;
    this.homeTourRoute = null;
    this.homeTourRouteController = null;
    this.homeTourFailure = null;
    this.homeTourVisitedAreaIds = new Set();
    this.homeTourLastUiAt = 0;
    this.homeTourRevealStartedAt = 0;
    this.homeTourSweepStartedAt = 0;
    this.homeTourRevealFromYaw = 0;
    this.homeTourShot = null;
    this.homeTourHeroName = null;
    this.homeTourRemainingMs = 0;
    this.homeTourPaused = false;
    this.homeTourPausedAt = 0;
    this.homeTourPausedBaseYaw = 0;
    this.homeTourPausedBasePitch = HOME_TOUR_PRESENTATION_BASE_PITCH;
    this.homeTourAdvanceAfterArrival = false;
    this.homeTourTotalDistanceMeters = 0;
    this.homeTourDoorOff = true;
    this.homeTourDoorVisibility = new Map();
    this.homeTourDoorExpressIds = new Set();
    this.homeTourDoorMeshesHidden = 0;
    this.homeTourFixedFovApplied = false;
  },

  _emitHomeTourState(extra = {}) {
    const activeStopIndex = this.homeTourActive && this.homeTourStops.length
      ? Math.min(this.homeTourTotalStops, this.homeTourStopIndex + 1)
      : this.homeTourVisitedAreaIds.size;
    const canControlStops = Boolean(this.homeTourActive && this.homeTourPhase !== 'planning');
    this.onState?.({
      type: 'home-tour',
      active: Boolean(this.homeTourActive),
      phase: this.homeTourPhase,
      stopIndex: activeStopIndex,
      totalStops: this.homeTourTotalStops,
      label: this.homeTourCurrentStop?.label || null,
      areaId: this.homeTourCurrentStop?.areaId || null,
      hero: this.homeTourHeroName || null,
      doorOff: this.homeTourDoorOff,
      doorMeshesHidden: this.homeTourDoorMeshesHidden || 0,
      visitedCount: this.homeTourVisitedAreaIds?.size || 0,
      remainingMs: this.homeTourRemainingMs || 0,
      paused: Boolean(this.homeTourPaused),
      canPreviousRoom: canControlStops && this.homeTourStopIndex > 0,
      canNextRoom: canControlStops && this.homeTourStopIndex < this.homeTourTotalStops - 1 && !this.homeTourAdvanceAfterArrival,
      totalDistanceMeters: this.homeTourTotalDistanceMeters || 0,
      failure: this.homeTourFailure,
      ...extra,
    });
  },

  setHomeTourDoorOff(value) {
    this.homeTourDoorOff = Boolean(value);
    if (this.homeTourActive) this._applyHomeTourDoorVisibility(this.homeTourDoorOff);
    this.onState?.({
      type: 'home-tour-door-off',
      value: this.homeTourDoorOff,
      hiddenCount: this.homeTourDoorMeshesHidden || 0,
    });
    return this.homeTourDoorOff;
  },

  _applyHomeTourDoorVisibility(hidden) {
    if (!this.model) return 0;
    if (!hidden) {
      for (const [object, previousVisible] of this.homeTourDoorVisibility.entries()) {
        if (object) object.visible = previousVisible;
      }
      const restored = this.homeTourDoorVisibility.size;
      this.homeTourDoorVisibility.clear();
      this.homeTourDoorMeshesHidden = 0;
      return restored;
    }

    if (this.homeTourDoorVisibility.size) return this.homeTourDoorVisibility.size;
    const doorIds = this.homeTourDoorExpressIds || new Set();
    let hiddenCount = 0;
    this.model.traverse((object) => {
      if (!object?.isMesh) return;
      const name = String(object.name || '');
      const match = name.match(/^Geom_(\d+)(?:_|$)/i);
      const expressMatch = Boolean(match && doorIds.has(Number(match[1])));
      const namedMatch = /^(?:ifc.?door|door(?:[_\s:-]|$)|hci_hosted_door(?:[_\s:-]|$))/i.test(name);
      if (!expressMatch && !namedMatch) return;
      this.homeTourDoorVisibility.set(object, object.visible);
      object.visible = false;
      hiddenCount += 1;
    });
    this.homeTourDoorMeshesHidden = hiddenCount;
    console.info('[HCI Home Tour] Door Off applied to presentation geometry.', {
      expressIds: doorIds.size,
      meshesHidden: hiddenCount,
    });
    return hiddenCount;
  },

  _isHomeTourSubjectVisible(subject) {
    if (!subject?.center || subject.visible === false || (subject.object && !subject.object.visible)) return false;
    if (typeof this._raycastPresentationOccluder !== 'function'
      || typeof this.position?.clone !== 'function'
      || typeof subject.center?.clone !== 'function') return true;

    const unit = Math.max(this.metersPerUnit || 1, 1e-6);
    const eye = this.position.clone();
    eye.y += (this.eyeHeight + this.heightOffset) * unit;
    const toTarget = subject.center.clone().sub(eye);
    const targetDistance = toTarget.length();
    if (!Number.isFinite(targetDistance) || targetDistance < 1e-5) return true;

    const hit = this._raycastPresentationOccluder(eye, toTarget.clone().normalize(), targetDistance);
    if (!hit) return true;
    const belongsToSubject = hit.object === subject.object || subject.meshObjects?.includes(hit.object);
    const tolerance = Math.max(0.32 * unit, targetDistance * 0.12);
    return Boolean(belongsToSubject || hit.distance >= targetDistance - tolerance);
  },

  _resolveHomeTourPresentation(stop) {
    const unit = Math.max(this.metersPerUnit || 1, 1e-6);
    const origin = { x: this.position.x, y: this.position.y, z: this.position.z };
    const areas = (Array.isArray(this.homeTourAreaSource) && this.homeTourAreaSource.length
      ? this.homeTourAreaSource
      : this.walkAreas || []);
    const allSubjects = (Array.isArray(this.presentationSubjects) ? this.presentationSubjects : [])
      .filter((subject) => subject?.center && [subject.center.x, subject.center.y, subject.center.z].every(Number.isFinite))
      .map((subject) => {
        const ownershipPoint = subject.basePosition || subject.center;
        const assignedAreaId = resolveHomeTourSubjectZone(ownershipPoint, areas, {
          metersPerUnit: unit,
          maxDistanceMeters: 4.5,
          minSeparationMeters: 0.5,
        });
        return {
          subject,
          assignedAreaId,
          distance: Math.hypot(subject.center.x - origin.x, subject.center.z - origin.z),
          areaDistance: Math.hypot(subject.center.x - stop.point.x, subject.center.z - stop.point.z),
        };
      })
      .filter((entry) => entry.distance >= 0.65 * unit && entry.distance <= 8.5 * unit && entry.areaDistance <= 8.5 * unit);

    const visibleSubjects = allSubjects.filter((entry) => this._isHomeTourSubjectVisible(entry.subject));
    // Do not trust the old nearest-center areaId attached during generic
    // presentation indexing. Recompute ownership with a separation margin and
    // never pull an ambiguous subject through a doorway from an adjacent zone.
    const roomPool = visibleSubjects.filter((entry) => entry.assignedAreaId === String(stop.areaId));
    const currentYaw = Number.isFinite(this.currentYaw) ? this.currentYaw : this.targetYaw;
    // The route tangent often points straight into the wall at the end of a
    // corridor. Re-compose the shot at the stop using structural raycasts and
    // only objects that passed this zone's ownership + visibility checks.
    const composition = selectHomeTourCompositionHeading({
      origin,
      currentYaw,
      subjects: roomPool.map((entry) => ({
        id: entry.subject.id,
        center: {
          x: entry.subject.center.x,
          y: entry.subject.center.y,
          z: entry.subject.center.z,
        },
        priority: entry.subject.heroPriority || (entry.subject.role === 'furniture' ? 9 : 5),
      })),
      opennessScore: (yaw) => this._headingWallGuardScore?.(this.position, yaw) ?? 0,
      opennessAvailable: Boolean(this.model),
      sampleCount: HOME_TOUR_SWEEP_SAMPLE_COUNT,
    });
    const heroEntry = composition.subjectId
      ? roomPool.find((entry) => String(entry.subject.id) === composition.subjectId) || null
      : null;
    const hero = heroEntry ? {
      id: heroEntry.subject.id,
      name: heroEntry.subject.name || heroEntry.subject.role || 'Room highlight',
      areaId: heroEntry.assignedAreaId,
      center: {
        x: heroEntry.subject.center.x,
        y: heroEntry.subject.center.y,
        z: heroEntry.subject.center.z,
      },
    } : null;
    const roomSubjects = roomPool.map((entry) => ({
      id: entry.subject.id,
      name: entry.subject.name || entry.subject.role || 'Room element',
      priority: entry.subject.heroPriority || (entry.subject.role === 'furniture' ? 9 : 5),
      center: {
        x: entry.subject.center.x,
        y: entry.subject.center.y,
        z: entry.subject.center.z,
      },
    }));

    // When no room-owned element is trustworthy, keep the arrival heading
    // from the safe route tangent. A coarse area center can sit behind a wall,
    // so it must not become an automatic camera target.
    const shot = buildHomeTourPresentationShot({
      origin,
      eyeHeightMeters: (this.eyeHeight || 1.68) + (this.heightOffset || 0),
      metersPerUnit: unit,
      currentYaw: Number.isFinite(composition.yaw) ? composition.yaw : currentYaw,
      hero,
      fallbackTarget: null,
      subjects: roomSubjects,
      headingSamples: composition.headingSamples,
      opennessReliable: composition.opennessReliable,
    });
    return shot ? { ...shot, heroSubject: heroEntry?.subject || null } : null;
  },

  async startHomeTour() {
    if (this.homeTourActive) return false;
    if (this.viewMode !== 'walk') {
      this.homeTourFailure = 'Enter the 3D walkthrough before starting Home Tour.';
      this.homeTourPhase = 'failed';
      this._emitHomeTourState({ failure: this.homeTourFailure });
      this.onState?.({ type: 'home-tour-error', message: this.homeTourFailure });
      return false;
    }
    if (!this.jobId || !this.apiBaseUrl || !this.position) {
      this._failHomeTour('The current project or walkthrough camera is not ready for Home Tour.');
      return false;
    }

    // Finish any other presentation mode before owning the walkthrough camera.
    if (this.walkMode !== 'guided') this.setWalkMode?.('guided');
    this.cancelSmart720Tour?.('home-tour-start');
    this.exitImmersivePresentation?.();
    this.path = null;
    this.pathIndex = 0;
    this.directTravel = null;
    this.pathVelocity?.set?.(0, 0, 0);
    this.velocity?.set?.(0, 0, 0);
    this.blockedTime = 0;
    this.stuck = false;
    this.recoveryAvailable = false;
    this.onState?.({ type: 'stuck', available: false });
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = true;
    this.guidedManualActive = false;
    this.guidedApproachActive = false;
    this.guidedRevealActive = false;
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;

    this.homeTourActive = true;
    this.homeTourPhase = 'planning';
    this.homeTourFailure = null;
    this.homeTourStops = [];
    this.homeTourStopIndex = 0;
    this.homeTourTotalStops = 0;
    this.homeTourCurrentStop = null;
    this.homeTourMotion = null;
    this.homeTourRoute = null;
    this.homeTourVisitedAreaIds = new Set();
    this.homeTourRemainingMs = 0;
    this.homeTourPaused = false;
    this.homeTourPausedAt = 0;
    this.homeTourPausedBaseYaw = 0;
    this.homeTourPausedBasePitch = HOME_TOUR_PRESENTATION_BASE_PITCH;
    this.homeTourAdvanceAfterArrival = false;
    this.homeTourLastUiAt = 0;
    this.homeTourTotalDistanceMeters = 0;
    this.homeTourFixedFovApplied = false;
    this.currentPitch = HOME_TOUR_CAMERA_PITCH;
    this.targetPitch = HOME_TOUR_CAMERA_PITCH;
    this.pitch = HOME_TOUR_CAMERA_PITCH;
    this.homeTourRouteController = new AbortController();
    const signal = this.homeTourRouteController.signal;
    this._emitHomeTourState({ phase: 'planning' });

    try {
      const origin = { x: this.position.x, y: this.position.y, z: this.position.z };
      let payload = null;
      let backendFailure = null;
      let routeRequestTimedOut = false;
      const routeRequestTimeout = setTimeout(() => {
        routeRequestTimedOut = true;
        this.homeTourRouteController?.abort?.();
      }, HOME_TOUR_ROUTE_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(
          `${this.apiBaseUrl.replace(/\/$/, '')}/api/projects/${encodeURIComponent(this.jobId)}/home-tour/route`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin }),
            signal,
            cache: 'no-store',
          },
        );
        const responsePayload = await response.json().catch(() => ({}));
        if (!response.ok || !responsePayload?.success) {
          const details = Array.isArray(responsePayload?.unreachableAreas) && responsePayload.unreachableAreas.length
            ? ` Unreachable area IDs: ${responsePayload.unreachableAreas.join(', ')}.`
            : '';
          throw new Error(`${responsePayload?.error || `Home Tour route request failed (${response.status}).`}${details}`);
        }
        payload = responsePayload;
      } catch (error) {
        if ((!routeRequestTimedOut && signal.aborted) || !this.homeTourActive) return false;
        backendFailure = routeRequestTimedOut
          ? new Error(`Home Tour route service timed out after ${HOME_TOUR_ROUTE_REQUEST_TIMEOUT_MS}ms.`)
          : error;
      } finally {
        clearTimeout(routeRequestTimeout);
      }
      if (routeRequestTimedOut) payload = null;
      if (!this.homeTourActive) return false;

      const expectedTourAreas = getHomeTourExpectedAreas(
        Array.isArray(this.homeTourAreaSource) && this.homeTourAreaSource.length
          ? this.homeTourAreaSource
          : (Array.isArray(this.walkAreas) ? this.walkAreas : []),
        this.hotspots,
      );
      if (payload?.route && !isHomeTourRouteComplete(payload.route, expectedTourAreas)) {
        console.warn('[HCI Home Tour] Backend returned a stale or incomplete route. Rebuilding from the loaded NavMesh.', {
          jobId: this.jobId,
          expectedAreaIds: expectedTourAreas.map((area) => String(area?.id || '')).filter(Boolean),
          receivedAreaIds: Array.isArray(payload.route.stops)
            ? payload.route.stops.map((stop) => String(stop?.areaId || ''))
            : [],
          receivedStopCount: Array.isArray(payload.route.stops) ? payload.route.stops.length : 0,
        });
        backendFailure = new Error('The backend route did not cover every loaded navigation zone.');
        payload = null;
      }

      if (!payload) {
        // The GLB, hotspots, and serialized NavMesh are already loaded in the
        // walkthrough. If the dedicated API is temporarily unavailable (or an
        // older backend has not yet received the Home Tour route), build the
        // exact same complete-path contract from that in-memory NavMesh. This
        // is a resilience fallback, not a straight-line or teleport fallback.
        const localPlan = buildLocalHomeTourRoute({
          areas: this.homeTourAreaSource,
          hotspots: this.hotspots,
          origin,
          metersPerUnit: this.metersPerUnit,
          query: this.query,
          filter: this.filter,
        });
        if (!localPlan.ok) {
          console.error('[HCI Home Tour] Backend route unavailable and local NavMesh fallback failed.', {
            jobId: this.jobId,
            backendError: backendFailure?.message || 'Unknown backend error',
            localError: localPlan.error,
            code: localPlan.code,
            unreachableAreas: localPlan.unreachableAreas || [],
          });
          throw new Error('We could not validate a continuous route through every room. Your walkthrough is still available; please try again after the navigation data has been repaired.');
        }
        payload = {
          success: true,
          route: localPlan.route,
          cacheHit: false,
          routeSource: 'local-navmesh-fallback',
        };
        console.warn('[HCI Home Tour] Using the loaded NavMesh because the Home Tour API was unavailable.', {
          jobId: this.jobId,
          backendError: backendFailure?.message || 'Unknown backend error',
          rooms: localPlan.route.areaCount,
        });
      }

      if (!this.homeTourActive || (signal.aborted && !routeRequestTimedOut)) return false;

      const route = payload.route;
      if (!isHomeTourRouteComplete(route, expectedTourAreas)) {
        throw new Error('The Home Tour itinerary does not cover every navigation zone with a complete, safe path. No movement was started.');
      }
      const metersPerUnit = Number(route.metersPerUnit);
      if (!Number.isFinite(metersPerUnit) || metersPerUnit <= 0) {
        throw new Error('The backend Home Tour route is missing its physical scene scale.');
      }

      const stops = route.stops.map((stop, index) => {
        const point = finitePoint(stop?.point);
        const path = Array.isArray(stop?.route) ? stop.route.map(finitePoint) : [];
        if (!point || !path.length || path.some((entry) => !entry)) {
          throw new Error(`The Home Tour route for ${stop?.label || `area ${index + 1}`} is malformed.`);
        }
        return {
          areaId: String(stop.areaId || `area-${index + 1}`),
          label: String(stop.label || `Area ${index + 1}`),
          point,
          path,
          routeLengthMeters: Number(stop.routeLengthMeters) || 0,
          role: String(stop.role || 'room-center'),
        };
      });

      this.homeTourRoute = route;
      this.homeTourStops = stops;
      this.homeTourTotalStops = stops.length;
      this.homeTourTotalDistanceMeters = Number(route.totalDistanceMeters) || 0;
      this.metersPerUnit = metersPerUnit;
      // The backend has validated and snapped this exact origin on the same
      // serialized NavMesh used to construct every leg.
      this.position.set(route.origin.x, route.origin.y, route.origin.z);
      if (this.homeTourDoorOff) this._applyHomeTourDoorVisibility(true);
      this.homeTourRouteController = null;
      this._emitHomeTourState({
        phase: 'traveling',
        cacheHit: Boolean(payload.cacheHit),
        routeSource: payload.routeSource || route.source || 'backend',
        totalDistanceMeters: this.homeTourTotalDistanceMeters,
      });
      this._startHomeTourNextLeg(performance.now());
      return true;
    } catch (error) {
      if (signal.aborted || !this.homeTourActive) return false;
      this._failHomeTour(error?.message || 'Home Tour route planning failed.');
      return false;
    }
  },

  _resumeHomeTourForCommand(now = performance.now()) {
    if (!this.homeTourPaused) return false;
    const pausedFor = Math.max(0, now - (Number(this.homeTourPausedAt) || now));
    if (this.homeTourPhase === 'revealing') this.homeTourRevealStartedAt += pausedFor;
    if (this.homeTourPhase === 'sweeping') this.homeTourSweepStartedAt += pausedFor;
    this.homeTourPaused = false;
    this.homeTourPausedAt = 0;
    this.homeTourPausedBaseYaw = 0;
    this.homeTourPausedBasePitch = HOME_TOUR_PRESENTATION_BASE_PITCH;
    return true;
  },

  toggleHomeTourPause() {
    if (!this.homeTourActive || this.homeTourPhase === 'planning') return false;
    const now = performance.now();
    if (this.homeTourPaused) {
      this._resumeHomeTourForCommand(now);
    } else {
      this.homeTourPaused = true;
      this.homeTourPausedAt = now;
      this.homeTourPausedBaseYaw = Number.isFinite(this.currentYaw)
        ? this.currentYaw
        : (Number.isFinite(this.targetYaw) ? this.targetYaw : 0);
      this.homeTourPausedBasePitch = Number.isFinite(this.currentPitch)
        ? this.currentPitch
        : (Number.isFinite(this.targetPitch) ? this.targetPitch : HOME_TOUR_PRESENTATION_BASE_PITCH);
    }
    this._emitHomeTourState({ paused: this.homeTourPaused });
    return this.homeTourPaused;
  },

  nextHomeTourRoom() {
    if (!this.homeTourActive || this.homeTourPhase === 'planning') return false;
    if (this.homeTourStopIndex >= this.homeTourTotalStops - 1 || this.homeTourAdvanceAfterArrival) return false;
    const now = performance.now();
    this._resumeHomeTourForCommand(now);

    if (this.homeTourPhase === 'traveling') {
      // Do not splice unrelated paths or teleport from mid-corridor. Finish the
      // already validated leg, then bypass its room presentation and continue.
      this.homeTourAdvanceAfterArrival = true;
      this._emitHomeTourState({ phase: 'traveling', advanceAfterArrival: true });
      return true;
    }

    if (!['revealing', 'sweeping'].includes(this.homeTourPhase)) return false;
    this.homeTourAdvanceAfterArrival = false;
    this.homeTourStopIndex += 1;
    return this._startHomeTourNextLeg(now);
  },

  previousHomeTourRoom() {
    if (!this.homeTourActive || this.homeTourPhase === 'planning' || this.homeTourStopIndex <= 0) return false;
    const now = performance.now();
    this._resumeHomeTourForCommand(now);

    const currentIndex = this.homeTourStopIndex;
    const previousStop = this.homeTourStops[currentIndex - 1];
    if (!previousStop?.point) return false;
    const unit = Math.max(this.metersPerUnit || 1, 1e-6);
    let reversePath = [];

    if (this.homeTourPhase === 'traveling') {
      const motion = this.homeTourMotion;
      if (!motion?.path?.length) return false;
      // Reverse only the corridor section already traversed. This remains on
      // the previously validated NavMesh polyline; no Euclidean shortcut.
      reversePath = [
        { x: this.position.x, y: this.position.y, z: this.position.z },
        ...motion.path.slice(0, Math.max(1, Math.min(motion.index, motion.path.length))).reverse(),
      ];
    } else if (['revealing', 'sweeping'].includes(this.homeTourPhase)) {
      const currentStop = this.homeTourStops[currentIndex];
      if (!Array.isArray(currentStop?.path) || currentStop.path.length < 2) return false;
      reversePath = currentStop.path.slice().reverse().map((point) => ({ x: point.x, y: point.y, z: point.z }));
      reversePath[0] = { x: this.position.x, y: this.position.y, z: this.position.z };
    } else {
      return false;
    }

    const dedupedPath = [];
    for (const point of reversePath) {
      if (!finitePoint(point)) return false;
      if (!dedupedPath.length || distance3D(dedupedPath[dedupedPath.length - 1], point) > 1e-4 * unit) {
        dedupedPath.push(finitePoint(point));
      }
    }
    if (!dedupedPath.length) return false;
    const endpointError = distance3D(dedupedPath[dedupedPath.length - 1], previousStop.point);
    if (endpointError > 0.24 * unit) {
      console.warn('[HCI Home Tour] Previous-room corridor did not end at the previous validated stop.', {
        endpointErrorMeters: endpointError / unit,
        previousAreaId: previousStop.areaId,
      });
      return false;
    }

    this.homeTourAdvanceAfterArrival = false;
    this.homeTourStopIndex = currentIndex - 1;
    this.homeTourCurrentStop = previousStop;
    this.homeTourShot = null;
    this.homeTourHeroName = null;
    this.homeTourMotion = {
      path: dedupedPath,
      index: dedupedPath.length > 1 ? 1 : dedupedPath.length,
      lastDirection: null,
    };
    this.homeTourPhase = 'traveling';
    this.homeTourRemainingMs = 0;
    this.path = null;
    this.pathIndex = 0;
    this.velocity?.set?.(0, 0, 0);
    this._emitHomeTourState({ phase: 'traveling', direction: 'previous', routeLengthMeters: previousStop.routeLengthMeters });
    if (dedupedPath.length <= 1) this._arriveHomeTourStop(now);
    return true;
  },

  _startHomeTourNextLeg(now = performance.now()) {
    if (!this.homeTourActive) return false;
    if (this.homeTourStopIndex >= this.homeTourStops.length) return this._finishHomeTour();

    const stop = this.homeTourStops[this.homeTourStopIndex];
    if (!stop?.point || !Array.isArray(stop.path) || !stop.path.length) {
      return this._failHomeTour(`The precomputed route is missing a validated stop for ${stop?.label || 'the next area'}.`);
    }

    const pathStart = stop.path[0];
    const unit = Math.max(this.metersPerUnit || 1, 1e-6);
    if (distance3D(this.position, pathStart) > 0.24 * unit) {
      return this._failHomeTour(`The next route leg does not connect to the current camera position (${stop.label}). The tour stopped safely.`);
    }

    this.homeTourCurrentStop = stop;
    this.homeTourShot = null;
    this.homeTourHeroName = null;
    this.homeTourMotion = {
      path: stop.path,
      index: stop.path.length > 1 ? 1 : stop.path.length,
      lastDirection: null,
    };
    this.homeTourPhase = 'traveling';
    this.homeTourRemainingMs = 0;
    this.path = null;
    this.pathIndex = 0;
    this.velocity?.set?.(0, 0, 0);

    const firstTarget = stop.path[Math.min(1, stop.path.length - 1)];
    if (firstTarget) {
      const yaw = homeTourYawFromDirection(firstTarget.x - this.position.x, firstTarget.z - this.position.z);
      if (Number.isFinite(yaw)) this.targetYaw = yaw;
    }
    this.targetPitch = HOME_TOUR_CAMERA_PITCH;
    this._emitHomeTourState({
      phase: 'traveling',
      routeLengthMeters: stop.routeLengthMeters,
      legIndex: this.homeTourStopIndex,
    });

    if (stop.path.length <= 1) this._arriveHomeTourStop(now);
    return true;
  },

  _advanceHomeTourMotion(dt, now) {
    const motion = this.homeTourMotion;
    if (!motion) return this._failHomeTour('Home Tour lost its active, precomputed camera path.');
    const unit = Math.max(this.metersPerUnit || 1, 1e-6);
    const step = HOME_TOUR_CRUISE_SPEED_MPS * unit * Math.min(0.05, Math.max(0, dt));
    const advanced = advanceHomeTourPolyline({
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      path: motion.path,
      index: motion.index,
      distance: step,
    });
    if (advanced.invalid || !finitePoint(advanced.position)) {
      return this._failHomeTour('Home Tour received an invalid point in its precomputed route.');
    }

    this.position.set(advanced.position.x, advanced.position.y, advanced.position.z);
    motion.index = advanced.index;
    if (advanced.direction) motion.lastDirection = advanced.direction;

    const lookDirection = homeTourLookAheadDirection(
      motion.path,
      motion.index,
      this.position,
      HOME_TOUR_LOOK_AHEAD_METERS * unit,
    ) || motion.lastDirection;
    if (lookDirection) {
      const yaw = homeTourYawFromDirection(lookDirection.x, lookDirection.z);
      if (Number.isFinite(yaw)) this.targetYaw = yaw;
    }
    this.targetPitch = HOME_TOUR_CAMERA_PITCH;

    if (now - this.homeTourLastUiAt >= 300) {
      this.homeTourLastUiAt = now;
      this._emitHomeTourState({
        phase: 'traveling',
        legProgress: motion.path.length > 1 ? motion.index / (motion.path.length - 1) : 1,
      });
    }
    if (advanced.finished) this._arriveHomeTourStop(now);
    return true;
  },

  _arriveHomeTourStop(now = performance.now()) {
    const stop = this.homeTourCurrentStop;
    if (!stop) return this._failHomeTour('Home Tour reached a route endpoint without a room stop.');

    this.position.set(stop.point.x, stop.point.y, stop.point.z);
    this.homeTourMotion = null;
    if (this.homeTourAdvanceAfterArrival) {
      this.homeTourAdvanceAfterArrival = false;
      this.homeTourShot = null;
      this.homeTourHeroName = null;
      this.homeTourStopIndex += 1;
      this.homeTourPhase = 'traveling';
      this.homeTourLastUiAt = now;
      this._emitHomeTourState({ phase: 'traveling', skippedPresentationAreaId: stop.areaId });
      return this._startHomeTourNextLeg(now);
    }
    this.homeTourVisitedAreaIds.add(stop.areaId);
    this.homeTourShot = this._resolveHomeTourPresentation(stop);
    this.homeTourHeroName = this.homeTourShot?.hero?.name || null;
    this.homeTourPhase = 'revealing';
    this.homeTourRevealStartedAt = now;
    this.homeTourSweepStartedAt = 0;
    this.homeTourRevealFromYaw = Number.isFinite(this.currentYaw) ? this.currentYaw : this.targetYaw;
    this.homeTourRemainingMs = HOME_TOUR_HERO_REVEAL_MS + (this.homeTourShot?.sweepDurationMs || 0);
    this.targetPitch = HOME_TOUR_TOP_REVEAL_PITCH;
    this.homeTourLastUiAt = now;
    this._emitHomeTourState({
      phase: 'revealing',
      hero: this.homeTourHeroName,
      remainingMs: this.homeTourRemainingMs,
      revealMs: HOME_TOUR_HERO_REVEAL_MS,
      sweepMs: this.homeTourShot?.sweepDurationMs || 0,
      subjects: this.homeTourShot?.relevantSubjectCount || 0,
    });
    return true;
  },

  _updateHomeTour(now = performance.now(), dt = this._lastDt || 0.016) {
    if (!this.homeTourActive) return false;
    if (this.homeTourPhase === 'planning') return true;
    if (this.homeTourPaused) {
      const ambientPose = homeTourPausedCameraPose(now - this.homeTourPausedAt, {
        baseYaw: this.homeTourPausedBaseYaw,
        basePitch: this.homeTourPausedBasePitch,
      });
      this.targetYaw = ambientPose.yaw;
      this.targetPitch = ambientPose.pitch;
      return true;
    }

    if (this.homeTourPhase === 'traveling') {
      this._advanceHomeTourMotion(dt, now);
      return true;
    }

    if (this.homeTourPhase === 'revealing') {
      const shot = this.homeTourShot;
      const elapsed = Math.max(0, now - this.homeTourRevealStartedAt);
      const progress = Math.max(0, Math.min(1, elapsed / HOME_TOUR_HERO_REVEAL_MS));
      const pose = homeTourRevealPose(progress, {
        fromYaw: this.homeTourRevealFromYaw,
        toYaw: shot?.heroYaw ?? this.homeTourRevealFromYaw,
        heroPitch: shot?.heroPitch ?? HOME_TOUR_PRESENTATION_BASE_PITCH,
      });
      this.targetYaw = pose.yaw;
      this.targetPitch = pose.pitch;
      this.homeTourRemainingMs = Math.max(0, HOME_TOUR_HERO_REVEAL_MS - elapsed)
        + (shot?.sweepDurationMs || 0);

      if (now - this.homeTourLastUiAt >= 250 || progress >= 1) {
        this.homeTourLastUiAt = now;
        this._emitHomeTourState({
          phase: 'revealing',
          hero: this.homeTourHeroName,
          remainingMs: this.homeTourRemainingMs,
          revealProgress: progress,
        });
      }
      if (progress >= 1) {
        this.homeTourPhase = 'sweeping';
        this.homeTourSweepStartedAt = now;
        this.homeTourRemainingMs = shot?.sweepDurationMs || 0;
        this._emitHomeTourState({
          phase: 'sweeping',
          hero: this.homeTourHeroName,
          remainingMs: this.homeTourRemainingMs,
          sweepProgress: 0,
        });
      }
      return true;
    }

    if (this.homeTourPhase === 'sweeping') {
      const shot = this.homeTourShot;
      const duration = Math.max(1_000, Number(shot?.sweepDurationMs) || 1_000);
      const elapsed = Math.max(0, now - this.homeTourSweepStartedAt);
      const progress = Math.max(0, Math.min(1, elapsed / duration));
      const sweep = homeTourRoomSweepPose(progress, {
        rotationRadians: shot?.sweepRotationRadians ?? Math.PI * 2,
        direction: shot?.sweepDirection ?? 1,
        targets: shot?.panoramaTargets || [],
        basePitch: shot?.sweepBasePitch ?? shot?.heroPitch ?? HOME_TOUR_PRESENTATION_BASE_PITCH,
      });
      this.targetYaw = (shot?.heroYaw ?? this.homeTourRevealFromYaw) + sweep.yawOffset;
      this.targetPitch = sweep.pitch;
      this.homeTourRemainingMs = Math.max(0, duration - elapsed);

      if (now - this.homeTourLastUiAt >= 250 || progress >= 1) {
        this.homeTourLastUiAt = now;
        this._emitHomeTourState({
          phase: 'sweeping',
          hero: this.homeTourHeroName,
          remainingMs: this.homeTourRemainingMs,
          sweepProgress: progress,
        });
      }
      if (progress >= 1) {
        // The camera has completed the content-aware arc and returned to the
        // hero. Advance immediately; there is no additional 10/12-second hold.
        this.homeTourStopIndex += 1;
        this._startHomeTourNextLeg(now);
      }
      return true;
    }
    return true;
  },

  _failHomeTour(message) {
    this.homeTourRouteController?.abort?.();
    this.homeTourRouteController = null;
    this.homeTourActive = false;
    this.homeTourPaused = false;
    this.homeTourPausedAt = 0;
    this.homeTourAdvanceAfterArrival = false;
    this.homeTourPhase = 'failed';
    // Keep actionable technical detail in developer diagnostics, not in the
    // customer-facing walkthrough. A partial/unsafe tour must never be implied
    // to have completed successfully.
    console.error('[HCI Home Tour] Tour could not continue safely.', {
      jobId: this.jobId || null,
      reason: String(message || 'Unknown Home Tour failure'),
      visitedAreas: this.homeTourVisitedAreaIds?.size || 0,
      totalAreas: this.homeTourTotalStops || 0,
    });
    this.homeTourFailure = 'The complete Home Tour could not be prepared for this model. Your walkthrough is still available; choose a destination from the floor map to continue.';
    this.homeTourMotion = null;
    this.homeTourRoute = null;
    this.homeTourRemainingMs = 0;
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity?.set?.(0, 0, 0);
    this.velocity?.set?.(0, 0, 0);
    this.directTravel = null;
    this.blockedTime = 0;
    this.stuck = false;
    this.recoveryAvailable = false;
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = false;
    this._applyHomeTourDoorVisibility(false);
    this._emitHomeTourState({ failure: this.homeTourFailure });
    this.onState?.({ type: 'home-tour-error', message: this.homeTourFailure });
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', active: false });
    return false;
  },

  stopHomeTour(reason = 'manual-stop') {
    if (!this.homeTourActive) {
      this.homeTourRouteController?.abort?.();
      this.homeTourRouteController = null;
      this._applyHomeTourDoorVisibility(false);
      return false;
    }
    this.homeTourRouteController?.abort?.();
    this.homeTourRouteController = null;
    this.homeTourActive = false;
    this.homeTourPaused = false;
    this.homeTourPausedAt = 0;
    this.homeTourAdvanceAfterArrival = false;
    this.homeTourPhase = 'cancelled';
    this.homeTourMotion = null;
    this.homeTourRoute = null;
    this.homeTourRemainingMs = 0;
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity?.set?.(0, 0, 0);
    this.velocity?.set?.(0, 0, 0);
    this.directTravel = null;
    this.blockedTime = 0;
    this.stuck = false;
    this.recoveryAvailable = false;
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = false;
    this._applyHomeTourDoorVisibility(false);
    this._emitHomeTourState({ cancelled: true, reason });
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', active: false });
    return true;
  },

  _finishHomeTour() {
    if (!this.homeTourActive) return false;
    this.homeTourActive = false;
    this.homeTourPaused = false;
    this.homeTourPausedAt = 0;
    this.homeTourAdvanceAfterArrival = false;
    this.homeTourPhase = 'complete';
    this.homeTourMotion = null;
    this.homeTourRemainingMs = 0;
    this.homeTourRouteController = null;
    this.path = null;
    this.pathIndex = 0;
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = false;
    this.blockedTime = 0;
    this.stuck = false;
    this.recoveryAvailable = false;
    this._applyHomeTourDoorVisibility(false);
    this._emitHomeTourState({ completed: true, visitedCount: this.homeTourVisitedAreaIds.size });
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', active: false });
    this.fitView?.();
    this.setViewPreset?.('isometric');
    return true;
  },
};
