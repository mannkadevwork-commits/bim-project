import * as THREE from 'three';
import {
  buildCinematicTourOrder,
  routePolylineLength,
  resolveHomeTourRoomLabel,
  sortRoomStopCandidates,
  HOME_TOUR_ROOM_HOLD_MS,
  HOME_TOUR_COMPOSITION_SETTLE_MS,
  HOME_TOUR_MAX_STEP_METERS,
  homeTourYawFromDirection,
  homeTourAngleLerp,
  homeTourCameraDirection,
  homeTourSpeedForDistance,
} from './homeTourPlan.js';

const HOME_TOUR_ARRIVAL_TOLERANCE_METERS = 0.42;
const HOME_TOUR_WAYPOINT_TOLERANCE_METERS = 0.13;
const HOME_TOUR_CAMERA_TRAVEL_PITCH = -0.055;
const HOME_TOUR_CAMERA_SWEEP_DEGREES = 2.4;
const HOME_TOUR_STALL_REFRESH_MS = 620;
const HOME_TOUR_STALL_TRANSITION_MS = 1350;
const HOME_TOUR_PORTAL_FADE_MS = 760;
const HOME_TOUR_PORTAL_SWITCH_AT = 0.48;
const HOME_TOUR_UI_INTERVAL_MS = 45;

const ROLE_PRIORITY = {
  viewpoint: 0,
  'room-center': 1,
  'room-entrance': 2,
  transition: 3,
  walkpoint: 4,
};

function pointFromHotspot(hotspot) {
  const resolved = hotspot?.resolvedWalkPoint;
  if (resolved && [resolved.x, resolved.y, resolved.z].every(Number.isFinite)) {
    return { x: resolved.x, y: resolved.y, z: resolved.z, polyRef: resolved.polyRef || 0 };
  }
  const raw = hotspot?.position;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const [x, y, z] = raw.slice(0, 3).map(Number);
  return [x, y, z].every(Number.isFinite) ? { x, y, z, polyRef: 0 } : null;
}

function distanceXZ(a, b) {
  return Math.hypot(Number(a?.x) - Number(b?.x), Number(a?.z) - Number(b?.z));
}

