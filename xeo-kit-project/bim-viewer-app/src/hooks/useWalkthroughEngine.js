import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { init as initRecast, importNavMesh, NavMeshQuery, QueryFilter } from 'recast-navigation';

const DEFAULT_SPEEDS = { walk: 1.65, run: 3.2 };
const DEFAULT_EYE_HEIGHT_METERS = 1.84;
const DEFAULT_HEIGHT_OFFSET_METERS = 0.0;
const MIN_HEIGHT_OFFSET_METERS = -0.45;
const MAX_HEIGHT_OFFSET_METERS = 1.0;
const DEFAULT_FOV_DEGREES = 115;
const GUIDED_CAMERA_HEIGHT_METERS = 2.16;
const GUIDED_PAN_AMPLITUDE_DEG = 13;
const GUIDED_PAN_RATE_RAD_PER_SEC = 0.035;

class WalkRuntime {
  constructor({ canvas, onState }) {
    this.canvas = canvas;
    this.onState = onState;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf4f6f8);
    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV_DEGREES, 1, 0.05, 5000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    canvas.appendChild(this.renderer.domElement);
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
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity = new THREE.Vector3();
    this.directTravel = null;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.05;
    this.eyeHeight = DEFAULT_EYE_HEIGHT_METERS;
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
    // Guided camera composition state.  The heading is chosen from actual
    // nearby destinations/open-space checks instead of a blind perpetual spin.
    this.guidedCompositionYaw = 0;
    this.guidedCompositionTargetYaw = 0;
    this.guidedLastCompositionAt = 0;
    this.guidedCompositionIntervalMs = 5500;
    this.guidedCompositionMinVisibleTargets = 2;
    this.guidedCompositionSweepDeg = 34;
    this.guidedCompositionLookaheadMeters = 8;
    this.lookLocked = false;
    this.autoRotate = false;
    this.lastMoveDirection = new THREE.Vector3();
    this.blockedTime = 0;
    this.portalClickSuppressedUntil = 0;
    this.stuck = false;
    this.recoveryAvailable = false;

