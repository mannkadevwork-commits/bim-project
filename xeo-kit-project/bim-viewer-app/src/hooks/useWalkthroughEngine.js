import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LightingDirector } from './walkthrough/lightingDirector.js';
import { init as initRecast, importNavMesh, NavMeshQuery, QueryFilter } from 'recast-navigation';
import { immersive360DirectorMethods } from './walkthrough/immersive360Director.js';
import { immersivePresentationDirectorMethods } from './walkthrough/immersivePresentationDirector.js';
import { immersiveSceneDirectorMethods } from './walkthrough/immersiveSceneDirector.js';
import { smart720TourDirectorMethods } from './walkthrough/smart720TourDirector.js';
import { WalkthroughPerformanceMonitor } from './walkthrough/WalkthroughPerformanceMonitor.js';
import { DEFAULT_PRESENTATION_SETTINGS, normalizePresentationSettings, resolveQualityProfile } from './walkthrough/presentationSettings.js';

const DEFAULT_SPEEDS = { walk: 1.65, run: 3.2 };
const GUIDED_AUTO_TRAVEL_SPEED_SCALE = 0.70; // ~1.15 m/s at the default physical scale.
const GUIDED_ARRIVAL_FOV_BOOST_DEGREES = 3;
const DEFAULT_EYE_HEIGHT_METERS = 1.68;
const DEFAULT_HEIGHT_OFFSET_METERS = 0.0;
const MIN_HEIGHT_OFFSET_METERS = -0.45;
const MAX_HEIGHT_OFFSET_METERS = 1.0;
const DEFAULT_FOV_DEGREES = 74;
const GUIDED_CAMERA_HEIGHT_METERS = 1.72;
const GUIDED_PAN_AMPLITUDE_DEG = 16;
const GUIDED_PAN_RATE_RAD_PER_SEC = 0.045;
const CAMERA_BODY_CLEARANCE_METERS = 0.28;
const PHASE_A_MAX_NAV_STEP_METERS = 0.07;
const PHASE_A_MAX_LOCAL_SNAP_METERS = 0.18;
const CAMERA_CLEARANCE_CHECK_INTERVAL_SEC = 0.10;
const SAFE_ANCHOR_MIN_OPEN_SPACE_METERS = 0.90;
const SAFE_ANCHOR_HISTORY_LIMIT = 14;

class WalkRuntime {
  constructor({ canvas, onState }) {
    this.canvas = canvas;
    this.onState = onState;
    this.presentationSettings = normalizePresentationSettings(DEFAULT_PRESENTATION_SETTINGS);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf4f6f8);
    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV_DEGREES, 1, 0.05, 5000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const initialQuality = resolveQualityProfile(this.presentationSettings.quality.mode);
    this.renderer.setPixelRatio(initialQuality.effectivePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.96;
    this.renderer.shadowMap.enabled = initialQuality.shadowsEnabled;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvas.appendChild(this.renderer.domElement);
    this.performanceMonitor = new WalkthroughPerformanceMonitor(this.renderer, canvas);
    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enabled = true;
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.enablePan = true;
    this.orbitControls.screenSpacePanning = false;

    this.lastFrameTime = performance.now();
    this.currentYaw = 0;
    this.currentPitch = -0.05;
    this.targetYaw = 0;
    this.targetPitch = -0.05;
    this.lookSmoothing = 18;
    this.lookSensitivity = 0.0048;
    this.headBobTime = 0;
    this.navSurfaceMesh = null;
    this.activeHotspotId = null;
    this.pointerDownAt = 0;
    this.running = true;
    this.animationFrame = 0;
    this.model = null;
    this.navMesh = null;
    this.query = null;
    this.filter = null;
    this.walkAreas = [];
    this.hotspots = [];
    this.presentationRooms = [];
    this.presentationSpaces = [];
    this.presentationPortals = [];
    this.presentationRoomGraph = null;
    this.navigationSpaceGraph = null;
    this.presentationPortalById = new Map();
    this.path = null;
    this.pathIndex = 0;
    this.pathReplanAttempts = 0;
    this.pathVelocity = new THREE.Vector3();
    this.travelTotalDistance = 0;
    this.travelElapsed = 0;
    this.travelMode = null;
    // Phase 8: destination choreography. Travel now has a small camera story:
    // approach -> reveal -> settle -> presentation. The physical path remains
    // unchanged; these fields only coordinate the Guided camera.
    this.arrivalSettleUntil = 0;
    this.guidedApproachActive = false;
    this.guidedApproachTargetYaw = 0;
    this.guidedApproachStartYaw = 0;
    this.guidedArrivalStartYaw = 0;
    this.guidedArrivalTargetYaw = 0;
    this.guidedArrivalStartPitch = -0.05;
    this.guidedArrivalTargetPitch = -0.05;
    this.guidedArrivalSettleStartedAt = 0;
    this.guidedArrivalSettleDurationMs = 1650;
    // Phase 9: transition-aware choreography. Different architectural transitions
    // get slightly different approach/settle characteristics without changing the
    // physical NavMesh movement itself.
    this.guidedTransitionKind = 'standard';
    this.guidedTransitionApproachDistanceMeters = 2.8;
    this.guidedApproachDistanceMeters = 2.8;
    // Phase 10: room reveal choreography. For room entries/crossings, the camera
    // begins composing the destination earlier than the final settle, using an
    // offset reveal heading so the new space opens into view instead of appearing
    // head-on like a point-to-point teleport.
    this.guidedRevealActive = false;
    this.guidedRevealTargetYaw = 0;
    this.guidedRevealStartDistanceMeters = 4.8;
    this.guidedRevealFinalDistanceMeters = 1.55;
    this.directTravel = null;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.05;
    this.eyeHeight = this.presentationSettings.camera.eyeHeightMeters;
    this.radius = 0.15;
    this.walkSpeed = DEFAULT_SPEEDS.walk;
    this.runSpeed = DEFAULT_SPEEDS.run;
    this.metersPerUnit = 1;
    this.heightOffset = DEFAULT_HEIGHT_OFFSET_METERS;
    // Start in a presentation-friendly perspective overview. Walk activates only after an explicit user action.
    this.viewMode = 'overview';
    // Customer-facing walk styles: guided keeps a stable presentation camera;
    // explore enables responsive cursor/mouse-look with WASD movement.
    this.walkMode = 'guided';
    this.guidedPitch = -0.085; // Slight downward architectural framing keeps floor destinations visible without feeling top-down.
    // Guided presentation uses a slow continuous panoramic yaw, similar to
    // an architectural showcase walkthrough. Position/path movement and camera
    // orientation remain independent so destination clicks never force a look-at.
    this.guidedYawRate = GUIDED_PAN_RATE_RAD_PER_SEC;
    this.guidedYawAmplitude = THREE.MathUtils.degToRad(GUIDED_PAN_AMPLITUDE_DEG);
    this.guidedYawCenter = 0;
    this.guidedPanPhase = 0;
    this.guidedAutoRotate = true;
    this.guidedTravelRotating = false;
    // Guided-mode manual yaw is a temporary user override. It pauses the
    // cinematic pan while the user drags, then resumes from the new heading.
    this.guidedManualYawUntil = 0;
    this.guidedManualActive = false;
    this.guidedPointerDown = null;
    this.guidedPointerDragging = false;
    // Phase 4: incremental pointer samples + a short inertial tail make Guided
    // feel like a polished camera control instead of a raw FPS mouse mapping.
    this.guidedLastPointer = null;
    this.guidedYawVelocity = 0;
    this.guidedManualResumeDelayMs = 2400;
    this.guidedManualVelocityDamping = 7.5;
    // Explore-mode mouse-look remains user-owned briefly, then automated
    // destination travel gently re-aligns the view with the actual path tangent.
    this.exploreManualLookUntil = 0;
    // Guided camera composition state.  The heading is chosen from actual
    // nearby destinations/open-space checks instead of a blind perpetual spin.
    this.guidedCompositionYaw = 0;
    this.guidedCompositionTargetYaw = 0;
    this.guidedLastCompositionAt = 0;
    this.guidedCompositionIntervalMs = 5500;
    this.guidedCompositionMinVisibleTargets = 2;
    this.guidedCompositionSweepDeg = 34;
    this.guidedCompositionLookaheadMeters = 8;
    // Phase 11: presentation must remain semantically inside the current space
    // unless the camera is deliberately executing a room-entry/crossing reveal.
    this.guidedPresentationAreaId = null;
    this.guidedWallDominancePenalty = 2.6;
    this.guidedPanWallGuardMeters = 1.15;
    this.presentationHotspotIds = new Set();
    this.presentationHotspotScores = new Map();
    // Phase 12: lightweight visual-subject index used only for camera composition.
    // It helps the Guided camera favor actual design content (furniture, fixtures,
    // doors/windows) instead of treating every visible ray as equally interesting.
    this.presentationSubjects = [];
    // Static structural meshes are enough for camera visibility / wall guards.
    // Raycasting every ray against the complete production GLB can stall the
    // Guided camera when it evaluates a group of candidate headings.
    this.presentationOccluders = [];
    // Phase 13: lock the Guided presentation onto one meaningful visual subject
    // during the arrival shot so the camera behaves like a deliberate architectural
    // composition instead of continually re-solving the frame.
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;
    // Phase 8B: guided architectural tour state. This layer chooses the next
    // semantic destination; the NavMesh remains responsible for physical travel.
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourHoldMs = 5000;
    this.guidedTourVisitedHotspots = new Set();
    this.guidedTourVisitedAreas = new Set();
    this.guidedTourLastAreaId = null;
    this.guidedTourLastVisitedHotspotId = null;
    this.guidedTourLastRole = null;
    this.guidedTourAdvanceLock = false;
    // Phase 5: semantic destination roles inferred from local floor context.
    // These roles are presentation hints; physical movement still uses the same
    // navigation/runtime path system as earlier phases.
    this.hotspotRoles = new Map();
    this.presentationMaxVisible = 4;
    this.presentationMaxDistanceMeters = 9;
    this.presentationMinSeparationDeg = 16;
    this.lookLocked = false;
    this.autoRotate = false;
    this.lastMoveDirection = new THREE.Vector3();
    this.blockedTime = 0;

    // Presentation directors are runtime-owned. These were previously present
    // in the source tree but never connected to WalkRuntime, which left the
    // WalkthroughPage 360/Smart 720 controls without their implementation.
    this._resetImmersive360State();
    this._resetImmersivePresentationState();
    this._resetImmersiveSceneState();
    this._resetSmart720TourState();
    this.portalClickSuppressedUntil = 0;
    this.stuck = false;
    this.recoveryAvailable = false;
    // Phase 6: navigation reliability. A safe anchor is a validated, connected
    // customer-facing hotspot that can be used to recover from a bad route or
    // camera collision. Keep a short breadcrumb history so recovery backtracks
    // naturally instead of jumping to an arbitrary nearest point.
    this.safeAnchorIds = new Set();
    this.safeAnchorById = new Map();
    this.navigationHistory = [];
    this.lastSafeAnchorId = null;
    this.lastSafeAnchorPosition = null;
    this.recoveryAttemptedIds = new Set();
    this.cameraClearanceTimer = 0;
    this.lastMovementPosition = new THREE.Vector3();
    this.progressWatchTime = 0;

    this.viewTarget = new THREE.Vector3();
    this.viewDistance = 1;
    this.fov = this.presentationSettings.camera.overviewFov;
    this.overviewPanSpeed = 1;
    this.keys = new Set();
    this.lastPointer = { x: 0, y: 0 };
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.portalObjects = [];
    this.portalTargets = new Map();

    this.lightingDirector = new LightingDirector({
      scene: this.scene,
      renderer: this.renderer,
      onChange: (state) => {
        this._updateLightingControl(state);
        this.onState?.({ type: 'lighting', ...state });
      },
    });
    this._createLightingControl();
    this._updateLightingControl(this.lightingDirector.getState());

    this._bind();
    this.resize();
    this._tick();
  }

  // Lighting controls are rendered by WalkthroughPage so all modes share one
  // accessible React settings surface. The runtime only owns the lighting state.
  _createLightingControl() {}

  _updateLightingControl() {}