function smooth01(value) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export const homeTourDirectorMethods = {
  _resetHomeTourState() {
    this.homeTourActive = false;
    this.homeTourPhase = 'idle';
    this.homeTourStops = [];
    this.homeTourStopIndex = 0;
    this.homeTourTotalStops = 0;
    this.homeTourCurrentStop = null;
    this.homeTourExpectedPoint = null;
    this.homeTourMotion = null;
    this.homeTourHoldUntil = 0;
    this.homeTourLastUiAt = 0;
    this.homeTourFailure = null;
    this.homeTourDoorOff = true;
    this.homeTourDoorVisibility = new Map();
    this.homeTourDoorExpressIds = new Set();
    this.homeTourDoorMeshesHidden = 0;
    this.homeTourVisitedAreaIds = new Set();
    this.homeTourLastHeroName = null;
    this.homeTourTransition = null;
    this.homeTourTransitionOpacity = 0;
    this.homeTourLastMoveDirection = new THREE.Vector3();
    this.homeTourLastMoveAt = 0;
    this.homeTourRouteRefreshCount = 0;
    this.homeTourAimYaw = null;
    this.homeTourAimPitch = HOME_TOUR_CAMERA_TRAVEL_PITCH;
    this.homeTourCompositionUntil = 0;
    this.homeTourPresentationStartedAt = 0;
  },

  _emitHomeTourState(extra = {}) {
    const currentIsRoom = this.homeTourCurrentStop?.kind === 'room';
    const visitedCount = this.homeTourVisitedAreaIds?.size || 0;
    const progress = this.homeTourActive && currentIsRoom && !this.homeTourVisitedAreaIds.has(this.homeTourCurrentStop?.areaId)
      ? Math.min(this.homeTourTotalStops, visitedCount + 1)
      : visitedCount;
    this.onState?.({
      type: 'home-tour',
      active: Boolean(this.homeTourActive),
      phase: this.homeTourPhase,
      stopIndex: progress,
      totalStops: this.homeTourTotalStops,
      label: this.homeTourCurrentStop?.label || null,
      areaId: this.homeTourCurrentStop?.areaId || null,
      hero: this.homeTourLastHeroName,
      doorOff: this.homeTourDoorOff,
      doorMeshesHidden: this.homeTourDoorMeshesHidden || 0,
      visitedCount,
      failure: this.homeTourFailure,
      transitionOpacity: this.homeTourTransitionOpacity || 0,
      transitionReason: this.homeTourTransition?.reason || null,
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

  _resolveHomeTourAreaStop(area) {
    if (!area?.id || !Array.isArray(area.center) || area.center.length < 3) return null;
    const areaHotspots = (this.hotspots || [])
      .filter((hotspot) => hotspot?.areaId === area.id && Array.isArray(hotspot.position));
    const ordered = sortRoomStopCandidates(areaHotspots);
    const candidates = [];
    const seen = [];

    for (const hotspot of ordered) {
      const raw = pointFromHotspot(hotspot);
      // Re-snap every serialized hotspot against the NavMesh loaded for this
      // exact job. A resolved point from an older compiler run can carry stale
      // coordinates/poly refs even when its JSON still looks valid.
      const snapped = raw && this._closestWalkPoint(raw, 0.95);
      const point = snapped ? { ...snapped, validatedByNavMesh: true } : null;
      if (!point) continue;
      if (seen.some((entry) => distanceXZ(entry, point) < 0.22 * Math.max(this.metersPerUnit || 1, 1e-6))) continue;
      seen.push(point);
      candidates.push({
        point,
        hotspot,
        role: hotspot.presentationRole || 'room-center',
        clearanceMeters: Number(hotspot.clearanceMeters) || 0,
        displayOrder: Number(hotspot.displayOrder) || 999,
      });
    }

    // A room center is a fallback, not an assumption that its centroid is the
    // best camera position. Prefer a curated viewpoint with more clearance.
    const snappedCenter = this._closestWalkPoint(area.center, 1.15);
    const center = snappedCenter ? { ...snappedCenter, validatedByNavMesh: true } : null;
    if (center && !seen.some((entry) => distanceXZ(entry, center) < 0.22 * Math.max(this.metersPerUnit || 1, 1e-6))) {
      candidates.push({
        point: center,
        hotspot: null,
        role: 'room-center',
        clearanceMeters: 0,
        displayOrder: 999,
      });
    }
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const roleA = ROLE_PRIORITY[a.role] ?? 8;
      const roleB = ROLE_PRIORITY[b.role] ?? 8;
      // Prefer a real room viewpoint or interior center over a doorway marker.
      // Clearance is the tie-breaker within a role; otherwise the tour tends
      // to stop at the threshold and frame a door jamb instead of the room.
      return (roleA - roleB) || (b.clearanceMeters - a.clearanceMeters) || (a.displayOrder - b.displayOrder);
    });

    const best = candidates[0];
    const fallbackLabel = area.label || best.hotspot?.areaLabel || best.hotspot?.label || `Room ${area.id}`;
    const fallbackHotspot = best.hotspot || {
      id: `home-tour-${area.id}`,
      areaId: area.id,
      areaLabel: fallbackLabel,
      label: fallbackLabel,
      position: [best.point.x, best.point.y, best.point.z],
      resolvedWalkPoint: best.point,
      presentationRole: 'room-center',
    };

    return {
      id: `home-tour-${area.id}`,
      areaId: area.id,
      label: fallbackLabel,
      hotspot: fallbackHotspot,
      point: best.point,
      candidates,
      kind: 'room',
    };
  },

  _computeHomeTourRoute(from, stop) {
    if (!this.query || !from || !stop?.candidates?.length) return null;
    let best = null;
    for (const candidate of stop.candidates) {
      const point = candidate.point;
      let result = null;
      try {
        result = this.query.computePath(
          { x: from.x, y: from.y, z: from.z },
          { x: point.x, y: point.y, z: point.z },
          { filter: this.filter, maxPathSize: 512, maxStraightPathSize: 512 },
        );
      } catch (_) {
        result = null;
      }
      const status = this._inspectPathEndpoint(result, point, 0.32);
      if (!status.complete) continue;
      const length = routePolylineLength(result.path, from);
      if (!Number.isFinite(length)) continue;
      if (!best || length < best.length) {
        best = { complete: true, path: result.path.map((p) => ({ x: p.x, y: p.y, z: p.z })), length, candidate };
      }
    }
    return best;
  },

  _buildHomeTourPlan() {
    // Interactive floor-map areas are filtered to those with at least one
    // displayable hotspot. Home Tour uses the original compiler-authored area
    // list as well, so one rejected marker cannot silently remove a whole room.
    const areas = Array.isArray(this.homeTourAreaSource) && this.homeTourAreaSource.length
      ? this.homeTourAreaSource
      : (Array.isArray(this.walkAreas) ? this.walkAreas : []);
    if (!areas.length || !this.query || !this.position) {
      return { ok: false, reason: 'This floor does not contain validated room presentation anchors.' };
    }

    const stops = areas.map((area) => this._resolveHomeTourAreaStop(area));
    if (stops.some((stop) => !stop)) {
      const missing = areas.filter((_, index) => !stops[index]).map((area) => area.label || area.id);
      return {
        ok: false,
        reason: `No safe on-floor presentation position could be validated for: ${missing.join(', ')}. No room was removed from the tour.`,
      };
    }

    const origin = { x: this.position.x, y: this.position.y, z: this.position.z };
    const ordered = buildCinematicTourOrder({
      stops,
      origin,
      routeBetween: (from, stop) => this._computeHomeTourRoute(from, stop),
    });
    if (!ordered.ok) return ordered;
    return { ok: true, stops: ordered.ordered, totalStops: ordered.totalStops };
  },

  startHomeTour() {
    if (this.homeTourActive) return false;
    if (this.viewMode !== 'walk') {
      this.homeTourFailure = 'Enter the 3D walkthrough before starting Home Tour.';
      this._emitHomeTourState({ phase: 'failed', failure: this.homeTourFailure });
      this.onState?.({ type: 'home-tour-error', message: this.homeTourFailure });
      return false;
    }
    // Home Tour owns presentation camera choreography; switch to Guided
    // automatically instead of making the user configure a prerequisite.
    if (this.walkMode !== 'guided') this.setWalkMode?.('guided');
    if (!this.query || !this.position) {
      this.homeTourFailure = 'The floor navigation data is not ready. Reload the walkthrough and try again.';
      this._emitHomeTourState({ phase: 'failed', failure: this.homeTourFailure });
      this.onState?.({ type: 'home-tour-error', message: this.homeTourFailure });
      return false;
    }

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
    this.guidedManualYawUntil = 0;
    this.guidedApproachActive = false;
    this.guidedRevealActive = false;
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;

    // Reacquire the camera's current NavMesh polygon before preflight. This
    // avoids starting the dedicated follower with a stale polyRef left by a
    // prior room-selection or view transition.
    const startAnchor = this._closestWalkPoint(this.position, 0.65);
    if (startAnchor) {
      this.position.set(startAnchor.x, startAnchor.y, startAnchor.z);
      this.currentPolyRef = startAnchor.polyRef || this.currentPolyRef;
      this.lastMovementPosition?.copy?.(this.position);
    }

    const plan = this._buildHomeTourPlan();
    if (!plan.ok) {
      this.homeTourActive = false;
      this.homeTourPhase = 'failed';
      this.homeTourFailure = plan.reason;
      this._emitHomeTourState({ failure: plan.reason });
      this.onState?.({ type: 'home-tour-error', message: plan.reason });
      return false;
    }

    this.homeTourActive = true;
    this.homeTourPhase = 'preflight-complete';
    this.homeTourStops = [...plan.stops];
    this.homeTourStopIndex = 0;
    this.homeTourTotalStops = plan.totalStops;
    this.homeTourCurrentStop = null;
    this.homeTourExpectedPoint = null;
    this.homeTourMotion = null;
    this.homeTourHoldUntil = 0;
    this.homeTourLastUiAt = 0;
    this.homeTourFailure = null;
    this.homeTourVisitedAreaIds = new Set();
    this.homeTourLastHeroName = null;
    this.homeTourTransition = null;
    this.homeTourTransitionOpacity = 0;
    this.homeTourLastMoveAt = performance.now();
    this.homeTourRouteRefreshCount = 0;
    this.homeTourAimYaw = null;
    this.homeTourAimPitch = HOME_TOUR_CAMERA_TRAVEL_PITCH;
    this.homeTourCompositionUntil = 0;
    this.homeTourPresentationStartedAt = 0;
    if (this.homeTourDoorOff) this._applyHomeTourDoorVisibility(true);
    this._emitHomeTourState({ phase: 'preflight-complete' });
    this._startHomeTourNextLeg(performance.now());
    return true;
  },

  _startHomeTourNextLeg(now = performance.now()) {
    if (!this.homeTourActive) return false;
    if (this.homeTourStopIndex >= this.homeTourStops.length) return this._finishHomeTour();

    const stop = this.homeTourStops[this.homeTourStopIndex];
    if (!stop?.point || !stop?.areaId) {
      return this._failHomeTour(`Home Tour has no validated camera anchor for ${stop?.label || 'the next room'}.`);
    }

    this.homeTourCurrentStop = stop;
    this.homeTourExpectedPoint = stop.point;
    this.activeHotspotId = stop.hotspot?.id || null;
    this.guidedPresentationAreaId = stop.areaId;
    this.guidedTourLastAreaId = stop.areaId;
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = true;
    this.guidedTransitionKind = 'room-crossing';
    this.guidedApproachActive = false;
    this.guidedRevealActive = false;
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;
    this.homeTourLastHeroName = null;
    this.homeTourRouteRefreshCount = 0;

    const fromSnap = this._closestWalkPoint(this.position, 0.35);
    if (fromSnap) {
      this.position.set(fromSnap.x, fromSnap.y, fromSnap.z);
      this.currentPolyRef = fromSnap.polyRef || this.currentPolyRef;
    }
    const from = { x: this.position.x, y: this.position.y, z: this.position.z };
    const route = this._computeHomeTourRoute(from, stop);
    const unit = Math.max(this.metersPerUnit || 1, 1e-6);
    const alreadyAtStop = distanceXZ(from, stop.point) <= HOME_TOUR_ARRIVAL_TOLERANCE_METERS * unit;
    if (alreadyAtStop) {
      this._arriveHomeTourStop(now);
      return true;
    }
    if (route?.complete && route.path?.length >= 2 && route.length > 0.28 * unit) {
      this.homeTourCurrentStop = { ...stop, point: route.candidate.point };
      this.homeTourExpectedPoint = route.candidate.point;
      this.homeTourMotion = {
        path: route.path,
        index: 1,
        polyRef: fromSnap?.polyRef || this.currentPolyRef || 0,
        target: route.candidate.point,
        speed: 0,
        cameraDirection: new THREE.Vector3(
          route.path[1].x - from.x,
          0,
          route.path[1].z - from.z,
        ).normalize(),
        actualMoveDirection: new THREE.Vector3(),
        lastActualMoveAt: now,
        noProgressMs: 0,
        progressWindowMs: 0,
        progressWindowDistance: 0,
        lastProgressAt: now,
        lastPosition: from,
        routeRefreshUsed: false,
        lastPolyReacquireAt: 0,
        startedAt: now,
      };
      this.path = route.path;
      this.pathIndex = 0;
      this.pathVelocity?.set?.(0, 0, 0);
      this.velocity?.set?.(0, 0, 0);
      this.homeTourPhase = 'traveling';
      this._emitHomeTourState({
        phase: 'traveling',
        routeLengthMeters: Number((route.length / Math.max(this.metersPerUnit || 1, 1e-6)).toFixed(2)),
        transitionMode: 'navmesh-walk',
      });
      return true;
    }

    // A disconnected or degenerate route does not stop the presentation. A
    // room-specific anchor is validated independently and entered by a short
    // fade-through transition rather than a visible teleport or wall clipping.
    const target = route?.candidate?.point || stop.point;
    const validated = this._closestWalkPoint(target, 0.45);
    if (!validated) return this._failHomeTour(`No safe presentation anchor remains available for ${stop.label}.`);
    this.homeTourCurrentStop = { ...stop, point: validated };
    this.homeTourExpectedPoint = validated;
    this._beginHomeTourPortalTransition(now, 'no-complete-navmesh-route', validated);
    return true;
  },

  _refreshHomeTourRoute(now, reason = 'local-progress-refresh') {
    const motion = this.homeTourMotion;
    const stop = this.homeTourCurrentStop;
    if (!motion || !stop || motion.routeRefreshUsed) return false;
    // Consume the one refresh allowance even when local snapping fails; do not
    // hammer the NavMesh query every frame while the camera is stalled.
    motion.routeRefreshUsed = true;

    const snapped = this._closestWalkPoint(this.position, 0.16);
    if (!snapped || Math.hypot(snapped.x - this.position.x, snapped.y - this.position.y, snapped.z - this.position.z) > 0.12 * Math.max(this.metersPerUnit || 1, 1e-6)) {
      return false;
    }
    this.position.set(snapped.x, snapped.y, snapped.z);
    this.currentPolyRef = snapped.polyRef || this.currentPolyRef;

    const route = this._computeHomeTourRoute(snapped, stop);
    if (!route?.complete || !route.path?.length) return false;

    motion.path = route.path;
    motion.index = route.path.length > 1 ? 1 : 0;
    motion.polyRef = snapped.polyRef || this.currentPolyRef || motion.polyRef;
    motion.target = route.candidate.point;
    motion.speed = 0;
    const firstRoutePoint = route.path[Math.min(1, route.path.length - 1)];
    motion.cameraDirection = new THREE.Vector3(
      firstRoutePoint.x - snapped.x,
      0,
      firstRoutePoint.z - snapped.z,
    ).normalize();
    motion.actualMoveDirection = new THREE.Vector3();
    motion.lastActualMoveAt = now;
    motion.noProgressMs = 0;
    motion.progressWindowMs = 0;
    motion.progressWindowDistance = 0;
    motion.lastPolyReacquireAt = now;
    motion.lastProgressAt = now;
    motion.lastPosition = { x: snapped.x, y: snapped.y, z: snapped.z };
    this.homeTourExpectedPoint = motion.target;
    this.homeTourCurrentStop = { ...stop, point: motion.target };
    this.path = motion.path;
    this.pathIndex = 0;
    this.homeTourRouteRefreshCount += 1;
    this.onState?.({ type: 'home-tour-diagnostic', event: reason, routeRefreshes: this.homeTourRouteRefreshCount });
    return true;
  },

  _advanceHomeTourMotion(dt, now) {
    const motion = this.homeTourMotion;
    if (!motion || !this.query) return false;
    const unit = Math.max(this.metersPerUnit || 1, 1e-6);
    const waypointTolerance = HOME_TOUR_WAYPOINT_TOLERANCE_METERS * unit;

    while (motion.index < motion.path.length) {
      const waypoint = motion.path[motion.index];
      if (distanceXZ(this.position, waypoint) > waypointTolerance) break;
      motion.index += 1;
    }

    if (motion.index >= motion.path.length) {
      const remaining = Math.hypot(
        this.position.x - motion.target.x,
        this.position.y - motion.target.y,
        this.position.z - motion.target.z,
      );
      if (remaining <= HOME_TOUR_ARRIVAL_TOLERANCE_METERS * unit) {
        this._arriveHomeTourStop(now);
        return true;
      }
      if (this._refreshHomeTourRoute(now, 'straight-path-endpoint-short')) return true;
      this._beginHomeTourPortalTransition(now, 'path-ended-before-room-anchor', motion.target);
      return true;
    }

    const waypoint = motion.path[motion.index];
    const dx = waypoint.x - this.position.x;
    const dz = waypoint.z - this.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-5) {
      motion.index += 1;
      return true;
    }

    // Smooth acceleration with a controlled slowdown as the actual destination
    // nears. Every movement request is a small Detour surface-constrained step.
    const finalDistance = Math.hypot(motion.target.x - this.position.x, motion.target.z - this.position.z);
    const finalDistanceMeters = finalDistance / unit;
    const targetSpeed = homeTourSpeedForDistance(finalDistanceMeters) * unit;
    // Gentle acceleration, a relaxed architectural walking pace, and a slow
    // final approach. The old 8 mm minimum step accidentally overrode slow speed.
    motion.speed += (targetSpeed - motion.speed) * (1 - Math.exp(-2.2 * dt));
    const stepLength = Math.min(
      distance,
      HOME_TOUR_MAX_STEP_METERS * unit,
      Math.max(0.001 * unit, motion.speed * dt),
    );
    const desired = {
      x: this.position.x + (dx / distance) * stepLength,
      y: this.position.y,
      z: this.position.z + (dz / distance) * stepLength,
    };

    const from = { x: this.position.x, y: this.position.y, z: this.position.z };
    let polyRef = motion.polyRef || this.currentPolyRef || 0;
    const resolveCurrentPolygon = () => {
      const resolved = this._resolveMovementPolygon?.(from);
      if (!resolved?.polyRef || !resolved.point) return null;
      const correction = Math.hypot(
        resolved.point.x - from.x,
        resolved.point.y - from.y,
        resolved.point.z - from.z,
      );
      if (correction > 0.18 * unit) return null;
      return { polyRef: resolved.polyRef, point: resolved.point, correction };
    };

    let moved = null;
    const moveStep = (ref, startPoint) => this.query.moveAlongSurface(ref, startPoint, desired, {
      filter: this.filter,
      maxVisitedSize: 128,
    });

    if (!polyRef) {
      const resolved = resolveCurrentPolygon();
      if (resolved) {
        polyRef = resolved.polyRef;
        if (resolved.correction > 0.0005 * unit) {
          this.position.set(resolved.point.x, resolved.point.y, resolved.point.z);
          from.x = resolved.point.x; from.y = resolved.point.y; from.z = resolved.point.z;
        }
      }
    }

    if (polyRef) {
      try { moved = moveStep(polyRef, from); } catch (_) { moved = null; }
    }

    // Detour can reject a stale cached polygon ref even though the camera is
    // still on a valid nearby polygon. Reacquire locally and repeat this same
    // sub-step once, matching the runtime's normal movement safety contract.
    if ((!moved?.success || !moved.resultPosition)
      && now - (motion.lastPolyReacquireAt || 0) >= 180) {
      motion.lastPolyReacquireAt = now;
      const resolved = resolveCurrentPolygon();
      if (resolved) {
        polyRef = resolved.polyRef;
        motion.polyRef = polyRef;
        motion.lastPolyReacquireAt = now;
        this.currentPolyRef = polyRef;
        if (resolved.correction > 0.0005 * unit) {
          this.position.set(resolved.point.x, resolved.point.y, resolved.point.z);
          from.x = resolved.point.x; from.y = resolved.point.y; from.z = resolved.point.z;
        }
        try { moved = moveStep(polyRef, from); } catch (_) { moved = null; }
        this.onState?.({ type: 'home-tour-diagnostic', event: 'local-poly-ref-reacquired' });
      }
    }

    let movedDistance = 0;
    if (moved?.success && moved.resultPosition
      && [moved.resultPosition.x, moved.resultPosition.y, moved.resultPosition.z].every(Number.isFinite)) {
      movedDistance = Math.hypot(
        moved.resultPosition.x - from.x,
        moved.resultPosition.y - from.y,
        moved.resultPosition.z - from.z,
      );
      if (movedDistance > 0.00025 * unit) {
        this.position.set(moved.resultPosition.x, moved.resultPosition.y, moved.resultPosition.z);
        const visited = Array.isArray(moved.visited) ? moved.visited : [];
        // Prefer Detour's resulting polygon ref. The final visited polygon can
        // describe the corridor traversal, not necessarily the landed polygon.
        motion.polyRef = moved.resultPolyRef || moved.polyRef || moved.ref
          || (visited.length ? visited[visited.length - 1] : 0)
          || polyRef;
        this.currentPolyRef = motion.polyRef || this.currentPolyRef;
        this.lastMoveDirection.set(this.position.x - from.x, 0, this.position.z - from.z);
        if (this.lastMoveDirection.lengthSq() > 1e-8) {
          this.lastMoveDirection.normalize();
          // Record the movement actually accepted by Detour after surface
          // constraints. This is the camera-heading authority: it cannot point
          // behind the camera when a waypoint cursor advances or is clamped.
          motion.actualMoveDirection ||= new THREE.Vector3();
          motion.actualMoveDirection.copy(this.lastMoveDirection);
          motion.lastActualMoveAt = now;
        }
        motion.lastPosition = { x: this.position.x, y: this.position.y, z: this.position.z };
      }
    }

    // A tiny clamped move must not reset the watchdog every frame. Measure
    // progress over a short rolling window; normal tour movement is ~1.2 m/s,
    // so 3.5 cm per 350 ms is a deliberately forgiving minimum.
    motion.progressWindowMs = (motion.progressWindowMs || 0) + dt * 1000;
    motion.progressWindowDistance = (motion.progressWindowDistance || 0) + movedDistance;
    if (motion.progressWindowMs >= 350) {
      if (motion.progressWindowDistance >= 0.035 * unit) {
        motion.noProgressMs = 0;
        motion.lastProgressAt = now;
      } else {
        motion.noProgressMs += motion.progressWindowMs;
      }
      motion.progressWindowMs = 0;
      motion.progressWindowDistance = 0;
    }

    // Exactly one local corridor refresh is allowed. If it still cannot make
    // meaningful progress, use the room's prevalidated anchor under a short
    // full-frame fade. The client never watches the camera push against a wall.
    if (motion.noProgressMs >= HOME_TOUR_STALL_REFRESH_MS && !motion.routeRefreshUsed) {
      if (this._refreshHomeTourRoute(now, 'local-navmesh-corridor-refresh')) return true;
    }
    if (motion.noProgressMs >= HOME_TOUR_STALL_TRANSITION_MS) {
      this._beginHomeTourPortalTransition(now, 'local-navmesh-corridor-unavailable', motion.target);
      return true;
    }

    this.homeTourMotion = motion;
    this.path = motion.path;
    this.pathIndex = Math.max(0, motion.index - 1);
    this.homeTourLastMoveDirection.copy(this.lastMoveDirection);
    return true;
  },

  _arriveHomeTourStop(now = performance.now()) {
    const stop = this.homeTourCurrentStop;
    const finalAnchor = stop?.point && this._closestWalkPoint(stop.point, 0.55);
    if (finalAnchor && distanceXZ(this.position, finalAnchor) <= HOME_TOUR_ARRIVAL_TOLERANCE_METERS * Math.max(this.metersPerUnit || 1, 1e-6)) {
      this.position.set(finalAnchor.x, finalAnchor.y, finalAnchor.z);
      this.currentPolyRef = finalAnchor.polyRef || this.currentPolyRef;
    }
    this.homeTourMotion = null;
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity?.set?.(0, 0, 0);
    this.velocity?.set?.(0, 0, 0);
    this.lastMovementPosition?.copy?.(this.position);
    this.arrivalSettleUntil = now + 220;
    this.homeTourPhase = 'settling';
    this.homeTourHoldUntil = now + 220;
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;
    this._emitHomeTourState({ phase: 'settling', label: stop?.label || 'Room' });
  },

  _beginHomeTourPortalTransition(now, reason, rawTarget) {
    // First try a fresh spatial query. If that query is locally unavailable,
    // retain the point that was already validated while building this tour's
    // stop list. That prevents a transient query failure from ending the tour.
    const freshlyValidated = this._closestWalkPoint(rawTarget, 1.35)
      || this._closestWalkPoint(this.homeTourCurrentStop?.point, 1.35);
    const previouslyValidated = rawTarget?.validatedByNavMesh
      ? rawTarget
      : (this.homeTourCurrentStop?.point?.validatedByNavMesh ? this.homeTourCurrentStop.point : null);
    const target = freshlyValidated || previouslyValidated;
    if (!target || ![target.x, target.y, target.z].every(Number.isFinite)) {
      return this._failHomeTour(`No validated room presentation anchor is available for ${this.homeTourCurrentStop?.label || 'the next room'}.`);
    }

    this.homeTourMotion = null;
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity?.set?.(0, 0, 0);
    this.velocity?.set?.(0, 0, 0);
    this.homeTourTransition = {
      startedAt: now,
      durationMs: HOME_TOUR_PORTAL_FADE_MS,
      switchAt: HOME_TOUR_PORTAL_SWITCH_AT,
      target,
      switched: false,
      reason,
    };
    this.homeTourTransitionOpacity = 0;
    this.homeTourPhase = 'portal-transition';
    this._emitHomeTourState({ phase: 'portal-transition', transitionMode: 'fade-through', transitionOpacity: 0 });
    return true;
  },

  _updateHomeTourPortalTransition(now) {
    const transition = this.homeTourTransition;
    if (!transition) return false;
    const progress = THREE.MathUtils.clamp((now - transition.startedAt) / transition.durationMs, 0, 1);
    const fadeOut = smooth01(progress / transition.switchAt);
    const fadeIn = 1 - smooth01((progress - transition.switchAt) / (1 - transition.switchAt));
    this.homeTourTransitionOpacity = progress <= transition.switchAt ? fadeOut : fadeIn;

    if (!transition.switched && progress >= transition.switchAt) {
      transition.switched = true;
      const target = transition.target;
      // Camera position changes only while the presentation viewport is fully
      // occluded. This is a deliberate cinematic doorway cut, not a visible warp.
      this.position.set(target.x, target.y, target.z);
      this.currentPolyRef = target.polyRef || this.currentPolyRef;
      this.lastMovementPosition?.copy?.(this.position);
      this.homeTourExpectedPoint = target;
      this.guidedApproachActive = false;
      this.guidedRevealActive = false;
      this.guidedShotSubject = null;
      this.guidedShotSubjectId = null;
      this.guidedShotSubjectUntil = 0;
    }

    if (now - this.homeTourLastUiAt >= HOME_TOUR_UI_INTERVAL_MS || progress >= 1) {
      this.homeTourLastUiAt = now;
      this._emitHomeTourState({
        phase: 'portal-transition',
        transitionMode: 'fade-through',
        transitionOpacity: this.homeTourTransitionOpacity,
        transitionReason: transition.reason,
      });
    }

    if (progress >= 1) {
      this.homeTourTransition = null;
      this.homeTourTransitionOpacity = 0;
      this.homeTourPhase = 'settling';
      this.homeTourHoldUntil = now + 260;
      this._emitHomeTourState({ phase: 'settling', transitionOpacity: 0 });
    }
    return true;
  },

  _selectHomeTourHero(areaId) {
    const subjects = Array.isArray(this.presentationSubjects) ? this.presentationSubjects : [];
    const unit = Math.max(this.metersPerUnit || 1, 1e-6);
    const origin = this.position;
    const eye = new THREE.Vector3(
      origin.x,
      origin.y + (this.eyeHeight + this.heightOffset) * unit,
      origin.z,
    );
    const areaSource = Array.isArray(this.homeTourAreaSource) && this.homeTourAreaSource.length
      ? this.homeTourAreaSource
      : this.walkAreas;
    const area = (areaSource || []).find((item) => item?.id === areaId);
    const areaCenter = Array.isArray(area?.center) && area.center.length >= 3
      ? area.center.slice(0, 3).map(Number)
      : (area?.center && [area.center.x, area.center.y, area.center.z].every((value) => Number.isFinite(Number(value)))
        ? [Number(area.center.x), Number(area.center.y), Number(area.center.z)]
        : null);
    const areaCandidates = subjects.filter((subject) => subject?.areaId === areaId && subject.center && subject.visible !== false);
    // Optimized presentation jobs sometimes have sparse/ambiguous area IDs.
    // Keep nearby semantic assets as candidates even when one low-value item
    // happens to carry the exact area ID; the room's sofa/bed/table should win.
    const nearbyFallback = areaCenter
      ? subjects.filter((subject) => subject?.center && subject.visible !== false
        && Math.hypot(subject.center.x - Number(areaCenter[0]), subject.center.z - Number(areaCenter[2])) <= 5.5 * unit)
      : [];
    const pool = [...new Map([...areaCandidates, ...nearbyFallback].map((subject) => [subject.id || subject.object?.uuid || subject, subject])).values()];
    let best = null;

    for (const subject of pool) {
      if (subject.object && !subject.object.visible) continue;
      if (!['furniture', 'fixture', 'decor', 'lighting', 'object'].includes(subject.role)) continue;
      const dx = subject.center.x - origin.x;
      const dz = subject.center.z - origin.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.45 * unit || distance > 9 * unit) continue;
      const direction = new THREE.Vector3(subject.center.x - eye.x, subject.center.y - eye.y, subject.center.z - eye.z);
      const distance3d = direction.length();
      let occluded = false;
      if (distance3d > 1e-5) {
        const hit = this._raycastPresentationOccluder?.(eye, direction.normalize(), distance3d);
        const belongs = Boolean(hit && (hit.object === subject.object || subject.meshObjects?.includes(hit.object)));
        if (hit && !belongs && hit.distance < distance3d - Math.max(0.22 * unit, distance3d * 0.10)) occluded = true;
      }
      if (occluded) continue;

      const name = String(subject.name || '').toLowerCase();
      const isHero = /(sofa|couch|sectional|bed|daybed|dining|dinning|kitchen island|wardrobe|cabinet|television unit)/.test(name);
      const semanticWeight = isHero ? 14 : 0;
      const roleWeight = Number(subject.heroPriority) || ({ furniture: 8, fixture: 4.5, decor: 1.8, lighting: 1.2, object: 0.8 }[subject.role] || 0.8);
      const distanceQuality = 1 - Math.min(Math.abs(distance - 2.7 * unit) / (6.0 * unit), 1);
      const sizeQuality = Math.min(Math.log1p((subject.radius || 0.5 * unit) / unit * 2), 1.4);
      const score = semanticWeight + roleWeight + (subject.areaId === areaId ? 6 : 0) + distanceQuality * 2.2 + sizeQuality;
      if (!best || score > best.score) best = { subject, score };
    }
    return best?.subject || null;
  },

  _beginHomeTourRoomPresentation(now = performance.now()) {
    const stop = this.homeTourCurrentStop;
    if (!stop || stop.kind !== 'room') return this._failHomeTour('Home Tour lost its current room identity.');

    const hero = this._selectHomeTourHero(stop.areaId);
    this.guidedShotSubject = hero;
    this.guidedShotSubjectId = hero?.id || hero?.object?.uuid || null;
    this.homeTourLastHeroName = hero?.name || null;
    stop.label = resolveHomeTourRoomLabel({
      areaId: stop.areaId,
      fallbackLabel: stop.label,
      heroName: hero?.name || '',
      areas: (Array.isArray(this.homeTourAreaSource) && this.homeTourAreaSource.length)
        ? this.homeTourAreaSource
        : this.walkAreas,
      subjects: this.presentationSubjects,
    });

    const heroYaw = hero ? this._yawToGuidedSubject(this.position, hero) : null;
    const heroPitch = hero ? this._pitchToGuidedSubject(this.position, hero) : null;
    let fallbackYaw = null;
    if (!Number.isFinite(heroYaw)) {
      const composition = this._findBestGuidedComposition?.(
        this.position,
        this.homeTourLastMoveDirection,
        this.currentYaw,
      );
      fallbackYaw = Number.isFinite(composition?.yaw) ? composition.yaw : null;
    }

    this.homeTourAimYaw = Number.isFinite(heroYaw)
      ? heroYaw
      : (Number.isFinite(fallbackYaw)
        ? fallbackYaw
        : (Number.isFinite(this.currentYaw) ? this.currentYaw : 0));
    this.homeTourAimPitch = Number.isFinite(heroPitch)
      ? THREE.MathUtils.clamp(heroPitch, THREE.MathUtils.degToRad(-22), THREE.MathUtils.degToRad(1))
      : -0.075;
    this.guidedCompositionTargetYaw = this.homeTourAimYaw;
    this.guidedCompositionYaw = this.currentYaw;
    this.guidedYawCenter = this.homeTourAimYaw;
    this.targetYaw = this.homeTourAimYaw;
    this.targetPitch = this.homeTourAimPitch;
    this.guidedShotSubjectUntil = Number.POSITIVE_INFINITY;

    // Give the camera time to settle onto the hero before the advertised
    // 15-second room dwell begins. The dwell timer starts after composition.
    this.homeTourPhase = 'composing';
    this.homeTourCompositionUntil = now + HOME_TOUR_COMPOSITION_SETTLE_MS;
    this.homeTourPresentationStartedAt = 0;
    this.homeTourHoldUntil = 0;
    this.homeTourVisitedAreaIds.add(stop.areaId);
    this._emitHomeTourState({
      phase: 'composing',
      hero: this.homeTourLastHeroName,
      compositionMs: HOME_TOUR_COMPOSITION_SETTLE_MS,
      holdMs: HOME_TOUR_ROOM_HOLD_MS,
    });
    return true;
  },

  /**
   * Home Tour owns its own camera heading. During travel it faces the actual
   * next NavMesh segment (not the generic path cursor, which can be one node
   * behind and turn the camera backwards at corners). During a room stop it
   * holds the selected hero with only a subtle, slow cinematic drift.
   */
  _updateHomeTourCameraHeading(now = performance.now(), dt = this._lastDt || 0.016) {
    if (!this.homeTourActive) return false;

    if (this.homeTourPhase === 'traveling' && this.homeTourMotion?.path?.length) {
      const motion = this.homeTourMotion;
      const path = motion.path;
      const unit = Math.max(this.metersPerUnit || 1, 1e-6);
      const index = THREE.MathUtils.clamp(motion.index, 0, path.length - 1);
      const waypoint = path[index];
      let dx = Number(waypoint?.x) - this.position.x;
      let dz = Number(waypoint?.z) - this.position.z;
      let length = Math.hypot(dx, dz);

      if (length < 0.025 * unit && index + 1 < path.length) {
        dx = path[index + 1].x - this.position.x;
        dz = path[index + 1].z - this.position.z;
        length = Math.hypot(dx, dz);
      }

      if (length > 1e-6) {
        const routeDirection = new THREE.Vector3(dx / length, 0, dz / length);
        // Look slightly into the next segment near a corner, but keep this
        // anticipation small so the camera does not turn before the body.
        if (index + 1 < path.length) {
          const nextDx = path[index + 1].x - waypoint.x;
          const nextDz = path[index + 1].z - waypoint.z;
          const nextLength = Math.hypot(nextDx, nextDz);
          if (nextLength > 1e-6) {
            const blend = THREE.MathUtils.clamp((0.65 * unit - length) / (0.65 * unit), 0, 1) * 0.14;
            routeDirection.lerp(new THREE.Vector3(nextDx / nextLength, 0, nextDz / nextLength), blend).normalize();
          }
        }

        // The movement vector returned by moveAlongSurface is authoritative.
        // If Detour clamps sideways against a wall, the camera follows the
        // accepted displacement instead of continuing to stare down the ideal
        // (but currently blocked) route tangent.
        const actual = motion.actualMoveDirection;
        const actualIsFresh = actual?.lengthSq?.() > 1e-8 && now - (motion.lastActualMoveAt || 0) < 240;
        const desiredDirection = homeTourCameraDirection(
          routeDirection.x,
          routeDirection.z,
          actual?.x,
          actual?.z,
          actualIsFresh,
        ) || { x: routeDirection.x, z: routeDirection.z };

        const desiredYaw = homeTourYawFromDirection(desiredDirection.x, desiredDirection.z);
        const currentDirection = motion.cameraDirection?.lengthSq?.() > 1e-8
          ? motion.cameraDirection
          : desired;
        const currentYaw = homeTourYawFromDirection(currentDirection.x, currentDirection.z);
        const headingYaw = Number.isFinite(currentYaw)
          ? homeTourAngleLerp(currentYaw, desiredYaw, 1 - Math.exp(-5.2 * dt))
          : desiredYaw;
        // Convert the circular yaw back to a forward vector. This avoids the
        // zero-vector normalization that occurs when linear vector lerp crosses
        // an exact 180-degree reversal.
        motion.cameraDirection = new THREE.Vector3(-Math.sin(headingYaw), 0, -Math.cos(headingYaw));
        this.homeTourLastMoveDirection.copy(motion.cameraDirection);
        if (Number.isFinite(headingYaw)) this.targetYaw = headingYaw;
      }
      this.targetPitch = HOME_TOUR_CAMERA_TRAVEL_PITCH;
      return true;
    }

    if (this.homeTourPhase === 'composing' || this.homeTourPhase === 'presenting') {
      const baseYaw = Number.isFinite(this.homeTourAimYaw) ? this.homeTourAimYaw : this.currentYaw;
      const elapsed = this.homeTourPhase === 'presenting'
        ? Math.max(0, now - this.homeTourPresentationStartedAt)
        : 0;
      const phase = this.homeTourPhase === 'presenting'
        ? THREE.MathUtils.clamp(elapsed / HOME_TOUR_ROOM_HOLD_MS, 0, 1)
        : 0;
      // A subtle two-sided sweep keeps the shot alive without losing the hero.
      const sweep = Math.sin(phase * Math.PI * 2) * THREE.MathUtils.degToRad(HOME_TOUR_CAMERA_SWEEP_DEGREES);
      this.targetYaw = baseYaw + sweep;
      this.targetPitch = this.homeTourAimPitch + Math.sin(phase * Math.PI * 2) * 0.003;
      return true;
    }

    if (this.homeTourPhase === 'settling' && this.homeTourLastMoveDirection?.lengthSq?.() > 1e-8) {
      const yaw = homeTourYawFromDirection(this.homeTourLastMoveDirection.x, this.homeTourLastMoveDirection.z);
      if (Number.isFinite(yaw)) this.targetYaw = yaw;
      this.targetPitch = HOME_TOUR_CAMERA_TRAVEL_PITCH;
      return true;
    }

    return false;
  },

  _updateHomeTour(now = performance.now(), dt = this._lastDt || 0.016) {
    if (!this.homeTourActive) return false;

    if (this.homeTourPhase === 'traveling') {
      this._advanceHomeTourMotion(dt, now);
      return true;
    }

    if (this.homeTourPhase === 'portal-transition') {
      this._updateHomeTourPortalTransition(now);
      return true;
    }

    if (this.homeTourPhase === 'settling') {
      if (now < this.homeTourHoldUntil) return true;
      this._beginHomeTourRoomPresentation(now);
      return true;
    }

    if (this.homeTourPhase === 'composing') {
      if (now < this.homeTourCompositionUntil) return true;
      this.homeTourPhase = 'presenting';
      this.homeTourPresentationStartedAt = now;
      this.homeTourHoldUntil = now + HOME_TOUR_ROOM_HOLD_MS;
      this.guidedShotSubjectUntil = this.homeTourHoldUntil + 500;
      this._emitHomeTourState({ phase: 'presenting', holdMs: HOME_TOUR_ROOM_HOLD_MS, remainingMs: HOME_TOUR_ROOM_HOLD_MS });
      return true;
    }

    if (this.homeTourPhase === 'presenting') {
      if (now - this.homeTourLastUiAt >= 250) {
        this.homeTourLastUiAt = now;
        this._emitHomeTourState({ remainingMs: Math.max(0, this.homeTourHoldUntil - now) });
      }
      if (now < this.homeTourHoldUntil) return true;
      this.homeTourStopIndex += 1;
      this._startHomeTourNextLeg(now);
      return true;
    }
    return true;
  },

  _failHomeTour(message) {
    if (!this.homeTourActive) return false;
    this.homeTourActive = false;
    this.homeTourPhase = 'failed';
    this.homeTourFailure = message || 'Home Tour could not complete.';
    this.homeTourMotion = null;
    this.homeTourTransition = null;
    this.homeTourTransitionOpacity = 0;
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
      this._applyHomeTourDoorVisibility(false);
      this.homeTourTransitionOpacity = 0;
      return false;
    }
    this.homeTourActive = false;
    this.homeTourPhase = 'cancelled';
    this.homeTourMotion = null;
    this.homeTourTransition = null;
    this.homeTourTransitionOpacity = 0;
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
    this._emitHomeTourState({ cancelled: true, reason, transitionOpacity: 0 });
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', active: false });
    return true;
  },

  _finishHomeTour() {
    if (!this.homeTourActive) return false;
    this.homeTourActive = false;
    this.homeTourPhase = 'complete';
    this.homeTourMotion = null;
    this.homeTourTransition = null;
    this.homeTourTransitionOpacity = 0;
    this.path = null;
    this.pathIndex = 0;
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = false;
    this.blockedTime = 0;
    this.stuck = false;
    this.recoveryAvailable = false;
    this._applyHomeTourDoorVisibility(false);
    this._emitHomeTourState({ completed: true, visitedCount: this.homeTourVisitedAreaIds.size, transitionOpacity: 0 });
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', active: false });
    this.fitView?.();
    this.setViewPreset?.('isometric');
    return true;
  },
};
