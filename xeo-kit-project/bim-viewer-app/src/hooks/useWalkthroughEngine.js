import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { init as initRecast, importNavMesh, NavMeshQuery, QueryFilter } from 'recast-navigation';

const DEFAULT_SPEEDS = { walk: 1.8, run: 4.5 };

class WalkRuntime {
  constructor({ canvas, onState }) {
    this.canvas = canvas;
    this.onState = onState;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf4f6f8);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 5000);
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
    this.running = true;
    this.animationFrame = 0;
    this.model = null;
    this.navMesh = null;
    this.query = null;
    this.filter = null;
    this.walkAreas = [];
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity = new THREE.Vector3();
    this.directTravel = null;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.05;
    this.eyeHeight = 1.6;
    this.radius = 0.15;
    this.walkSpeed = DEFAULT_SPEEDS.walk;
    this.runSpeed = DEFAULT_SPEEDS.run;
    this.metersPerUnit = 1;
    this.heightOffset = 0;
    // Start in a presentation-friendly perspective overview. Walk activates only after an explicit user action.
    this.viewMode = 'overview';
    this.lookLocked = false;
    this.autoRotate = false;
    this.lastMoveDirection = new THREE.Vector3();
    this.blockedTime = 0;
    this.portalClickSuppressedUntil = 0;
    this.pendingSemanticFallback = null;

    this.viewTarget = new THREE.Vector3();
    this.viewDistance = 1;
    this.fov = 70;
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
      if (['w', 'a', 's', 'd', 'shift', 'q', 'e'].includes(key)) {
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
      if (e.button === 0) this._pickPortal(e);
    };
    this.onDoubleClick = (e) => {
      if (this.viewMode !== 'walk') return;
      e.preventDefault();
      e.stopPropagation();
      this.portalClickSuppressedUntil = performance.now() + 350;
      this.setLookLocked(!this.lookLocked, true);
    };
    this.onPointerUp = (e) => {
      if (e.button === 2) {
            this.renderer.domElement.releasePointerCapture?.(e.pointerId);
      }
    };
    this.onPointerMove = (e) => {
      if (this.lookLocked || this.viewMode !== 'walk') return;
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      const dx = e.movementX || (e.clientX - this.lastPointer.x);
      const dy = e.movementY || (e.clientY - this.lastPointer.y);
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;
      this.targetYaw -= dx * this.lookSensitivity;
      this.targetPitch = THREE.MathUtils.clamp(
        this.targetPitch - dy * (this.lookSensitivity * 0.82),
        -Math.PI * 0.43,
        Math.PI * 0.43,
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

    const [surfacePayload, areasPayload, navBuffer, gltf] = await Promise.all([
      fetch(`${jobBase}/navigation_surface.json`, { cache: 'no-store' }).then(this._assertJson('navigation_surface.json')),
      fetch(`${jobBase}/walk_areas.json`, { cache: 'no-store' }).then(this._assertJson('walk_areas.json')).catch((error) => {
        console.warn('[Walkthrough] walk_areas.json unavailable; using fallback destination list.', error);
        return { areas: [] };
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
    this.walkAreas = Array.isArray(areasPayload?.areas) ? areasPayload.areas.filter((a) => Array.isArray(a?.center) && a.center.length >= 3) : [];
    this.metersPerUnit = Number(surfacePayload?.metadata?.physicalMetersPerUnit) > 0 ? Number(surfacePayload.metadata.physicalMetersPerUnit) : 1;
    this.eyeHeight = Number(surfacePayload?.metadata?.eyeHeightMeters) > 0 ? Number(surfacePayload.metadata.eyeHeightMeters) : 1.6;
    this.radius = Number(surfacePayload?.metadata?.agentRadiusMeters) > 0 ? Number(surfacePayload.metadata.agentRadiusMeters) : 0.15;
    this.walkSpeed = DEFAULT_SPEEDS.walk * this.metersPerUnit;
    this.runSpeed = DEFAULT_SPEEDS.run * this.metersPerUnit;

    this.model = gltf.scene;
    this.model.updateMatrixWorld(true);
    this.scene.add(this.model);

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

    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    this.viewTarget.copy(center);
    // Fit the camera so the full scene is visible on load.
    this.viewDistance = Math.max(size.x, size.y, size.z, 1) * 1.65;
    this.overviewPanSpeed = Math.max(size.x, size.y, size.z, 1) * 0.6;
    this.orbitControls.target.copy(center);
    this.orbitControls.minDistance = Math.max(maxDim * 0.04, 0.3);
    this.orbitControls.maxDistance = Math.max(maxDim * 12, 30);
    this.camera.near = Math.max(0.02, maxDim / 5000);
    this.camera.far = Math.max(200, maxDim * 20);
    this.camera.updateProjectionMatrix();

    // Presentation start: a clean, slightly pulled-back perspective overview.
    this.setViewPreset('perspective');

    const startSeed = this.walkAreas[0]?.center || [center.x, 0, center.z];
    const start = this._closestWalkPoint(startSeed);
    if (!start) throw new Error('Serialized NavMesh has no reachable spawn point.');

    this.position.set(start.x, start.y, start.z);
    this.currentPolyRef = start.polyRef || 0;
    this.currentYaw = this.yaw;
    this.targetYaw = this.yaw;
    this.currentPitch = this.pitch;
    this.targetPitch = this.pitch;
    this._lookForwardTo(this.walkAreas[1]?.center || [center.x, center.y, center.z]);
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
      navMeshBytes: navBuffer.byteLength,
      meshCount,
      visibleMeshCount,
    });

    this.onState?.({ type: 'loaded', areas: this.walkAreas, size, center });
    return { areas: this.walkAreas, size, center };
  }

  _assertJson(name) {
    return async (response) => {
      if (!response.ok) throw new Error(`${name} returned ${response.status}`);
      return response.json();
    };
  }

  _closestWalkPoint(point) {
    const p = { x: Number(point[0]), y: Number(point[1]) || 0, z: Number(point[2]) };
    const result = this.query.findClosestPoint(p, {
      halfExtents: { x: 5, y: 3, z: 5 },
      filter: this.filter,
    });
    if (!result.success) return null;
    return {
      x: result.point.x,
      y: result.point.y,
      z: result.point.z,
      polyRef: result.polyRef ?? result.ref ?? 0,
    };
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

  _buildPortals() {
    this.portalObjects.forEach((o) => {
      o.material.map?.dispose();
      o.material.dispose();
    });
    this.portalObjects = [];
    this.portalTargets.clear();

    this.walkAreas.forEach((area) => {
      const texture = this._makePortalTexture(area.label || 'Room');
      const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(1.25 * this.metersPerUnit, 0.42 * this.metersPerUnit, 1);
      sprite.position.set(area.center[0], area.center[1] + this.eyeHeight * this.metersPerUnit * 0.7, area.center[2]);
      sprite.userData.walkTarget = area.center;
      sprite.userData.walkLabel = area.label || 'Room';
      this.scene.add(sprite);
      this.portalObjects.push(sprite);
      this.portalTargets.set(area.label, area.center);
    });
  }

  _makePortalTexture(label) {
    const c = document.createElement('canvas');
    c.width = 360; c.height = 140;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.shadowColor = '#ff914d';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#ff914d';
    ctx.beginPath();
    ctx.moveTo(32, 86); ctx.lineTo(56, 48); ctx.lineTo(80, 86);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(20, 25, 30, 0.78)';
    ctx.beginPath(); ctx.roundRect(98, 43, 232, 46, 18); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 24px Inter, Arial, sans-serif';
    ctx.fillText(label, 118, 73);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _pickPortal(event) {
    if (performance.now() < this.portalClickSuppressedUntil) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.portalObjects, false);
    if (!hits.length) return;
    const sprite = hits[0].object;
    const label = sprite.userData.walkLabel;
    this.travelTo(sprite.userData.walkTarget, label);
  }

  async travelTo(target, label = 'Destination') {
    if (!this.query) return false;
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
      // Explicit destination requests should never strand the user.
      // Fall back to semantic room switching when physical pathing is blocked.
      return this._startDirectRoomTravel(closest, label, 'path-fallback');
    }
    this.directTravel = null;
    this.pendingSemanticFallback = { closest, label };
    this.path = result.path.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    this.pathIndex = 0;
    this.pathVelocity.set(0, 0, 0);
    this.onState?.({ type: 'travel', label, active: true, mode: 'path' });
    return true;
  }

  async switchRoom(target, label = 'Room') {
    if (!this.query) return false;
    const closest = this._closestWalkPoint(target);
    if (!closest) {
      this.onState?.({ type: 'error', message: `No walkable destination found for ${label}.` });
      return false;
    }
    return this._startDirectRoomTravel(closest, label, 'room-switch');
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

  setSensitivity(value) {
    this.lookSensitivity = THREE.MathUtils.clamp(Number(value) || 0.0048, 0.0015, 0.009);
  }

  setLookLocked(value, notify = false) {
    this.lookLocked = Boolean(value);
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
      this._syncCamera();
    }
    this.onState?.({ type: 'view-mode', mode: this.viewMode });
  }

  setAutoRotate(value) {
    this.autoRotate = Boolean(value);
    this.orbitControls.autoRotate = this.viewMode === 'overview' && this.autoRotate;
  }

  setViewPreset(name) {
    const distance = this.viewDistance;
    const target = this.viewTarget.clone();
    const presets = {
      top: new THREE.Vector3(0, 1, 0),
      front: new THREE.Vector3(0, 0.28, 1),
      side: new THREE.Vector3(1, 0.28, 0),
      perspective: new THREE.Vector3(0.72, 0.62, 0.72),
      isometric: new THREE.Vector3(0.86, 0.78, 0.86),
    };
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
    this.fov = THREE.MathUtils.clamp(Number(value) || 70, 30, 110);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
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
    this.heightOffset = THREE.MathUtils.clamp(value, -0.15, 0.35);
  }

  stopTravel() {
    this.path = null;
    this.pathIndex = 0;
    this.pathVelocity.set(0, 0, 0);
    this.directTravel = null;
    this.pendingSemanticFallback = null;
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
        this.currentPolyRef = this.directTravel.targetPolyRef || this.currentPolyRef;
        this.directTravel = null;
        this.pendingSemanticFallback = null;
        this.onState?.({ type: 'travel', active: false });
      }
      return;
    }

    if (this.path?.length) {
      const target = this.path[this.pathIndex];
      const delta = new THREE.Vector3(target.x - this.position.x, 0, target.z - this.position.z);
      if (delta.length() < Math.max(0.05 * this.metersPerUnit, 0.06)) {
        this.pathIndex += 1;
        if (this.pathIndex >= this.path.length) {
          this.path = null;
          this.pathIndex = 0;
          this.pathVelocity.set(0, 0, 0);
          this.velocity.set(0, 0, 0);
          this.pendingSemanticFallback = null;
          this.onState?.({ type: 'travel', active: false });
          return;
        }
      }
      const next = this.path[this.pathIndex];
      const before = this.position.clone();
      this.lastMoveDirection.set(next.x - this.position.x, 0, next.z - this.position.z);
      if (this.lastMoveDirection.lengthSq() > 1e-8) this.lastMoveDirection.normalize();
      this._moveToward(next, dt, this.walkSpeed);
      const moved = before.distanceTo(this.position);
      if (moved < 0.0002 * Math.max(1, this.metersPerUnit)) {
        this.blockedTime += dt;
        if (this.blockedTime > 0.65) {
          const recovered = this._recoverFromStall();
          if (recovered) this.blockedTime = 0;
        }
        if (this.blockedTime > 1.25 && this.pendingSemanticFallback) {
          const fallback = this.pendingSemanticFallback;
          this.pendingSemanticFallback = null;
          this._startDirectRoomTravel(fallback.closest, fallback.label, 'unstuck-fallback');
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
    if (this.keys.has('w')) wish.add(forward);
    if (this.keys.has('s')) wish.sub(forward);
    if (this.keys.has('d')) wish.add(right);
    if (this.keys.has('a')) wish.sub(right);
    if (this.keys.has('q')) this.heightOffset = Math.min(this.heightOffset + 0.35 * dt, 0.35);
    if (this.keys.has('e')) this.heightOffset = Math.max(this.heightOffset - 0.35 * dt, -0.15);

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
          const recovered = this._recoverFromStall();
          if (recovered) this.blockedTime = 0;
        }
      } else {
        this.blockedTime = 0;
      }
      this.headBobTime += dt * (moving ? (this.keys.has('shift') ? 10.5 : 8.5) : 5);
    } else {
      this.headBobTime += dt * 2;
    }
  }

  _moveToward(target, dt, speed) {
    const direction = new THREE.Vector3(target.x - this.position.x, 0, target.z - this.position.z);
    if (direction.lengthSq() < 1e-8) return;
    direction.normalize();
    const desiredVelocity = direction.multiplyScalar(speed);
    const response = 5.5;
    this.pathVelocity.lerp(desiredVelocity, 1 - Math.exp(-response * dt));
    this._moveTo(this.position.clone().addScaledVector(this.pathVelocity, dt));
    this.headBobTime += dt * (speed > this.walkSpeed * 1.05 ? 10.5 : 8.5);
  }

  _recoverFromStall() {
    if (!this.query) return;
    const baseRadius = Math.max(this.radius * 2.2, 0.18 * this.metersPerUnit);
    const directions = [];
    const away = this.lastMoveDirection.clone().multiplyScalar(-1);
    if (away.lengthSq() > 1e-8) directions.push(away.normalize());
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8;
      directions.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    let best = null;
    let bestDist = Infinity;
    for (const dir of directions) {
      const candidate = this.position.clone().addScaledVector(dir, baseRadius);
      const result = this.query.findClosestPoint(
        { x: candidate.x, y: candidate.y, z: candidate.z },
        { halfExtents: { x: baseRadius * 1.8, y: Math.max(0.25, this.metersPerUnit), z: baseRadius * 1.8 }, filter: this.filter },
      );
      if (!result.success) continue;
      const point = new THREE.Vector3(result.point.x, result.point.y, result.point.z);
      const d = point.distanceTo(candidate);
      if (d < bestDist && point.distanceTo(this.position) > 0.01 * Math.max(1, this.metersPerUnit)) {
        best = { point, polyRef: result.polyRef ?? result.ref ?? 0 };
        bestDist = d;
      }
    }
    if (best) {
      this.position.copy(best.point);
      this.currentPolyRef = best.polyRef || this.currentPolyRef;
      this.velocity.set(0, 0, 0);
      this.pathVelocity.set(0, 0, 0);
      this.onState?.({ type: 'unstuck' });
      return true;
    }
    return false;
  }

  _moveTo(desired) {
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
    }
  }

  _updateOverviewKeys(dt) {
    if (!this.keys.size) return;
    const speed = this.overviewPanSpeed * (this.keys.has('shift') ? 3 : 1);
    // WASD pan the orbit target in the camera's horizontal plane
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).setY(0).normalize();
    const fwd = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).negate().setY(0).normalize();
    const pan = new THREE.Vector3();
    if (this.keys.has('w')) pan.addScaledVector(fwd, speed * dt);
    if (this.keys.has('s')) pan.addScaledVector(fwd, -speed * dt);
    if (this.keys.has('a')) pan.addScaledVector(right, -speed * dt);
    if (this.keys.has('d')) pan.addScaledVector(right, speed * dt);
    if (this.keys.has('q')) this.zoom(-1);
    if (this.keys.has('e')) this.zoom(1);
    if (pan.lengthSq() > 0) {
      this.orbitControls.target.add(pan);
      this.camera.position.add(pan);
      this.viewTarget.add(pan);
    }
  }

  _syncCamera() {
    const smoothing = 1 - Math.exp(-this.lookSmoothing * (this._lastDt || 0.016));
    this.currentYaw = THREE.MathUtils.lerp(this.currentYaw, this.targetYaw, smoothing);
    this.currentPitch = THREE.MathUtils.lerp(this.currentPitch, this.targetPitch, smoothing);
    this.yaw = this.currentYaw;
    this.pitch = this.currentPitch;

    const baseH = this.eyeHeight * this.metersPerUnit + this.heightOffset * this.metersPerUnit;
    const isMoving = this.velocity.lengthSq() > 0.0025;
    const bobAmplitude = Math.min(this.metersPerUnit * 0.018, 0.018);
    const bob = isMoving ? Math.sin(this.headBobTime) * bobAmplitude : 0;
    const sway = isMoving ? Math.cos(this.headBobTime * 0.5) * bobAmplitude * 0.35 : 0;

    this.camera.position.set(
      this.position.x + sway * Math.cos(this.currentYaw),
      this.position.y + baseH + bob,
      this.position.z - sway * Math.sin(this.currentYaw),
    );

    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.currentPitch, this.currentYaw, 0, 'YXZ');
  }

  _updatePortals() {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    this.portalObjects.forEach((sprite) => {
      const to = sprite.position.clone().sub(this.camera.position);
      const dist = to.length();
      sprite.visible = dist < 18 * this.metersPerUnit;
      if (!sprite.visible) return;
      to.normalize();
      const dot = forward.dot(to);
      sprite.visible = dot > -0.15;
      if (sprite.visible) sprite.quaternion.copy(this.camera.quaternion);
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
    this.portalObjects.forEach((o) => { o.material.map?.dispose(); o.material.dispose(); });
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
  const [state, setState] = useState({ status: 'idle', areas: [], activeArea: null, message: '', lookLocked: false });

  useEffect(() => {
    if (!containerRef.current || !jobId) return undefined;
    const runtime = new WalkRuntime({
      canvas: containerRef.current,
      onState: (event) => {
        if (event.type === 'loaded') setState({ status: 'ready', areas: event.areas || [], activeArea: null, message: '', lookLocked: runtimeRef.current?.lookLocked ?? false });
        if (event.type === 'loading') setState((prev) => ({ ...prev, status: 'loading' }));
        if (event.type === 'travel') setState((prev) => ({ ...prev, activeArea: event.label || null, message: event.active ? `Walking to ${event.label}…` : '' }));
        if (event.type === 'error') setState((prev) => ({ ...prev, message: event.message || 'Navigation failed.' }));
        if (event.type === 'look-lock') setState((prev) => ({ ...prev, lookLocked: event.locked }));
        if (event.type === 'unstuck') setState((prev) => ({ ...prev, message: 'Recovered walk position.' }));
        if (event.type === 'escape') setState((prev) => ({ ...prev, message: '' }));
      },
    });
    runtimeRef.current = runtime;
    const base = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    runtime.load(jobId, base).catch((error) => {
      console.error('[Walkthrough] Failed to load job:', error);
      setState({ status: 'error', areas: [], activeArea: null, message: error.message, lookLocked: false });
    });
    return () => {
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, [containerRef, jobId]);

  const travelTo = useCallback((area) => runtimeRef.current?.travelTo(area.center, area.label), []);
  const switchRoom = useCallback((area) => runtimeRef.current?.switchRoom(area.center, area.label), []);
  const stopTravel = useCallback(() => runtimeRef.current?.stopTravel(), []);
  const setHeightOffset = useCallback((value) => runtimeRef.current?.setHeightOffset(value), []);
  const setSensitivity = useCallback((value) => runtimeRef.current?.setSensitivity(value), []);
  const setLookLocked = useCallback((value) => runtimeRef.current?.setLookLocked(value), []);
  const setFov = useCallback((value) => runtimeRef.current?.setFov(value), []);
  const setViewMode = useCallback((value) => runtimeRef.current?.setViewMode(value), []);
  const setAutoRotate = useCallback((value) => runtimeRef.current?.setAutoRotate(value), []);
  const setViewPreset = useCallback((value) => runtimeRef.current?.setViewPreset(value), []);
  const zoom = useCallback((value) => runtimeRef.current?.zoom(value), []);
  const fitView = useCallback(() => runtimeRef.current?.fitView(), []);
  return { ...state, travelTo, switchRoom, stopTravel, setHeightOffset, setSensitivity, setLookLocked, setViewMode, setAutoRotate, setViewPreset, zoom, fitView, setFov };
}