  _bind() {
    this.onKeyDown = (e) => {
      const key = e.key.toLowerCase();
      const activeTag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) return;

      // L cycles the presentation lighting independently of overview/walk state.
      if (key === 'l') {
        e.preventDefault();
        this.cycleLighting();
        return;
      }

      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', 'q', 'e'].includes(key)) {
        e.preventDefault();
        this.keys.add(key);
      }
      // Overview zoom with +/- keys
      if (this.viewMode === 'overview') {
        if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoom(1); }
        if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoom(-1); }
      }
      if (e.key === 'Escape') {
        this.onState?.({ type: 'escape' });
      }
    };
    this.onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    this.onContextMenu = (e) => e.preventDefault();
    this.onPointerDown = (e) => {
      if (e.button !== 0 || this.viewMode !== 'walk') return;
      this.pointerDownAt = performance.now();

      if (this.immersive360Active) {
        this._beginImmersive360Pointer(e);
        return;
      }

      // Guided: left-drag is an explicit, modern way to yaw the camera.
      // A simple click remains a navigation action, so we defer the floor/hotspot
      // click until pointer-up and only treat it as a click when the pointer did
      // not move beyond a small drag threshold.
      if (this.walkMode === 'guided') {
        // Manual interaction always wins over the cinematic director.
        // An explicit destination click will re-arm the tour in navigateToHotspot.
        this.guidedTourArmed = false;
        this.guidedTourNextAt = 0;
        this.guidedTourAdvanceLock = false;
        this.arrivalSettleUntil = 0;
        this.guidedShotSubject = null;
        this.guidedShotSubjectId = null;
        this.guidedShotSubjectUntil = 0;
        this.guidedApproachActive = false;
        this.guidedPointerDown = { x: e.clientX, y: e.clientY };
        this.guidedLastPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
        this.guidedPointerDragging = false;
        this.guidedYawVelocity = 0;
        this.renderer.domElement.setPointerCapture?.(e.pointerId);
        return;
      }

      if (this.walkMode === 'explore' && this.lookLocked) return;
      this._handleWalkPointer(e);
    };
    this.onDoubleClick = (e) => {
      if (this.viewMode !== 'walk' || this.walkMode !== 'explore') return;
      e.preventDefault();
      e.stopPropagation();
      this.portalClickSuppressedUntil = performance.now() + 350;
      this.setLookLocked(!this.lookLocked, true);
    };
    this.onPointerUp = (e) => {
      if (e.button === 0 && this.immersive360Active && this.viewMode === 'walk') {
        this._endImmersive360Pointer(e);
        return;
      }
      if (e.button === 0 && this.walkMode === 'guided' && this.viewMode === 'walk') {
        const wasDragging = this.guidedPointerDragging;
        this.guidedPointerDown = null;
        this.guidedLastPointer = null;
        this.guidedPointerDragging = false;
        this.guidedManualActive = wasDragging;
        this.guidedManualYawUntil = performance.now() + this.guidedManualResumeDelayMs;
        this.renderer.domElement.releasePointerCapture?.(e.pointerId);
        if (!wasDragging && performance.now() >= this.portalClickSuppressedUntil) {
          this._handleWalkPointer(e);
        }
        return;
      }
      if (e.button === 2) {
        this.renderer.domElement.releasePointerCapture?.(e.pointerId);
      }
    };
    this.onPointerMove = (e) => {
      if (this.viewMode !== 'walk') return;
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;

      if (this.immersive360Active) {
        this._moveImmersive360Pointer(e);
        return;
      }

      if (this.walkMode === 'guided') {
        if (!this.guidedPointerDown || !this.guidedLastPointer) return;

        const now = performance.now();
        const totalDx = e.clientX - this.guidedPointerDown.x;
        const totalDy = e.clientY - this.guidedPointerDown.y;
        const dragDistance = Math.hypot(totalDx, totalDy);
        if (dragDistance < 4) return;

        this.guidedPointerDragging = true;

        // Consume only the incremental delta. Using the full distance from
        // pointer-down on every event compounds the rotation and feels clunky.
        const dx = e.clientX - this.guidedLastPointer.x;
        const dtMs = Math.max(8, now - this.guidedLastPointer.t);
        this.guidedLastPointer = { x: e.clientX, y: e.clientY, t: now };

        const yawDelta = dx * (this.lookSensitivity * 0.72);
        this.targetYaw -= yawDelta;
        this.guidedYawVelocity = THREE.MathUtils.clamp(
          -yawDelta / (dtMs / 1000),
          -1.6,
          1.6,
        );

        // Guided remains horizontal-look only; pitch is the presentation
        // framing and stays stable so floor markers do not disappear.
        this.targetPitch = this.guidedPitch;
        this.guidedManualActive = true;
        this.guidedManualYawUntil = now + this.guidedManualResumeDelayMs;
        this.guidedYawCenter = this.targetYaw;
        this.guidedCompositionYaw = this.targetYaw;
        this.guidedCompositionTargetYaw = this.targetYaw;
        this.guidedLastCompositionAt = now;
        this.guidedPanPhase = 0;
        this.lastPointer.x = e.clientX;
        this.lastPointer.y = e.clientY;
        return;
      }

      if (this.lookLocked || this.walkMode !== 'explore') return;
      const dx = e.movementX || (e.clientX - this.lastPointer.x);
      const dy = e.movementY || (e.clientY - this.lastPointer.y);
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;

      // Cursor-driven free look with damping. Movement remains independent of
      // the camera destination, so clicking a floor target never reorients view.
      this.targetYaw -= dx * this.lookSensitivity;
      this.exploreManualLookUntil = performance.now() + 1600;
      this.targetPitch = THREE.MathUtils.clamp(
        this.targetPitch - dy * (this.lookSensitivity * 0.82),
        -Math.PI * 0.43,
        Math.PI * 0.28,
      );
    };

    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    this.renderer.domElement.addEventListener('contextmenu', this.onContextMenu);
    this.onPointerCancel = (e) => {
      if (e.pointerId == null || this.walkMode !== 'guided') return;
      const wasDragging = this.guidedPointerDragging;
      this.guidedPointerDown = null;
      this.guidedLastPointer = null;
      this.guidedPointerDragging = false;
      this.guidedManualActive = wasDragging;
      this.guidedManualYawUntil = performance.now() + this.guidedManualResumeDelayMs;
      this.renderer.domElement.releasePointerCapture?.(e.pointerId);
    };

    const previousPointerCancel = this.onPointerCancel;
    this.onPointerCancel = (e) => {
      if (e.pointerId == null) return;
      if (this.immersive360Active) {
        this._cancelImmersive360Pointer(e);
        return;
      }
      previousPointerCancel?.(e);
    };

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.addEventListener('pointercancel', this.onPointerCancel);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('resize', this.resize);
  }

  resize = () => {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height, false);
  };

  async load(jobId, baseUrl) {
    const loadStartedAt = performance.now();
    const jobBase = `${baseUrl.replace(/\/$/, '')}/jobs/${encodeURIComponent(jobId)}`;
    this.onState?.({ type: 'loading', value: true });

    const [surfacePayload, hotspotsPayload, topologyPayload, navBuffer, gltf, projectStatePayload] = await Promise.all([
      fetch(`${jobBase}/navigation_surface.json`, { cache: 'no-store' }).then(this._assertJson('navigation_surface.json')),
      fetch(`${jobBase}/walk_hotspots.json`, { cache: 'no-store' }).then(this._assertJson('walk_hotspots.json')).catch((error) => {
        console.warn('[Walkthrough] walk_hotspots.json unavailable; no destinations will be shown.', error);
        return { hotspots: [] };
      }),
      fetch(`${jobBase}/presentation_portals.json`, { cache: 'no-store' }).then(this._assertJson('presentation_portals.json')).catch((error) => {
        console.warn('[Walkthrough] presentation_portals.json unavailable; using hotspot-only navigation.', error);
        return { rooms: [], portals: [] };
      }),
      fetch(`${jobBase}/navigation_navmesh.bin`, { cache: 'no-store' }).then(async (r) => {
        if (!r.ok) throw new Error(`navigation_navmesh.bin returned ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      }),
      new Promise((resolve, reject) => new GLTFLoader().load(`${jobBase}/output.glb`, resolve, undefined, reject)),
      fetch(`${jobBase}/project_state.json`, { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`project_state.json returned ${response.status}`);
          return response.json();
        })
        .catch((error) => {
          // Optional metadata: existing projects still work if their state file is not exposed.
          console.warn('[Walkthrough] project_state.json unavailable; using visible mesh names for arrival framing.', error);
          return null;
        }),
    ]);

    await initRecast();
    const imported = importNavMesh(navBuffer);
    if (!imported?.navMesh) throw new Error('Unable to import serialized Recast NavMesh.');

    this.navMesh = imported.navMesh;
    this.query = new NavMeshQuery(this.navMesh);
    this.filter = new QueryFilter();
    const semanticAreas = Array.isArray(hotspotsPayload?.areas)
      ? hotspotsPayload.areas.filter((area) => Array.isArray(area?.center) && area.center.length >= 3)
      : [];
    this.walkAreas = semanticAreas;
    const loadedHotspots = Array.isArray(hotspotsPayload?.hotspots)
      ? hotspotsPayload.hotspots.filter((h) => Array.isArray(h?.position) && h.position.length >= 3)
      : [];
    this.metersPerUnit = Number(surfacePayload?.metadata?.physicalMetersPerUnit) > 0 ? Number(surfacePayload.metadata.physicalMetersPerUnit) : 1;
    const rawHotspots = loadedHotspots;

    const navigationPlan = this._buildNavigationPlan(surfacePayload, rawHotspots);
    this.navigationPlan = navigationPlan;
    // Keep the visual camera independently tuned from the navigation agent.
    // The NavMesh can remain authored around its 1.6m agent clearance while the
    // customer-facing camera sits slightly higher for architectural presentation.
    this.eyeHeight = this.presentationSettings.camera.eyeHeightMeters;
    // Guided and Explore use their own manifest-controlled eye-line and FOV.
    this._applyCurrentCameraSettings({ updateHeight: true, notify: false });
    this.radius = Number(surfacePayload?.metadata?.agentRadiusMeters) > 0 ? Number(surfacePayload.metadata.agentRadiusMeters) : 0.15;
    this.walkSpeed = DEFAULT_SPEEDS.walk * this.metersPerUnit;
    this.runSpeed = DEFAULT_SPEEDS.run * this.metersPerUnit;

    this.presentationRooms = Array.isArray(topologyPayload?.rooms)
      ? topologyPayload.rooms.filter((room) => Array.isArray(room?.center) && room.center.length >= 3)
      : [];
    this.presentationSpaces = Array.isArray(topologyPayload?.spaces)
      ? topologyPayload.spaces.filter((space) => space?.id && Array.isArray(space?.center) && space.center.length >= 3)
      : [];
    this.presentationRoomGraph = topologyPayload?.graph || null;
    this.navigationSpaceGraph = topologyPayload?.navigationSpaceGraph || null;
    this.presentationPortals = Array.isArray(topologyPayload?.portals)
      ? topologyPayload.portals.filter((portal) => portal?.id && Array.isArray(portal?.center) && portal.center.length >= 3)
      : [];
    this.presentationPortalById = new Map(this.presentationPortals.map((portal) => [portal.id, portal]));

    this.model = gltf.scene;
    this.model.updateMatrixWorld(true);
    this.scene.add(this.model);
    this.performanceMonitor?.setLoadInfo({
      jobId,
      navigationMeshBytes: navBuffer.byteLength,
      navigationHotspotCount: rawHotspots.length,
      navigationAreaCount: semanticAreas.length,
      roomCount: Array.isArray(topologyPayload?.rooms) ? topologyPayload.rooms.length : 0,
      navigationSpaceCount: Array.isArray(topologyPayload?.spaces) ? topologyPayload.spaces.length : 0,
      portalCount: Array.isArray(topologyPayload?.portals) ? topologyPayload.portals.length : 0,
      parallelAssetLoadMs: Number((performance.now() - loadStartedAt).toFixed(1)),
    });
    this.lightingDirector.attachModel(this.model);
    this.onState?.({ type: 'lighting', ...this.lightingDirector.getState() });
    this._buildPresentationSubjectIndex(projectStatePayload, hotspotsPayload);

    this.onState?.({
      type: 'presentation-topology',
      rooms: this.presentationRooms,
      spaces: this.presentationSpaces,
      portals: this.presentationPortals,
      roomGraph: this.presentationRoomGraph,
      navigationSpaceGraph: this.navigationSpaceGraph,
      stats: topologyPayload?.stats || null,
    });

    this._buildNavigationSurface(surfacePayload);

    // GLB bounding volumes can be stale/invalid after compiler-side transforms.
    // Disable frustum culling for walkthrough rendering until bounds are verified.
    let meshCount = 0;
    let visibleMeshCount = 0;
    this.model.traverse((obj) => {
      if (!obj.isMesh) return;
      meshCount += 1;
      obj.visible = true;

      // Phase 0 safety: preserve the known-working walkthrough visibility
      // behavior. Robust bounds/culling will be introduced as a separate,
      // measured performance phase.
      obj.frustumCulled = false;
      visibleMeshCount += obj.visible ? 1 : 0;
    });
    this.performanceMonitor?.setModel(this.model);

    const box = new THREE.Box3().setFromObject(this.model);
    const modelSphere = box.getBoundingSphere(new THREE.Sphere());
    if (Number.isFinite(modelSphere.radius) && modelSphere.radius > 0) {
      const recommendedFar = THREE.MathUtils.clamp(modelSphere.radius * 4, 250, 2500);
      this.camera.far = Math.min(this.camera.far, recommendedFar);
      this.camera.updateProjectionMatrix();
    }

    // Never expose or spawn on destinations where the presentation camera would
    // be underneath a low object (e.g. a bed, table, cabinet) even if the
    // architectural slab is technically walkable beneath it.
    const safeRenderedHotspots = rawHotspots.filter((hotspot) => this._hasCameraClearance(hotspot.position));
    // Phase 7: curated backend destinations are already spatially selected and
    // semantically typed. Do not re-expand them into generic floor markers.
    // Legacy/older jobs without curated metadata keep the Phase 6 augmentation
    // fallback so they remain usable.
    const isCuratedDestinationSet = hotspotsPayload?.metadata?.navigationQuality === 'curated-v1'
      || safeRenderedHotspots.some((hotspot) => hotspot.presentationRole);
    const augmentedHotspots = isCuratedDestinationSet
      ? safeRenderedHotspots
      : this._augmentHotspotsFromFloor(surfacePayload, safeRenderedHotspots, 18);
    this.hotspots = augmentedHotspots;
    if (semanticAreas.length) {
      const activeAreaIds = new Set(augmentedHotspots.map((hotspot) => hotspot.areaId).filter(Boolean));
      this.walkAreas = semanticAreas.filter((area) => activeAreaIds.has(area.id));
    }
    this.lightingDirector.setRoomAnchors(this.walkAreas);
    this._assignHotspotRoles();
    this._buildDestinationPresentationIndex();
    this._buildSafeAnchorRegistry();
    this.navigationPlan = this._buildNavigationPlan(surfacePayload, augmentedHotspots);
    if (safeRenderedHotspots.length !== rawHotspots.length) {
      console.info('[Walkthrough] Removed unsafe low-clearance hotspots', {
        removed: rawHotspots.length - safeRenderedHotspots.length,
        remaining: augmentedHotspots.length,
      });
    }
    if (augmentedHotspots.length > safeRenderedHotspots.length) {
      console.info('[Walkthrough] Added safe presentation hotspots', {
        added: augmentedHotspots.length - safeRenderedHotspots.length,
        total: augmentedHotspots.length,
      });
    }

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);

    // IFC/GLB files can contain distant helper geometry or stale bounds.
    // For the initial camera framing, prefer the semantic walk-area footprint
    // because those points describe the actual house people can move through.
    let overviewWidth = Math.max(size.x, 1);
    let overviewDepth = Math.max(size.z, 1);
    let overviewTarget = center.clone();
    if (this.walkAreas.length >= 2) {
      const xs = this.walkAreas.map((area) => Number(area.center[0])).filter(Number.isFinite);
      const zs = this.walkAreas.map((area) => Number(area.center[2])).filter(Number.isFinite);
      const ys = this.walkAreas.map((area) => Number(area.center[1])).filter(Number.isFinite);
      if (xs.length && zs.length) {
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minZ = Math.min(...zs);
        const maxZ = Math.max(...zs);
        const footprintPadding = Math.max(this.metersPerUnit * 2, Math.min(size.x, size.z) * 0.08);
        overviewWidth = Math.max(maxX - minX + footprintPadding * 2, this.metersPerUnit * 4);
        overviewDepth = Math.max(maxZ - minZ + footprintPadding * 2, this.metersPerUnit * 4);
        overviewTarget.set(
          (minX + maxX) * 0.5,
          ys.length ? THREE.MathUtils.clamp(ys.reduce((a, b) => a + b, 0) / ys.length, box.min.y, box.max.y) : box.min.y,
          (minZ + maxZ) * 0.5,
        );
      }
    }

    this.viewTarget.copy(overviewTarget);
    this.overviewWidth = overviewWidth;
    this.overviewDepth = overviewDepth;
    // Keep legacy preset framing for perspective/isometric/front/side, while
    // Top view computes its distance from the actual horizontal footprint.
    this.viewDistance = Math.max(maxDim, 1) * 1.65;
    this.overviewPanSpeed = Math.max(overviewWidth, overviewDepth, 1) * 0.6;
    this.orbitControls.target.copy(center);
    this.orbitControls.minDistance = Math.max(maxDim * 0.04, 0.3);
    this.orbitControls.maxDistance = Math.max(maxDim * 12, 30);
    this.camera.near = Math.max(0.02, maxDim / 5000);
    this.camera.far = Math.max(200, maxDim * 20);
    this.camera.updateProjectionMatrix();

    // Presentation start: center the camera over the actual house footprint.
    // A top view is more useful as the default because it immediately establishes
    // the floorplan/house context before the user enters walkthrough mode.
    this.setViewPreset('top');

    const spawnCandidates = [...this.hotspots]
      .filter((hotspot) => Array.isArray(hotspot.position))
      .map((hotspot) => ({ hotspot, openness: this._presentationOpenSpaceScore(hotspot.position) }))
      .filter((entry) => entry.openness > 0)
      .sort((a, b) => b.openness - a.openness || (Number(b.hotspot.score) || 0) - (Number(a.hotspot.score) || 0));
    let start = null;
    for (const entry of spawnCandidates) {
      const candidate = this._closestWalkPoint(entry.hotspot.position);
      if (!candidate || !this._hasCameraClearance([candidate.x, candidate.y, candidate.z])) continue;
      start = candidate;
      break;
    }
    if (!start) {
      const emergencySeed = this.walkAreas[0]?.center || [center.x, 0, center.z];
      start = this._findSafeSpawnFromSurface(surfacePayload, emergencySeed);
    }
    if (!start) throw new Error('No safe walkthrough spawn position was found on the walkable floor.');

    this.position.set(start.x, start.y, start.z);
    this.currentPolyRef = start.polyRef || 0;
    this.lastMovementPosition.copy(this.position);
    this._rememberNearestSafeAnchor(this.position, 'spawn');

    // The architectural hotspot probe validates the floor and headroom. The
    // movement guard below validates the actual camera envelope. If a stale or
    // marginal hotspot leaves the camera too close to a wall, promote a known
    // safe anchor before the user even enters walkthrough mode.
    if (!this._hasCameraBodyClearance(this.position)) {
      const recoveryCandidate = this._safeAnchorCandidates(this.position)
        .find((entry) => Math.hypot(entry.point.x - this.position.x, entry.point.z - this.position.z) > 0.55 * Math.max(this.metersPerUnit, 0.000001));
      if (recoveryCandidate?.point) {
        this.position.set(recoveryCandidate.point.x, recoveryCandidate.point.y, recoveryCandidate.point.z);
        this.currentPolyRef = recoveryCandidate.point.polyRef || this.currentPolyRef;
        this.lastMovementPosition.copy(this.position);
        this._rememberNearestSafeAnchor(this.position, 'spawn-recovery');
      }
    }
    // Prepare the very first Guided view immediately. Without this, the camera
    // could enter the walkthrough carrying the overview heading and stare into a
    // wall/ceiling before the first destination click caused a reframe.
    this.currentYaw = this.yaw;
    this.targetYaw = this.yaw;
    this.currentPitch = this.guidedPitch;
    this.targetPitch = this.guidedPitch;
    this._syncCamera();
    this._prepareGuidedArrivalView(this.position, this.lastMoveDirection);
    if (this.walkMode === 'guided' && Number.isFinite(this.targetYaw)) {
      this.currentYaw = this.targetYaw;
      this.guidedYawCenter = this.currentYaw;
      this.guidedCompositionYaw = this.currentYaw;
      this.guidedCompositionTargetYaw = this.currentYaw;
      this.guidedLastCompositionAt = performance.now();
      this.guidedPanPhase = 0;
    }
    // Keep the player position prepared in the background, but leave the camera in overview mode.
    this._buildPortals();

    console.info('[Walkthrough] Scene ready', {
      jobId,
      modelBounds: { min: box.min.toArray(), max: box.max.toArray() },
      modelSize: size.toArray(),
      sceneCenter: center.toArray(),
      spawn: this.position.toArray(),
      cameraPosition: this.camera.position.toArray(),
      cameraNearFar: [this.camera.near, this.camera.far],
      destinationCount: this.walkAreas.length,
      hotspotCount: this.hotspots.length,
      safeAnchorCount: this.safeAnchorIds.size,
      navMeshBytes: navBuffer.byteLength,
      meshCount,
      visibleMeshCount,
    });

    this.onState?.({ type: 'loaded', areas: this.walkAreas, size, center });
    return { areas: this.walkAreas, size, center };
  }

  _augmentHotspotsFromFloor(surfacePayload, existing, targetCount = 18) {
    const base = Array.isArray(existing) ? [...existing] : [];
    if (base.length >= targetCount) return base;

    const positions = Array.isArray(surfacePayload?.positions) ? surfacePayload.positions : [];
    const indices = Array.isArray(surfacePayload?.indices) ? surfacePayload.indices : [];
    if (positions.length < 9 || indices.length < 3) return base;

    const candidates = [];
    const triangleCount = Math.floor(indices.length / 3);
    const step = Math.max(1, Math.floor(triangleCount / 700));
    for (let t = 0; t < triangleCount; t += step) {
      const ia = Number(indices[t * 3]) * 3;
      const ib = Number(indices[t * 3 + 1]) * 3;
      const ic = Number(indices[t * 3 + 2]) * 3;
      if (![ia, ib, ic].every((i) => Number.isFinite(i) && i >= 0 && i + 2 < positions.length)) continue;

      const candidate = [
        (Number(positions[ia]) + Number(positions[ib]) + Number(positions[ic])) / 3,
        (Number(positions[ia + 1]) + Number(positions[ib + 1]) + Number(positions[ic + 1])) / 3,
        (Number(positions[ia + 2]) + Number(positions[ib + 2]) + Number(positions[ic + 2])) / 3,
      ];
      const snapped = this._closestWalkPoint(candidate);
      if (!snapped) continue;
      const point = [snapped.x, snapped.y, snapped.z];
      if (!this._hasCameraClearance(point)) continue;

      const openness = this._presentationOpenSpaceScore(point);
      if (!(openness > 0)) continue;

      let nearestExisting = Infinity;
      for (const h of base) {
        if (!Array.isArray(h.position)) continue;
        nearestExisting = Math.min(nearestExisting, Math.hypot(point[0] - h.position[0], point[2] - h.position[2]));
      }
      // Keep destinations meaningfully separated. Unit is GLB-space-aware.
      const minSpacing = 1.25 * Math.max(this.metersPerUnit, 0.000001);
      if (nearestExisting < minSpacing) continue;
      candidates.push({ point, openness });
    }

    candidates.sort((a, b) => b.openness - a.openness);
    const selected = [];
    const minSpacing = 1.35 * Math.max(this.metersPerUnit, 0.000001);
    for (const candidate of candidates) {
      let tooClose = false;
      for (const h of [...base, ...selected]) {
        if (!Array.isArray(h.position)) continue;
        if (Math.hypot(candidate.point[0] - h.position[0], candidate.point[2] - h.position[2]) < minSpacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      selected.push({
        id: `generated-hotspot-${selected.length + 1}`,
        position: candidate.point,
        clearanceMeters: candidate.openness,
        score: candidate.openness,
        source: 'navmesh-floor',
        label: `Navigation point ${base.length + selected.length + 1}`,
      });
      if (base.length + selected.length >= targetCount) break;
    }
    return [...base, ...selected];
  }

  _assignHotspotRoles() {
    this.hotspotRoles.clear();
    if (!this.hotspots?.length) return;

    const unit = Math.max(this.metersPerUnit, 0.000001);
    const radiusNear = 1.35 * unit;
    const radiusCluster = 3.4 * unit;

    // First pass: derive local spatial statistics. We deliberately avoid naming
    // rooms unless the backend already supplied an areaId/label. The runtime can
    // still distinguish a useful presentation role without pretending that a
    // generic hotspot is a real architectural room.
    for (const hotspot of this.hotspots) {
      if (!hotspot?.id || !Array.isArray(hotspot.position)) continue;
      const x = Number(hotspot.position[0]);
      const z = Number(hotspot.position[2]);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;

      const neighbors = [];
      for (const other of this.hotspots) {
        if (other === hotspot || !Array.isArray(other?.position)) continue;
        const dx = Number(other.position[0]) - x;
        const dz = Number(other.position[2]) - z;
        const distance = Math.hypot(dx, dz);
        if (distance <= radiusCluster) neighbors.push(distance);
      }
      neighbors.sort((a, b) => a - b);
      const closeCount = neighbors.filter((distance) => distance <= radiusNear).length;
      const openness = Number(hotspot.clearanceMeters ?? hotspot.score ?? 0) || 0;

      const explicitRole = String(hotspot.presentationRole || hotspot.role || '').trim();
      let role = ['room-center', 'room-entrance', 'viewpoint', 'transition', 'walkpoint'].includes(explicitRole)
        ? explicitRole
        : 'walkpoint';
      if (!explicitRole && /entr(y|ance)/i.test(String(hotspot.label || ''))) {
        role = 'room-entrance';
      } else if (!explicitRole && closeCount <= 1 && openness >= 1.45) {
        role = 'viewpoint';
      } else if (!explicitRole && closeCount >= 5) {
        role = 'room-center';
      } else if (!explicitRole && closeCount >= 3 && openness < 1.0) {
        role = 'transition';
      }

      this.hotspotRoles.set(hotspot.id, role);
      hotspot.presentationRole = role;
    }

    // Guarantee at least one center/viewpoint candidate in the overall scene.
    // Pick from open destinations rather than inventing new geometry.
    const hasCenter = [...this.hotspotRoles.values()].some((role) => role === 'room-center');
    if (!hasCenter) {
      let best = null;
      for (const hotspot of this.hotspots) {
        const openness = Number(hotspot.clearanceMeters ?? hotspot.score ?? 0) || 0;
        if (!best || openness > best.score) best = { hotspot, score: openness };
      }
      if (best?.hotspot?.id) {
        this.hotspotRoles.set(best.hotspot.id, 'room-center');
        best.hotspot.presentationRole = 'room-center';
      }
    }
  }

  _getHotspotRole(hotspot) {
    if (!hotspot?.id) return 'walkpoint';
    return this.hotspotRoles.get(hotspot.id) || hotspot.presentationRole || 'walkpoint';
  }

  _buildDestinationPresentationIndex() {
    const records = (this.hotspots || [])
      .filter((hotspot) => hotspot?.id && Array.isArray(hotspot.position))
      .map((hotspot) => {
        const role = this._getHotspotRole(hotspot);
        const kind = role === 'room-center' ? 'primary' : role === 'viewpoint' ? 'optional' : 'internal';
        const areaLabel = String(hotspot.areaLabel || '').trim();
        const presentationLabel = kind === 'primary'
          ? (areaLabel || hotspot.label || 'Room')
          : kind === 'optional'
            ? (areaLabel ? `${areaLabel} · View` : (hotspot.label || 'Viewpoint'))
            : (hotspot.label || 'Navigation point');
        return { ...hotspot, destinationKind: kind, presentationRole: role, presentationLabel };
      });

    // Guarantee one client-facing destination for each known area.
    const byArea = new Map();
    records.forEach((record) => {
      if (!record.areaId) return;
      if (!byArea.has(record.areaId)) byArea.set(record.areaId, []);
      byArea.get(record.areaId).push(record);
    });
    for (const areaRecords of byArea.values()) {
      if (areaRecords.some((record) => record.destinationKind === 'primary')) continue;
      const fallback = areaRecords.find((record) => record.destinationKind === 'optional') || areaRecords[0];
      if (fallback) fallback.destinationKind = 'primary';
    }

    this.destinationPresentation = {
      version: 1,
      byId: new Map(records.map((record) => [record.id, record])),
      presentationHotspots: records.filter((record) => record.destinationKind !== 'internal'),
    };
    return this.destinationPresentation;
  }

  _getDestinationPresentation(hotspotOrId) {
    const id = typeof hotspotOrId === 'string' ? hotspotOrId : hotspotOrId?.id;
    return id ? this.destinationPresentation?.byId?.get(id) || null : null;
  }

  _isCustomerFacingDestination(hotspotOrId) {
    const destination = this._getDestinationPresentation(hotspotOrId);
    return Boolean(destination && destination.destinationKind !== 'internal');
  }

  _getCustomerFacingDestinations() {
    return this.destinationPresentation?.presentationHotspots || [];
  }

  _buildSafeAnchorRegistry() {
    this.safeAnchorIds.clear();
    this.safeAnchorById.clear();
    this.navigationHistory = [];
    this.lastSafeAnchorId = null;
    this.lastSafeAnchorPosition = null;
    this.recoveryAttemptedIds.clear();

    for (const hotspot of this.hotspots || []) {
      if (!hotspot?.id || !Array.isArray(hotspot.position)) continue;
      const role = this._getHotspotRole(hotspot);
      const openness = this._presentationOpenSpaceScore(hotspot.position);
      const safeForRecovery =
        openness >= SAFE_ANCHOR_MIN_OPEN_SPACE_METERS &&
        role !== 'walkpoint' &&
        this._hasCameraClearance(hotspot.position);
      if (!safeForRecovery) continue;

      const point = this._closestWalkPoint(hotspot.position, 0.45);
      if (!point) continue;
      if (!this._hasCameraClearance([point.x, point.y, point.z])) continue;

      const metadata = {
        hotspot,
        point,
        role,
        openness,
        score: (Number(hotspot.score) || 0) + openness,
      };
      this.safeAnchorIds.add(hotspot.id);
      this.safeAnchorById.set(hotspot.id, metadata);
    }

    // Always retain at least one recovery anchor when the scene has any valid
    // hotspot at all. Prefer the most open presentation destination.
    if (!this.safeAnchorIds.size && this.hotspots?.length) {
      const fallback = this.hotspots
        .map((hotspot) => ({ hotspot, openness: this._presentationOpenSpaceScore(hotspot.position) }))
        .filter((entry) => entry.openness > 0)
        .sort((a, b) => b.openness - a.openness)[0];
      if (fallback?.hotspot?.id) {
        const point = this._closestWalkPoint(fallback.hotspot.position, 0.45);
        if (point && this._hasCameraClearance([point.x, point.y, point.z])) {
          const metadata = {
            hotspot: fallback.hotspot,
            point,
            role: this._getHotspotRole(fallback.hotspot),
            openness: fallback.openness,
            score: (Number(fallback.hotspot.score) || 0) + fallback.openness,
          };
          this.safeAnchorIds.add(fallback.hotspot.id);
          this.safeAnchorById.set(fallback.hotspot.id, metadata);
        }
      }
    }
  }

  _rememberNearestSafeAnchor(position = this.position, reason = 'stable') {
    if (!this.safeAnchorIds.size || !position) return null;

    let best = null;
    for (const id of this.safeAnchorIds) {
      const entry = this.safeAnchorById.get(id);
      if (!entry?.point) continue;
      const distance = Math.hypot(entry.point.x - position.x, entry.point.z - position.z);
      if (!best || distance < best.distance) best = { id, entry, distance };
    }

    const snapDistance = 1.15 * Math.max(this.metersPerUnit, 0.000001);
    if (!best || best.distance > snapDistance) return null;

    this.lastSafeAnchorId = best.id;
    this.lastSafeAnchorPosition = best.entry.point;
    this.recoveryAttemptedIds.delete(best.id);

    const previous = this.navigationHistory[this.navigationHistory.length - 1];
    if (!previous || previous.id !== best.id) {
      this.navigationHistory.push({
        id: best.id,
        position: { x: best.entry.point.x, y: best.entry.point.y, z: best.entry.point.z },
        timestamp: performance.now(),
        reason,
      });
      if (this.navigationHistory.length > SAFE_ANCHOR_HISTORY_LIMIT) {
        this.navigationHistory.splice(0, this.navigationHistory.length - SAFE_ANCHOR_HISTORY_LIMIT);
      }
    }

    return best;
  }

  _safeAnchorCandidates(startPoint = this.position) {
    const candidates = [];
    for (const id of this.safeAnchorIds) {
      const entry = this.safeAnchorById.get(id);
      if (!entry?.point || this.recoveryAttemptedIds.has(id)) continue;
      const distanceFromStart = Math.hypot(entry.point.x - startPoint.x, entry.point.z - startPoint.z);
      if (distanceFromStart < 0.60 * Math.max(this.metersPerUnit, 0.000001)) continue;
      const result = this.query.computePath(startPoint, entry.point, {
        filter: this.filter,
        maxStraightPathSize: 256,
        maxPathSize: 256,
      });
      if (!this._isCompleteNavPath(result, entry.point)) continue;

      let length = 0;
      let previous = startPoint;
      for (const p of result.path) {
        length += Math.hypot(p.x - previous.x, p.z - previous.z);
        previous = p;
      }

      const historyIndex = this.navigationHistory.findIndex((item) => item.id === id);
      const historyBonus = historyIndex >= 0 ? (historyIndex / Math.max(1, this.navigationHistory.length)) * 1.5 : 0;
      const roleBonus = entry.role === 'room-center' ? 1.35
        : entry.role === 'room-entrance' ? 1.05
        : entry.role === 'viewpoint' ? 0.90
        : 0.35;
      const recentPenalty = id === this.lastSafeAnchorId ? 0.65 : 0;
      const score = length / Math.max(this.metersPerUnit, 0.000001) - roleBonus - historyBonus + recentPenalty;
      candidates.push({ id, ...entry, path: result.path, pathLength: length, score });
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates;
  }

  _buildNavigationPlan(surfacePayload, hotspots) {
    const positions = Array.isArray(surfacePayload?.positions) ? surfacePayload.positions : [];
    const indices = Array.isArray(surfacePayload?.indices) ? surfacePayload.indices : [];
    const points = [];
    const maxTriangles = 520;

    if (positions.length >= 9 && indices.length >= 3) {
      const triangleCount = Math.floor(indices.length / 3);
      const step = Math.max(1, Math.ceil(triangleCount / maxTriangles));
      for (let t = 0; t < triangleCount; t += step) {
        const base = t * 3;
        const ia = Number(indices[base]) * 3;
        const ib = Number(indices[base + 1]) * 3;
        const ic = Number(indices[base + 2]) * 3;
        if (![ia, ib, ic].every((i) => Number.isFinite(i) && i >= 0 && i + 2 < positions.length)) continue;
        points.push([
          Number(positions[ia]), Number(positions[ia + 2]),
          Number(positions[ib]), Number(positions[ib + 2]),
          Number(positions[ic]), Number(positions[ic + 2]),
        ]);
      }
    }

    const allHotspots = (hotspots || []).map((h, i) => ({
      id: h.id || `hotspot-${i + 1}`,
      x: Number(h.position?.[0]),
      z: Number(h.position?.[2]),
      label: h.label || `Navigation ${i + 1}`,
    })).filter((h) => Number.isFinite(h.x) && Number.isFinite(h.z));

    const xs = [];
    const zs = [];
    points.forEach((tri) => {
      for (let i = 0; i < tri.length; i += 2) { xs.push(tri[i]); zs.push(tri[i + 1]); }
    });
    allHotspots.forEach((h) => { xs.push(h.x); zs.push(h.z); });

    if (!xs.length || !zs.length) return null;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const pad = Math.max((maxX - minX) * 0.04, (maxZ - minZ) * 0.04, 0.2);

    return {
      bounds: { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad },
      triangles: points,
      hotspots: allHotspots,
    };
  }

  _assertJson(name) {
    return async (response) => {
      if (!response.ok) throw new Error(`${name} returned ${response.status}`);
      return response.json();
    };
  }

  _closestWalkPoint(point, toleranceMeters = 0.45) {
    // Navigation callers use both compact arrays ([x,y,z]) and Recast point
    // objects ({x,y,z}). Normalize at the boundary so a valid Recast point
    // cannot become NaN merely because a caller used the object form.
    const coordinates = Array.isArray(point)
      ? point
      : point && typeof point === 'object'
        ? [point.x, point.y, point.z]
        : [];
    if (coordinates.length < 3) return null;
    const p = {
      x: Number(coordinates[0]),
      y: Number(coordinates[1]) || 0,
      z: Number(coordinates[2]),
    };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    const tolerance = Math.max(0.12, toleranceMeters * Math.max(this.metersPerUnit, 1e-6));
    const result = this.query.findClosestPoint(p, {
      halfExtents: { x: tolerance, y: Math.max(0.6, 1.5 * Math.max(this.metersPerUnit, 1e-6)), z: tolerance },
      filter: this.filter,
    });
    if (!result.success) return null;
    const distance = Math.hypot(result.point.x - p.x, result.point.z - p.z);
    if (distance > tolerance * 1.05) return null;
    return {
      x: result.point.x,
      y: result.point.y,
      z: result.point.z,
      polyRef: result.polyRef ?? result.ref ?? 0,
    };
  }

  _inspectPathEndpoint(result, target, toleranceMeters = 0.4) {
    const coordinates = Array.isArray(target)
      ? target
      : target && typeof target === 'object'
        ? [target.x, target.y, target.z]
        : [];
    const targetX = Number(coordinates[0]);
    const targetY = Number(coordinates[1]) || 0;
    const targetZ = Number(coordinates[2]);
    const path = Array.isArray(result?.path) ? result.path : [];
    const endpoint = path.length ? path[path.length - 1] : null;
    const unit = Math.max(Number(this.metersPerUnit) || 1, 1e-6);
    const horizontalTolerance = Math.max(toleranceMeters * unit, 0.25);
    const verticalTolerance = Math.max(0.5 * unit, 0.35);

    if (!result?.success || !endpoint || ![targetX, targetY, targetZ, endpoint.x, endpoint.y, endpoint.z].every(Number.isFinite)) {
      return {
        complete: false,
        reason: 'no-path',
        endpoint: endpoint ? [endpoint.x, endpoint.y, endpoint.z] : null,
        target: Number.isFinite(targetX) && Number.isFinite(targetZ) ? [targetX, targetY, targetZ] : null,
        horizontalDistance: Infinity,
        verticalDistance: Infinity,
        horizontalTolerance,
        verticalTolerance,
      };
    }

    const horizontalDistance = Math.hypot(endpoint.x - targetX, endpoint.z - targetZ);
    const verticalDistance = Math.abs(endpoint.y - targetY);
    const complete = path.length > 0 && horizontalDistance <= horizontalTolerance && verticalDistance <= verticalTolerance;
    return {
      complete,
      reason: complete ? 'complete-path' : 'partial-path-endpoint',
      endpoint: [endpoint.x, endpoint.y, endpoint.z],
      target: [targetX, targetY, targetZ],
      horizontalDistance,
      verticalDistance,
      horizontalTolerance,
      verticalTolerance,
    };
  }

  _isCompleteNavPath(result, target, toleranceMeters = 0.4) {
    return this._inspectPathEndpoint(result, target, toleranceMeters).complete;
  }

  _isNavMeshCurveSegmentSafe(start, samples) {
    if (!this.query || !start || !Array.isArray(samples) || samples.length === 0) return false;
    const unit = Math.max(this.metersPerUnit || 1, 0.000001);
    const horizontalExtent = Math.max(0.20 * unit, 0.10);
    const snapTolerance = Math.max(0.10 * unit, 0.05);
    const sampleTolerance = Math.max(0.085 * unit, 0.045);
    let snapped = null;
    try {
      snapped = this.query.findClosestPoint(start, {
        halfExtents: {
          x: horizontalExtent,
          y: Math.max(0.65 * unit, 0.35),
          z: horizontalExtent,
        },
        filter: this.filter,
      });
    } catch (_) {
      return false;
    }
    if (!snapped?.success || !snapped.point) return false;
    let current = {
      x: Number(snapped.point.x),
      y: Number(snapped.point.y),
      z: Number(snapped.point.z),
    };
    const snapDistance = Math.hypot(current.x - start.x, current.y - start.y, current.z - start.z);
    let polyRef = snapped.polyRef ?? snapped.ref ?? 0;
    if (!polyRef || snapDistance > snapTolerance) return false;

    for (const sample of samples) {
      let moved = null;
      try {
        moved = this.query.moveAlongSurface(polyRef, current, sample, {
          filter: this.filter,
          maxVisitedSize: 128,
        });
      } catch (_) {
        return false;
      }
      if (!moved?.success || !moved.resultPosition) return false;
      const landed = {
        x: Number(moved.resultPosition.x),
        y: Number(moved.resultPosition.y),
        z: Number(moved.resultPosition.z),
      };
      if (![landed.x, landed.y, landed.z].every(Number.isFinite)) return false;
      // Reject a curve if Recast has to clamp its sample back to a boundary.
      // This prevents corner rounding from cutting through a wall or a narrow door.
      const error = Math.hypot(landed.x - sample.x, landed.y - sample.y, landed.z - sample.z);
      if (error > sampleTolerance) return false;
      current = landed;
      const visited = Array.isArray(moved.visited) ? moved.visited : [];
      polyRef = moved.resultPolyRef || visited[visited.length - 1] || polyRef;
    }
    return true;
  }

  _prepareNavPath(points) {
    if (!Array.isArray(points) || points.length <= 2) return this._simplifyPath(points || []);
    const unit = Math.max(this.metersPerUnit || 1, 0.000001);
    const minRadius = Math.max(0.075 * unit, 0.045);
    const maxRadius = 0.30 * unit;
    const minTurn = THREE.MathUtils.degToRad(20);
    const maxTurn = THREE.MathUtils.degToRad(148);
    const curveSteps = 5;
    const clean = points.filter((point) => point && [point.x, point.y, point.z].every(Number.isFinite));
    if (clean.length <= 2) return this._simplifyPath(clean);

    const prepared = [clean[0]];
    for (let i = 1; i < clean.length - 1; i += 1) {
      const previous = clean[i - 1];
      const corner = clean[i];
      const next = clean[i + 1];
      const inX = corner.x - previous.x;
      const inZ = corner.z - previous.z;
      const outX = next.x - corner.x;
      const outZ = next.z - corner.z;
      const inLength = Math.hypot(inX, inZ);
      const outLength = Math.hypot(outX, outZ);
      if (inLength < minRadius * 1.5 || outLength < minRadius * 1.5) {
        prepared.push(corner);
        continue;
      }

      const dot = THREE.MathUtils.clamp((inX * outX + inZ * outZ) / (inLength * outLength), -1, 1);
      const turnAngle = Math.acos(dot);
      if (turnAngle < minTurn || turnAngle > maxTurn) {
        prepared.push(corner);
        continue;
      }

      // Trim both legs and make a quadratic corner arc. Radius is deliberately
      // conservative in doorways and tight halls; Recast validates every sample.
      const radius = Math.min(maxRadius, inLength * 0.30, outLength * 0.30);
      if (radius < minRadius) {
        prepared.push(corner);
        continue;
      }
      const inNX = inX / inLength;
      const inNZ = inZ / inLength;
      const outNX = outX / outLength;
      const outNZ = outZ / outLength;
      const entry = {
        x: corner.x - inNX * radius,
        y: previous.y + (corner.y - previous.y) * (1 - radius / inLength),
        z: corner.z - inNZ * radius,
      };
      const exit = {
        x: corner.x + outNX * radius,
        y: corner.y + (next.y - corner.y) * (radius / outLength),
        z: corner.z + outNZ * radius,
      };
      const samples = [];
      for (let step = 1; step <= curveSteps; step += 1) {
        const t = step / curveSteps;
        const u = 1 - t;
        samples.push({
          x: u * u * entry.x + 2 * u * t * corner.x + t * t * exit.x,
          y: u * u * entry.y + 2 * u * t * corner.y + t * t * exit.y,
          z: u * u * entry.z + 2 * u * t * corner.z + t * t * exit.z,
        });
      }

      if (!this._isNavMeshCurveSegmentSafe(entry, samples)) {
        // Preserve the exact NavMesh corner when the arc lacks clearance.
        prepared.push(corner);
        continue;
      }
      prepared.push(entry, ...samples);
    }
    prepared.push(clean[clean.length - 1]);
    return this._simplifyPath(prepared);
  }

  _safePathLookAheadDistance(startIndex, requestedDistance) {
    if (!this.path?.length || this.path.length < 3) return requestedDistance;
    const unit = Math.max(this.metersPerUnit || 1, 0.000001);
    const cornerBuffer = 0.14 * unit;
    const turnThreshold = Math.cos(THREE.MathUtils.degToRad(25));
    let previous = this.position;
    let travelled = 0;

    for (let i = Math.max(0, startIndex); i < this.path.length - 1; i += 1) {
      const corner = this.path[i];
      const next = this.path[i + 1];
      const inX = corner.x - previous.x;
      const inZ = corner.z - previous.z;
      const outX = next.x - corner.x;
      const outZ = next.z - corner.z;
      const inLength = Math.hypot(inX, inZ);
      const outLength = Math.hypot(outX, outZ);
      if (inLength < 1e-5 || outLength < 1e-5) {
        if (inLength >= 1e-5) travelled += inLength;
        previous = corner;
        continue;
      }
      const dot = THREE.MathUtils.clamp((inX * outX + inZ * outZ) / (inLength * outLength), -1, 1);
      const distanceToCorner = travelled + inLength;
      // On an un-smoothed/clearance-rejected sharp corner, do not steer to a
      // point beyond it: that creates a chord through the inside of the turn.
      if (dot < turnThreshold && distanceToCorner <= requestedDistance + cornerBuffer) {
        return distanceToCorner > cornerBuffer
          ? Math.min(requestedDistance, distanceToCorner - cornerBuffer)
          : Math.min(requestedDistance, distanceToCorner);
      }
      travelled += inLength;
      previous = corner;
    }
    return requestedDistance;
  }

  _getTravelPathYaw(maxLookAheadMeters = 1.05) {
    if (!this.path?.length) return null;
    const unit = Math.max(this.metersPerUnit || 1, 0.000001);
    const requested = Math.max(0.22 * unit, maxLookAheadMeters * unit);
    const lookAhead = this._safePathLookAheadDistance(this.pathIndex, requested);
    const target = this._pointAlongPath(this.pathIndex, Math.max(0.03 * unit, lookAhead));
    let dx = (target?.x ?? this.position.x) - this.position.x;
    let dz = (target?.z ?? this.position.z) - this.position.z;
    if (Math.hypot(dx, dz) < 1e-4) {
      const waypoint = this.path[Math.min(this.pathIndex, this.path.length - 1)];
      dx = waypoint.x - this.position.x;
      dz = waypoint.z - this.position.z;
    }
    if (Math.hypot(dx, dz) < 1e-4) return null;
    return Math.atan2(-dx, -dz);
  }

  _clampYawToTravelHeading(yaw, maxOffsetDegrees = 38) {
    const travelYaw = this._getTravelPathYaw();
    if (!Number.isFinite(travelYaw) || !Number.isFinite(yaw)) return yaw;
    const delta = Math.atan2(Math.sin(yaw - travelYaw), Math.cos(yaw - travelYaw));
    const limit = THREE.MathUtils.degToRad(maxOffsetDegrees);
    return travelYaw + THREE.MathUtils.clamp(delta, -limit, limit);
  }

  _simplifyPath(points) {
    if (!Array.isArray(points) || points.length <= 2) return points || [];
    const minSegment = Math.max(0.06 * this.metersPerUnit, 0.04);
    const compact = [points[0]];
    for (let i = 1; i < points.length; i += 1) {
      const prev = compact[compact.length - 1];
      const next = points[i];
      if (Math.hypot(next.x - prev.x, next.z - prev.z) >= minSegment || i === points.length - 1) compact.push(next);
    }
    return compact;
  }

  _pointAlongPath(startIndex, lookAheadDistance) {
    if (!this.path?.length) return null;
    let current = this.position.clone();
    let remaining = Math.max(0, lookAheadDistance);

    for (let i = Math.max(0, startIndex); i < this.path.length; i += 1) {
      const node = this.path[i];
      const dx = node.x - current.x;
      const dz = node.z - current.z;
      const segment = Math.hypot(dx, dz);
      if (segment < 1e-6) {
        current.set(node.x, node.y, node.z);
        continue;
      }
      if (segment >= remaining) {
        const t = remaining / segment;
        return new THREE.Vector3(
          current.x + dx * t,
          current.y + (node.y - current.y) * t,
          current.z + dz * t,
        );
      }
      remaining -= segment;
      current.set(node.x, node.y, node.z);
    }
    const last = this.path[this.path.length - 1];
    return new THREE.Vector3(last.x, last.y, last.z);
  }

  _teleportToDestination(point, label = 'Destination', mode = 'map-jump') {
    if (!point) return false;
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.directTravel = null;
    this.blockedTime = 0;
    this.guidedApproachActive = false;
    this.guidedRevealActive = false;
    this.guidedArrivalSettleStartedAt = 0;

    this.position.set(point.x, point.y, point.z);
    this.currentPolyRef = point.polyRef || this.currentPolyRef;
    this.lastMovementPosition.copy(this.position);
    this._rememberNearestSafeAnchor(this.position, 'teleport');
    this._prepareGuidedArrivalView(this.position, this.lastMoveDirection);
    this.stuck = false;
    this.recoveryAvailable = false;
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', label, active: false, mode });
    this.onState?.({ type: 'teleport', label, mode });
    return true;
  }

  _isWalkablePortalVisual(object) {
    let current = object;
    while (current) {
      const extras = current.userData || {};
      if (extras.hciWalkablePortal === true || extras.hciPortalType === 'door' && extras.hciWalkablePortal !== false) {
        return true;
      }
      current = current.parent || null;
    }
    return false;
  }

  _firstBlockingModelHit(origin, direction) {
    if (!this.model) return null;
    this.raycaster.set(origin, direction);
    const hits = this.raycaster.intersectObject(this.model, true);
    return hits.find((hit) => !this._isWalkablePortalVisual(hit.object)) || null;
  }

  _hasCameraBodyClearance(point) {
    const coordinates = Array.isArray(point)
      ? point
      : point && typeof point === 'object'
        ? [point.x, point.y, point.z]
        : [];
    if (!this.model || coordinates.length < 3) return true;

    const unit = Math.max(this.metersPerUnit, 0.000001);
    const bodyRadius = CAMERA_BODY_CLEARANCE_METERS * unit;
    const cameraY = Number(coordinates[1]) + this.eyeHeight * unit + this.heightOffset * unit * 0.92;
    const origin = new THREE.Vector3(Number(coordinates[0]), cameraY, Number(coordinates[2]));

    // This is a deliberately cheaper movement-time collision test than the full
    // hotspot clearance probe. It protects the camera body from entering walls or
    // furniture while avoiding an 8-ray architectural validation every frame.
    const directions = 12;
    for (let i = 0; i < directions; i += 1) {
      const angle = (Math.PI * 2 * i) / directions;
      const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const hit = this._firstBlockingModelHit(origin, direction);
      if (hit && hit.distance < bodyRadius) return false;
    }

    // Also reject a position already embedded in geometry by probing a tiny
    // outward shell in the opposite direction of the last movement.
    if (this.lastMoveDirection.lengthSq() > 1e-8) {
      const back = this.lastMoveDirection.clone().normalize().negate();
      const hit = this._firstBlockingModelHit(origin, back);
      if (hit && hit.distance < bodyRadius * 0.72) return false;
    }
    return true;
  }

  _hasCameraClearance(point) {
    if (!this.model || !Array.isArray(point) || point.length < 3) return true;

    const unit = Math.max(this.metersPerUnit, 0.000001);
    const originY = Number(point[1]) + Math.max(0.06 * unit, 0.01);
    const cameraClearance = (this.eyeHeight + 0.10) * unit;

    // Vertical ray catches the exact class of failure seen in the screenshot:
    // a valid floor position exists underneath a bed/table, but there isn't
    // enough head room for the walkthrough camera.
    const verticalHit = this._firstBlockingModelHit(
      new THREE.Vector3(Number(point[0]), originY, Number(point[2])),
      new THREE.Vector3(0, 1, 0),
    );
    if (verticalHit && verticalHit.distance < cameraClearance) return false;

    // Also reject destinations with a very tight horizontal envelope around the
    // avatar. This is intentionally conservative for customer-facing hotspots.
    const horizontalOrigin = new THREE.Vector3(Number(point[0]), originY + 0.25 * unit, Number(point[2]));
    const clearance = 0.34 * unit;
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8;
      const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const hit = this._firstBlockingModelHit(horizontalOrigin, direction);
      if (hit && hit.distance < clearance) return false;
    }
    return true;
  }

  _presentationOpenSpaceScore(point) {
    if (!this.model || !Array.isArray(point) || point.length < 3) return 1;
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const origin = new THREE.Vector3(Number(point[0]), Number(point[1]) + 0.12 * unit, Number(point[2]));
    const requiredHeadroom = (this.eyeHeight + 0.08) * unit;
    const ceilingHit = this._firstBlockingModelHit(origin, new THREE.Vector3(0, 1, 0));
    if (ceilingHit && ceilingHit.distance < requiredHeadroom) return 0;

    let nearest = Infinity;
    for (let i = 0; i < 16; i++) {
      const angle = (Math.PI * 2 * i) / 16;
      const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const hit = this._firstBlockingModelHit(origin, dir);
      if (hit) nearest = Math.min(nearest, hit.distance);
    }
    const comfort = 0.55 * unit;
    if (nearest < comfort) return 0;
    return Math.min(nearest / Math.max(unit, 0.000001), 4);
  }

  _findSafeSpawnFromSurface(surfacePayload, fallbackCenter) {
    const positions = surfacePayload?.positions;
    const indices = surfacePayload?.indices;
    if (Array.isArray(positions) && Array.isArray(indices) && positions.length >= 9 && indices.length >= 3) {
      const step = Math.max(1, Math.floor((indices.length / 3) / 500));
      for (let t = 0; t < indices.length / 3; t += step) {
        const ia = indices[t * 3] * 3;
        const ib = indices[t * 3 + 1] * 3;
        const ic = indices[t * 3 + 2] * 3;
        const candidate = [
          (positions[ia] + positions[ib] + positions[ic]) / 3,
          (positions[ia + 1] + positions[ib + 1] + positions[ic + 1]) / 3,
          (positions[ia + 2] + positions[ib + 2] + positions[ic + 2]) / 3,
        ];
        if (!this._hasCameraClearance(candidate)) continue;
        const snapped = this._closestWalkPoint(candidate);
        if (snapped && this._hasCameraClearance([snapped.x, snapped.y, snapped.z])) return snapped;
      }
    }
    if (fallbackCenter && this._hasCameraClearance(fallbackCenter)) return this._closestWalkPoint(fallbackCenter);
    return null;
  }

  _lookForwardTo(target) {
    const delta = new THREE.Vector3(target[0] - this.position.x, 0, target[2] - this.position.z);
    if (delta.lengthSq() < 1e-8) return;
    delta.normalize();
    const nextYaw = Math.atan2(-delta.x, -delta.z);
    this.yaw = nextYaw;
    this.pitch = -0.05;
    this.currentYaw = nextYaw;
    this.targetYaw = nextYaw;
    this.currentPitch = -0.05;
    this.targetPitch = -0.05;
  }

  _buildNavigationSurface(surfacePayload) {
    this.navSurfaceMesh?.geometry?.dispose?.();
    this.navSurfaceMesh?.material?.dispose?.();
    this.navSurfaceMesh && this.scene.remove(this.navSurfaceMesh);
    this.navSurfaceMesh = null;

    const positions = surfacePayload?.positions;
    const indices = surfacePayload?.indices;
    if (!Array.isArray(positions) || !Array.isArray(indices) || positions.length < 9 || indices.length < 3) {
      return;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    // The navigation surface is an invisible raycast target. It is deliberately
    // not rendered: the user interacts with the same floor representation that
    // powers the authoritative Recast NavMesh.
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.navSurfaceMesh = new THREE.Mesh(geometry, material);
    this.navSurfaceMesh.userData.isNavigationSurface = true;
    this.navSurfaceMesh.frustumCulled = false;
    this.scene.add(this.navSurfaceMesh);
  }

  _buildPortals() {
    this.portalObjects.forEach((object) => {
      object.traverse?.((child) => {
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      });
      this.scene.remove(object);
    });
    this.portalObjects = [];
    this.portalTargets.clear();

    const unit = Math.max(this.metersPerUnit, 0.000001);
    const diskRadius = 0.17 * unit;
    const ringRadius = 0.25 * unit;
    const haloRadius = 0.48 * unit;
    const lift = Math.max(0.006 * unit, 0.002);

    const diskGeometry = new THREE.CircleGeometry(diskRadius, 48);
    const ringGeometry = new THREE.RingGeometry(diskRadius * 1.18, ringRadius, 48);
    const haloGeometry = new THREE.CircleGeometry(haloRadius, 48);

    this.hotspots.forEach((hotspot) => {
      const group = new THREE.Group();
      const diskMaterial = new THREE.MeshBasicMaterial({
        color: 0xff914d,
        transparent: true,
        opacity: 0.28,
        depthTest: true,
        depthWrite: false,
      });
      const disk = new THREE.Mesh(diskGeometry.clone(), diskMaterial);
      disk.rotation.x = -Math.PI / 2;
      disk.renderOrder = 6;

      const ringMaterial = new THREE.MeshBasicMaterial({
        color: 0xff914d,
        transparent: true,
        opacity: 0.95,
        depthTest: true,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeometry.clone(), ringMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 7;

      const haloMaterial = new THREE.MeshBasicMaterial({
        color: 0xff914d,
        transparent: true,
        opacity: 0.07,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const halo = new THREE.Mesh(haloGeometry.clone(), haloMaterial);
      halo.rotation.x = -Math.PI / 2;
      halo.renderOrder = 5;

      group.add(halo, disk, ring);
      group.position.set(
        Number(hotspot.position[0]),
        Number(hotspot.position[1]) + lift,
        Number(hotspot.position[2]),
      );
      group.userData.walkTarget = [
        Number(hotspot.position[0]),
        Number(hotspot.position[1]),
        Number(hotspot.position[2]),
      ];
      group.userData.walkLabel = hotspot.label || 'Floor destination';
      group.userData.hotspotId = hotspot.id;
      group.userData.source = hotspot.source;
      group.visible = false;
      this.scene.add(group);
      this.portalObjects.push(group);
      this.portalTargets.set(hotspot.id, group.userData.walkTarget);
    });
  }

  _pickPortal(event) {
    const hits = this._raycastHotspots(event);
    if (!hits.length) return false;
    const group = hits[0].object.parent?.isGroup ? hits[0].object.parent : hits[0].object;
    if (!group?.userData?.walkTarget) return false;
    const hotspot = this.hotspots.find((item) => item?.id === group.userData.hotspotId) || {
      id: group.userData.hotspotId || null,
      position: group.userData.walkTarget,
      label: group.userData.walkLabel || 'Floor destination',
    };
    const label = hotspot.label || 'Floor destination';
    this.navigateToHotspot(hotspot).then((ok) => {
      if (!ok) {
        // Keep the user's chosen destination authoritative. A failed route must
        // not silently send the camera toward a different recovery hotspot.
        console.warn('[Walkthrough] Destination route was not started; preserving current position.', {
          hotspotId: hotspot.id || null,
          label,
        });
      }
    });
    return true;
  }

  _raycastHotspots(event) {
    if (this.viewMode !== 'walk') return [];
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const visiblePortals = this.portalObjects.filter((portal) => portal.visible && portal.userData?.walkTarget);
    const hotspotHits = this.raycaster.intersectObjects(visiblePortals, true);
    if (!hotspotHits.length) return [];

    // A destination is clickable only when it is actually visible from the current
    // camera. Raycaster does not treat CSS/UI visibility as an interaction rule,
    // so explicitly reject portals hidden behind walls/doors/furniture.
    if (this.model) {
      const portalHit = hotspotHits[0];
      const sceneHit = this.raycaster.intersectObject(this.model, true)[0];
      if (sceneHit && sceneHit.distance + 0.02 * Math.max(this.metersPerUnit, 0.000001) < portalHit.distance) return [];
    }
    return hotspotHits;
  }

  _raycastNavigationSurface(event) {
    if (!this.navSurfaceMesh || this.viewMode !== 'walk') return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const floorHits = this.raycaster.intersectObject(this.navSurfaceMesh, false);
    if (!floorHits.length) return null;

    // Do not allow a floor click to pass through a visible bed, sofa, cabinet,
    // wall, etc. Compare the rendered scene hit against the invisible floor hit.
    const sceneHits = this.model
      ? this.raycaster.intersectObject(this.model, true)
      : [];
    const floorHit = floorHits[0];
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const occludedByObject = sceneHits.some((hit) =>
      hit.distance + 0.035 * unit < floorHit.distance
    );
    if (occludedByObject) return null;

    return floorHit.point;
  }

  _handleWalkPointer(event) {
    if (performance.now() < this.portalClickSuppressedUntil) return;
    if (this.path || this.directTravel) return;

    // Hotspots remain the preferred interaction target. They are prevalidated
    // physical destinations and therefore give deterministic travel behavior.
    if (this._pickPortal(event)) return;

    // A clean floor click is also a valid destination. Raycasting the invisible
    // exported navigation surface guarantees that we only accept actual floor,
    // never beds, sofas, walls, or other rendered geometry.
    const floorPoint = this._raycastNavigationSurface(event);
    if (!floorPoint) return;
    if (this.activeHotspotId) {
      this.guidedTourLastVisitedHotspotId = this.activeHotspotId;
    }
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = false;
    this.guidedManualActive = false;
    this.guidedManualYawUntil = 0;
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;
    this.activeHotspotId = null;
    this.travelTo([floorPoint.x, floorPoint.y, floorPoint.z], 'Floor destination');
  }

  async navigateToHotspot(hotspot) {
    if (!hotspot || this.viewMode !== 'walk') return false;
    if (this.path || this.directTravel) return false;

    // Normalize map records back to the runtime's canonical hotspot whenever
    // possible. The map intentionally stores a lightweight {x,y,z,id,label}
    // record; re-resolving by id prevents a presentation-layer copy from being
    // treated as a new/stale navigation point.
    const canonical = hotspot.id
      ? this.hotspots.find((item) => item?.id === hotspot.id)
      : null;
    const resolvedHotspot = canonical || hotspot;

    // Floor-map markers may omit Y. In-scene hotspots always carry a full tuple.
    const rawPosition = Array.isArray(resolvedHotspot.position)
      ? resolvedHotspot.position
      : [resolvedHotspot.x, Number(resolvedHotspot.y) || 0, resolvedHotspot.z];
    if (!Number.isFinite(Number(rawPosition[0])) || !Number.isFinite(Number(rawPosition[2]))) {
      return false;
    }

    // Hotspots in this.hotspots have already passed the camera-safety gate during
    // load. Do not re-run that gate against a re-snapped point: a closest-point
    // query can legally move a few centimeters to a neighbouring polygon and
    // make an already-approved presentation destination look unsafe.
    const usesCanonicalValidatedHotspot = Boolean(canonical);
    let point = this._closestWalkPoint(rawPosition, usesCanonicalValidatedHotspot ? 1.0 : 0.6);
    // Canonical hotspots were validated against the same NavMesh during load.
    // If the serialized query lands just outside the small lookup envelope
    // (for example after a raster/coordinate precision difference), retry with
    // a wider search envelope before declaring the destination unavailable.
    if (!point && usesCanonicalValidatedHotspot) {
      point = this._closestWalkPoint(rawPosition, 2.5);
      if (point) {
        console.warn('[Walkthrough] Canonical hotspot resolved with relaxed NavMesh lookup.', {
          hotspotId: resolvedHotspot.id,
          requested: rawPosition,
          resolved: [point.x, point.y, point.z],
        });
      }
    }
    if (!point) {
      this.onState?.({ type: 'error', message: 'That navigation point is no longer available.' });
      return false;
    }

    if (!usesCanonicalValidatedHotspot && !this._hasCameraClearance([point.x, point.y, point.z])) {
      this.onState?.({ type: 'error', message: 'That navigation point is no longer available.' });
      return false;
    }

    // A map/portal selection is a one-shot navigation request. It must stop any
    // previously running auto-tour and leave the camera focused on this room on
    // arrival. The autonomous tour advances only through _advanceGuidedTour().
    const previousActiveHotspotId = this.activeHotspotId;
    if (previousActiveHotspotId) {
      this.guidedTourLastVisitedHotspotId = previousActiveHotspotId;
    }
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = false;
    this.guidedPresentationAreaId = resolvedHotspot.areaId || null;
    this._configureGuidedTransition(resolvedHotspot);
    this.activeHotspotId = resolvedHotspot.id || null;

    // An explicit destination selection outranks a previous manual yaw override.
    // Otherwise the arrival-settle branch can be skipped and the camera never
    // re-frames the destination after a floor-map click.
    this.guidedManualActive = false;
    this.guidedManualYawUntil = 0;
    this.guidedPointerDown = null;
    this.guidedLastPointer = null;
    this.guidedPointerDragging = false;
    this.guidedYawVelocity = 0;
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;

    const label = resolvedHotspot.label || 'Navigation point';
    const start = { x: this.position.x, y: this.position.y, z: this.position.z };
    const result = this.query?.computePath(start, point, {
      filter: this.filter,
      maxStraightPathSize: 256,
      maxPathSize: 256,
    });

    const endpointStatus = this._inspectPathEndpoint(result, point);
    if (!endpointStatus.complete) {
      console.warn('[Walkthrough] Destination rejected because the NavMesh route is incomplete.', {
        hotspotId: resolvedHotspot.id || null,
        label,
        ...endpointStatus,
      });
      this.stuck = true;
      this.recoveryAvailable = this.hotspots.length > 0;
      this.onState?.({ type: 'error', message: `${label} is not fully reachable through the current walkable route.` });
      this.onState?.({ type: 'stuck', available: this.recoveryAvailable });
      return false;
    }

    return this.travelTo([point.x, point.y, point.z], label, { resolvedPoint: point });
  }

  async travelTo(target, label = 'Destination', options = null) {
    if (!this.query || this.viewMode !== 'walk' || this.path || this.directTravel) return false;
    const start = { x: this.position.x, y: this.position.y, z: this.position.z };
    const closest = options?.resolvedPoint || this._closestWalkPoint(target);
    if (!closest) {
      this.onState?.({ type: 'error', message: `No walkable point found for ${label}.` });
      return false;
    }
    const result = this.query.computePath(start, closest, {
      filter: this.filter,
      maxStraightPathSize: 256,
      maxPathSize: 256,
    });
    const endpointStatus = this._inspectPathEndpoint(result, closest);
    if (!endpointStatus.complete) {
      console.warn('[Walkthrough] Travel rejected because the NavMesh route is incomplete.', {
        label,
        ...endpointStatus,
      });
      this.onState?.({ type: 'error', message: `${label} is not fully reachable from the current position.` });
      this.stuck = true;
      this.recoveryAvailable = this.hotspots.length > 0;
      this.onState?.({ type: 'stuck', available: this.recoveryAvailable });
      return false;
    }
    this.directTravel = null;
    this.path = this._prepareNavPath(result.path.map((p) => ({ x: p.x, y: p.y, z: p.z })));
    this.pathIndex = 0;
    this.pathReplanAttempts = 0;
    this.pathVelocity.set(0, 0, 0);
    this.travelTotalDistance = this._estimatePathLengthFrom(this.position, 0);
    this.travelElapsed = 0;
    this.travelMode = 'path';
    this.arrivalSettleUntil = 0;
    this.guidedApproachActive = false;
    this.guidedRevealActive = false;
    this.guidedArrivalSettleStartedAt = 0;
    this.blockedTime = 0;
    this.cameraClearanceTimer = 0;
    this.progressWatchTime = 0;
    this.lastMovementPosition.copy(this.position);
    this.stuck = false;
    this.recoveryAvailable = false;
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', label, active: true, mode: 'path', hotspotId: this.activeHotspotId });
    return true;
  }

  async switchRoom(target, label = 'Node') {
    if (!this.query) return false;

    const areaId = target?.id;
    const semanticRoom = this.presentationRooms.find((room) => room?.id === areaId)
      || this.presentationSpaces.find((space) => space?.id === areaId)
      || null;
    const targetPoint = Array.isArray(semanticRoom?.center)
      ? [semanticRoom.center[0], semanticRoom.center[1], semanticRoom.center[2]]
      : (Array.isArray(target?.center) ? target.center : [0, 0, 0]);
    const pool = this.hotspots
      .filter((hotspot) => !areaId || !semanticRoom || hotspot.areaId === areaId || !hotspot.areaId)
      .filter((hotspot) => Array.isArray(hotspot.position) && this._hasCameraClearance(hotspot.position));

    const candidates = (pool.length ? pool : this.hotspots)
      .map((hotspot) => ({
        hotspot,
        distance: Math.hypot(hotspot.position[0] - targetPoint[0], hotspot.position[2] - targetPoint[2]),
        role: this._getHotspotRole(hotspot),
      }))
      .sort((a, b) => {
        const priority = (role) => role === 'room-entrance' ? 0 : role === 'room-center' ? 1 : role === 'viewpoint' ? 2 : role === 'transition' ? 3 : 4;
        return (priority(a.role) - priority(b.role)) || (a.distance - b.distance);
      });

    const start = { x: this.position.x, y: this.position.y, z: this.position.z };
    for (const candidate of candidates) {
      const closest = this._closestWalkPoint(candidate.hotspot.position, 1.0);
      if (!closest) continue;
      const route = this.query.computePath(start, closest, {
        filter: this.filter,
        maxStraightPathSize: 256,
        maxPathSize: 256,
      });
      if (!this._isCompleteNavPath(route, closest)) continue;
      this._armGuidedTourForHotspot(candidate.hotspot);
      const ok = await this.travelTo([closest.x, closest.y, closest.z], label, { resolvedPoint: closest });
      if (ok) return true;
    }

    // Room selection must not interpolate/teleport through structural geometry.
    // A failed full path is surfaced as a navigation issue until the wall opening
    // and Recast surface are genuinely connected.
    this.onState?.({ type: 'error', message: `${label} has no complete walkable route from the current room.` });
    return false;
  }

  _configureGuidedTransition(hotspot) {
    const current = this.hotspots.find((item) => item.id === this.guidedTourLastVisitedHotspotId);
    const currentArea = current?.areaId || this.guidedTourLastAreaId || null;
    const nextArea = hotspot?.areaId || null;
    const role = this._getHotspotRole(hotspot);

    let kind = 'standard';
    if (currentArea && nextArea && currentArea === nextArea) {
      kind = 'same-space';
    } else if (role === 'room-entrance') {
      kind = 'room-entry';
    } else if (currentArea && nextArea && currentArea !== nextArea) {
      kind = 'room-crossing';
    }

    this.guidedTransitionKind = kind;
    this.guidedTransitionApproachDistanceMeters = kind === 'room-entry'
      ? 4.1
      : kind === 'room-crossing'
        ? 3.8
        : kind === 'same-space'
          ? 2.6
          : 3.0;

    this.guidedArrivalSettleDurationMs = kind === 'room-entry'
      ? 1850
      : kind === 'room-crossing'
        ? 1750
        : kind === 'same-space'
          ? 1250
          : 1500;
  }

  _armGuidedTourForHotspot(hotspot) {
    if (this.walkMode !== 'guided' || !hotspot?.id) return;
    this.guidedTourArmed = true;
    this.guidedPresentationAreaId = hotspot.areaId || this.guidedTourLastAreaId || null;
    this._configureGuidedTransition(hotspot);
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = false;
    this.guidedTourVisitedHotspots.add(hotspot.id);
    if (hotspot.areaId) {
      this.guidedTourLastAreaId = hotspot.areaId;
      this.guidedTourLastRole = this._getHotspotRole(hotspot);
    }
  }

  _markGuidedTourArrival() {
    if (this.walkMode !== 'guided' || !this.guidedTourArmed) return;
    const current = this.hotspots.find((hotspot) => hotspot.id === this.activeHotspotId);
    if (current?.id) {
      this.guidedTourVisitedHotspots.add(current.id);
      this.guidedTourLastVisitedHotspotId = current.id;
    }
    if (current?.areaId) {
      this.guidedTourVisitedAreas.add(current.areaId);
      this.guidedTourLastAreaId = current.areaId;
      this.guidedTourLastRole = this._getHotspotRole(current);
    }
    this.guidedTourNextAt = performance.now() + this.guidedArrivalSettleDurationMs + this.guidedTourHoldMs;
    this.guidedTourAdvanceLock = false;
  }

  _tourRolePriority(currentRole, candidateRole) {
    if (currentRole === 'room-center') {
      if (candidateRole === 'viewpoint') return 0;
      if (candidateRole === 'room-entrance') return 1;
      if (candidateRole === 'room-center') return 2;
    } else if (currentRole === 'viewpoint') {
      if (candidateRole === 'room-entrance') return 0;
      if (candidateRole === 'room-center') return 1;
      if (candidateRole === 'viewpoint') return 2;
    } else if (currentRole === 'room-entrance') {
      if (candidateRole === 'room-center') return 0;
      if (candidateRole === 'viewpoint') return 1;
      if (candidateRole === 'room-entrance') return 2;
    }
    return candidateRole === 'room-center' ? 0 : candidateRole === 'viewpoint' ? 1 : candidateRole === 'room-entrance' ? 2 : 3;
  }

  _chooseNextGuidedTourDestination() {
    if (!this.guidedTourArmed || !this.query || !this.hotspots?.length) return null;
    const current = this.hotspots.find((hotspot) => hotspot.id === this.activeHotspotId);
    const currentRole = current ? this._getHotspotRole(current) : (this.guidedTourLastRole || 'room-center');
    const currentAreaId = current?.areaId || this.guidedTourLastAreaId || null;
    const candidates = [];

    for (const hotspot of this.hotspots) {
      if (!hotspot?.id || !Array.isArray(hotspot.position)) continue;
      if (hotspot.id === this.activeHotspotId || this.guidedTourVisitedHotspots.has(hotspot.id)) continue;
      const role = this._getHotspotRole(hotspot);
      if (role === 'walkpoint' || role === 'transition') continue;
      if (!this._hasCameraClearance(hotspot.position)) continue;

      const point = this._closestWalkPoint(hotspot.position, 0.45);
      if (!point) continue;
      const result = this.query.computePath(
        { x: this.position.x, y: this.position.y, z: this.position.z },
        point,
        { filter: this.filter, maxStraightPathSize: 256, maxPathSize: 256 },
      );
      if (!this._isCompleteNavPath(result, point)) continue;

      let pathLength = 0;
      let previous = this.position;
      for (const p of result.path) {
        pathLength += Math.hypot(p.x - previous.x, p.z - previous.z);
        previous = p;
      }
      const distanceMeters = pathLength / Math.max(this.metersPerUnit, 1e-6);
      if (!Number.isFinite(distanceMeters) || distanceMeters < 0.9 || distanceMeters > 18) continue;

      const sameArea = Boolean(currentAreaId && hotspot.areaId && hotspot.areaId === currentAreaId);
      const newArea = Boolean(hotspot.areaId && !this.guidedTourVisitedAreas.has(hotspot.areaId));
      const rolePriority = this._tourRolePriority(currentRole, role);
      let score = (3 - rolePriority) * 2.2;
      score += sameArea ? 2.4 : 0;
      score += newArea ? 5.0 : 0;
      score += role === 'room-center' ? 2.1 : role === 'viewpoint' ? 1.4 : 0.4;
      score -= Math.min(distanceMeters, 12) * 0.17;
      if (currentRole === 'room-center' && role === 'viewpoint' && sameArea) score += 2.4;
      if (currentRole === 'viewpoint' && role === 'room-entrance') score += 2.7;
      if (currentRole === 'room-entrance' && role === 'room-center' && sameArea) score += 3.1;
      if (role === 'room-center' && newArea) score += 2.0;
      candidates.push({ hotspot, point, score, distanceMeters, sameArea, newArea });
    }

    candidates.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.12) return b.score - a.score;
      if (a.newArea !== b.newArea) return a.newArea ? -1 : 1;
      return a.distanceMeters - b.distanceMeters;
    });

    const best = candidates[0];
    if (!best) return null;
    const newRoomAlternative = candidates.find((candidate) => candidate.newArea && candidate.distanceMeters <= best.distanceMeters + 5);
    if (newRoomAlternative && best.sameArea && best.score < newRoomAlternative.score + 1.6) return newRoomAlternative;
    return best;
  }

  _advanceGuidedTour(now = performance.now()) {
    if (
      this.walkMode !== 'guided' ||
      !this.guidedTourArmed ||
      this.guidedTourAdvanceLock ||
      this.arrivalSettleUntil > now ||
      this.path ||
      this.directTravel ||
      now < this.guidedTourNextAt
    ) return false;

    const next = this._chooseNextGuidedTourDestination();
    if (!next) {
      this.guidedTourArmed = false;
      this.guidedTourNextAt = 0;
      this.guidedTourAdvanceLock = false;
      this.onState?.({ type: 'tour-complete' });
      return false;
    }

    this.guidedTourAdvanceLock = true;
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;
    this._armGuidedTourForHotspot(next.hotspot);
    const target = [next.point.x, next.point.y, next.point.z];
    const started = this.travelTo(target, next.hotspot.label || 'Next destination', {
      resolvedPoint: next.point,
    });
    if (!started) this.guidedTourAdvanceLock = false;
    if (started) {
      this.onState?.({
        type: 'tour-advance',
        hotspotId: next.hotspot.id,
        areaId: next.hotspot.areaId || null,
        role: this._getHotspotRole(next.hotspot),
        distanceMeters: Number(next.distanceMeters.toFixed(2)),
      });
    }
    return started;
  }

  _startEmergencyRecovery(target, label = 'Safe position') {
    if (!this.query) return false;

    const current = this._closestWalkPoint([this.position.x, this.position.y, this.position.z]);
    const start = current || { x: this.position.x, y: this.position.y, z: this.position.z };
    const pool = this.hotspots
      .filter((hotspot) => Array.isArray(hotspot.position) && this._hasCameraClearance(hotspot.position))
      .map((hotspot) => {
        const destination = this._closestWalkPoint(hotspot.position);
        if (!destination) return null;
        const result = this.query.computePath(start, destination, {
          filter: this.filter, maxStraightPathSize: 128, maxPathSize: 128,
        });
        if (!this._isCompleteNavPath(result, destination)) return null;
        return { hotspot, destination, distance: Math.hypot(destination.x - start.x, destination.z - start.z) };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);

    const chosen = pool[0];
    if (chosen) {
      this.activeHotspotId = chosen.hotspot.id;
      return this.travelTo(chosen.destination, label);
    }

    // Do not use direct camera interpolation as a fallback: it can cross walls
    // and makes a disconnected NavMesh look like successful room traversal.
    return false;
  }

  _startDirectRoomTravel(closest, label, mode = 'room-switch') {
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    const from = this.position.clone();
    const to = new THREE.Vector3(closest.x, closest.y, closest.z);
    const distance = from.distanceTo(to);
    const duration = THREE.MathUtils.clamp(420 + distance * 70, 420, 1000);
    this.directTravel = {
      start: from,
      end: to,
      startTime: performance.now(),
      duration,
      targetPolyRef: closest.polyRef || 0,
    };
    this.onState?.({ type: 'travel', label, active: true, mode });
    return true;
  }

  _notifyCameraSettings() {
    this.onState?.({
      type: 'camera-settings',
      cameraHeightMeters: this.eyeHeight + this.heightOffset,
      heightOffsetMeters: this.heightOffset,
      fov: this.fov,
    });
  }

  _currentPresentationFovKey() {
    if (this.immersive360Active) return 'immersiveFov';
    if (this.viewMode === 'overview') return 'overviewFov';
    return this.walkMode === 'guided' ? 'guidedFov' : 'exploreFov';
  }

  _applyCurrentCameraSettings({ updateHeight = false, notify = true } = {}) {
    const cameraSettings = this.presentationSettings.camera;
    this.eyeHeight = cameraSettings.eyeHeightMeters;
    if (updateHeight) {
      const guidedBaseOffset = (this.viewMode === 'walk' && this.walkMode === 'guided')
        ? cameraSettings.guidedEyeHeightMeters - this.eyeHeight
        : 0;
      this.heightOffset = guidedBaseOffset + cameraSettings.heightOffsetMeters;
    }
    this.fov = cameraSettings[this._currentPresentationFovKey()] || DEFAULT_FOV_DEGREES;
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    if (notify) this._notifyCameraSettings();
  }

  _resetWalkCameraDefaults() {
    this._applyCurrentCameraSettings({ updateHeight: true });
  }

  setSensitivity(value) {
    this.lookSensitivity = THREE.MathUtils.clamp(Number(value) || 0.0048, 0.0015, 0.009);
    this.presentationSettings.camera.lookSensitivity = this.lookSensitivity;
  }

  applyPresentationSettings(settings) {
    this.presentationSettings = normalizePresentationSettings(settings);
    const config = this.presentationSettings;
    this.lookSensitivity = config.camera.lookSensitivity;

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (config.appearance.toneMapping === 'aces') {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    } else if (config.appearance.toneMapping === 'neutral') {
      this.renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
    } else {
      this.renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
    }

    this.lightingDirector?.setPresentationOverrides({
      exposureMultiplier: config.appearance.exposureMultiplier,
      environmentMultiplier: config.appearance.environmentMultiplier,
    });
    if (this.lightingDirector?.targetMode !== config.appearance.lightingPreset) {
      this.lightingDirector?.setMode(config.appearance.lightingPreset);
    }

    const quality = resolveQualityProfile(config.quality.mode);
    this.renderer.setPixelRatio(quality.effectivePixelRatio);
    this.renderer.shadowMap.enabled = quality.shadowsEnabled;
    if (this.lightingDirector?.keyLight) this.lightingDirector.keyLight.castShadow = quality.shadowsEnabled;
    if (quality.shadowsEnabled && this.lightingDirector?.staticShadowPrepared) {
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.resize();
    this._applyCurrentCameraSettings({ updateHeight: this.viewMode === 'walk' });
    this.onState?.({
      type: 'presentation-settings',
      settings: config,
      quality: { requestedMode: config.quality.mode, resolvedMode: quality.mode, pixelRatio: quality.effectivePixelRatio, shadowsEnabled: quality.shadowsEnabled },
    });
    return config;
  }


  setWalkMode(mode) {
    const next = mode === 'explore' ? 'explore' : 'guided';
    if (next === this.walkMode) return;
    this.walkMode = next;

    // Switching from Explore -> Guided freezes the current composition.
    // Switching back restores mouse-look immediately without a view jump.
    if (next === 'guided') {
      this.guidedTourArmed = false;
      this.guidedTourNextAt = 0;
      this.guidedTourAdvanceLock = false;
      this.guidedTourVisitedHotspots.clear();
      this.guidedTourVisitedAreas.clear();
      this.guidedTourLastAreaId = null;
      this.guidedTourLastVisitedHotspotId = null;
      this.guidedTourLastRole = null;
      this.guidedPresentationAreaId = null;
      this.arrivalSettleUntil = 0;
      this.guidedApproachActive = false;
      this.guidedArrivalSettleStartedAt = 0;
      this.guidedYawCenter = this.currentYaw;
      this.guidedCompositionYaw = this.currentYaw;
      this.guidedCompositionTargetYaw = this.currentYaw;
      this.guidedLastCompositionAt = performance.now();
      this.guidedPointerDown = null;
      this.guidedLastPointer = null;
      this.guidedYawVelocity = 0;
      this.guidedManualActive = false;
      this.guidedPitch = this.currentPitch;
      this.targetPitch = this.currentPitch;
      this._applyCurrentCameraSettings({ updateHeight: true });
      this.lookLocked = true;
      this.onState?.({ type: 'look-lock', locked: true });
    } else {
      this.lookLocked = false;
      this.onState?.({ type: 'look-lock', locked: false });
    }
    this.onState?.({ type: 'walk-mode', mode: this.walkMode });
  }

  setLookLocked(value, notify = false) {
    if (this.walkMode === 'guided') {
      this.lookLocked = true;
    } else {
      this.lookLocked = Boolean(value);
    }
    if (notify) this.onState?.({ type: 'look-lock', locked: this.lookLocked });
  }

  setViewMode(mode) {
    const next = mode === 'overview' ? 'overview' : 'walk';
    if (next === this.viewMode) return;
    this.viewMode = next;
    if (next === 'overview') {
      this.arrivalSettleUntil = 0;
      this.guidedApproachActive = false;
      this.guidedArrivalSettleStartedAt = 0;
      this.path = null;
      this.pathIndex = 0;
      this.directTravel = null;
      this.velocity.set(0, 0, 0);
      this.orbitControls.enabled = true;
      this.orbitControls.autoRotate = this.autoRotate;
      this.orbitControls.target.copy(this.viewTarget);
      const dir = this.camera.position.clone().sub(this.viewTarget);
      if (dir.lengthSq() < 1e-8) dir.set(1, 0.8, 1);
      dir.normalize().multiplyScalar(this.viewDistance);
      this.camera.position.copy(this.viewTarget).add(dir);
      this.orbitControls.update();
      this._applyCurrentCameraSettings();
    } else {
      this.orbitControls.enabled = false;
      this._resetWalkCameraDefaults();
      // Guided is the stable presentation mode. Explore is free-look.
      if (this.walkMode === 'guided') {
        this.lookLocked = true;
        this.guidedManualActive = false;
        this.guidedManualYawUntil = 0;
        this.guidedCompositionYaw = this.currentYaw;
        this.guidedCompositionTargetYaw = this.currentYaw;
        this.guidedLastCompositionAt = performance.now();
        this.currentPitch = this.guidedPitch;
        this.targetPitch = this.guidedPitch;
        // Put the camera at the walk position first, then choose an initial
        // heading from safe nearby destinations. This makes the floor disks
        // immediately visible instead of requiring a room/map click.
        this._syncCamera();
        this._prepareGuidedArrivalView(this.position, this.lastMoveDirection);
        if (Number.isFinite(this.targetYaw)) {
          this.currentYaw = this.targetYaw;
          this.guidedYawCenter = this.currentYaw;
          this.guidedCompositionYaw = this.currentYaw;
          this.guidedCompositionTargetYaw = this.currentYaw;
          this.guidedLastCompositionAt = performance.now();
          this.guidedPanPhase = 0;
        }
        this.onState?.({ type: 'look-lock', locked: true });
      } else {
        this.lookLocked = false;
        this.guidedManualActive = false;
        this.onState?.({ type: 'look-lock', locked: false });
      }
      this._syncCamera();
    }
    this.stuck = false;
    this.recoveryAvailable = false;
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'view-mode', mode: this.viewMode });
  }

  setAutoRotate(value) {
    this.autoRotate = Boolean(value);
    this.orbitControls.autoRotate = this.viewMode === 'overview' && this.autoRotate;
    this._notifyCameraSettings();
  }

  setViewPreset(name) {
    const target = this.viewTarget.clone();
    const presets = {
      top: new THREE.Vector3(0, 1, 0),
      front: new THREE.Vector3(0, 0.28, 1),
      side: new THREE.Vector3(1, 0.28, 0),
      perspective: new THREE.Vector3(0.72, 0.62, 0.72),
      isometric: new THREE.Vector3(0.86, 0.78, 0.86),
    };

    let distance = this.viewDistance;
    // if (name === 'top') {
    //   // Top view is framed from the house footprint instead of the model's
    //   // potentially inflated Y/diagonal bounding-box dimension.
    //   const aspect = Math.max(this.camera.aspect || 1, 0.1);
    //   const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    //   const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * aspect);
    //   const verticalDistance = (this.overviewDepth * 0.5) / Math.tan(verticalFov * 0.5);
    //   const horizontalDistance = (this.overviewWidth * 0.5) / Math.tan(horizontalFov * 0.5);
    //   distance = Math.max(verticalDistance, horizontalDistance, this.metersPerUnit * 3) * 1.7;

    //   // The walkthrough UI intentionally overlays the left side of the canvas
    //   // (Rooms panel). Centering the floorplan on the raw canvas therefore makes
    //   // it feel pushed to the right. Shift only the TOP preset toward the
    //   // unobstructed visual area; orbit/perspective presets keep the true model center.
    //   // const visualOffsetX = this.overviewWidth * 0.12;
    //   // target.x -= visualOffsetX;
    // }
if (name === 'top') {
  const aspect = Math.max(this.camera.aspect || 1, 0.1);
  const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);

  const horizontalFov =
    2 * Math.atan(
      Math.tan(verticalFov * 0.5) * aspect
    );

  const verticalDistance =
    (this.overviewDepth * 0.5) /
    Math.tan(verticalFov * 0.5);

  const horizontalDistance =
    (this.overviewWidth * 0.5) /
    Math.tan(horizontalFov * 0.5);

  distance = Math.max(
    verticalDistance,
    horizontalDistance,
    this.metersPerUnit * 3
  ) * 1.7;

  // Small visual compensation for the walkthrough UI.
  // Positive X moves the floorplan visually left.
  // Positive Z moves the floorplan visually upward in this top-down camera.
  const visualOffsetX = this.overviewWidth * 0.06;
  const visualOffsetZ = this.overviewDepth * 0.05;

  target.x += visualOffsetX;
  target.z += visualOffsetZ;
}
    const dir = (presets[name] || presets.perspective).normalize().multiplyScalar(distance);
    this.viewMode = 'overview';
    this._applyCurrentCameraSettings({ notify: false });
    this.orbitControls.enabled = true;
    this.orbitControls.target.copy(target);
    this.camera.position.copy(target).add(dir);
    this.orbitControls.update();
    this.onState?.({ type: 'view-mode', mode: 'overview' });
  }

  zoom(delta) {
    if (this.viewMode !== 'overview') return;
    const fromTarget = this.camera.position.clone().sub(this.orbitControls.target);
    const factor = delta > 0 ? 0.72 : 1.38;
    const next = Math.max(this.orbitControls.minDistance, Math.min(this.orbitControls.maxDistance, fromTarget.length() * factor));
    fromTarget.normalize().multiplyScalar(next);
    this.camera.position.copy(this.orbitControls.target).add(fromTarget);
    this.orbitControls.update();
  }

  setFov(value) {
    const key = this._currentPresentationFovKey();
    this.presentationSettings.camera[key] = THREE.MathUtils.clamp(Number(value) || DEFAULT_FOV_DEGREES, 45, 100);
    this._applyCurrentCameraSettings();
    return { key, value: this.fov };
  }

  fitView() {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this.viewTarget.copy(center);
    this.viewDistance = Math.max(size.x, size.y, size.z, 1) * 1.65;
    this.setViewPreset('perspective');
  }

  setHeightOffset(value) {
    this.presentationSettings.camera.heightOffsetMeters = THREE.MathUtils.clamp(Number(value) || 0, MIN_HEIGHT_OFFSET_METERS, MAX_HEIGHT_OFFSET_METERS);
    this._applyCurrentCameraSettings({ updateHeight: true });
  }

  stopTravel() {
    this.path = null;
    this.pathIndex = 0;
    this.pathReplanAttempts = 0;
    this.pathVelocity.set(0, 0, 0);
    this.directTravel = null;
    this.travelTotalDistance = 0;
    this.travelElapsed = 0;
    this.travelMode = null;
    this.guidedTourArmed = false;
    this.guidedTourNextAt = 0;
    this.guidedTourAdvanceLock = false;
    this.arrivalSettleUntil = 0;
    this.guidedApproachActive = false;
    this.guidedRevealActive = false;
    this.guidedArrivalSettleStartedAt = 0;
    this.cameraClearanceTimer = 0;
    this.progressWatchTime = 0;
    this.onState?.({ type: 'travel', active: false });
  }

  _estimatePathLengthFrom(position = this.position, startIndex = 0) {
    if (!this.path?.length) return 0;
    let previous = position;
    let total = 0;
    for (let i = Math.max(0, startIndex); i < this.path.length; i += 1) {
      const p = this.path[i];
      total += Math.hypot(p.x - previous.x, p.z - previous.z);
      previous = p;
    }
    return total;
  }

  _cinematicSpeedFactor(remainingDistance) {
    const unit = Math.max(this.metersPerUnit, 1e-6);
    const remaining = Math.max(0, remainingDistance / unit);
    const total = Math.max(0, this.travelTotalDistance / unit);

    // Short hops should feel responsive; longer trips get a noticeable
    // acceleration phase, comfortable cruise, then a deliberate arrival brake.
    const accelDistance = THREE.MathUtils.clamp(total * 0.28, 0.45, 1.6);
    const brakeDistance = THREE.MathUtils.clamp(total * 0.34, 0.75, 2.2);

    const smooth01 = (value) => {
      const t = THREE.MathUtils.clamp(value, 0, 1);
      return t * t * (3 - 2 * t);
    };

    let accel = 1;
    if (total > 0.05 && total - remaining < accelDistance) {
      accel = THREE.MathUtils.lerp(0.18, 1, smooth01((total - remaining) / accelDistance));
    }

    let brake = 1;
    if (remaining < brakeDistance) {
      brake = THREE.MathUtils.lerp(0.28, 1, smooth01(remaining / brakeDistance));
    }

    return THREE.MathUtils.clamp(Math.min(accel, brake), 0.18, 1);
  }

  _updateMovement(dt) {
    if (this.immersive360Active) {
      // Showcase 360 is stationary by design. Ignore any stale keyboard input
      // while the user is looking around the current architectural scene.
      this.velocity.set(0, 0, 0);
      this.pathVelocity.set(0, 0, 0);
      this.keys.clear();
      return;
    }

    if (this.directTravel) {
      const now = performance.now();
      const elapsed = now - this.directTravel.startTime;
      const t = THREE.MathUtils.clamp(elapsed / this.directTravel.duration, 0, 1);
      const eased = t * t * (3 - 2 * t);
      // Direct/semantic travel is intentionally decisive: use a smooth cinematic
      // ease rather than the old constant-feeling drag. This path is used only
      // for explicit map jumps / room transitions, not physical hotspot travel.
      const cinematicT = eased * eased * (3 - 2 * eased);
      this.position.lerpVectors(this.directTravel.start, this.directTravel.end, cinematicT);
      this.velocity.set(0, 0, 0);
      this.pathVelocity.set(0, 0, 0);
      this.blockedTime = 0;
      if (t >= 1) {
        const arrivalDirection = this.directTravel.end.clone().sub(this.directTravel.start).setY(0);
        this._prepareGuidedArrivalView(this.directTravel.end, arrivalDirection);
        this.currentPolyRef = this.directTravel.targetPolyRef || this.currentPolyRef;
        this.directTravel = null;
        this.lastMovementPosition.copy(this.position);
        this.cameraClearanceTimer = 0;
        this.progressWatchTime = 0;
        this._rememberNearestSafeAnchor(this.position, 'arrival');
        this._markGuidedTourArrival();
        this.arrivalSettleUntil = performance.now() + this.guidedArrivalSettleDurationMs;
            this.stuck = false;
            this.recoveryAvailable = false;
            this.onState?.({ type: 'stuck', available: false });
            this.onState?.({ type: 'travel', active: false });
      }
      return;
    }

    if (this.path?.length) {
      const waypoint = this.path[this.pathIndex];
      const waypointDistance = Math.hypot(waypoint.x - this.position.x, waypoint.z - this.position.z);
      const waypointThreshold = Math.max(0.12 * this.metersPerUnit, 0.08);
      if (waypointDistance <= waypointThreshold) {
        this.pathIndex += 1;
        if (this.pathIndex >= this.path.length) {
          this._prepareGuidedArrivalView(this.position, this.lastMoveDirection);
          this.path = null;
          this.pathIndex = 0;
          this.pathVelocity.set(0, 0, 0);
          this.velocity.set(0, 0, 0);
          this.lastMovementPosition.copy(this.position);
          this.cameraClearanceTimer = 0;
          this.progressWatchTime = 0;
          this._rememberNearestSafeAnchor(this.position, 'arrival');
          this._markGuidedTourArrival();
          this.travelTotalDistance = 0;
          this.travelElapsed = 0;
          this.travelMode = null;
          this.arrivalSettleUntil = performance.now() + this.guidedArrivalSettleDurationMs;
          this.stuck = false;
          this.recoveryAvailable = false;
          this.onState?.({ type: 'stuck', available: false });
          this.onState?.({ type: 'travel', active: false });
          return;
        }
      }

      // Game-style steering: aim a little ahead on the path instead of chasing
      // each corner directly. This keeps turns fluid and prevents the camera
      // from visibly zig-zagging around furniture.
      this.travelElapsed += dt;
      const remainingDistance = this._estimateRemainingPathDistance();
      const speedFactor = this._cinematicSpeedFactor(remainingDistance);

      // Phase 8: begin the destination reveal before the physical arrival. This
      // is deliberately distance-based, not time-based, so short and long routes
      // both reach the same visual choreography.
      if (this.walkMode === 'guided' && !this.guidedApproachActive && this.path?.length) {
        const finalPathPoint = this.path[this.path.length - 1];
        const remainingMeters = remainingDistance / Math.max(this.metersPerUnit, 1e-6);
        if (remainingMeters <= this.guidedTransitionApproachDistanceMeters) {
          this._beginGuidedApproachView(
            this.position,
            finalPathPoint,
            this.lastMoveDirection,
          );
        }
      }

      // Look farther ahead at higher speed so turns are anticipated rather than
      // followed like a chain of rigid waypoints. The path itself remains intact.
      const unit = Math.max(this.metersPerUnit || 1, 0.000001);
      const desiredLookAhead = THREE.MathUtils.clamp(
        (0.34 + this.pathVelocity.length() * 0.12) * unit,
        0.28 * unit,
        0.62 * unit,
      );
      const requestedLookAhead = Math.min(desiredLookAhead, Math.max(0.025 * unit, remainingDistance));
      const lookAhead = this._safePathLookAheadDistance(this.pathIndex, requestedLookAhead);
      const steerTarget = this._pointAlongPath(this.pathIndex, Math.max(0.025 * unit, lookAhead));
      const next = steerTarget || this.path[this.pathIndex];
      const before = this.position.clone();
      this.lastMoveDirection.set(next.x - this.position.x, 0, next.z - this.position.z);
      if (this.lastMoveDirection.lengthSq() > 1e-8) this.lastMoveDirection.normalize();

      // Slow slightly as the safe steering horizon contracts before a sharp
      // corner. Existing velocity smoothing then draws a natural arc without
      // pushing the agent through the inside of the turn.
      const cornerSpeedFactor = THREE.MathUtils.clamp(lookAhead / Math.max(desiredLookAhead, 1e-6), 0.42, 1);
      const guidedSpeedScale = this.walkMode === 'guided' ? GUIDED_AUTO_TRAVEL_SPEED_SCALE : 1;
      const targetSpeed = this.walkSpeed * guidedSpeedScale * speedFactor * cornerSpeedFactor;
      this._moveToward(next, dt, targetSpeed);
      const moved = before.distanceTo(this.position);
      if (moved > 0.01 * Math.max(this.metersPerUnit, 0.000001)) this._rememberNearestSafeAnchor(this.position, 'travel');
      this.cameraClearanceTimer += dt;
      this.progressWatchTime += dt;

      // NavMesh is the physical movement authority. Do not veto a valid NavMesh
      // step with raycasts against the full visual GLB: wall faces/door frames can
      // still be hit near a correctly cut opening and make room transitions feel
      // blocked even when Recast reports connected paths. Camera-clearance checks
      // remain enabled for spawn and curated destination selection only.

      const progressDistance = this.position.distanceTo(this.lastMovementPosition);
      if (progressDistance > 0.035 * Math.max(this.metersPerUnit, 0.000001)) {
        this.lastMovementPosition.copy(this.position);
        this.progressWatchTime = 0;
      } else if (this.progressWatchTime > 0.8 && moved < 0.001 * Math.max(1, this.metersPerUnit)) {
        this.blockedTime += dt;
      }

      if (moved < 0.0002 * Math.max(1, this.metersPerUnit)) {
        this.blockedTime += dt;
        if (this.blockedTime > 0.65) {
          if (this._replanStalledRoute()) return;
          // Keep the camera at the last valid NavMesh position. Do not silently
          // divert to another hotspot when the selected path cannot be followed.
          this.path = null;
          this.pathIndex = 0;
          this.pathVelocity.set(0, 0, 0);
          this.velocity.set(0, 0, 0);
          this.travelTotalDistance = 0;
          this.travelElapsed = 0;
          this.travelMode = null;
          this.blockedTime = 0;
          this.stuck = true;
          this.recoveryAvailable = this.hotspots.length > 0;
          this.onState?.({ type: 'travel', active: false });
          this.onState?.({ type: 'stuck', available: this.recoveryAvailable });
          this.onState?.({ type: 'error', message: 'The selected destination has no continuous walkable route from this position. Navigation stopped at the last safe point; choose another destination or use recovery manually.' });
          return;
        }
      } else {
        this.blockedTime = 0;
      }
      return;
    }

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (this.keys.has('w') || this.keys.has('arrowup')) wish.add(forward);
    if (this.keys.has('s') || this.keys.has('arrowdown')) wish.sub(forward);
    if (this.keys.has('d') || this.keys.has('arrowright')) wish.add(right);
    if (this.keys.has('a') || this.keys.has('arrowleft')) wish.sub(right);
    // Camera height is a presentation setting, not a walk-time keyboard control.

    const moving = wish.lengthSq() > 1e-8;
    if (moving) wish.normalize();
    const speed = this.keys.has('shift') ? this.runSpeed : this.walkSpeed;
    const targetVelocity = wish.multiplyScalar(speed);
    const response = moving ? 8 : 12;
    this.velocity.lerp(targetVelocity, 1 - Math.exp(-response * dt));
    if (!moving && this.velocity.lengthSq() < 1e-5) this.velocity.set(0, 0, 0);

    if (this.velocity.lengthSq() > 1e-8) {
      const desired = this.position.clone().addScaledVector(this.velocity, dt);
      this.lastMoveDirection.copy(this.velocity).normalize();
      const before = this.position.clone();
      this._moveTo(desired);
      const moved = before.distanceTo(this.position);
      if (moved < 0.0002 * Math.max(1, this.metersPerUnit)) {
        this.blockedTime += dt;
        if (this.blockedTime > 0.18) {
          // A user pressing into a wall in free Explore mode is not a route
          // failure. Bleed off momentum; do not trigger recovery/teleport logic.
          this.velocity.set(0, 0, 0);
          this.blockedTime = 0;
        }
      } else {
        this.blockedTime = 0;
        if (this.stuck) {
          this.stuck = false;
          this.recoveryAvailable = false;
          this.onState?.({ type: 'stuck', available: false });
        }
      }
    } else {
    }
  }

  _estimateRemainingPathDistance() {
    if (!this.path?.length || this.pathIndex >= this.path.length) return 0;
    let distance = Math.hypot(this.path[this.pathIndex].x - this.position.x, this.path[this.pathIndex].z - this.position.z);
    for (let i = this.pathIndex + 1; i < this.path.length; i += 1) {
      distance += Math.hypot(
        this.path[i].x - this.path[i - 1].x,
        this.path[i].z - this.path[i - 1].z,
      );
    }
    return distance;
  }

  _moveToward(target, dt, speed) {
    const direction = new THREE.Vector3(target.x - this.position.x, 0, target.z - this.position.z);
    if (direction.lengthSq() < 1e-8) return;
    direction.normalize();
    const desiredVelocity = direction.multiplyScalar(speed);
    const response = 5.5;
    this.pathVelocity.lerp(desiredVelocity, 1 - Math.exp(-response * dt));
    this._moveTo(this.position.clone().addScaledVector(this.pathVelocity, dt));
  }

  recoverToSafeSpot(label = 'Safe position') {
    if (!this.query || !this.hotspots.length) return false;

    this.path = null;
    this.pathIndex = 0;
    this.directTravel = null;
    this.pathVelocity.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    // Preserve blockedTime until a valid recovery route starts. Callers need
    // to distinguish a successful reroute from a recovery attempt that failed.
    this.cameraClearanceTimer = 0;
    this.progressWatchTime = 0;

    const start = this._closestWalkPoint(
      [this.position.x, this.position.y, this.position.z],
      0.9,
    );
    const startPoint = start || { x: this.position.x, y: this.position.y, z: this.position.z };

    // 1) Prefer an actual breadcrumb from the user's recent route. This creates
    // a natural backtrack rather than teleporting to whichever hotspot happens
    // to be numerically closest.
    const history = [...this.navigationHistory].reverse();
    for (const item of history) {
      if (!item?.id || this.recoveryAttemptedIds.has(item.id)) continue;
      const entry = this.safeAnchorById.get(item.id);
      if (!entry?.point) continue;
      const distanceFromStart = Math.hypot(entry.point.x - startPoint.x, entry.point.z - startPoint.z);
      if (distanceFromStart < 0.60 * Math.max(this.metersPerUnit, 0.000001)) continue;
      const result = this.query.computePath(startPoint, entry.point, {
        filter: this.filter,
        maxStraightPathSize: 256,
        maxPathSize: 256,
      });
      if (!this._isCompleteNavPath(result, entry.point)) {
        this.recoveryAttemptedIds.add(item.id);
        continue;
      }

      this.recoveryAttemptedIds.add(item.id);
      this.activeHotspotId = item.id;
      const ok = this._startPathToDestination(entry.point, label, 'recovery-backtrack');
      if (ok) {
        this.stuck = false;
        this.recoveryAvailable = false;
        this.onState?.({ type: 'navigation-recovery', mode: 'backtrack', anchorId: item.id });
        this.onState?.({ type: 'stuck', available: false });
        return true;
      }
    }

    // 2) Re-plan to the best connected safe anchor. Score favors open, useful
    // presentation anchors and known-good points while still respecting physical
    // reachability from the current location.
    const candidates = this._safeAnchorCandidates(startPoint);
    const chosen = candidates[0];
    if (chosen) {
      this.recoveryAttemptedIds.add(chosen.id);
      this.activeHotspotId = chosen.id;
      const ok = this._startPathToDestination(chosen.point, label, 'recovery-reroute');
      if (ok) {
        this.stuck = false;
        this.recoveryAvailable = false;
        this.onState?.({ type: 'navigation-recovery', mode: 'reroute', anchorId: chosen.id });
        this.onState?.({ type: 'stuck', available: false });
        return true;
      }
    }

    // Phase A: never teleport the camera through the house as an automatic
    // fallback. If no complete NavMesh route exists, leave the agent where it
    // is and surface a recoverable stuck state. Teleports hid broken routes and
    // made room traversal look successful when it was not physically connected.
    this.stuck = true;
    this.recoveryAvailable = this.hotspots.length > 0;
    this.onState?.({
      type: 'error',
      message: 'No complete walkable recovery route is available from this position.',
    });
    this.onState?.({ type: 'stuck', available: this.recoveryAvailable });
    return false;
  }

  _startPathToDestination(destination, label, mode = 'path') {
    const start = { x: this.position.x, y: this.position.y, z: this.position.z };
    const result = this.query?.computePath(start, destination, {
      filter: this.filter,
      maxStraightPathSize: 256,
      maxPathSize: 256,
    });
    const endpointStatus = this._inspectPathEndpoint(result, destination);
    if (!endpointStatus.complete) {
      console.warn('[Walkthrough] Rejected incomplete recovery route.', endpointStatus);
      return false;
    }
    this.path = this._prepareNavPath(result.path.map((p) => ({ x: p.x, y: p.y, z: p.z })));
    this.pathIndex = 0;
    this.pathReplanAttempts = 0;
    this.pathVelocity.set(0, 0, 0);
    this.travelTotalDistance = this._estimatePathLengthFrom(this.position, 0);
    this.travelElapsed = 0;
    this.travelMode = mode;
    this.arrivalSettleUntil = 0;
    this.guidedApproachActive = false;
    this.guidedRevealActive = false;
    this.guidedArrivalSettleStartedAt = 0;
    this.blockedTime = 0;
    this.cameraClearanceTimer = 0;
    this.progressWatchTime = 0;
    this.lastMovementPosition.copy(this.position);
    this.stuck = false;
    this.recoveryAvailable = false;
    // Keep currentPolyRef associated with the agent's current position. The
    // destination polygon becomes current only after moveAlongSurface reaches it.
    if (!this.currentPolyRef) {
      try {
        const current = this.query.findClosestPoint(start, {
          halfExtents: { x: 0.65, y: 1.0, z: 0.65 },
          filter: this.filter,
        });
        this.currentPolyRef = current?.polyRef || current?.ref || 0;
      } catch (_) {
        this.currentPolyRef = 0;
      }
    }
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', label, active: true, mode, hotspotId: this.activeHotspotId });
    return true;
  }

  _replanStalledRoute() {
    if (!this.query || !this.path?.length || this.pathReplanAttempts >= 1) return false;
    const finalPoint = this.path[this.path.length - 1];
    if (!finalPoint || ![finalPoint.x, finalPoint.y, finalPoint.z].every(Number.isFinite)) return false;
    this.pathReplanAttempts += 1;
    const start = { x: this.position.x, y: this.position.y, z: this.position.z };
    const target = { x: finalPoint.x, y: finalPoint.y, z: finalPoint.z };
    let result = null;
    try {
      result = this.query.computePath(start, target, {
        filter: this.filter,
        maxStraightPathSize: 256,
        maxPathSize: 256,
      });
    } catch (_) {
      return false;
    }
    if (!this._inspectPathEndpoint(result, target).complete) return false;
    const repaired = this._prepareNavPath(result.path.map((p) => ({ x: p.x, y: p.y, z: p.z })));
    if (repaired.length < 2) return false;

    this.path = repaired;
    this.pathIndex = 0;
    this.pathVelocity.set(0, 0, 0);
    this.travelTotalDistance = this._estimatePathLengthFrom(this.position, 0);
    this.travelElapsed = 0;
    this.blockedTime = 0;
    this.cameraClearanceTimer = 0;
    this.progressWatchTime = 0;
    this.lastMovementPosition.copy(this.position);
    this.stuck = false;
    this.recoveryAvailable = false;
    this.onState?.({ type: 'travel', active: true, mode: 'route-replan' });
    console.info('[Walkthrough] Replanned a stalled route once from the current walkable position.');
    return true;
  }

  _resolveMovementPolygon(point) {
    if (!this.query || !point) return null;
    const unit = Math.max(this.metersPerUnit || 1, 0.000001);
    const maxSnap = Math.max(PHASE_A_MAX_LOCAL_SNAP_METERS * unit, 0.06);
    let snapped = null;
    try {
      snapped = this.query.findClosestPoint(point, {
        halfExtents: {
          x: Math.max(0.32 * unit, 0.12),
          y: Math.max(0.55 * unit, 0.3),
          z: Math.max(0.32 * unit, 0.12),
        },
        filter: this.filter,
      });
    } catch (error) {
      return null;
    }
    if (!snapped?.success || !snapped.point) return null;
    const dx = snapped.point.x - point.x;
    const dy = snapped.point.y - point.y;
    const dz = snapped.point.z - point.z;
    const snapDistance = Math.hypot(dx, dy, dz);
    const polyRef = snapped.polyRef ?? snapped.ref ?? 0;
    // Only correct floating-point drift. Never snap to a different room or
    // silently relocate the player when the current physical position is invalid.
    if (!polyRef || snapDistance > maxSnap) return null;
    return { point: snapped.point, polyRef, snapDistance };
  }

  _moveTo(desired) {
    // The NavMesh is the physical movement authority. Keep the player on it and
    // advance in short substeps so high frame deltas cannot jump across a narrow
    // boundary/corner. Do not raycast the visual GLB here: door frames and faces
    // near a legitimate opening must not veto a NavMesh-valid step.
    if (!this.query || !desired) return false;

    const unit = Math.max(this.metersPerUnit || 1, 0.000001);
    const start = this.position.clone();
    const target = new THREE.Vector3(Number(desired.x), Number(desired.y), Number(desired.z));
    if (![target.x, target.y, target.z].every(Number.isFinite)) return false;

    const totalDistance = start.distanceTo(target);
    if (totalDistance <= 1e-7) return true;

    const maxStep = Math.max(PHASE_A_MAX_NAV_STEP_METERS * unit, 0.025);
    const stepCount = Math.min(32, Math.max(1, Math.ceil(totalDistance / maxStep)));
    const actualStep = totalDistance / stepCount;
    let working = { x: start.x, y: start.y, z: start.z };
    let workingRef = this.currentPolyRef || 0;
    let movedAny = false;

    const moveAlong = (polyRef, from, to) => this.query.moveAlongSurface(
      polyRef,
      from,
      to,
      { filter: this.filter, maxVisitedSize: 128 },
    );

    // Resolve a missing/stale polygon reference only around the agent's current
    // point. The snap distance is strictly limited to prevent hidden teleports.
    if (!workingRef) {
      const resolved = this._resolveMovementPolygon(working);
      if (!resolved) return false;
      workingRef = resolved.polyRef;
      working = {
        x: resolved.point.x,
        y: resolved.point.y,
        z: resolved.point.z,
      };
    }

    for (let i = 1; i <= stepCount; i += 1) {
      const t = i / stepCount;
      const stepTarget = {
        x: start.x + (target.x - start.x) * t,
        y: start.y + (target.y - start.y) * t,
        z: start.z + (target.z - start.z) * t,
      };
      let result = null;
      try {
        result = moveAlong(workingRef, working, stepTarget);
      } catch (error) {
        result = null;
      }

      if (!result?.success || !result.resultPosition) {
        // Reacquire only if the cached polygon is stale. This is a tiny local
        // correction, not a retry against the target room.
        const resolved = this._resolveMovementPolygon(working);
        if (!resolved) break;
        workingRef = resolved.polyRef;
        working = {
          x: resolved.point.x,
          y: resolved.point.y,
          z: resolved.point.z,
        };
        try {
          result = moveAlong(workingRef, working, stepTarget);
        } catch (error) {
          result = null;
        }
      }
      if (!result?.success || !result.resultPosition) break;

      const next = {
        x: Number(result.resultPosition.x),
        y: Number(result.resultPosition.y),
        z: Number(result.resultPosition.z),
      };
      if (![next.x, next.y, next.z].every(Number.isFinite)) break;

      const dx = next.x - working.x;
      const dy = next.y - working.y;
      const dz = next.z - working.z;
      const stepMoved = Math.hypot(dx, dy, dz);
      if (stepMoved < 1e-6) break;

      working = next;
      const visited = Array.isArray(result.visited) ? result.visited : [];
      workingRef = result.resultPolyRef || visited[visited.length - 1] || workingRef;
      movedAny = true;

      // If Recast stopped substantially short of this sub-target, accept its
      // last valid surface point and stop the frame there instead of repeatedly
      // pushing through the same boundary.
      const horizontalResidual = Math.hypot(stepTarget.x - working.x, stepTarget.z - working.z);
      if (horizontalResidual > Math.max(actualStep * 1.75, 0.035 * unit)) break;
    }

    if (!movedAny) return false;
    this.position.set(working.x, working.y, working.z);
    if (workingRef) this.currentPolyRef = workingRef;
    return start.distanceToSquared(this.position) > 1e-10;
  }

  _updateOverviewKeys(dt) {
    if (!this.keys.size) return;
    const speed = this.overviewPanSpeed * (this.keys.has('shift') ? 3 : 1);
    // WASD pan the orbit target in the camera's horizontal plane
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).setY(0).normalize();
    const fwd = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).negate().setY(0).normalize();
    const pan = new THREE.Vector3();
    if (this.keys.has('w') || this.keys.has('arrowup')) pan.addScaledVector(fwd, speed * dt);
    if (this.keys.has('s') || this.keys.has('arrowdown')) pan.addScaledVector(fwd, -speed * dt);
    if (this.keys.has('a') || this.keys.has('arrowleft')) pan.addScaledVector(right, -speed * dt);
    if (this.keys.has('d') || this.keys.has('arrowright')) pan.addScaledVector(right, speed * dt);
    if (this.keys.has('q')) this.zoom(-1);
    if (this.keys.has('e')) this.zoom(1);
    if (pan.lengthSq() > 0) {
      this.orbitControls.target.add(pan);
      this.camera.position.add(pan);
      this.viewTarget.add(pan);
    }
  }

  _getGuidedPresentationAreaId() {
    if (this.guidedPresentationAreaId) return this.guidedPresentationAreaId;
    if (this.activeHotspotId) {
      const active = this.hotspots.find((hotspot) => hotspot?.id === this.activeHotspotId);
      if (active?.areaId) return active.areaId;
    }
    if (this.guidedTourLastAreaId) return this.guidedTourLastAreaId;
    return null;
  }

  _buildPresentationSubjectIndex(projectStatePayload = null, hotspotsPayload = null) {
    this.presentationSubjects = [];
    this.presentationOccluders = [];
    // A production GLB optimizer may flatten nodes to "unnamed"/"Geom_*",
    // so mesh-name classification alone cannot reliably identify the sofa/bed.
    // Use the job's existing project_state.json as the semantic source of truth.
    this.guidedShotSubject = null;
    this.guidedShotSubjectId = null;
    this.guidedShotSubjectUntil = 0;
    if (!this.model) return;

    const unit = Math.max(this.metersPerUnit, 0.000001);
    const meshPriority = { furniture: 5.0, fixture: 4.1, decor: 2.6, lighting: 2.3, object: 1.5 };
    const genericName = /^(?:unnamed|mesh|node|object|geom(?:etry)?[_\s:-]*[\w-]*|scene|group)[_\s:-]*\d*$/i;

    const classifyNamedSubject = (name = '') => {
      const lower = String(name).toLowerCase().replace(/[_:/-]+/g, ' ');
      if (!lower || genericName.test(String(name).trim())) return null;
      // Structural geometry and openings must not win the hero shot.
      if (/(wall|floor|slab|ceiling|roof|column|beam|structural|opening|door|window|glazing|glass panel|portal|wall frame|window frame|door frame|trim)/.test(lower)) return null;
      if (/(sofa|couch|sectional|bed|daybed|armchair|recliner|lounge chair)/.test(lower)) {
        return { role: 'furniture', heroPriority: 9.6 };
      }
      if (/(dining table|coffee table|side table|desk|table|chair|stool|bench|ottoman|wardrobe|closet|dresser|cabinet|bookcase|bookshelf|tv stand|television unit|kitchen island)/.test(lower)) {
        return { role: 'furniture', heroPriority: 7.3 };
      }
      if (/(sink|toilet|bathtub|bath|shower|basin|vanity|hob|oven|fridge|refrigerator|appliance)/.test(lower)) {
        return { role: 'fixture', heroPriority: 5.8 };
      }
      if (/(plant|decor|artwork|painting|mirror|rug|carpet|curtain|lamp|light fixture)/.test(lower)) {
        return { role: 'decor', heroPriority: 2.8 };
      }
      return null;
    };

    const meshRecords = [];
    const semanticNodes = new Map();
    this.model.updateMatrixWorld(true);
    this.model.traverse((obj) => {
      if (!obj.isMesh || !obj.visible) return;
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(maxDim) || maxDim < 0.06 * unit) return;
      meshRecords.push({ object: obj, box, size, center, maxDim });
      const objectName = String(obj.name || '').trim();
      // In the current production GLB, IFC structure is emitted as Geom_* nodes
      // and placed catalog assets are generally unnamed. Keep the camera's
      // occlusion rays on structure / hosted door geometry instead of testing all
      // furniture triangles on every heading candidate.
      if (/^(?:geom(?:etry)?[_\s:-]|hci_hosted_door(?:\b|::)|wall\b|floor\b|slab\b|ceiling\b|roof\b|column\b|beam\b|structural\b)/i.test(objectName)) {
        this.presentationOccluders.push(obj);
      }

      // Search this mesh and its ancestors for a meaningful semantic name.
      let cursor = obj;
      while (cursor && cursor !== this.model) {
        const data = cursor.userData || {};
        const metadataName = [
          cursor.name,
          data.name,
          data.label,
          data.displayName,
          data.catalogItemName,
          data.instanceName,
          data.originalName,
          data.sourceName,
          data.category,
          data.ifcType,
          data.elementType,
        ].filter(Boolean).join(' ');
        const classification = classifyNamedSubject(metadataName);
        if (classification) {
          semanticNodes.set(cursor, {
            object: cursor,
            ...classification,
            semanticName: metadataName,
          });
          break;
        }
        cursor = cursor.parent;
      }
    });

    // Keep a small name-based fallback for older, unoptimized jobs whose mesh
    // hierarchy still retains catalog names.
    for (const entry of semanticNodes.values()) {
      const box = new THREE.Box3().setFromObject(entry.object);
      if (box.isEmpty()) continue;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(maxDim) || maxDim < 0.08 * unit || maxDim > 8.0 * unit) continue;
      const meshObjects = [];
      entry.object.traverse((child) => {
        if (child.isMesh && child.visible) meshObjects.push(child);
      });
      this.presentationSubjects.push({
        id: `mesh:${entry.object.uuid}`,
        object: entry.object,
        meshObjects,
        name: entry.semanticName,
        role: entry.role,
        heroPriority: entry.heroPriority,
        center,
        size,
        radius: Math.max(maxDim * 0.5, 0.12 * unit),
        areaId: null,
        source: 'mesh-name',
      });
    }

    const position3 = (value) => {
      if (Array.isArray(value) && value.length >= 3) {
        const point = value.slice(0, 3).map(Number);
        return point.every(Number.isFinite) ? point : null;
      }
      if (value && typeof value === 'object') {
        const point = [Number(value.x), Number(value.y), Number(value.z)];
        return point.every(Number.isFinite) ? point : null;
      }
      return null;
    };

    const areas = Array.isArray(hotspotsPayload?.areas) ? hotspotsPayload.areas : this.walkAreas;
    const nearestAreaId = (position) => {
      let nearest = null;
      let bestDistance = Infinity;
      for (const area of areas || []) {
        const center = position3(area?.center);
        if (!area?.id || !center) continue;
        const distance = Math.hypot(center[0] - position[0], center[2] - position[2]);
        if (distance < bestDistance) {
          bestDistance = distance;
          nearest = area;
        }
      }
      // If an item is far from every curated room center, don't guess its room.
      return nearest && bestDistance <= 7.0 * unit ? nearest.id : null;
    };

    const furniture = Array.isArray(projectStatePayload?.furniture) ? projectStatePayload.furniture : [];
    const placedSubjects = [];
    for (let index = 0; index < furniture.length; index += 1) {
      const item = furniture[index];
      if (!item || item.doorHostWallId) continue;
      const itemName = String(item.name || item.label || item.catalogItemName || '').trim();
      const classification = classifyNamedSubject(itemName);
      if (!classification) continue;
      const position = position3(item.position);
      if (!position) continue;
      const scale = position3(item.scale) || [1, 1, 1];
      const dims = position3(item.glbNormalization?.dimensions || item.dimensions);
      const scaleY = Math.max(0.01, Math.abs(scale[1] || 1));
      const dimensionHeight = dims && Number.isFinite(dims[1]) && dims[1] > 0.15
        ? dims[1] * scaleY
        : null;
      const nameLower = itemName.toLowerCase();
      let defaultAimHeight = 0.72;
      let matchRadiusMeters = 1.05;
      if (/(bed|daybed|sofa|couch|sectional|armchair|recliner|lounge chair)/.test(nameLower)) {
        defaultAimHeight = /bed|daybed/.test(nameLower) ? 0.52 : 0.62;
        matchRadiusMeters = /bed|daybed/.test(nameLower) ? 1.75 : 1.45;
      } else if (/(wardrobe|closet|bookcase|bookshelf|refrigerator|fridge|cabinet|dresser)/.test(nameLower)) {
        defaultAimHeight = 1.12;
        matchRadiusMeters = 1.15;
      } else if (/(tv|television)/.test(nameLower)) {
        defaultAimHeight = 1.28;
        matchRadiusMeters = 0.9;
      } else if (/(dining table|desk|table|island)/.test(nameLower)) {
        defaultAimHeight = 0.68;
        matchRadiusMeters = 1.25;
      } else if (/(toilet|sink|bathtub|shower|basin|vanity)/.test(nameLower)) {
        defaultAimHeight = 0.78;
        matchRadiusMeters = 0.95;
      } else if (/(plant|mirror|painting|rug|carpet|curtain|lamp)/.test(nameLower)) {
        defaultAimHeight = 1.1;
        matchRadiusMeters = 0.9;
      }
      const aimHeightMeters = THREE.MathUtils.clamp(dimensionHeight ? dimensionHeight * 0.5 : defaultAimHeight, 0.28, 1.85);
      const center = new THREE.Vector3(
        position[0],
        position[1] + aimHeightMeters * unit,
        position[2],
      );
      const matchRadius = matchRadiusMeters * unit;

      // Optimized GLBs often flatten names, but their mesh bounds still cluster
      // around the saved instance placement. Associate nearby non-structural
      // meshes so visibility tests can distinguish the hero item from a wall.
      const associatedRecords = meshRecords
        .filter((record) => {
          const name = String(record.object.name || '');
          if (/^(?:geom(?:etry)?[_\s:-]|hci_hosted_door|door|wall|floor|slab|ceiling)/i.test(name)) return false;
          if (record.maxDim > 4.5 * unit || record.size.y > 2.75 * unit) return false;
          const dx = position[0] < record.box.min.x ? record.box.min.x - position[0]
            : position[0] > record.box.max.x ? position[0] - record.box.max.x : 0;
          const dz = position[2] < record.box.min.z ? record.box.min.z - position[2]
            : position[2] > record.box.max.z ? position[2] - record.box.max.z : 0;
          const boxGap = Math.hypot(dx, dz);
          const centerDistance = Math.hypot(record.center.x - position[0], record.center.z - position[2]);
          return boxGap <= 0.18 * unit || centerDistance <= matchRadius;
        });
      const associatedMeshes = associatedRecords.map((record) => record.object);

      // project_state supplies semantic identity, while optimized GLB bounds are
      // the most reliable final-render coordinates. Aim at actual matched geometry
      // when it clusters near the saved placement; fall back to the semantic aim
      // point if the association looks too broad or belongs to another object.
      if (associatedRecords.length) {
        const associatedBounds = new THREE.Box3();
        associatedRecords.forEach((record) => associatedBounds.union(record.box));
        if (!associatedBounds.isEmpty()) {
          const boundsSize = associatedBounds.getSize(new THREE.Vector3());
          const boundsCenter = associatedBounds.getCenter(new THREE.Vector3());
          const centerOffset = Math.hypot(boundsCenter.x - position[0], boundsCenter.z - position[2]);
          const plausibleBounds = centerOffset <= matchRadiusMeters * 1.8 * unit
            && boundsSize.x <= 5.5 * unit
            && boundsSize.z <= 5.5 * unit
            && boundsSize.y <= 3.2 * unit;
          if (plausibleBounds) center.copy(boundsCenter);
        }
      }

      const areaId = nearestAreaId(position);
      placedSubjects.push({
        id: `asset:${item.instanceId || item.id || index}`,
        instanceId: item.instanceId || item.id || `asset-${index}`,
        object: associatedMeshes[0] || null,
        meshObjects: associatedMeshes,
        isPlacedAsset: true,
        visible: true,
        name: itemName,
        role: classification.role,
        heroPriority: classification.heroPriority,
        center,
        basePosition: new THREE.Vector3(position[0], position[1], position[2]),
        size: new THREE.Vector3(matchRadiusMeters * 2 * unit, aimHeightMeters * unit * 2, matchRadiusMeters * 2 * unit),
        radius: Math.max(matchRadius, aimHeightMeters * unit),
        areaId,
        source: 'project-state',
      });
    }

    // Prefer semantic, saved placements over generic mesh pieces. Keep the list
    // bounded so the per-arrival ray tests stay cheap in furnished large models.
    this.presentationSubjects.sort((a, b) => (b.heroPriority || meshPriority[b.role] || 0) - (a.heroPriority || meshPriority[a.role] || 0));
    if (this.presentationSubjects.length > 60) this.presentationSubjects.length = 60;
    placedSubjects.sort((a, b) => b.heroPriority - a.heroPriority);
    if (placedSubjects.length > 80) placedSubjects.length = 80;
    this.presentationSubjects.push(...placedSubjects);

    console.info('[Walkthrough:camera] Presentation subjects indexed', {
      namedMeshes: this.presentationSubjects.filter((subject) => subject.source === 'mesh-name').length,
      placedAssets: placedSubjects.length,
      occluderMeshes: this.presentationOccluders.length,
      labels: placedSubjects.slice(0, 12).map((subject) => ({ name: subject.name, areaId: subject.areaId, center: subject.center.toArray() })),
    });
  }

  _raycastPresentationOccluder(origin, direction, maxDistance = Infinity) {
    if (!this.model || !origin || !direction) return null;

    const raycaster = this.raycaster;
    const previousNear = raycaster.near;
    const previousFar = raycaster.far;
    let hit = null;
    try {
      raycaster.near = 0;
      raycaster.far = Number.isFinite(maxDistance) ? Math.max(0, maxDistance) : Infinity;
      raycaster.set(origin, direction);
      if (this.presentationOccluders?.length) {
        hit = raycaster.intersectObjects(this.presentationOccluders, false)[0] || null;
      } else {
        // Keep compatibility with older / unusual models whose structural nodes
        // do not use the production naming convention.
        hit = raycaster.intersectObject(this.model, true)[0] || null;
      }
    } finally {
      raycaster.near = previousNear;
      raycaster.far = previousFar;
    }
    return hit;
  }

  _chooseGuidedShotSubject(referencePosition = this.position, candidateYaw = this.currentYaw) {
    if (!this.presentationSubjects.length) return null;
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const areaId = this._getGuidedPresentationAreaId();
    const eye = new THREE.Vector3(
      referencePosition.x,
      referencePosition.y + (this.eyeHeight + this.heightOffset) * unit,
      referencePosition.z,
    );
    const forward = new THREE.Vector3(-Math.sin(candidateYaw), 0, -Math.cos(candidateYaw));
    const maxDistance = 8.5 * unit;
    const candidates = [];
    const rolePriority = { furniture: 6.0, fixture: 4.0, opening: 1.5, decor: 2.5, lighting: 2.0, object: 1.0 };

    for (const subject of this.presentationSubjects) {
      if (!subject || subject.visible === false || (subject.object && !subject.object.visible)) continue;
      // areaId is inferred from sampled NavMesh centers, not a true room polygon.
      // Prefer the current area, but don't categorically exclude a visible bed or
      // sofa when those approximate centers assigned it to a neighboring area.

      const target = subject.center?.clone?.();
      if (!target) continue;
      const to = target.clone().sub(referencePosition);
      to.y = 0;
      const distance = to.length();
      if (!Number.isFinite(distance) || distance < 0.65 * unit || distance > maxDistance) continue;

      const direction = to.clone().normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(forward.dot(direction), -1, 1));
      // A hero can be to the side or behind the entry heading. Arrival framing
      // is allowed to deliberately turn toward it, provided it is visible.
      if (angle > THREE.MathUtils.degToRad(155)) continue;

      const targetForVisibility = target.clone();
      const toTarget = targetForVisibility.sub(eye);
      const targetDistance = toTarget.length();
      if (this.model && targetDistance > 1e-6) {
        const hit = this._raycastPresentationOccluder(eye, toTarget.normalize(), targetDistance);
        const hitBelongsToSubject = Boolean(hit && (
          hit.object === subject.object ||
          subject.meshObjects?.includes(hit.object)
        ));
        const occlusionTolerance = Math.max(0.38 * unit, targetDistance * 0.12);
        // For a placed asset, the target point is inside the furniture, so the
        // first legitimate hit should be one of its associated meshes.
        if (hit && !hitBelongsToSubject && hit.distance < targetDistance - occlusionTolerance) continue;
      }

      const angleQuality = 1 - angle / THREE.MathUtils.degToRad(155);
      const preferredDistance = 2.7 * unit;
      const distanceQuality = THREE.MathUtils.clamp(1 - Math.abs(distance - preferredDistance) / (5.2 * unit), 0, 1);
      const sizeQuality = THREE.MathUtils.clamp(Math.log1p((subject.radius || unit * 0.5) / unit * 3) * 0.5, 0, 1.2);
      const roleWeight = subject.heroPriority || rolePriority[subject.role] || 1.0;
      // Area membership is a soft preference because the NavMesh's six sampled
      // spaces do not map one-to-one to this job's three detected rooms.
      const sameAreaBonus = areaId && subject.areaId === areaId ? 2.6 : 0;
      const score = roleWeight * 1.3 + sameAreaBonus + angleQuality * 1.25 + distanceQuality * 2.0 + sizeQuality * 0.25;
      candidates.push({ subject, score, angle, distance, target });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.subject || null;
  }

  _yawToGuidedSubject(referencePosition = this.position, subject = this.guidedShotSubject) {
    if (!subject?.center) return null;
    const dx = subject.center.x - referencePosition.x;
    const dz = subject.center.z - referencePosition.z;
    if (Math.hypot(dx, dz) < 0.15 * Math.max(this.metersPerUnit, 0.000001)) return null;
    return Math.atan2(-dx, -dz);
  }

  _pitchToGuidedSubject(referencePosition = this.position, subject = this.guidedShotSubject) {
    if (!subject?.center) return null;
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const eyeY = referencePosition.y + (this.eyeHeight + this.heightOffset) * unit;
    const dx = subject.center.x - referencePosition.x;
    const dz = subject.center.z - referencePosition.z;
    const horizontalDistance = Math.hypot(dx, dz);
    if (!Number.isFinite(horizontalDistance) || horizontalDistance < 0.18 * unit) return null;
    const dy = subject.center.y - eyeY;
    // Keep the look-down angle architectural rather than game-like/top-down.
    return THREE.MathUtils.clamp(
      Math.atan2(dy, horizontalDistance),
      // Keep the hero in frame while retaining enough ceiling/floor context to
      // read the whole interior; very steep bed-level aim looks cramped.
      THREE.MathUtils.degToRad(-27),
      THREE.MathUtils.degToRad(10),
    );
  }

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
        const hit = this._raycastPresentationOccluder(eye, toTarget.normalize(), targetDistance);
        const hitBelongsToSubject = Boolean(hit && (
          hit.object === subject.object ||
          subject.meshObjects?.includes(hit.object)
        ));
        const occlusionTolerance = Math.max(0.38 * unit, targetDistance * 0.12);
        if (hit && !hitBelongsToSubject && hit.distance < targetDistance - occlusionTolerance) continue;
      }

      const angleQuality = 1 - angle / THREE.MathUtils.degToRad(68);
      const distanceQuality = THREE.MathUtils.clamp(1 - distance / maxDistance, 0, 1);
      const sizeQuality = THREE.MathUtils.clamp(Math.log1p(subject.radius / unit * 3) * 0.55, 0, 1.3);
      const roleWeight = subject.heroPriority || (subject.role === 'furniture' ? 1.35
        : subject.role === 'fixture' ? 1.2
        : subject.role === 'opening' ? 0.95
        : subject.role === 'decor' ? 0.82
        : subject.role === 'lighting' ? 0.65
        : 0.55);

      score += roleWeight * (0.7 + angleQuality * 1.7 + distanceQuality * 0.8 + sizeQuality * 0.5);
      visibleSubjects += 1;
      if (visibleSubjects >= 8) break;
    }

    return score;
  }

  _headingWallGuardScore(referencePosition = this.position, candidateYaw = this.currentYaw) {
    if (!this.model) return 0;
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const origin = new THREE.Vector3(
      referencePosition.x,
      referencePosition.y + this.eyeHeight * unit + this.heightOffset * unit,
      referencePosition.z,
    );
    const offsets = [-18, 0, 18];
    let score = 0;
    for (const offsetDeg of offsets) {
      const yaw = candidateYaw + THREE.MathUtils.degToRad(offsetDeg);
      const dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const hit = this._raycastPresentationOccluder(origin, dir, 2.5 * unit);
      const distance = hit?.distance ?? Infinity;
      if (distance < 0.55 * unit) score -= 2.2;
      else if (distance < this.guidedPanWallGuardMeters * unit) score -= 1.5;
      else if (distance > 2.5 * unit) score += 0.45;
      else score += 0.1;
    }
    return score;
  }

  _getGuidedVisibleHotspots(referencePosition = this.position, yaw = this.currentYaw, maxDistanceMeters = this.guidedCompositionLookaheadMeters) {
    if (!this.hotspots.length) return [];
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const base = new THREE.Vector3(referencePosition.x, referencePosition.y, referencePosition.z);
    const eyeHeight = this.eyeHeight * unit + this.heightOffset * unit;
    const eye = new THREE.Vector3(base.x, base.y + eyeHeight, base.z);
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const visible = [];
    const presentationAreaId = this._getGuidedPresentationAreaId();
    const allowCrossArea = this.guidedTransitionKind === 'room-entry' || this.guidedTransitionKind === 'room-crossing';

    for (const hotspot of this.hotspots) {
      if (!Array.isArray(hotspot?.position)) continue;
      const target = new THREE.Vector3(
        Number(hotspot.position[0]),
        Number(hotspot.position[1]),
        Number(hotspot.position[2]),
      );
      const to = target.clone().sub(base);
      to.y = 0;
      const distance = to.length();
      if (!Number.isFinite(distance) || distance < 0.65 * unit || distance > maxDistanceMeters * unit) continue;
      if (presentationAreaId && hotspot.areaId && hotspot.areaId !== presentationAreaId && !allowCrossArea) continue;
      // Every hotspot is clearance-validated once when navigation data is loaded.
      // Repeating the 9-ray full-scene test for every candidate heading caused
      // large synchronous spikes in Guided mode without changing the result.
      const direction = to.normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(forward.dot(direction), -1, 1));
      if (angle > THREE.MathUtils.degToRad(82)) continue;

      let occluded = false;
      if (this.model) {
        const toTarget = target.clone().sub(eye);
        const targetDistance = toTarget.length();
        if (targetDistance > 1e-6) {
          const hit = this._raycastPresentationOccluder(eye, toTarget.normalize(), targetDistance);
          occluded = Boolean(hit && hit.distance < targetDistance - 0.06 * unit);
        }
      }
      if (occluded) continue;

      visible.push({ hotspot, distance, angle, target, direction });
    }
    return visible;
  }

  _scoreGuidedHeading(referencePosition = this.position, candidateYaw = this.currentYaw, incomingDirection = this.lastMoveDirection) {
    const visible = this._getGuidedVisibleHotspots(referencePosition, candidateYaw, this.guidedCompositionLookaheadMeters);
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const incoming = new THREE.Vector3(incomingDirection?.x || 0, 0, incomingDirection?.z || 0);
    if (incoming.lengthSq() > 1e-8) incoming.normalize();

    let score = this._headingWallGuardScore(referencePosition, candidateYaw);
    // Phase 12: prefer headings that actually show design content, not just open space.
    score += this._visualSubjectScore(referencePosition, candidateYaw) * 0.72;
    const presentationAreaId = this._getGuidedPresentationAreaId();
    for (const item of visible) {
      const proximity = THREE.MathUtils.clamp(1 - item.distance / (this.guidedCompositionLookaheadMeters * unit), 0, 1);
      const centered = 1 - THREE.MathUtils.clamp(item.angle / THREE.MathUtils.degToRad(75), 0, 1);
      const forwardBonus = incoming.lengthSq() > 1e-8 ? Math.max(0, incoming.dot(item.direction)) : 0;
      const role = this._getHotspotRole(item.hotspot);
      const sameSpaceBonus = presentationAreaId && item.hotspot.areaId === presentationAreaId ? 1.35 : 0;
      const roleBonus = role === 'room-center' ? 0.9
        : role === 'viewpoint' ? 0.75
        : role === 'room-entrance' ? 0.45
        : role === 'transition' ? 0.25
        : 0.1;
      score += 1.8 + proximity * 1.4 + centered * 1.2 + forwardBonus * 0.55 + roleBonus + sameSpaceBonus;
    }

    // A clear forward ray is a useful tie-breaker because a good presentation
    // view should not immediately bury the user in a wall.
    const eye = new THREE.Vector3(referencePosition.x, referencePosition.y + this.eyeHeight * unit + this.heightOffset * unit, referencePosition.z);
    const lookDir = new THREE.Vector3(-Math.sin(candidateYaw), 0, -Math.cos(candidateYaw));
    if (this.model) {
      // These thresholds all inspect the same heading, so share one bounded ray.
      const hit = this._raycastPresentationOccluder(eye, lookDir, 7.0 * unit);
      for (const meters of [2.0, 4.0, 7.0]) {
        if (!hit || hit.distance > meters * unit) score += 0.9;
      }
    }

    return { score, visible };
  }

  _findBestGuidedComposition(referencePosition = this.position, incomingDirection = this.lastMoveDirection, preferredYaw = this.currentYaw) {
    const offsets = [-72, -54, -36, -20, -8, 0, 8, 20, 36, 54, 72];
    const candidates = offsets.map((offsetDeg) => {
      const yaw = preferredYaw + THREE.MathUtils.degToRad(offsetDeg);
      return { yaw, ...this._scoreGuidedHeading(referencePosition, yaw, incomingDirection) };
    });

    const best = candidates.reduce((selected, candidate) => (
      !selected || candidate.score > selected.score ? candidate : selected
    ), null);
    if (!best) return null;

    const angleDelta = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const current = candidates
      .filter((candidate) => angleDelta(candidate.yaw, preferredYaw) <= THREE.MathUtils.degToRad(8))
      .sort((a, b) => b.score - a.score)[0];
    // Each candidate already contains its full visibility evaluation. Reuse those
    // results instead of raycasting the winning/current heading a second time.
    const bestEvaluation = best;
    const currentEvaluation = current || best;
    const hasSameSpaceSubject = bestEvaluation.visible.some((item) => {
      const areaId = this._getGuidedPresentationAreaId();
      return !areaId || !item.hotspot.areaId || item.hotspot.areaId === areaId;
    });
    if (!hasSameSpaceSubject && currentEvaluation.score >= best.score - 0.45) {
      return { yaw: preferredYaw, score: currentEvaluation.score };
    }

    // Stability rule: don't rotate to a dramatically different composition for
    // a negligible gain in quality.
    if (current && best.score < current.score * 1.10) return current;
    return best;
  }

  _angleLerp(a, b, t) {
    const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + delta * THREE.MathUtils.clamp(t, 0, 1);
  }

  _findGuidedRevealYaw(referencePosition = this.position, destination = null, incomingDirection = this.lastMoveDirection) {
    if (!destination) return this.currentYaw;

    const toDestination = new THREE.Vector3(
      destination.x - referencePosition.x,
      0,
      destination.z - referencePosition.z,
    );
    if (toDestination.lengthSq() < 1e-8) return this.currentYaw;
    toDestination.normalize();

    const destinationYaw = Math.atan2(-toDestination.x, -toDestination.z);
    const sideSigns = [1, -1];
    const offsets = [28, 42, 58, 72];
    const candidates = [destinationYaw];

    // Prefer a shallow side reveal: it lets a doorway/room open laterally in the
    // frame instead of pointing the camera straight down the travel vector.
    for (const sign of sideSigns) {
      for (const offset of offsets) candidates.push(destinationYaw + THREE.MathUtils.degToRad(sign * offset));
    }

    const forwardTravel = incomingDirection?.clone?.().setY(0);
    if (forwardTravel?.lengthSq?.() > 1e-8) forwardTravel.normalize();

    let best = { yaw: destinationYaw, score: -Infinity };
    const eye = new THREE.Vector3(
      referencePosition.x,
      referencePosition.y + this.eyeHeight * Math.max(this.metersPerUnit, 1e-6) + this.heightOffset * Math.max(this.metersPerUnit, 1e-6),
      referencePosition.z,
    );
    const unit = Math.max(this.metersPerUnit, 1e-6);

    for (const yaw of candidates) {
      const dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const headingScore = this._scoreGuidedHeading(referencePosition, yaw, incomingDirection)?.score || 0;
      let clearanceScore = 0;
      if (this.model) {
        // One ray gives the nearest obstacle distance for all three clearance
        // thresholds; the previous code repeated the identical ray three times.
        const hit = this._raycastPresentationOccluder(eye, dir, 4.5 * unit);
        for (const meters of [1.6, 2.8, 4.5]) {
          if (!hit || hit.distance > meters * unit) clearanceScore += 0.7;
        }
      }

      const targetBias = Math.max(0, dir.dot(toDestination));
      const lateralReveal = 1 - Math.abs(targetBias);
      const wallGuard = this._headingWallGuardScore(referencePosition, yaw);
      const travelContinuity = forwardTravel?.lengthSq?.() > 1e-8
        ? Math.max(0, forwardTravel.dot(dir))
        : 0;
      const score = headingScore + clearanceScore + wallGuard + lateralReveal * 1.9 + targetBias * 1.25 + travelContinuity * 0.35;
      if (score > best.score) best = { yaw, score };
    }

    return best.yaw;
  }

  _beginGuidedApproachView(referencePosition = this.position, destination = null, incomingDirection = this.lastMoveDirection) {
    if (this.walkMode !== 'guided' || !destination || this.arrivalSettleUntil > performance.now()) return;

    const destinationDirection = new THREE.Vector3(
      destination.x - referencePosition.x,
      0,
      destination.z - referencePosition.z,
    );
    if (destinationDirection.lengthSq() < 1e-8) return;
    destinationDirection.normalize();

    const destinationYaw = Math.atan2(-destinationDirection.x, -destinationDirection.z);
    const best = this._findBestGuidedComposition(
      destination,
      incomingDirection,
      destinationYaw,
    );
    const finalYaw = Number.isFinite(best?.yaw) ? best.yaw : destinationYaw;
    const revealYaw = this._findGuidedRevealYaw(referencePosition, destination, incomingDirection);
    const isTransition = this.guidedTransitionKind === 'room-entry' || this.guidedTransitionKind === 'room-crossing';

    // Phase 10: introduce a distinct reveal heading for architectural transitions.
    // It stays subtle for same-space hops and more lateral for room crossings,
    // creating a readable glimpse of the new space while the body keeps following
    // the physical path.
    this.guidedApproachStartYaw = this.currentYaw;
    const revealBlend = isTransition ? 0.68 : 0.58;
    const revealTarget = isTransition ? revealYaw : finalYaw;
    this.guidedApproachTargetYaw = this._angleLerp(this.currentYaw, revealTarget, revealBlend);
    this.guidedRevealTargetYaw = this._angleLerp(revealYaw, finalYaw, isTransition ? 0.34 : 0.18);
    this.guidedApproachActive = true;
    this.guidedRevealActive = isTransition;
    this.guidedCompositionTargetYaw = this.guidedApproachTargetYaw;
    this.guidedLastCompositionAt = performance.now();
  }

  _prepareGuidedArrivalView(referencePosition = this.position, incomingDirection = this.lastMoveDirection) {
    if (this.walkMode !== 'guided') return;
    let resolvedAreaId = null;
    if (this.activeHotspotId) {
      const active = this.hotspots.find((hotspot) => hotspot?.id === this.activeHotspotId);
      if (active?.areaId) resolvedAreaId = active.areaId;
    }
    if (!resolvedAreaId && this.walkAreas?.length) {
      let nearestArea = null;
      let nearestDistance = Infinity;
      for (const area of this.walkAreas) {
        const center = Array.isArray(area?.center) ? area.center : null;
        if (!center || center.length < 3) continue;
        const distance = Math.hypot(Number(center[0]) - referencePosition.x, Number(center[2]) - referencePosition.z);
        if (Number.isFinite(distance) && distance < nearestDistance) {
          nearestDistance = distance;
          nearestArea = area;
        }
      }
      if (nearestArea && nearestDistance <= 7.0 * Math.max(this.metersPerUnit, 0.000001)) {
        resolvedAreaId = nearestArea.id;
      }
    }
    if (resolvedAreaId) {
      this.guidedPresentationAreaId = resolvedAreaId;
      this.guidedTourLastAreaId = resolvedAreaId;
    } else {
      this.guidedPresentationAreaId = null;
    }
    if (this.activeHotspotId) {
      this.guidedTourLastVisitedHotspotId = this.activeHotspotId;
    }

    const preferredYaw = Number.isFinite(this.currentYaw)
      ? this.currentYaw
      : (incomingDirection?.lengthSq?.() > 1e-8 ? Math.atan2(-incomingDirection.x, -incomingDirection.z) : 0);
    const best = this._findBestGuidedComposition(referencePosition, incomingDirection, preferredYaw);
    const baseArrivalYaw = Number.isFinite(best?.yaw)
      ? best.yaw
      : (incomingDirection?.lengthSq?.() > 1e-8
        ? Math.atan2(-incomingDirection.x, -incomingDirection.z)
        : preferredYaw);

    // Phase 13: choose one visible design subject for the shot and let the camera
    // settle toward it. If no trustworthy subject exists, keep the Phase 11/12
    // composition instead of forcing a synthetic focus.
    this.guidedShotSubject = this._chooseGuidedShotSubject(referencePosition, baseArrivalYaw);
    this.guidedShotSubjectId = this.guidedShotSubject?.id || this.guidedShotSubject?.object?.uuid || null;
    const subjectYaw = this._yawToGuidedSubject(referencePosition, this.guidedShotSubject);
    const subjectPitch = this._pitchToGuidedSubject(referencePosition, this.guidedShotSubject);
    // A selected hero is the intended final composition, not a weak suggestion:
    // center it in both azimuth and elevation, then ease into that shot.
    const arrivalYaw = Number.isFinite(subjectYaw) ? subjectYaw : baseArrivalYaw;
    const arrivalPitch = Number.isFinite(subjectPitch) ? subjectPitch : this.guidedPitch;

    const now = performance.now();
    this.guidedApproachActive = false;
    this.guidedRevealActive = false;
    this.guidedArrivalStartYaw = this.currentYaw;
    this.guidedArrivalTargetYaw = arrivalYaw;
    this.guidedArrivalStartPitch = this.currentPitch;
    this.guidedArrivalTargetPitch = arrivalPitch;
    this.guidedArrivalSettleStartedAt = now;
    this.arrivalSettleUntil = now + this.guidedArrivalSettleDurationMs;
    this.guidedShotSubjectUntil = this.guidedTourArmed
      ? now + this.guidedArrivalSettleDurationMs + this.guidedTourHoldMs
      : Number.POSITIVE_INFINITY;
    this.guidedCompositionYaw = this.currentYaw;
    this.guidedCompositionTargetYaw = arrivalYaw;
    this.guidedYawCenter = this.currentYaw;
    this.targetYaw = this.currentYaw;
    this.targetPitch = this.currentPitch;
    this.guidedLastCompositionAt = now;
    this.guidedPanPhase = 0;
    this._refreshPresentationDestinations(referencePosition, arrivalYaw);
    console.info('[Walkthrough:camera] Arrival composition', {
      areaId: this.guidedPresentationAreaId,
      subject: this.guidedShotSubject?.name || null,
      subjectSource: this.guidedShotSubject?.source || null,
      subjectId: this.guidedShotSubjectId,
      yawTarget: Number(arrivalYaw.toFixed(3)),
      pitchTarget: Number(arrivalPitch.toFixed(3)),
    });
  }

  _refreshPresentationDestinations(referencePosition = this.position, yaw = this.currentYaw) {
    this.presentationHotspotIds.clear();
    this.presentationHotspotScores.clear();
    if (!this.hotspots.length) return;

    const unit = Math.max(this.metersPerUnit, 0.000001);
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
    const origin = new THREE.Vector3(referencePosition.x, referencePosition.y, referencePosition.z);
    const candidates = [];

    for (const hotspot of this.hotspots) {
      if (!hotspot?.id || !Array.isArray(hotspot.position)) continue;
      const dx = Number(hotspot.position[0]) - origin.x;
      const dz = Number(hotspot.position[2]) - origin.z;
      const distance = Math.hypot(dx, dz);
      if (!Number.isFinite(distance) || distance < 0.5 * unit || distance > this.presentationMaxDistanceMeters * unit) continue;
      // this.hotspots is pre-filtered through _hasCameraClearance during load.
      // Rechecking here duplicates 9 full-scene raycasts for each hotspot on
      // every arrival, so visibility is handled by the bounded occlusion ray below.
      const direction = new THREE.Vector3(dx, 0, dz).normalize();
      const dot = forward.dot(direction);
      const angle = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
      if (angle > THREE.MathUtils.degToRad(78)) continue;

      let visible = true;
      if (this.model) {
        const eye = new THREE.Vector3(origin.x, origin.y + this.eyeHeight * unit + this.heightOffset * unit, origin.z);
        const target = new THREE.Vector3(Number(hotspot.position[0]), Number(hotspot.position[1]), Number(hotspot.position[2]));
        const toTarget = target.sub(eye);
        const targetDistance = toTarget.length();
        if (targetDistance > 1e-6) {
          const hit = this._raycastPresentationOccluder(eye, toTarget.normalize(), targetDistance);
          visible = !hit || hit.distance >= targetDistance - 0.05 * unit;
        }
      }
      if (!visible) continue;

      const proximity = THREE.MathUtils.clamp(1 - distance / (this.presentationMaxDistanceMeters * unit), 0, 1);
      const centered = 1 - angle / THREE.MathUtils.degToRad(78);
      const role = this._getHotspotRole(hotspot);
      const roleBonus = role === 'room-center' ? 1.4
        : role === 'viewpoint' ? 1.15
        : role === 'room-entrance' ? 0.85
        : role === 'transition' ? 0.55
        : 0.2;
      const score = proximity * 2.2 + centered * 2.0 + (Number(hotspot.score) || 0) * 0.15 + roleBonus;
      candidates.push({ hotspot, distance, angle, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    const minSep = THREE.MathUtils.degToRad(this.presentationMinSeparationDeg);
    for (const candidate of candidates) {
      const separated = [...this.presentationHotspotIds].every((id) => {
        const previous = candidates.find((entry) => entry.hotspot.id === id);
        if (!previous) return true;
        const delta = Math.atan2(Math.sin(candidate.angle - previous.angle), Math.cos(candidate.angle - previous.angle));
        return Math.abs(delta) >= minSep;
      });
      if (!separated) continue;
      this.presentationHotspotIds.add(candidate.hotspot.id);
      this.presentationHotspotScores.set(candidate.hotspot.id, candidate.score);
      if (this.presentationHotspotIds.size >= this.presentationMaxVisible) break;
    }
  }

  _syncCamera() {
    const smoothing = 1 - Math.exp(-this.lookSmoothing * (this._lastDt || 0.016));
    const dt = this._lastDt || 0.016;
    const isTravelling = Boolean(this.path?.length || this.directTravel);

    // Guided mode is a presentation camera: it slowly pans continuously, not
    // only while travelling. Phase 8 adds two higher-priority cinematic states:
    // a final-approach reveal and a short arrival settle.
    if (this.immersive360Active) {
      this.guidedTravelRotating = false;
      this.targetPitch = this.guidedPitch;
    } else if (this.walkMode === 'guided' && this.guidedAutoRotate) {
      const now = performance.now();

      if (!this.guidedManualActive && this.arrivalSettleUntil > now) {
        const totalMs = Math.max(1, this.guidedArrivalSettleDurationMs);
        const elapsedMs = Math.max(0, now - this.guidedArrivalSettleStartedAt);
        const t = THREE.MathUtils.clamp(elapsedMs / totalMs, 0, 1);
        const eased = t * t * (3 - 2 * t);
        const settleYaw = this._angleLerp(this.guidedArrivalStartYaw, this.guidedArrivalTargetYaw, eased);
        const settlePitch = THREE.MathUtils.lerp(this.guidedArrivalStartPitch, this.guidedArrivalTargetPitch, eased);
        this.guidedCompositionYaw = settleYaw;
        this.guidedCompositionTargetYaw = this.guidedArrivalTargetYaw;
        this.targetYaw = settleYaw;
        this.targetPitch = settlePitch;
        this.guidedPanPhase = 0;
      } else if (!this.guidedManualActive && this.guidedApproachActive && isTravelling) {
        let approachYaw = this.guidedApproachTargetYaw;
        if (this.guidedRevealActive && this.path?.length) {
          const remainingMeters = this._estimateRemainingPathDistance() / Math.max(this.metersPerUnit, 1e-6);
          const span = Math.max(0.35, this.guidedRevealStartDistanceMeters - this.guidedRevealFinalDistanceMeters);
          const revealT = THREE.MathUtils.clamp(
            (this.guidedRevealStartDistanceMeters - remainingMeters) / span,
            0,
            1,
          );
          const easedReveal = revealT * revealT * (3 - 2 * revealT);
          approachYaw = this._angleLerp(
            this.guidedApproachTargetYaw,
            this.guidedRevealTargetYaw,
            easedReveal,
          );
          if (remainingMeters <= this.guidedRevealFinalDistanceMeters) {
            this.guidedRevealActive = false;
          }
        }
        // A destination reveal may glance sideways, but it must not point the
        // camera through a wall while the body is following a different corridor.
        approachYaw = this._clampYawToTravelHeading(approachYaw, this.guidedTransitionKind === 'room-entry' || this.guidedTransitionKind === 'room-crossing' ? 42 : 32);
        this.guidedCompositionYaw = this._angleLerp(
          this.guidedCompositionYaw,
          approachYaw,
          1 - Math.exp(-1.55 * dt),
        );
        this.guidedCompositionTargetYaw = approachYaw;
        this.targetYaw = this.guidedCompositionYaw;
        this.targetPitch = this.guidedPitch;
      } else if (!this.guidedManualActive && isTravelling && this.path?.length) {
        // During the actual walk, face the route tangent rather than scanning
        // scenic subjects. Camera composition resumes at the final approach/arrival.
        const travelYaw = this._getTravelPathYaw();
        if (Number.isFinite(travelYaw)) {
          this.guidedCompositionTargetYaw = travelYaw;
          this.guidedCompositionYaw = this._angleLerp(
            this.guidedCompositionYaw,
            travelYaw,
            1 - Math.exp(-2.8 * dt),
          );
          this.targetYaw = this.guidedCompositionYaw;
        }
        this.targetPitch = this.guidedPitch;
        this.guidedPanPhase = 0;
      } else if (this.guidedManualActive) {
        this.targetPitch = this.guidedPitch;

        // Small inertia after release gives the camera a polished viewport feel.
        if (this.guidedPointerDown == null && Math.abs(this.guidedYawVelocity) > 0.0005) {
          const inertiaDelta = this.guidedYawVelocity * dt * 0.18;
          this.targetYaw += inertiaDelta;
          this.guidedYawVelocity *= Math.exp(-this.guidedManualVelocityDamping * dt);
        }

        // Once the interaction pause has elapsed, hand control back to the
        // intelligent composition director instead of snapping to an old center.
        if (now >= this.guidedManualYawUntil && this.guidedPointerDown == null) {
          this.guidedManualActive = false;
          const best = this._findBestGuidedComposition(
            this.position,
            this.lastMoveDirection,
            this.currentYaw,
          );
          const resumeYaw = Number.isFinite(best?.yaw) ? best.yaw : this.currentYaw;
          this.guidedCompositionYaw = this.currentYaw;
          this.guidedCompositionTargetYaw = resumeYaw;
          this.guidedYawCenter = this.currentYaw;
          this.guidedLastCompositionAt = now;
          this.guidedPanPhase = 0;
          this._refreshPresentationDestinations(this.position, resumeYaw);
        }
      } else {
        // Phase 13: while the current architectural shot is still being presented,
        // preserve its chosen subject instead of letting periodic composition search
        // pull the camera toward another room/object.
        const subjectLockActive = Boolean(
          this.guidedShotSubject
          && !isTravelling
          && !this.guidedManualActive
          && now < this.guidedShotSubjectUntil
        );
        if (subjectLockActive) {
          const subjectYaw = this._yawToGuidedSubject(this.position, this.guidedShotSubject);
          const subjectPitch = this._pitchToGuidedSubject(this.position, this.guidedShotSubject);
          if (Number.isFinite(subjectYaw)) {
            this.guidedCompositionTargetYaw = subjectYaw;
            this.guidedCompositionYaw = this._angleLerp(
              this.guidedCompositionYaw,
              this.guidedCompositionTargetYaw,
              1 - Math.exp(-1.8 * dt),
            );
          }
          if (Number.isFinite(subjectPitch)) this.targetPitch = subjectPitch;
        }

        // Phase 8B: continue the guided architectural story after the current shot
        // has had time to settle. The user can interrupt the shot by dragging or
        // clicking another destination; the tour still advances on its own timer.
        this._advanceGuidedTour(now);

        const due = now - this.guidedLastCompositionAt >= this.guidedCompositionIntervalMs;
        if (due && !subjectLockActive) {
          const visible = this._getGuidedVisibleHotspots(this.position, this.currentYaw, this.guidedCompositionLookaheadMeters);
          // Reframe periodically, but only when the current view is weak. During
          // travel this keeps the next useful choices visible without making the
          // camera feel as though it is chasing every waypoint.
          if (visible.length < this.guidedCompositionMinVisibleTargets || !isTravelling) {
            const best = this._findBestGuidedComposition(this.position, this.lastMoveDirection, this.currentYaw);
            if (best && Number.isFinite(best.yaw)) this.guidedCompositionTargetYaw = best.yaw;
          }
          this._refreshPresentationDestinations(this.position, this.guidedCompositionTargetYaw);
          this.guidedLastCompositionAt = now;
        }

        if (subjectLockActive) {
          // Hold a real design feature in the center instead of panning off it.
          this.guidedPanPhase = 0;
          this.targetYaw = this.guidedCompositionYaw;
          const subjectPitch = this._pitchToGuidedSubject(this.position, this.guidedShotSubject);
          this.targetPitch = Number.isFinite(subjectPitch) ? subjectPitch : this.guidedPitch;
        } else {
          this.guidedCompositionYaw = THREE.MathUtils.lerp(
            this.guidedCompositionYaw,
            this.guidedCompositionTargetYaw,
            1 - Math.exp(-1.8 * dt),
          );

          // Very small cinematic drift around the chosen composition.
          this.guidedPanPhase += dt * this.guidedYawRate;
          let microSweep = Math.sin(this.guidedPanPhase) * THREE.MathUtils.degToRad(this.guidedCompositionSweepDeg) * 0.12;
          const sweepYaw = this.guidedCompositionYaw + microSweep;
          if (this._headingWallGuardScore(this.position, sweepYaw) < -this.guidedWallDominancePenalty) {
            microSweep *= 0.18;
          }
          this.targetYaw = this.guidedCompositionYaw + microSweep;
          this.targetPitch = this.guidedPitch;
        }
      }
      this.guidedTravelRotating = !this.guidedManualActive;
    } else if (!isTravelling) {
      this.guidedTravelRotating = false;
    }

    if (this.walkMode === 'explore' && this.path?.length && performance.now() >= this.exploreManualLookUntil) {
      const travelYaw = this._getTravelPathYaw();
      if (Number.isFinite(travelYaw)) {
        this.targetYaw = this._angleLerp(this.targetYaw, travelYaw, 1 - Math.exp(-1.7 * dt));
      }
    }

    this.currentYaw = THREE.MathUtils.lerp(this.currentYaw, this.targetYaw, smoothing);
    this.currentPitch = THREE.MathUtils.lerp(this.currentPitch, this.targetPitch, smoothing);
    this.yaw = this.currentYaw;
    this.pitch = this.currentPitch;

    const fovKey = this._currentPresentationFovKey();
    const configuredFov = Number(this.presentationSettings?.camera?.[fovKey]) || this.fov || DEFAULT_FOV_DEGREES;
    const settledGuidedDestination = this.viewMode === 'walk'
      && this.walkMode === 'guided'
      && !this.immersive360Active
      && !isTravelling
      && Boolean(this.activeHotspotId || this.guidedShotSubject);
    const targetFov = Math.min(
      88,
      configuredFov + (settledGuidedDestination ? GUIDED_ARRIVAL_FOV_BOOST_DEGREES : 0),
    );
    const nextFov = THREE.MathUtils.lerp(
      this.camera.fov || configuredFov,
      targetFov,
      1 - Math.exp(-2.0 * dt),
    );
    if (Math.abs(nextFov - this.camera.fov) > 0.025) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }

    const baseH = this.eyeHeight * this.metersPerUnit + this.heightOffset * this.metersPerUnit;
    // Interior-design walkthroughs should feel like a stabilized architectural
    // camera, not a first-person game. Keep walking motion visually stable.
    this.camera.position.set(
      this.position.x,
      this.position.y + baseH,
      this.position.z,
    );

    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.currentPitch, this.currentYaw, 0, 'YXZ');
  }

  _updatePortals() {
    const visibleLimit = this.walkMode === 'guided' ? 5 : 8;
    const maxDistance = 11 * Math.max(this.metersPerUnit, 0.000001);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();

    if (this.viewMode !== 'walk') {
      this.portalObjects.forEach((portal) => { portal.visible = false; });
      return;
    }

    const candidates = [];
    for (const portal of this.portalObjects) {
      const to = portal.position.clone().sub(this.position);
      const dist = Math.hypot(to.x, to.z);
      if (dist < 0.35 * this.metersPerUnit || dist > maxDistance) {
        portal.visible = false;
        continue;
      }
      const flatTo = new THREE.Vector3(to.x, 0, to.z).normalize();
      const dot = forward.dot(flatTo);
      if (dot < -0.18) {
        portal.visible = false;
        continue;
      }
      candidates.push({ portal, dist, dot, angle: Math.atan2(flatTo.x, flatTo.z) });
    }

    candidates.sort((a, b) => {
      // Prefer nearby destinations, but keep a useful view spread. A pure distance
      // sort causes several close disks to consume the visible budget and hide
      // farther choices in the same room.
      const scoreA = (a.dist / Math.max(this.metersPerUnit, 0.000001)) - Math.max(0, a.dot) * 1.8;
      const scoreB = (b.dist / Math.max(this.metersPerUnit, 0.000001)) - Math.max(0, b.dot) * 1.8;
      return scoreA - scoreB;
    });

    // Select nearby destinations with angular diversity so the user can see
    // choices distributed across the room instead of seven markers stacked in
    // the same direction.
    if (this.walkMode === 'guided') {
      const presentationEntries = candidates
        .filter((candidate) => this.presentationHotspotIds.has(candidate.portal.userData?.hotspotId))
        .sort((a, b) => (this.presentationHotspotScores.get(b.portal.userData?.hotspotId) || 0) - (this.presentationHotspotScores.get(a.portal.userData?.hotspotId) || 0));
      candidates.sort((a, b) => {
        const ap = this.presentationHotspotIds.has(a.portal.userData?.hotspotId) ? 0 : 1;
        const bp = this.presentationHotspotIds.has(b.portal.userData?.hotspotId) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return ((this.presentationHotspotScores.get(b.portal.userData?.hotspotId) || 0) - (this.presentationHotspotScores.get(a.portal.userData?.hotspotId) || 0)) || (a.dist - b.dist);
      });
    }

    const selected = [];
    const minAngularSeparation = THREE.MathUtils.degToRad(this.walkMode === 'guided' ? 12 : 10);
    for (const candidate of candidates) {
      const separated = selected.every((chosen) => {
        const delta = Math.atan2(Math.sin(candidate.angle - chosen.angle), Math.cos(candidate.angle - chosen.angle));
        return Math.abs(delta) >= minAngularSeparation;
      });
      if (separated) selected.push(candidate);
      if (selected.length >= visibleLimit) break;
    }
    if (selected.length < visibleLimit) {
      for (const candidate of candidates) {
        if (!selected.includes(candidate)) selected.push(candidate);
        if (selected.length >= visibleLimit) break;
      }
    }

    const selectedSet = new Set(selected.map((entry) => entry.portal));
    const hoveredHits = this.raycaster.intersectObjects(
      selected.map((entry) => entry.portal),
      true,
    );
    const hoveredGroup = hoveredHits.length
      ? (hoveredHits[0].object.parent?.isGroup ? hoveredHits[0].object.parent : hoveredHits[0].object)
      : null;

    candidates.forEach((entry) => {
      const portal = entry.portal;
      portal.visible = selectedSet.has(portal) && !this.path && !this.directTravel;
      if (!portal.visible) return;
      const pulse = 1 + Math.sin(performance.now() * 0.0025 + portal.position.x * 2.7 + portal.position.z) * 0.035;
      const hover = portal === hoveredGroup ? 1.16 : 1;
      portal.scale.setScalar(pulse * hover);
      const distanceFade = THREE.MathUtils.clamp(1 - entry.dist / maxDistance, 0.25, 1);
      const proximity = THREE.MathUtils.clamp(1 - entry.dist / (4.5 * Math.max(this.metersPerUnit, 0.000001)), 0, 1);
      const hoverBoost = portal === hoveredGroup ? 1.35 : 1;
      const glow = 0.55 + proximity * 0.45;
      const halo = portal.children[0];
      const disk = portal.children[1];
      const ring = portal.children[2];
      if (halo?.material) halo.material.opacity = (0.04 + proximity * 0.16) * distanceFade * hoverBoost;
      if (disk?.material) disk.material.opacity = (0.18 + proximity * 0.20) * distanceFade * hoverBoost;
      if (ring?.material) ring.material.opacity = (0.72 + proximity * 0.24) * distanceFade * hoverBoost;
      portal.children.forEach((child) => {
        if (child.material) child.material.needsUpdate = false;
      });
      portal.userData.glowStrength = glow;
    });
  }

  _tick = () => {
    if (!this.running) return;
    const now = performance.now();
    const actualFrameTimeMs = Math.max(0, now - this.lastFrameTime);
    const dt = Math.min(0.05, Math.max(0.001, actualFrameTimeMs / 1000));
    this.lastFrameTime = now;
    this._lastDt = dt;
    this._lastFrameElapsedMs = actualFrameTimeMs;
    this.lightingDirector?.update(dt);
    this._updateImmersive360?.(now, dt);
    this._updateSmart720Tour?.(now);
    this._updateSmart720Offer?.();
    this._updateImmersiveSceneSwitch?.(now);
    if (this.viewMode === 'walk') {
      this._updateMovement(dt);
      this._syncCamera();
    } else {
      this._updateOverviewKeys(dt);
      this.orbitControls.autoRotate = this.autoRotate;
      this.orbitControls.update();
    }
    this._updatePortals();
    this.renderer.render(this.scene, this.camera);
    this.performanceMonitor?.recordFrame(this._lastFrameElapsedMs ?? (dt * 1000));
    this.animationFrame = requestAnimationFrame(this._tick);
  };

  setLightingMode(mode) {
    return this.lightingDirector?.setMode(mode);
  }

  cycleLighting() {
    return this.lightingDirector?.cycle();
  }

  dispose() {
    this.running = false;
    this.performanceMonitor?.dispose();
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.renderer.domElement.removeEventListener('contextmenu', this.onContextMenu);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.removeEventListener('pointercancel', this.onPointerCancel);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('resize', this.resize);
    this.portalObjects.forEach((o) => {
      o.traverse?.((child) => {
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      });
      o.parent?.remove?.(o);
    });
    this.navSurfaceMesh?.geometry?.dispose?.();
    this.navSurfaceMesh?.material?.dispose?.();
    this.navSurfaceMesh?.parent?.remove?.(this.navSurfaceMesh);
    this.navSurfaceMesh = null;
    this.orbitControls.dispose();
    this.lightingDirector?.dispose?.();
    if (this.lightingControl?.root) this.lightingControl.root.remove();
    this.lightingControl = null;
    this.navMesh?.destroy?.();
    this.query?.destroy?.();
    this.model?.traverse?.((obj) => {
      if (!obj.isMesh) return;
      obj.geometry?.dispose?.();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
      else obj.material?.dispose?.();
    });
    this.renderer.dispose();
    this.canvas.innerHTML = '';
  }
}

// These directors are deliberately attached at the runtime boundary instead of
// monkey-patching Three.js globally. Each director only owns presentation state
// and delegates physical movement back to the existing WalkRuntime methods.
Object.assign(
  WalkRuntime.prototype,
  immersive360DirectorMethods,
  immersivePresentationDirectorMethods,
  immersiveSceneDirectorMethods,
  smart720TourDirectorMethods,
);

export function useWalkthroughEngine({ containerRef, jobId }) {
  const runtimeRef = useRef(null);
  const [state, setState] = useState({
    status: 'idle',
    areas: [],
    rooms: [],
    spaces: [],
    portals: [],
    roomGraph: null,
    navigationSpaceGraph: null,
    navigationPlan: null,
    activeArea: null,
    activeHotspotId: null,
    message: '',
    lookLocked: true,
    walkMode: 'guided',
    cameraHeightMeters: DEFAULT_EYE_HEIGHT_METERS + DEFAULT_HEIGHT_OFFSET_METERS,
    heightOffsetMeters: DEFAULT_HEIGHT_OFFSET_METERS,
    cameraFov: DEFAULT_FOV_DEGREES,
    lightingMode: 'day',
    stuck: false,
    recoveryAvailable: false,
    immersive360Active: false,
    immersive360OfferAvailable: false,
    immersive360AutoRotate: true,
    immersivePresentationActive: false,
    immersivePresentationLabel: null,
    immersiveSceneIndex: 0,
    immersiveSceneTotal: 0,
    immersiveSceneLabel: null,
    immersiveSceneCanPrev: false,
    immersiveSceneCanNext: false,
    immersiveSceneSwitching: false,
    smart720Active: false,
    smart720OfferAvailable: false,
    smart720CurrentLabel: null,
    smart720StopIndex: 0,
    smart720TotalStops: 0,
  });

  useEffect(() => {
    if (!containerRef.current || !jobId) return undefined;
    const runtime = new WalkRuntime({
      canvas: containerRef.current,
      onState: (event) => {
        if (event.type === 'loaded') setState((previous) => ({
          ...previous,
          status: 'ready',
          areas: event.areas || [],
          rooms: runtimeRef.current?.presentationRooms || [],
          spaces: runtimeRef.current?.presentationSpaces || [],
          portals: runtimeRef.current?.presentationPortals || [],
          roomGraph: runtimeRef.current?.presentationRoomGraph || null,
          navigationSpaceGraph: runtimeRef.current?.navigationSpaceGraph || null,
          navigationPlan: runtimeRef.current?.navigationPlan || null,
          activeArea: null,
          activeHotspotId: null,
          message: '',
          lookLocked: runtimeRef.current?.lookLocked ?? false,
          walkMode: runtimeRef.current?.walkMode ?? 'guided',
          cameraHeightMeters: (runtimeRef.current?.eyeHeight || DEFAULT_EYE_HEIGHT_METERS) + (runtimeRef.current?.heightOffset || 0),
          heightOffsetMeters: runtimeRef.current?.heightOffset || 0,
          cameraFov: runtimeRef.current?.fov || DEFAULT_FOV_DEGREES,
          lightingMode: runtimeRef.current?.lightingDirector?.targetMode || 'day',
          stuck: false,
          recoveryAvailable: false,
          immersive360OfferAvailable: true,
        }));
        if (event.type === 'loading') setState((prev) => ({ ...prev, status: 'loading' }));
        if (event.type === 'travel') setState((prev) => ({ ...prev, activeArea: event.label || null, activeHotspotId: event.hotspotId || prev.activeHotspotId || null, message: event.active ? `Walking to ${event.label}…` : '' }));
        if (event.type === 'error') setState((prev) => ({ ...prev, message: event.message || 'Navigation failed.' }));
        if (event.type === 'look-lock') setState((prev) => ({ ...prev, lookLocked: event.locked }));
        if (event.type === 'walk-mode') setState((prev) => ({ ...prev, walkMode: event.mode }));
        if (event.type === 'presentation-topology') setState((prev) => ({
          ...prev,
          rooms: event.rooms || [],
          spaces: event.spaces || [],
          portals: event.portals || [],
          roomGraph: event.roomGraph || null,
          navigationSpaceGraph: event.navigationSpaceGraph || null,
        }));
        if (event.type === 'camera-settings') setState((prev) => ({ ...prev, cameraHeightMeters: event.cameraHeightMeters, heightOffsetMeters: event.heightOffsetMeters, cameraFov: event.fov }));
        if (event.type === 'lighting') setState((prev) => ({ ...prev, lightingMode: event.targetMode || event.mode || 'day' }));
        if (event.type === 'immersive-360') setState((prev) => ({
          ...prev,
          immersive360Active: Boolean(event.active),
          immersive360AutoRotate: event.autoRotate === undefined ? prev.immersive360AutoRotate : Boolean(event.autoRotate),
          immersive360OfferAvailable: event.active
            ? false
            : (prev.walkMode === 'guided' && prev.status === 'ready'),
        }));
        if (event.type === 'immersive-presentation') setState((prev) => ({
          ...prev,
          immersivePresentationActive: Boolean(event.active),
          immersivePresentationLabel: event.label ?? prev.immersivePresentationLabel,
        }));
        if (event.type === 'immersive-scene') setState((prev) => ({
          ...prev,
          immersiveSceneIndex: Number(event.index) || 0,
          immersiveSceneTotal: Number(event.total) || 0,
          immersiveSceneLabel: event.label ?? null,
          immersiveSceneCanPrev: Boolean(event.canPrev),
          immersiveSceneCanNext: Boolean(event.canNext),
          immersiveSceneSwitching: Boolean(event.switching),
        }));
        if (event.type === 'smart-720-offer') setState((prev) => ({ ...prev, smart720OfferAvailable: Boolean(event.available) }));
        if (event.type === 'smart-720-tour') setState((prev) => ({
          ...prev,
          smart720Active: Boolean(event.active),
          smart720CurrentLabel: event.label ?? prev.smart720CurrentLabel,
          smart720StopIndex: Number(event.stopIndex) || prev.smart720StopIndex,
          smart720TotalStops: Number(event.totalStops) || prev.smart720TotalStops,
          smart720OfferAvailable: Boolean(event.active) ? false : prev.smart720OfferAvailable,
        }));
        if (event.type === 'view-mode') setState((prev) => ({
          ...prev,
          immersive360OfferAvailable: event.mode === 'walk' ? !prev.immersive360Active : false,
        }));
        if (event.type === 'unstuck') setState((prev) => ({ ...prev, message: 'Recovered walk position.', stuck: false, recoveryAvailable: false }));
        if (event.type === 'stuck') setState((prev) => ({ ...prev, stuck: Boolean(event.available), recoveryAvailable: Boolean(event.available) }));
        if (event.type === 'escape') setState((prev) => ({ ...prev, message: '' }));
      },
    });
    runtimeRef.current = runtime;
    const base = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    runtime.load(jobId, base).catch((error) => {
      console.error('[Walkthrough] Failed to load job:', error);
      setState((previous) => ({ ...previous, status: 'error', areas: [], activeArea: null, message: error.message, lookLocked: true, walkMode: 'guided', stuck: false, recoveryAvailable: false }));
    });
    return () => {
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, [containerRef, jobId]);

  const travelTo = useCallback((area) => runtimeRef.current?.travelTo(area.center, area.label), []);
  const switchRoom = useCallback((area) => runtimeRef.current?.switchRoom(area, area?.label), []);
  const navigateToHotspot = useCallback((hotspot) => runtimeRef.current?.navigateToHotspot(hotspot), []);
  const stopTravel = useCallback(() => runtimeRef.current?.stopTravel(), []);
  const setHeightOffset = useCallback((value) => runtimeRef.current?.setHeightOffset(value), []);
  const setSensitivity = useCallback((value) => runtimeRef.current?.setSensitivity(value), []);
  const setWalkMode = useCallback((value) => runtimeRef.current?.setWalkMode(value), []);
  const setLookLocked = useCallback((value) => runtimeRef.current?.setLookLocked(value), []);
  const setFov = useCallback((value) => runtimeRef.current?.setFov(value), []);
  const applyPresentationSettings = useCallback((settings) => runtimeRef.current?.applyPresentationSettings(settings), []);
  const setLightingMode = useCallback((value) => runtimeRef.current?.setLightingMode(value), []);
  const cycleLighting = useCallback(() => runtimeRef.current?.cycleLighting(), []);
  const setViewMode = useCallback((value) => runtimeRef.current?.setViewMode(value), []);
  const setAutoRotate = useCallback((value) => runtimeRef.current?.setAutoRotate(value), []);
  const setViewPreset = useCallback((value) => runtimeRef.current?.setViewPreset(value), []);
  const zoom = useCallback((value) => runtimeRef.current?.zoom(value), []);
  const fitView = useCallback(() => runtimeRef.current?.fitView(), []);
  const recoverToSafeSpot = useCallback(() => runtimeRef.current?.recoverToSafeSpot(), []);
  const enterImmersivePresentation = useCallback((options = {}) => {
    const runtime = runtimeRef.current;
    const result = runtime?.enterImmersivePresentation(options);
    runtime?._applyCurrentCameraSettings?.();
    return result;
  }, []);
  const exitImmersivePresentation = useCallback(() => {
    const runtime = runtimeRef.current;
    const result = runtime?.exitImmersivePresentation();
    runtime?._applyCurrentCameraSettings?.();
    return result;
  }, []);
  const resetImmersivePresentationView = useCallback(() => runtimeRef.current?.resetImmersivePresentationView(), []);
  const setImmersive360AutoRotate = useCallback((value) => runtimeRef.current?.setImmersive360AutoRotate(value), []);
  const switchImmersiveScene = useCallback((direction) => runtimeRef.current?.switchImmersiveScene(direction), []);
  const startSmart720Tour = useCallback(() => runtimeRef.current?.startSmart720Tour(), []);
  return {
    ...state,
    travelTo,
    switchRoom,
    navigateToHotspot,
    stopTravel,
    recoverToSafeSpot,
    setHeightOffset,
    setSensitivity,
    setWalkMode,
    setLookLocked,
    setViewMode,
    setAutoRotate,
    setViewPreset,
    zoom,
    fitView,
    setFov,
    applyPresentationSettings,
    setLightingMode,
    cycleLighting,
    enterImmersivePresentation,
    exitImmersivePresentation,
    resetImmersivePresentationView,
    setImmersive360AutoRotate,
    switchImmersiveScene,
    startSmart720Tour,
  };
}