    this.viewTarget = new THREE.Vector3();
    this.viewDistance = 1;
    this.fov = DEFAULT_FOV_DEGREES;
    this.overviewPanSpeed = 1;
    this.keys = new Set();
    this.lastPointer = { x: 0, y: 0 };
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.portalObjects = [];
    this.portalTargets = new Map();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5a6570, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(-15, 25, 20);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fc7ff, 0.55);
    fill.position.set(15, 10, -10);
    this.scene.add(fill);

    this._bind();
    this.resize();
    this._tick();
  }

  _bind() {
    this.onKeyDown = (e) => {
      const key = e.key.toLowerCase();
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

      // Guided: left-drag is an explicit, modern way to yaw the camera.
      // A simple click remains a navigation action, so we defer the floor/hotspot
      // click until pointer-up and only treat it as a click when the pointer did
      // not move beyond a small drag threshold.
      if (this.walkMode === 'guided') {
        this.guidedPointerDown = { x: e.clientX, y: e.clientY };
        this.guidedPointerDragging = false;
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
      if (e.button === 0 && this.walkMode === 'guided' && this.viewMode === 'walk') {
        const wasDragging = this.guidedPointerDragging;
        this.guidedPointerDown = null;
        this.guidedPointerDragging = false;
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

      if (this.walkMode === 'guided') {
        if (!this.guidedPointerDown) return;
        const dx = e.clientX - this.guidedPointerDown.x;
        const dy = e.clientY - this.guidedPointerDown.y;
        const dragDistance = Math.hypot(dx, dy);
        if (dragDistance < 4) return;

        this.guidedPointerDragging = true;
        // Horizontal drag controls yaw only. Keep Guided pitch locked so the
        // floor-marker composition remains stable.
        this.targetYaw -= (e.movementX || dx) * (this.lookSensitivity * 0.78);
        this.currentYaw += (e.movementX || dx) * -(this.lookSensitivity * 0.30);
        this.targetPitch = this.guidedPitch;
        this.currentPitch = this.guidedPitch;
        this.guidedManualActive = true;
        this.guidedManualYawUntil = performance.now() + 2600;
        this.guidedYawCenter = this.targetYaw;
        this.guidedCompositionYaw = this.targetYaw;
        this.guidedCompositionTargetYaw = this.targetYaw;
        this.guidedLastCompositionAt = performance.now();
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
      this.targetPitch = THREE.MathUtils.clamp(
        this.targetPitch - dy * (this.lookSensitivity * 0.82),
        -Math.PI * 0.43,
        Math.PI * 0.28,
      );
    };

    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    this.renderer.domElement.addEventListener('contextmenu', this.onContextMenu);
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
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
    const jobBase = `${baseUrl.replace(/\/$/, '')}/jobs/${encodeURIComponent(jobId)}`;
    this.onState?.({ type: 'loading', value: true });

    const [surfacePayload, hotspotsPayload, navBuffer, gltf] = await Promise.all([
      fetch(`${jobBase}/navigation_surface.json`, { cache: 'no-store' }).then(this._assertJson('navigation_surface.json')),
      fetch(`${jobBase}/walk_hotspots.json`, { cache: 'no-store' }).then(this._assertJson('walk_hotspots.json')).catch((error) => {
        console.warn('[Walkthrough] walk_hotspots.json unavailable; no destinations will be shown.', error);
        return { hotspots: [] };
      }),
      fetch(`${jobBase}/navigation_navmesh.bin`, { cache: 'no-store' }).then(async (r) => {
        if (!r.ok) throw new Error(`navigation_navmesh.bin returned ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      }),
      new Promise((resolve, reject) => new GLTFLoader().load(`${jobBase}/output.glb`, resolve, undefined, reject)),
    ]);

    await initRecast();
    const imported = importNavMesh(navBuffer);
    if (!imported?.navMesh) throw new Error('Unable to import serialized Recast NavMesh.');

    this.navMesh = imported.navMesh;
    this.query = new NavMeshQuery(this.navMesh);
    this.filter = new QueryFilter();
    this.walkAreas = [];
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
    this.eyeHeight = DEFAULT_EYE_HEIGHT_METERS;
    // Guided presentation uses a dedicated architectural eye height instead of
    // the Explore slider maximum. This prevents the camera from feeling like a
    // drone while still giving a slightly elevated view over furniture.
    this.heightOffset = this.walkMode === 'guided'
      ? GUIDED_CAMERA_HEIGHT_METERS - this.eyeHeight
      : DEFAULT_HEIGHT_OFFSET_METERS;
    this.fov = this.walkMode === 'guided' ? 120 : DEFAULT_FOV_DEGREES;
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this.radius = Number(surfacePayload?.metadata?.agentRadiusMeters) > 0 ? Number(surfacePayload.metadata.agentRadiusMeters) : 0.15;
    this.walkSpeed = DEFAULT_SPEEDS.walk * this.metersPerUnit;
    this.runSpeed = DEFAULT_SPEEDS.run * this.metersPerUnit;

    this.model = gltf.scene;
    this.model.updateMatrixWorld(true);
    this.scene.add(this.model);

    this._buildNavigationSurface(surfacePayload);

    // GLB bounding volumes can be stale/invalid after compiler-side transforms.
    // Disable frustum culling for walkthrough rendering until bounds are verified.
    let meshCount = 0;
    let visibleMeshCount = 0;
    this.model.traverse((obj) => {
      if (!obj.isMesh) return;
      meshCount += 1;
      obj.visible = true;
      obj.frustumCulled = false;
      visibleMeshCount += obj.visible ? 1 : 0;
    });

    // Never expose or spawn on destinations where the presentation camera would
    // be underneath a low object (e.g. a bed, table, cabinet) even if the
    // architectural slab is technically walkable beneath it.
    const safeRenderedHotspots = rawHotspots.filter((hotspot) => this._hasCameraClearance(hotspot.position));
    const augmentedHotspots = this._augmentHotspotsFromFloor(surfacePayload, safeRenderedHotspots, 18);
    this.hotspots = augmentedHotspots;
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

    const box = new THREE.Box3().setFromObject(this.model);
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
    const p = { x: Number(point[0]), y: Number(point[1]) || 0, z: Number(point[2]) };
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

    this.position.set(point.x, point.y, point.z);
    this.currentPolyRef = point.polyRef || this.currentPolyRef;
    this._prepareGuidedArrivalView(this.position, this.lastMoveDirection);
    this.stuck = false;
    this.recoveryAvailable = false;
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', label, active: false, mode });
    this.onState?.({ type: 'teleport', label, mode });
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
    this.raycaster.set(
      new THREE.Vector3(Number(point[0]), originY, Number(point[2])),
      new THREE.Vector3(0, 1, 0),
    );
    const verticalHits = this.raycaster.intersectObject(this.model, true);
    if (verticalHits.length && verticalHits[0].distance < cameraClearance) return false;

    // Also reject destinations with a very tight horizontal envelope around the
    // avatar. This is intentionally conservative for customer-facing hotspots.
    const horizontalOrigin = new THREE.Vector3(Number(point[0]), originY + 0.25 * unit, Number(point[2]));
    const clearance = 0.34 * unit;
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8;
      const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      this.raycaster.set(horizontalOrigin, direction);
      const hits = this.raycaster.intersectObject(this.model, true);
      if (hits.length && hits[0].distance < clearance) return false;
    }
    return true;
  }

  _presentationOpenSpaceScore(point) {
    if (!this.model || !Array.isArray(point) || point.length < 3) return 1;
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const origin = new THREE.Vector3(Number(point[0]), Number(point[1]) + 0.12 * unit, Number(point[2]));
    const requiredHeadroom = (this.eyeHeight + 0.08) * unit;
    this.raycaster.set(origin, new THREE.Vector3(0, 1, 0));
    const ceilingHit = this.raycaster.intersectObject(this.model, true)[0];
    if (ceilingHit && ceilingHit.distance < requiredHeadroom) return 0;

    let nearest = Infinity;
    for (let i = 0; i < 16; i++) {
      const angle = (Math.PI * 2 * i) / 16;
      const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      this.raycaster.set(origin, dir);
      const hit = this.raycaster.intersectObject(this.model, true)[0];
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
    this.activeHotspotId = group.userData.hotspotId || null;
    const label = group.userData.walkLabel || 'Floor destination';
    this.travelTo(group.userData.walkTarget, label).then((ok) => {
      if (!ok) this._startEmergencyRecovery(group.userData.walkTarget, label);
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
    this.activeHotspotId = null;
    this.travelTo([floorPoint.x, floorPoint.y, floorPoint.z], 'Floor destination');
  }

  async navigateToHotspot(hotspot) {
    if (!hotspot || this.viewMode !== 'walk') return false;
    if (this.path || this.directTravel) return false;

    // Floor-map markers are rendered as {x, z}, while in-scene hotspots carry
    // a full position tuple. Accept both shapes so the map is a first-class
    // destination navigator instead of silently failing on a shape mismatch.
    const rawPosition = Array.isArray(hotspot.position)
      ? hotspot.position
      : [hotspot.x, Number(hotspot.y) || 0, hotspot.z];
    if (!Number.isFinite(Number(rawPosition[0])) || !Number.isFinite(Number(rawPosition[2]))) {
      return false;
    }

    const point = this._closestWalkPoint(rawPosition);
    if (!point || !this._hasCameraClearance([point.x, point.y, point.z])) {
      this.onState?.({ type: 'error', message: 'That navigation point is no longer available.' });
      return false;
    }

    this.activeHotspotId = hotspot.id || null;
    const label = hotspot.label || 'Navigation point';
    const start = { x: this.position.x, y: this.position.y, z: this.position.z };
    const result = this.query?.computePath(start, point, {
      filter: this.filter,
      maxStraightPathSize: 256,
      maxPathSize: 256,
    });

    if (result?.success && result.path?.length) {
      return this.travelTo([point.x, point.y, point.z], label);
    }

    // A floor-map point is an explicit user destination. When the physical
    // NavMesh cannot connect the current location to it (for example a closed
    // door or disconnected room), do not drag the camera through the scene.
    // Teleport directly to the already-validated destination instead.
    return this._teleportToDestination(point, label, 'map-teleport');
  }

  async travelTo(target, label = 'Destination') {
    if (!this.query || this.viewMode !== 'walk' || this.path || this.directTravel) return false;
    const start = { x: this.position.x, y: this.position.y, z: this.position.z };
    const closest = this._closestWalkPoint(target);
    if (!closest) {
      this.onState?.({ type: 'error', message: `No walkable point found for ${label}.` });
      return false;
    }
    const result = this.query.computePath(start, closest, {
      filter: this.filter,
      maxStraightPathSize: 256,
      maxPathSize: 256,
    });
    if (!result.success || !result.path?.length) {
      this.onState?.({ type: 'error', message: `${label} is not reachable from here.` });
      this.stuck = true;
      this.recoveryAvailable = this.hotspots.length > 0;
      this.onState?.({ type: 'stuck', available: this.recoveryAvailable });
      return false;
    }
    this.directTravel = null;
    this.path = this._simplifyPath(result.path.map((p) => ({ x: p.x, y: p.y, z: p.z })));
    this.pathIndex = 0;
    this.pathVelocity.set(0, 0, 0);
    this.blockedTime = 0;
    this.stuck = false;
    this.recoveryAvailable = false;
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', label, active: true, mode: 'path', hotspotId: this.activeHotspotId });
    return true;
  }

  async switchRoom(target, label = 'Node') {
    if (!this.query) return false;

    const areaId = target?.id;
    const targetPoint = Array.isArray(target?.center) ? target.center : [0, 0, 0];
    const pool = this.hotspots
      .filter((hotspot) => !areaId || hotspot.areaId === areaId)
      .filter((hotspot) => Array.isArray(hotspot.position) && this._hasCameraClearance(hotspot.position));

    const candidates = (pool.length ? pool : this.hotspots)
      .map((hotspot) => ({ hotspot, distance: Math.hypot(hotspot.position[0] - targetPoint[0], hotspot.position[2] - targetPoint[2]) }))
      .sort((a, b) => a.distance - b.distance);

    for (const candidate of candidates) {
      const ok = await this.travelTo(candidate.hotspot.position, label);
      if (ok) return true;
    }

    // Semantic room navigation may cross a blocked doorway, but the arrival point
    // must still be a verified safe hotspot. Never direct-travel to an arbitrary
    // NavMesh point that could sit behind a door or inside furniture.
    const safe = candidates[0]?.hotspot;
    if (safe) {
      const closest = this._closestWalkPoint(safe.position);
      if (closest && this._hasCameraClearance([closest.x, closest.y, closest.z])) {
        return this._startDirectRoomTravel(closest, label, 'room-recovery');
      }
    }

    this.onState?.({ type: 'error', message: `${label} has no safe reachable presentation destination.` });
    return false;
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
        if (!result.success || !result.path?.length) return null;
        return { hotspot, destination, distance: Math.hypot(destination.x - start.x, destination.z - start.z) };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);

    const chosen = pool[0];
    if (chosen) {
      this.activeHotspotId = chosen.hotspot.id;
      return this.travelTo(chosen.destination, label);
    }

    const fallback = target ? this._closestWalkPoint(target) : null;
    if (fallback && this._hasCameraClearance([fallback.x, fallback.y, fallback.z])) {
      return this._startDirectRoomTravel(fallback, label, 'recovery');
    }
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

  _resetWalkCameraDefaults() {
    this.heightOffset = DEFAULT_HEIGHT_OFFSET_METERS;
    this.fov = DEFAULT_FOV_DEGREES;
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this._notifyCameraSettings();
  }

  setSensitivity(value) {
    this.lookSensitivity = THREE.MathUtils.clamp(Number(value) || 0.0048, 0.0015, 0.009);
  }

  setWalkMode(mode) {
    const next = mode === 'explore' ? 'explore' : 'guided';
    if (next === this.walkMode) return;
    this.walkMode = next;

    // Switching from Explore -> Guided freezes the current composition.
    // Switching back restores mouse-look immediately without a view jump.
    if (next === 'guided') {
      this.guidedYawCenter = this.currentYaw;
      this.guidedCompositionYaw = this.currentYaw;
      this.guidedCompositionTargetYaw = this.currentYaw;
      this.guidedLastCompositionAt = performance.now();
      this.guidedPitch = this.currentPitch;
      this.targetPitch = this.currentPitch;
      this.heightOffset = GUIDED_CAMERA_HEIGHT_METERS - this.eyeHeight;
      this.fov = 120;
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this._notifyCameraSettings();
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
    this.fov = THREE.MathUtils.clamp(Number(value) || DEFAULT_FOV_DEGREES, 30, 120);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this._notifyCameraSettings();
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
    this.heightOffset = THREE.MathUtils.clamp(Number(value) || 0, MIN_HEIGHT_OFFSET_METERS, MAX_HEIGHT_OFFSET_METERS);
    this._notifyCameraSettings();
  }

  stopTravel() {
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity.set(0, 0, 0);
    this.directTravel = null;
    this.onState?.({ type: 'travel', active: false });
  }

  _updateMovement(dt) {
    if (this.directTravel) {
      const now = performance.now();
      const elapsed = now - this.directTravel.startTime;
      const t = THREE.MathUtils.clamp(elapsed / this.directTravel.duration, 0, 1);
      const eased = t * t * (3 - 2 * t);
      this.position.lerpVectors(this.directTravel.start, this.directTravel.end, eased);
      this.velocity.set(0, 0, 0);
      this.pathVelocity.set(0, 0, 0);
      this.blockedTime = 0;
      if (t >= 1) {
        const arrivalDirection = this.directTravel.end.clone().sub(this.directTravel.start).setY(0);
        this._prepareGuidedArrivalView(this.directTravel.end, arrivalDirection);
        this.currentPolyRef = this.directTravel.targetPolyRef || this.currentPolyRef;
        this.directTravel = null;
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
      const remainingDistance = this._estimateRemainingPathDistance();
      const lookAhead = THREE.MathUtils.clamp(0.35 * this.metersPerUnit + this.pathVelocity.length() * 0.18, 0.32 * this.metersPerUnit, 0.9 * this.metersPerUnit);
      const steerTarget = this._pointAlongPath(this.pathIndex, Math.min(lookAhead, Math.max(lookAhead, remainingDistance)));
      const next = steerTarget || this.path[this.pathIndex];
      const before = this.position.clone();
      this.lastMoveDirection.set(next.x - this.position.x, 0, next.z - this.position.z);
      if (this.lastMoveDirection.lengthSq() > 1e-8) this.lastMoveDirection.normalize();

      // Smooth acceleration, then brake naturally as we approach the destination.
      const brakeDistance = Math.max(1.15 * this.metersPerUnit, 0.9);
      const speedFactor = remainingDistance < brakeDistance
        ? THREE.MathUtils.clamp(remainingDistance / brakeDistance, 0.38, 1)
        : 1;
      this._moveToward(next, dt, this.walkSpeed * speedFactor);
      const moved = before.distanceTo(this.position);
      if (moved < 0.0002 * Math.max(1, this.metersPerUnit)) {
        this.blockedTime += dt;
        if (this.blockedTime > 0.65) {
          const recovered = this.recoverToSafeSpot('Recovered walk position');
          if (recovered) this.blockedTime = 0;
        }
        if (this.blockedTime > 1.25) {
          this.path = null;
          this.pathIndex = 0;
          this.pathVelocity.set(0, 0, 0);
          this.velocity.set(0, 0, 0);
          this.blockedTime = 0;
          this.stuck = true;
          this.recoveryAvailable = this.hotspots.length > 0;
          this.onState?.({ type: 'travel', active: false });
          this.onState?.({ type: 'stuck', available: this.recoveryAvailable });
          this.onState?.({ type: 'error', message: 'Navigation paused. Choose a nearby safe floor marker to continue.' });
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
    this.velocity.lerp(targetVelocity, Math.min(1, response * dt));
    if (!moving && this.velocity.lengthSq() < 1e-5) this.velocity.set(0, 0, 0);

    if (this.velocity.lengthSq() > 1e-8) {
      const desired = this.position.clone().addScaledVector(this.velocity, dt);
      this.lastMoveDirection.copy(this.velocity).normalize();
      const before = this.position.clone();
      this._moveTo(desired);
      const moved = before.distanceTo(this.position);
      if (moved < 0.0002 * Math.max(1, this.metersPerUnit)) {
        this.blockedTime += dt;
        if (this.blockedTime > 0.8) {
          const recovered = this.recoverToSafeSpot('Recovered walk position');
          if (recovered) this.blockedTime = 0;
        }
      } else {
        this.blockedTime = 0;
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

    // Cancel whatever was preventing movement and start a fresh destination search.
    this.path = null;
    this.pathIndex = 0;
    this.directTravel = null;
    this.pathVelocity.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.blockedTime = 0;

    const start = this._closestWalkPoint([this.position.x, this.position.y, this.position.z], 0.8);
    const startPoint = start || { x: this.position.x, y: this.position.y, z: this.position.z };

    const candidates = [];
    for (const hotspot of this.hotspots) {
      if (!Array.isArray(hotspot?.position)) continue;
      const destination = this._closestWalkPoint(hotspot.position, 0.45);
      if (!destination) continue;
      if (!this._hasCameraClearance([destination.x, destination.y, destination.z])) continue;

      const result = this.query.computePath(startPoint, destination, {
        filter: this.filter,
        maxStraightPathSize: 256,
        maxPathSize: 256,
      });
      if (!result?.success || !result.path?.length) continue;

      let length = 0;
      let previous = startPoint;
      for (const p of result.path) {
        length += Math.hypot(p.x - previous.x, p.z - previous.z);
        previous = p;
      }
      candidates.push({ hotspot, destination, length });
    }

    candidates.sort((a, b) => a.length - b.length);
    const chosen = candidates[0];

    if (chosen) {
      this.activeHotspotId = chosen.hotspot.id || null;
      const ok = this._startPathToDestination(chosen.destination, label, 'recovery-path');
      if (ok) {
        this.stuck = false;
        this.recoveryAvailable = false;
        this.onState?.({ type: 'stuck', available: false });
        return true;
      }
    }

    // Last-resort recovery: only teleport to a validated hotspot. This is deliberately
    // not an arbitrary NavMesh point; the user must still land at a safe destination.
    const safe = this.hotspots
      .map((hotspot) => ({ hotspot, point: this._closestWalkPoint(hotspot.position, 0.45) }))
      .filter(({ point }) => point && this._hasCameraClearance([point.x, point.y, point.z]))
      .sort((a, b) => {
        const da = Math.hypot(a.point.x - this.position.x, a.point.z - this.position.z);
        const db = Math.hypot(b.point.x - this.position.x, b.point.z - this.position.z);
        return da - db;
      })[0];

    if (!safe?.point) return false;
    this.activeHotspotId = safe.hotspot.id || null;
    return this._teleportToDestination(safe.point, label, 'recovery-teleport');
  }

  _startPathToDestination(destination, label, mode = 'path') {
    const start = { x: this.position.x, y: this.position.y, z: this.position.z };
    const result = this.query?.computePath(start, destination, {
      filter: this.filter,
      maxStraightPathSize: 256,
      maxPathSize: 256,
    });
    if (!result?.success || !result.path?.length) return false;
    this.path = this._simplifyPath(result.path.map((p) => ({ x: p.x, y: p.y, z: p.z })));
    this.pathIndex = 0;
    this.pathVelocity.set(0, 0, 0);
    this.blockedTime = 0;
    this.stuck = false;
    this.recoveryAvailable = false;
    this.currentPolyRef = destination.polyRef || this.currentPolyRef;
    this.onState?.({ type: 'stuck', available: false });
    this.onState?.({ type: 'travel', label, active: true, mode, hotspotId: this.activeHotspotId });
    return true;
  }

  _moveTo(desired) {
    // Recast's agent radius is the physical collision authority during motion.
    // Camera-clearance raycasts are reserved for spawn/destination validation;
    // applying them every frame can incorrectly reject a valid corridor and
    // make the character appear to snag or choose an odd side around furniture.
    const startRef = this.currentPolyRef || 0;
    const result = this.query.moveAlongSurface(
      startRef,
      { x: this.position.x, y: this.position.y, z: this.position.z },
      { x: desired.x, y: desired.y, z: desired.z },
      { filter: this.filter, maxVisitedSize: 128 },
    );
    if (result.success) {
      this.position.set(result.resultPosition.x, result.resultPosition.y, result.resultPosition.z);
      if (result.visited?.length) this.currentPolyRef = result.visited[result.visited.length - 1];
      if (result.resultPolyRef) this.currentPolyRef = result.resultPolyRef;
      return true;
    }
    return false;
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

  _getGuidedVisibleHotspots(referencePosition = this.position, yaw = this.currentYaw, maxDistanceMeters = this.guidedCompositionLookaheadMeters) {
    if (!this.hotspots.length) return [];
    const unit = Math.max(this.metersPerUnit, 0.000001);
    const base = new THREE.Vector3(referencePosition.x, referencePosition.y, referencePosition.z);
    const eyeHeight = this.eyeHeight * unit + this.heightOffset * unit;
    const eye = new THREE.Vector3(base.x, base.y + eyeHeight, base.z);
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const visible = [];

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
      if (!this._hasCameraClearance([target.x, target.y, target.z])) continue;

      const direction = to.normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(forward.dot(direction), -1, 1));
      if (angle > THREE.MathUtils.degToRad(82)) continue;

      let occluded = false;
      if (this.model) {
        const toTarget = target.clone().sub(eye);
        const targetDistance = toTarget.length();
        if (targetDistance > 1e-6) {
          this.raycaster.set(eye, toTarget.normalize());
          const hit = this.raycaster.intersectObject(this.model, true)[0];
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

    let score = 0;
    for (const item of visible) {
      const proximity = THREE.MathUtils.clamp(1 - item.distance / (this.guidedCompositionLookaheadMeters * unit), 0, 1);
      const centered = 1 - THREE.MathUtils.clamp(item.angle / THREE.MathUtils.degToRad(75), 0, 1);
      const forwardBonus = incoming.lengthSq() > 1e-8 ? Math.max(0, incoming.dot(item.direction)) : 0;
      score += 1.8 + proximity * 1.4 + centered * 1.2 + forwardBonus * 0.55;
    }

    // A clear forward ray is a useful tie-breaker because a good presentation
    // view should not immediately bury the user in a wall.
    const eye = new THREE.Vector3(referencePosition.x, referencePosition.y + this.eyeHeight * unit + this.heightOffset * unit, referencePosition.z);
    const lookDir = new THREE.Vector3(-Math.sin(candidateYaw), 0, -Math.cos(candidateYaw));
    if (this.model) {
      for (const meters of [2.0, 4.0, 7.0]) {
        this.raycaster.set(eye, lookDir);
        const hit = this.raycaster.intersectObject(this.model, true)[0];
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

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return null;

    const angleDelta = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const current = candidates
      .filter((candidate) => angleDelta(candidate.yaw, preferredYaw) <= THREE.MathUtils.degToRad(8))
      .sort((a, b) => b.score - a.score)[0];

    // Stability rule: don't rotate to a dramatically different composition for
    // a negligible gain in quality.
    if (current && best.score < current.score * 1.10) return current;
    return best;
  }

  _prepareGuidedArrivalView(referencePosition = this.position, incomingDirection = this.lastMoveDirection) {
    if (this.walkMode !== 'guided') return;

    const preferredYaw = Number.isFinite(this.currentYaw)
      ? this.currentYaw
      : (incomingDirection?.lengthSq?.() > 1e-8 ? Math.atan2(-incomingDirection.x, -incomingDirection.z) : 0);
    const best = this._findBestGuidedComposition(referencePosition, incomingDirection, preferredYaw);

    if (best && Number.isFinite(best.yaw)) {
      this.guidedCompositionYaw = best.yaw;
      this.guidedCompositionTargetYaw = best.yaw;
      this.guidedYawCenter = best.yaw;
      this.targetYaw = best.yaw;
    } else if (incomingDirection?.lengthSq?.() > 1e-8) {
      const fallbackYaw = Math.atan2(-incomingDirection.x, -incomingDirection.z);
      this.guidedCompositionYaw = fallbackYaw;
      this.guidedCompositionTargetYaw = fallbackYaw;
      this.guidedYawCenter = fallbackYaw;
      this.targetYaw = fallbackYaw;
    }

    this.guidedLastCompositionAt = performance.now();
    this.guidedPanPhase = 0;
    this.targetPitch = this.guidedPitch;
  }

  _syncCamera() {
    const smoothing = 1 - Math.exp(-this.lookSmoothing * (this._lastDt || 0.016));
    const dt = this._lastDt || 0.016;
    const isTravelling = Boolean(this.path?.length || this.directTravel);

    // Guided mode is a presentation camera: it slowly pans continuously, not
    // only while travelling. The pitch stays fixed so the user gets a stable
    // architectural horizon, while movement follows the NavMesh independently.
    if (this.walkMode === 'guided' && this.guidedAutoRotate) {
      const now = performance.now();
      if (this.guidedManualActive) {
        this.targetPitch = this.guidedPitch;
        if (now >= this.guidedManualYawUntil) {
          this.guidedManualActive = false;
          this.guidedCompositionYaw = this.currentYaw;
          this.guidedCompositionTargetYaw = this.currentYaw;
          this.guidedYawCenter = this.currentYaw;
          this.guidedLastCompositionAt = now;
          this.guidedPanPhase = 0;
        }
      } else {
        const due = now - this.guidedLastCompositionAt >= this.guidedCompositionIntervalMs;
        if (due) {
          const visible = this._getGuidedVisibleHotspots(this.position, this.currentYaw, this.guidedCompositionLookaheadMeters);
          // Reframe periodically, but only when the current view is weak. During
          // travel this keeps the next useful choices visible without making the
          // camera feel as though it is chasing every waypoint.
          if (visible.length < this.guidedCompositionMinVisibleTargets || !isTravelling) {
            const best = this._findBestGuidedComposition(this.position, this.lastMoveDirection, this.currentYaw);
            if (best && Number.isFinite(best.yaw)) this.guidedCompositionTargetYaw = best.yaw;
          }
          this.guidedLastCompositionAt = now;
        }

        this.guidedCompositionYaw = THREE.MathUtils.lerp(
          this.guidedCompositionYaw,
          this.guidedCompositionTargetYaw,
          1 - Math.exp(-1.8 * dt),
        );

        // Very small cinematic drift around the chosen composition. This is no
        // longer a one-direction spin: the selected composition is the anchor.
        this.guidedPanPhase += dt * this.guidedYawRate;
        const microSweep = Math.sin(this.guidedPanPhase) * THREE.MathUtils.degToRad(this.guidedCompositionSweepDeg) * 0.12;
        this.targetYaw = this.guidedCompositionYaw + microSweep;
        this.targetPitch = this.guidedPitch;
      }
      this.guidedTravelRotating = !this.guidedManualActive;
    } else if (!isTravelling) {
      this.guidedTravelRotating = false;
    }

    this.currentYaw = THREE.MathUtils.lerp(this.currentYaw, this.targetYaw, smoothing);
    this.currentPitch = THREE.MathUtils.lerp(this.currentPitch, this.targetPitch, smoothing);
    this.yaw = this.currentYaw;
    this.pitch = this.currentPitch;

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
    const visibleLimit = 9;
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
    const selected = [];
    const minAngularSeparation = THREE.MathUtils.degToRad(10);
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
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    this._lastDt = dt;
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
    this.animationFrame = requestAnimationFrame(this._tick);
  };

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.renderer.domElement.removeEventListener('contextmenu', this.onContextMenu);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
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

export function useWalkthroughEngine({ containerRef, jobId }) {
  const runtimeRef = useRef(null);
  const [state, setState] = useState({ status: 'idle', areas: [], navigationPlan: null, activeArea: null, activeHotspotId: null, message: '', lookLocked: true, walkMode: 'guided', cameraHeightMeters: DEFAULT_EYE_HEIGHT_METERS + DEFAULT_HEIGHT_OFFSET_METERS, heightOffsetMeters: DEFAULT_HEIGHT_OFFSET_METERS, cameraFov: DEFAULT_FOV_DEGREES, stuck: false, recoveryAvailable: false });

  useEffect(() => {
    if (!containerRef.current || !jobId) return undefined;
    const runtime = new WalkRuntime({
      canvas: containerRef.current,
      onState: (event) => {
        if (event.type === 'loaded') setState({ status: 'ready', areas: event.areas || [], navigationPlan: runtimeRef.current?.navigationPlan || null, activeArea: null, activeHotspotId: null, message: '', lookLocked: runtimeRef.current?.lookLocked ?? false, walkMode: runtimeRef.current?.walkMode ?? 'guided', cameraHeightMeters: (runtimeRef.current?.eyeHeight || DEFAULT_EYE_HEIGHT_METERS) + (runtimeRef.current?.heightOffset || 0), heightOffsetMeters: runtimeRef.current?.heightOffset || 0, cameraFov: runtimeRef.current?.fov || DEFAULT_FOV_DEGREES, stuck: false, recoveryAvailable: false });
        if (event.type === 'loading') setState((prev) => ({ ...prev, status: 'loading' }));
        if (event.type === 'travel') setState((prev) => ({ ...prev, activeArea: event.label || null, activeHotspotId: event.hotspotId || prev.activeHotspotId || null, message: event.active ? `Walking to ${event.label}…` : '' }));
        if (event.type === 'error') setState((prev) => ({ ...prev, message: event.message || 'Navigation failed.' }));
        if (event.type === 'look-lock') setState((prev) => ({ ...prev, lookLocked: event.locked }));
        if (event.type === 'walk-mode') setState((prev) => ({ ...prev, walkMode: event.mode }));
        if (event.type === 'camera-settings') setState((prev) => ({ ...prev, cameraHeightMeters: event.cameraHeightMeters, heightOffsetMeters: event.heightOffsetMeters, cameraFov: event.fov }));
        if (event.type === 'unstuck') setState((prev) => ({ ...prev, message: 'Recovered walk position.', stuck: false, recoveryAvailable: false }));
        if (event.type === 'stuck') setState((prev) => ({ ...prev, stuck: Boolean(event.available), recoveryAvailable: Boolean(event.available) }));
        if (event.type === 'escape') setState((prev) => ({ ...prev, message: '' }));
      },
    });
    runtimeRef.current = runtime;
    const base = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    runtime.load(jobId, base).catch((error) => {
      console.error('[Walkthrough] Failed to load job:', error);
      setState({ status: 'error', areas: [], activeArea: null, message: error.message, lookLocked: true, walkMode: 'guided', stuck: false, recoveryAvailable: false });
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
  const setViewMode = useCallback((value) => runtimeRef.current?.setViewMode(value), []);
  const setAutoRotate = useCallback((value) => runtimeRef.current?.setAutoRotate(value), []);
  const setViewPreset = useCallback((value) => runtimeRef.current?.setViewPreset(value), []);
  const zoom = useCallback((value) => runtimeRef.current?.zoom(value), []);
  const fitView = useCallback(() => runtimeRef.current?.fitView(), []);
  const recoverToSafeSpot = useCallback(() => runtimeRef.current?.recoverToSafeSpot(), []);
  return { ...state, travelTo, switchRoom, navigateToHotspot, stopTravel, recoverToSafeSpot, setHeightOffset, setSensitivity, setWalkMode, setLookLocked, setViewMode, setAutoRotate, setViewPreset, zoom, fitView, setFov };
}