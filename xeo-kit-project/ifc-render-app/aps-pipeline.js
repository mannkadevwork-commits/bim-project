require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');
const path = require('path');

const BUNDLE_ID = "IFCRenderBundle_v2";
const ACTIVITY_ID = "IFCRenderActivity_v2";
const ALIAS = "prod";
const ENGINE = "Autodesk.3dsMax+2024";
const BUCKET_KEY = (process.env.APS_CLIENT_ID + "_render_storage").toLowerCase();

const CAMERA_ANGLE = process.argv[2] || "top-front-right";
const JOB_DIR = process.argv[3] || ".";
const JOB_ID = path.basename(JOB_DIR) || "default";

const LOCAL_IFC_PATH = path.join(JOB_DIR, "input.ifc");
const LOCAL_STATE_PATH = path.join(JOB_DIR, "project_state.json");
const LOCAL_OBJ_PATH = path.join(JOB_DIR, "input.obj");
const LOCAL_MTL_PATH = path.join(JOB_DIR, "input.mtl");
const CAMERA_JSON_PATH = path.join(JOB_DIR, "camera.json");
const RESULT_PNG_PATH = path.join(JOB_DIR, "result.png");
const HTML_OUT_PATH = path.join(JOB_DIR, "360_viewer.html");
const LOCAL_BUNDLE_PATH = "./IFCRenderBundle.zip";

const CLOUD_OBJ_KEY = `${JOB_ID}_input.obj`;
const CLOUD_MTL_KEY = `${JOB_ID}_input.mtl`;
const CLOUD_CAM_KEY = `${JOB_ID}_camera.json`;
const CLOUD_OUT_KEY = `${JOB_ID}_result.png`;
const CLOUD_DIAG_KEY = `${JOB_ID}_diag.txt`;

const VALID_ANGLES = [
    "top-front-right", "top-front-left", "front", "rear",
    "left", "right", "birds-eye", "top-down", "eye-level", "isometric", "360"
];
if (!VALID_ANGLES.includes(CAMERA_ANGLE)) {
    console.error(`Invalid angle: ${CAMERA_ANGLE}`);
    process.exit(1);
}

async function uploadFileToOSS(token, bucketKey, objectKey, filePath) {
    const getUrl = `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${objectKey}/signeds3upload`;
    const getRes = await axios.get(getUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const { uploadKey, urls } = getRes.data;
    await axios.put(urls[0], fs.readFileSync(filePath), { headers: { 'Content-Type': 'application/octet-stream' } });
    await axios.post(getUrl, { uploadKey }, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
}

function generate360ViewerFromGLB(jobDir) {
    const outputGlbPath = path.join(jobDir, 'output.glb');
    if (!fs.existsSync(outputGlbPath)) {
        throw new Error(`generate360ViewerFromGLB: output.glb not found at ${outputGlbPath}`);
    }

    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'render-config.json'), 'utf-8'));
    const c = (arr) => `0x${arr.map(v => v.toString(16).padStart(2, '0')).join('')}`;
    const cf = (arr) => arr.map(v => (v / 255).toFixed(3));

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>360 IFC Viewer</title>
<style>
  body { margin: 0; overflow: hidden; background: #1a1a1a; }
  canvas { display: block; }
  #info {
    position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
    color: #fff; font-family: sans-serif; font-size: 14px;
    background: rgba(0,0,0,0.6); padding: 8px 20px; border-radius: 6px;
    pointer-events: none;
  }
  #loading {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    color: #fff; font-family: sans-serif; font-size: 16px;
    background: rgba(0,0,0,0.7); padding: 14px 28px; border-radius: 6px;
  }
  #controls {
    position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: center;
  }
  button {
    padding: 8px 18px; border: none; border-radius: 4px;
    background: #4a9eff; color: #fff; cursor: pointer; font-size: 13px;
  }
  button:hover { background: #3a8eef; }
  .nav-btn { background: #ff7300; font-weight: bold; }
  .nav-btn:hover { background: #e06500; }
  #room-panel {
    position: absolute; top: 88px; left: 16px; width: 210px; max-height: 62vh;
    background: rgba(20,24,28,0.78); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; color: #fff;
    font-family: sans-serif; font-size: 13px; overflow: hidden; display: none;
    box-shadow: 0 8px 28px rgba(0,0,0,.25);
  }
  #room-panel.collapsed #room-list { display: none; }
  #room-panel-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 12px; font-weight: bold; cursor: pointer; background: rgba(255,255,255,0.08);
  }
  #room-panel-toggle { background: transparent; border: none; color: #fff; font-size: 16px; cursor: pointer; padding: 0 4px; }
  #room-list { list-style: none; margin: 0; padding: 6px; max-height: 60vh; overflow-y: auto; }
  .room-item { padding: 9px 10px; border-radius: 6px; cursor: pointer; margin-bottom: 3px; display:flex; align-items:center; gap:8px; }
  .room-item:before { content:''; width:7px; height:7px; border:1px solid rgba(255,255,255,.8); border-radius:50%; flex:0 0 auto; }
  .room-item:hover { background: rgba(255,255,255,0.10); }
  .room-item.active { background: rgba(255,115,0,.24); font-weight: bold; }
  .room-item.active:before { background:#ff7300; border-color:#ff7300; }
  #walk-status { padding: 9px 12px; font-size:12px; color:rgba(255,255,255,.72); border-top:1px solid rgba(255,255,255,.08); }
  #walk-tip { padding: 8px 12px; font-size:11px; color:rgba(255,255,255,.55); }
  #room-panel-header span { letter-spacing:.02em; }
</style>
</head>
<body>
<div id="info">3D View</div>
<div id="walk-hud" style="display:none;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;color:#fff;font:600 13px/1.4 sans-serif;text-shadow:0 1px 4px #000;text-align:center;">
  <div style="width:7px;height:7px;border:1px solid rgba(255,255,255,.9);border-radius:50%;margin:0 auto 10px;background:rgba(255,255,255,.25);"></div>
  <div>W A S D · Shift run · Q/E height · Esc exit</div>
</div>
<div id="loading">Loading model&hellip;</div>
<div id="controls">
  <button onclick="resetView()">Reset View</button>
  <button onclick="toggleAutoRotate()">Auto-Rotate</button>
  <button onclick="setView('top')">Top</button>
  <button onclick="setView('front')">Front</button>
  <button onclick="setView('side')">Side</button>
  <button onclick="setView('perspective')">Perspective</button>
  <button onclick="toggleFullscreen()">Fullscreen</button>
  <button onclick="toggleWalkMode()" class="nav-btn" id="walk-btn">Walk</button>
  <button onclick="startNavigation()" class="nav-btn" id="tour-btn" style="display:none;">Start Tour</button>
</div>

<div id="room-panel">
  <div id="room-panel-header">
    <span>Rooms / Areas</span>
    <button id="room-panel-toggle" title="Toggle room panel (R)">&minus;</button>
  </div>
  <ul id="room-list"></ul>
  <div id="walk-status">Walk mode ready</div>
  <div id="walk-tip">Click a room to travel there. In Walk mode, center your crosshair on a room pointer and click.</div>
</div>

<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/"
  }
}
</script>

<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const RECAST_VERSION = '0.43.1';
let recastModulePromise = null;
async function loadRecastRuntime() {
    if (!recastModulePromise) {
        recastModulePromise = import('https://cdn.jsdelivr.net/npm/recast-navigation@' + RECAST_VERSION + '/+esm')
            .then(function(core) {
                return { core };
            });
    }
    return recastModulePromise;
}


const scene = new THREE.Scene();
scene.background = new THREE.Color(${c(cfg.background.color)});

const camera = new THREE.PerspectiveCamera(${cfg.camera.fov}, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.autoRotate = false;
controls.autoRotateSpeed = 2.0;

scene.add(new THREE.HemisphereLight(
    new THREE.Color(${cf(cfg.lighting.ambient.skyColor).join(',')}),
    new THREE.Color(${cf(cfg.lighting.ambient.groundColor).join(',')}),
    ${cfg.lighting.ambient.intensity}
));

const keyLight = new THREE.DirectionalLight(
    new THREE.Color(${cf(cfg.lighting.keyLight.color).join(',')}),
    ${cfg.lighting.keyLight.intensity}
);
keyLight.position.set(${cfg.lighting.keyLight.position.join(',')}).normalize().multiplyScalar(50);
keyLight.castShadow = ${cfg.lighting.keyLight.castShadows};
keyLight.shadow.mapSize.set(${cfg.lighting.keyLight.shadowMapSize}, ${cfg.lighting.keyLight.shadowMapSize});
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(
    new THREE.Color(${cf(cfg.lighting.fillLight.color).join(',')}),
    ${cfg.lighting.fillLight.intensity}
);
fillLight.position.set(${cfg.lighting.fillLight.position.join(',')}).normalize().multiplyScalar(40);
scene.add(fillLight);

const backLight = new THREE.DirectionalLight(
    new THREE.Color(${cf(cfg.lighting.backLight.color).join(',')}),
    ${cfg.lighting.backLight.intensity}
);
backLight.position.set(${cfg.lighting.backLight.position.join(',')}).normalize().multiplyScalar(30);
scene.add(backLight);

${cfg.ground.enabled ? `const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ opacity: ${cfg.ground.shadowOpacity} })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);` : 'const ground = { position: { y: 0 } };'}

${cfg.ground.gridEnabled ? `const grid = new THREE.GridHelper(100, 40, 0xcccccc, 0xe0e0e0);
scene.add(grid);` : 'const grid = { position: { y: 0 } };'}

let modelSize = 1;
let roomList = [];
let walkAreas = [];

class NavigationGraph {
    constructor() { this.nodes = []; }
    getNode(id) { return this.nodes.find(n => n.id === id); }
}

class HotspotManager {
    constructor(scene, camera, onClickCallback) {
        this.scene = scene;
        this.camera = camera;
        this.onClickCallback = onClickCallback;
        this.hotspots = [];
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.arrowTexture = this._buildArrowTexture();
        this.pathTexture = this._buildPathTexture();

        window.addEventListener('click', this._onClick.bind(this));
        window.addEventListener('mousemove', this._onMouseMove.bind(this));
    }

    _buildArrowTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const cx = 128, cy = 128;

        const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, 112);
        glow.addColorStop(0, 'rgba(255, 150, 20, 0.55)');
        glow.addColorStop(0.6, 'rgba(255, 115, 0, 0.20)');
        glow.addColorStop(1, 'rgba(255, 115, 0, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(cx, cy, 112, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth = 22;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - 46, cy + 32);
        ctx.lineTo(cx, cy - 36);
        ctx.lineTo(cx + 46, cy + 32);
        ctx.stroke();

        return new THREE.CanvasTexture(canvas);
    }

    _buildPathTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 256;
        const ctx = canvas.getContext('2d');

        const grad = ctx.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, 'rgba(255,150,20,0)');
        grad.addColorStop(0.2, 'rgba(255,150,20,0.18)');
        grad.addColorStop(0.6, 'rgba(255,165,50,0.5)');
        grad.addColorStop(1, 'rgba(255,200,110,0.85)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 64, 256);

        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        for (let y = 10; y < 256; y += 40) {
            ctx.fillRect(10, y, 44, 16);
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        return tex;
    }

    createHotspots(currentNode, graph, floorY, hotspotSize, originPos) {
        this.clearHotspots();
        if (!currentNode || !currentNode.links) return Promise.resolve();

        const start = originPos ? originPos.clone() : new THREE.Vector3().fromArray(currentNode.position);
        start.y = floorY;

        currentNode.links.forEach(linkId => {
            const targetNode = graph.getNode(linkId);
            if (!targetNode) return;

            const end = new THREE.Vector3().fromArray(targetNode.position);
            end.y = floorY;

            const dir = new THREE.Vector3().subVectors(end, start);
            const totalDist = dir.length();
            if (totalDist < 0.01) return;
            dir.normalize();

            const placementDist = Math.min(totalDist * 0.35, hotspotSize * 2.2);
            const group = new THREE.Group();
            group.position.copy(start).add(dir.clone().multiplyScalar(placementDist));
            group.position.y = floorY + hotspotSize * 0.6;

            const material = new THREE.MeshBasicMaterial({
                map: this.arrowTexture, transparent: true, depthWrite: false,
                side: THREE.DoubleSide, opacity: 0
            });
            const size = hotspotSize * 0.9;
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
            mesh.userData = { targetId: linkId };
            group.add(mesh);

            this.scene.add(group);

            const pathLength = Math.max(placementDist - hotspotSize * 0.3, hotspotSize * 0.6);
            const pathWidth = hotspotSize * 0.32;
            const pathGeometry = new THREE.PlaneGeometry(pathWidth, pathLength);
            pathGeometry.rotateX(-Math.PI / 2);

            const pathMap = this.pathTexture.clone();
            pathMap.needsUpdate = true;
            pathMap.wrapS = THREE.RepeatWrapping;
            pathMap.wrapT = THREE.RepeatWrapping;
            pathMap.repeat.set(1, Math.max(pathLength / (hotspotSize * 0.8), 1));

            const pathMaterial = new THREE.MeshBasicMaterial({
                map: pathMap, transparent: true, depthWrite: false,
                side: THREE.DoubleSide, opacity: 0, blending: THREE.AdditiveBlending
            });

            const pathMesh = new THREE.Mesh(pathGeometry, pathMaterial);
            pathMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
            pathMesh.position.copy(start).add(dir.clone().multiplyScalar(pathLength / 2));
            pathMesh.position.y = floorY + 0.015;
            pathMesh.renderOrder = 1;
            this.scene.add(pathMesh);

            this.hotspots.push({
                group, mesh, material, targetId: linkId,
                pathMesh, pathMaterial,
                hovered: false, hoverT: 0, fadeOpacity: 0
            });
        });

        return this.fadeIn();
    }

    update(time) {
        this.hotspots.forEach(arrow => {
            arrow.mesh.quaternion.copy(this.camera.quaternion);

            const pulse = 1 + Math.sin(time * 0.003 + arrow.group.position.x * 3.1) * 0.06;

            const hoverTarget = arrow.hovered ? 1 : 0;
            arrow.hoverT += (hoverTarget - arrow.hoverT) * 0.15;
            const hoverScale = 1 + arrow.hoverT * 0.25;

            arrow.mesh.scale.setScalar(pulse * hoverScale);
            arrow.material.opacity = arrow.fadeOpacity;

            const brightness = 0.85 + arrow.hoverT * 0.25;
            arrow.material.color.setScalar(brightness);

            if (arrow.pathMaterial) {
                arrow.pathMaterial.opacity = arrow.fadeOpacity * 0.85;
                const flowSpeed = 0.0016 + arrow.hoverT * 0.0025;
                arrow.pathMaterial.map.offset.y = (arrow.pathMaterial.map.offset.y + flowSpeed) % 1;
                arrow.pathMaterial.color.setScalar(0.8 + arrow.hoverT * 0.35);
            }
        });
    }

    _onMouseMove(event) {
        if (this.hotspots.length === 0) return;
        this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const meshes = this.hotspots.map(a => a.mesh);
        const intersects = this.raycaster.intersectObjects(meshes);
        const hoveredMesh = intersects.length > 0 ? intersects[0].object : null;
        this.hotspots.forEach(a => { a.hovered = (a.mesh === hoveredMesh); });
        document.body.style.cursor = hoveredMesh ? 'pointer' : 'default';
    }

    _onClick(event) {
        if (event.button !== 0 || this.hotspots.length === 0) return;
        this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const meshes = this.hotspots.map(a => a.mesh);
        const intersects = this.raycaster.intersectObjects(meshes);
        if (intersects.length > 0) this.onClickCallback(intersects[0].object.userData.targetId);
    }

    fadeIn(duration = 300) {
        return this._fade(1, duration);
    }

    fadeOut(duration = 220) {
        return this._fade(0, duration);
    }

    _fade(targetOpacity, duration) {
        if (this.hotspots.length === 0) return Promise.resolve();
        const startOpacities = this.hotspots.map(a => a.fadeOpacity);
        const startTime = performance.now();

        return new Promise(resolve => {
            const step = (time) => {
                const elapsed = time - startTime;
                let t = elapsed / duration;
                if (t > 1) t = 1;
                this.hotspots.forEach((arrow, i) => {
                    arrow.fadeOpacity = startOpacities[i] + (targetOpacity - startOpacities[i]) * t;
                });
                if (t < 1) requestAnimationFrame(step);
                else resolve();
            };
            requestAnimationFrame(step);
        });
    }

    clearHotspots() {
        this.hotspots.forEach(a => {
            if (a.group.parent) this.scene.remove(a.group);
            if (a.mesh.geometry) a.mesh.geometry.dispose();
            if (a.material) a.material.dispose();
            if (a.pathMesh) {
                if (a.pathMesh.parent) this.scene.remove(a.pathMesh);
                a.pathMesh.geometry.dispose();
                if (a.pathMaterial.map) a.pathMaterial.map.dispose();
                a.pathMaterial.dispose();
            }
        });
        this.hotspots = [];
        document.body.style.cursor = 'default';
    }
}

class CameraAnimator {
    constructor(camera, controls) {
        this.camera = camera;
        this.controls = controls;
        this.animating = false;
    }

    animateTo(targetPosArr, lookAtArr, duration = 800) {
        return new Promise(resolve => {
            this.animating = true;
            this.controls.enabled = false;

            const startPos = this.camera.position.clone();
            const endPos = new THREE.Vector3().fromArray(targetPosArr);
            const endLookAt = new THREE.Vector3().fromArray(lookAtArr);

            const startQuat = this.camera.quaternion.clone();
            const lookMatrix = new THREE.Matrix4().lookAt(endPos, endLookAt, this.camera.up);
            const endQuat = new THREE.Quaternion().setFromRotationMatrix(lookMatrix);

            const startTime = performance.now();

            const animate = (time) => {
                const elapsed = time - startTime;
                let t = elapsed / duration;
                if (t > 1) t = 1;
                
                const easeT = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

                this.camera.position.lerpVectors(startPos, endPos, easeT);
                this.camera.quaternion.slerpQuaternions(startQuat, endQuat, easeT);

                const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
                this.controls.target.copy(this.camera.position).add(forward);
                this.controls.update();

                if (t < 1.0) requestAnimationFrame(animate);
                else { this.controls.enabled = true; this.animating = false; resolve(); }
            };
            requestAnimationFrame(animate);
        });
    }
}

class NavigationManager {
    constructor(scene, camera, controls) {
        this.graph = new NavigationGraph();
        this.animator = new CameraAnimator(camera, controls);
        this.hotspotManager = new HotspotManager(scene, camera, this.navigateTo.bind(this));
        this.currentNode = null;
        this.currentPosition = null;
        this.model = null;
        this.floorY = 0;
        this.hotspotSize = 1;
        this.onNodeChange = null;
        
        window.addEventListener('keydown', (e) => {
            if (!this.currentNode || this.animator.animating) return;
            const links = this.currentNode.links;
            if (!links || links.length === 0) return;

            const camDir = new THREE.Vector3();
            camera.getWorldDirection(camDir);
            camDir.y = 0; camDir.normalize();

            const targetDir = new THREE.Vector3();

            if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'w') {
                targetDir.copy(camDir);
            } else if (e.key === 'ArrowDown' || e.key.toLowerCase() === 's') {
                targetDir.copy(camDir).negate();
            } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') {
                targetDir.set(camDir.z, 0, -camDir.x);
            } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') {
                targetDir.set(-camDir.z, 0, camDir.x);
            } else {
                return;
            }

            let bestNode = null;
            let bestScore = -Infinity;
            const currentPos = new THREE.Vector3().fromArray(this.currentNode.position);

            links.forEach(linkId => {
                const node = this.graph.getNode(linkId);
                const dirToNode = new THREE.Vector3().fromArray(node.position).sub(currentPos);
                dirToNode.y = 0; dirToNode.normalize();

                const score = dirToNode.dot(targetDir);
                if (score > 0.5 && score > bestScore) {
                    bestScore = score;
                    bestNode = linkId;
                }
            });

            if (bestNode) this.navigateTo(bestNode);
        });
    }

    setModel(model) {
        this.model = model;
    }

    _resolveFloorY(x, z) {
        if (!this.model) return this.floorY;
        if (!this._downRay) this._downRay = new THREE.Raycaster();
        this._downRay.set(new THREE.Vector3(x, this.floorY + 3, z), new THREE.Vector3(0, -1, 0));
        this._downRay.far = 5;
        const hits = this._downRay.intersectObject(this.model, true);
        if (!hits.length) return this.floorY;
        return hits.reduce((min, h) => Math.min(min, h.point.y), hits[0].point.y);
    }

    _comfortPosition(node) {
        if (!this.model) return node.position.slice();

        const eyeHeight = node.position[1] - this.floorY;
        const clipTolerance = 0.35;
        const rawFloor = this._resolveFloorY(node.position[0], node.position[2]);
        if (rawFloor <= this.floorY + clipTolerance) return node.position.slice();

        const neighborIds = node.links || [];
        const avg = new THREE.Vector3();
        let count = 0;
        neighborIds.forEach(id => {
            const n = this.graph.getNode(id);
            if (!n) return;
            avg.add(new THREE.Vector3().fromArray(n.position));
            count++;
        });
        if (count === 0) return node.position.slice();
        avg.divideScalar(count);

        const nodePos = new THREE.Vector3().fromArray(node.position);
        const toOpen = new THREE.Vector3().subVectors(avg, nodePos);
        toOpen.y = 0;
        if (toOpen.lengthSq() < 0.0001) return node.position.slice();
        toOpen.normalize().multiplyScalar(0.4);

        const candidate = nodePos.clone().add(toOpen);
        const candidateFloor = this._resolveFloorY(candidate.x, candidate.z);
        if (candidateFloor <= this.floorY + clipTolerance) {
            candidate.y = this.floorY + eyeHeight;
            return candidate.toArray();
        }
        return node.position.slice();
    }

    _avoidWallGaze(fromPos, facing) {
        if (!this.model) return facing;
        if (!this._fwdRay) this._fwdRay = new THREE.Raycaster();

        const eye = fromPos.clone();
        eye.y += 0.02;

        const testDir = (dir) => {
            this._fwdRay.set(eye, dir);
            this._fwdRay.far = 0.6;
            const hits = this._fwdRay.intersectObject(this.model, true);
            return hits.length ? hits[0].distance : Infinity;
        };

        const wallThreshold = 0.5;
        const forwardDist = testDir(facing);
        if (forwardDist >= wallThreshold) return facing;

        const left = new THREE.Vector3(facing.z, 0, -facing.x).normalize();
        const right = left.clone().negate();
        const leftDist = testDir(left);
        const rightDist = testDir(right);
        const side = leftDist >= rightDist ? left : right;

        const openness = 1 - Math.min(forwardDist / wallThreshold, 1);
        return facing.clone().lerp(side, 0.6 * openness).normalize();
    }

    _preservedOrientation(cam, fromPos, toPos) {
        const moveDir = new THREE.Vector3().subVectors(toPos, fromPos);
        moveDir.y = 0;

        const currentForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        currentForward.y = 0; currentForward.normalize();

        if (moveDir.lengthSq() < 0.0001) return this._avoidWallGaze(toPos, currentForward);
        moveDir.normalize();

        let facing = currentForward.clone();
        if (currentForward.dot(moveDir) < -0.3) {
            facing.lerp(moveDir, 0.5).normalize();
        }

        return this._avoidWallGaze(toPos, facing);
    }

    startAt(nodeId) {
        const node = this.graph.getNode(nodeId);
        if (!node) return;
        this.currentNode = node;
        if (this.onNodeChange) this.onNodeChange(this.currentNode.id);

        controls.enablePan = false;
        controls.enableZoom = false;
        controls.minDistance = 0.001;
        controls.maxDistance = 0.001;

        const comfortPos = this._comfortPosition(node);
        const offset = new THREE.Vector3().fromArray(comfortPos).sub(new THREE.Vector3().fromArray(node.position));
        const pos = new THREE.Vector3().fromArray(comfortPos);
        const look = new THREE.Vector3().fromArray(node.lookAt).add(offset);
        const dir = new THREE.Vector3().subVectors(look, pos).normalize().multiplyScalar(0.001);

        camera.position.copy(pos);
        controls.target.copy(pos).add(dir);
        controls.update();

        this.currentPosition = comfortPos;
        this.hotspotManager.createHotspots(this.currentNode, this.graph, this.floorY, this.hotspotSize, pos);
    }

    async navigateTo(nodeId) {
        if (this.animator.animating) return;
        const node = this.graph.getNode(nodeId);
        if (!node) return;
        this.hotspotManager.clearHotspots();

        const curPos = new THREE.Vector3().fromArray(this.currentPosition || this.currentNode.position);
        const comfortPos = this._comfortPosition(node);
        const nextPos = new THREE.Vector3().fromArray(comfortPos);

        const facing = this._preservedOrientation(camera, curPos, nextPos);
        const lookAtTarget = nextPos.clone().add(facing);

        await this.animator.animateTo(comfortPos, lookAtTarget.toArray(), 420);
        this.currentNode = node;
        this.currentPosition = comfortPos;
        if (this.onNodeChange) this.onNodeChange(this.currentNode.id);
        this.hotspotManager.createHotspots(this.currentNode, this.graph, this.floorY, this.hotspotSize, nextPos);
    }

    async jumpTo(nodeId) {
        const node = this.graph.getNode(nodeId);
        if (!node) return;
        if (this.animator.animating) return;

        if (!this.currentNode) {
            this.startAt(nodeId);
            return;
        }

        this.hotspotManager.clearHotspots();
        const lookAtTarget = node.lookAt || node.position;
        await this.animator.animateTo(node.position, lookAtTarget, 900);
        this.currentNode = node;
        this.currentPosition = node.position.slice();
        if (this.onNodeChange) this.onNodeChange(this.currentNode.id);
        this.hotspotManager.createHotspots(this.currentNode, this.graph, this.floorY, this.hotspotSize, new THREE.Vector3().fromArray(node.position));
    }
}

const navManager = new NavigationManager(scene, camera, controls);

class ContinuousWalkController {
    constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.model = null;
        this.active = false;
        this.ready = false;
        this.navMesh = null;
        this.query = null;
        this.filter = null;
        this.nodeRef = 0;
        this.position = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.yaw = 0;
        this.pitch = 0;
        this.physicalMetersPerUnit = 1;
        this.eyeHeightMeters = 1.6;
        this.radiusMeters = 0.15;
        this.walkSpeedMeters = 1.8;
        this.runSpeedMeters = 4.5;
        this.walkSpeed = 1.8;
        this.runSpeed = 4.5;
        this.acceleration = 7.0;
        this.deceleration = 10.0;
        this.heightOffset = 0;
        this.heightSpeedMeters = 0.35;
        this.minHeightOffsetMeters = -0.15;
        this.maxHeightOffsetMeters = 0.35;
        this.keys = new Set();
        this.pointerLocked = false;
        this._lastTime = performance.now();
        this._savedCamera = null;
        this._savedControls = null;
        this._travelPath = null;
        this._travelIndex = 0;
        this._touring = false;
        this._boundMouseMove = this._onMouseMove.bind(this);
        this._boundPointerLock = this._onPointerLockChange.bind(this);
        this._boundKeyDown = this._onKeyDown.bind(this);
        this._boundKeyUp = this._onKeyUp.bind(this);
        document.addEventListener('pointerlockchange', this._boundPointerLock);
        window.addEventListener('mousemove', this._boundMouseMove);
        window.addEventListener('keydown', this._boundKeyDown);
        window.addEventListener('keyup', this._boundKeyUp);
    }

    _setMetrics(metadata) {
        this.physicalMetersPerUnit = Number(metadata?.physicalMetersPerUnit) > 0 ? Number(metadata.physicalMetersPerUnit) : 1;
        this.eyeHeightMeters = Number(metadata?.eyeHeightMeters) > 0 ? Number(metadata.eyeHeightMeters) : 1.6;
        this.radiusMeters = Number(metadata?.agentRadiusMeters) > 0 ? Number(metadata.agentRadiusMeters) : 0.15;
        this.walkSpeed = this.walkSpeedMeters * this.physicalMetersPerUnit;
        this.runSpeed = this.runSpeedMeters * this.physicalMetersPerUnit;
        this.acceleration = 7.0 * this.physicalMetersPerUnit;
        this.deceleration = 10.0 * this.physicalMetersPerUnit;
    }

    _candidateSpawn(surfacePayload) {
        const positions = surfacePayload.positions || [];
        const indices = surfacePayload.indices || [];
        if (!positions.length || !indices.length) return null;

        const ray = new THREE.Raycaster();
        const directions = [
            new THREE.Vector3(1,0,0), new THREE.Vector3(-1,0,0),
            new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,-1),
            new THREE.Vector3(1,0,1).normalize(), new THREE.Vector3(-1,0,1).normalize(),
            new THREE.Vector3(1,0,-1).normalize(), new THREE.Vector3(-1,0,-1).normalize()
        ];
        const maxRay = 2.5 * this.physicalMetersPerUnit;
        const candidates = [];
        const step = Math.max(1, Math.floor((indices.length / 3) / 180));

        for (let t = 0; t < indices.length / 3; t += step) {
            const ia = indices[t * 3] * 3;
            const ib = indices[t * 3 + 1] * 3;
            const ic = indices[t * 3 + 2] * 3;
            const p = new THREE.Vector3(
                (positions[ia] + positions[ib] + positions[ic]) / 3,
                (positions[ia + 1] + positions[ib + 1] + positions[ic + 1]) / 3,
                (positions[ia + 2] + positions[ib + 2] + positions[ic + 2]) / 3
            );
            const eyeY = p.y + this.eyeHeightMeters * this.physicalMetersPerUnit * 0.55;
            let minClearance = maxRay;
            for (const dir of directions) {
                ray.set(new THREE.Vector3(p.x, eyeY, p.z), dir);
                ray.far = maxRay;
                const hits = this.model ? ray.intersectObject(this.model, true) : [];
                if (hits.length) minClearance = Math.min(minClearance, hits[0].distance);
            }
            candidates.push({ point: p, clearance: minClearance });
        }

        candidates.sort((a,b) => b.clearance - a.clearance);
        return candidates.length ? candidates[0].point : null;
    }

    async init(navMeshBytes, surfacePayload, model) {
        const runtime = await loadRecastRuntime();
        await runtime.core.init();
        this.model = model;
        this._setMetrics(surfacePayload?.metadata || {});

        const imported = runtime.core.importNavMesh(new Uint8Array(navMeshBytes));
        if (!imported || !imported.navMesh) throw new Error('Browser could not import serialized Recast NavMesh.');

        this.navMesh = imported.navMesh;
        this.query = new runtime.core.NavMeshQuery(this.navMesh);
        this.filter = new runtime.core.QueryFilter();

        const seed = this._candidateSpawn(surfacePayload) || new THREE.Vector3(
            Number(surfacePayload.metadata?.spawnX ?? 0),
            Number(surfacePayload.metadata?.spawnY ?? 0),
            Number(surfacePayload.metadata?.spawnZ ?? 0)
        );
        const start = this.query.findClosestPoint({ x: seed.x, y: seed.y, z: seed.z }, {
            halfExtents: {
                x: 4 * this.physicalMetersPerUnit,
                y: 2 * this.physicalMetersPerUnit,
                z: 4 * this.physicalMetersPerUnit
            },
            filter: this.filter
        });
        if (!start.success) throw new Error('Browser Recast could not find a walkable start position.');

        this.position.set(start.point.x, start.point.y, start.point.z);
        this.nodeRef = start.polyRef;
        this.ready = true;
        this._syncCamera();
    }

    async enter(navMeshBytes, surfacePayload, model) {
        if (!this.ready) await this.init(navMeshBytes, surfacePayload, model);
        if (!this.ready) return false;

        this._savedCamera = {
            position: this.camera.position.clone(),
            quaternion: this.camera.quaternion.clone(),
            target: controls.target.clone()
        };
        this._savedControls = {
            enablePan: controls.enablePan,
            enableZoom: controls.enableZoom,
            autoRotate: controls.autoRotate
        };

        controls.enabled = false;
        controls.autoRotate = false;
        if (navManager.hotspotManager) navManager.hotspotManager.clearHotspots();
        if (ground && ground.material) ground.visible = false;
        if (grid) grid.visible = false;

        this.active = true;
        this.velocity.set(0, 0, 0);
        this._travelPath = null;
        this._travelIndex = 0;
        this._touring = false;
        this.heightOffset = 0;
        this._captureOrientationFromCamera();
        document.getElementById('walk-hud').style.display = 'block';
        document.getElementById('walk-btn').textContent = 'Exit Walk';
        const statusEl = document.getElementById('walk-status'); if (statusEl) statusEl.textContent = 'Walk mode active';
        document.getElementById('info').textContent = 'Walk Mode — click to capture mouse · WASD move · Shift run · Q/E camera height · Esc exit';
        this.domElement.requestPointerLock();
        this._lastTime = performance.now();
        return true;
    }

    exit() {
        this.active = false;
        this.keys.clear();
        this.velocity.set(0, 0, 0);
        this._travelPath = null;
        this._touring = false;
        document.getElementById('walk-hud').style.display = 'none';
        document.getElementById('walk-btn').textContent = 'Walk';
        const statusEl = document.getElementById('walk-status'); if (statusEl) statusEl.textContent = 'Walk mode ready';
        if (document.pointerLockElement === this.domElement) document.exitPointerLock();

        if (this._savedControls) {
            controls.enabled = true;
            controls.enablePan = this._savedControls.enablePan;
            controls.enableZoom = this._savedControls.enableZoom;
            controls.autoRotate = this._savedControls.autoRotate;
        } else {
            controls.enabled = true;
        }
        if (ground) ground.visible = false;
        if (grid) grid.visible = false;

        if (this._savedCamera) {
            this.camera.position.copy(this._savedCamera.position);
            this.camera.quaternion.copy(this._savedCamera.quaternion);
            controls.target.copy(this._savedCamera.target);
            controls.update();
        }
    }

    _captureOrientationFromCamera() {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        forward.y = THREE.MathUtils.clamp(forward.y, -0.999, 0.999);
        this.yaw = Math.atan2(-forward.x, -forward.z);
        this.pitch = Math.asin(forward.y);
    }

    _syncCamera() {
        const h = this.eyeHeightMeters * this.physicalMetersPerUnit;
        const offset = this.heightOffset * this.physicalMetersPerUnit;
        this.camera.position.set(this.position.x, this.position.y + h + offset, this.position.z);
        const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), this.pitch);
        const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), this.yaw);
        this.camera.quaternion.copy(yawQuat).multiply(pitchQuat);
        const running = this.keys.has('shift');
        const targetFov = running ? 76 : 70;
        this.camera.fov += (targetFov - this.camera.fov) * 0.08;
        this.camera.updateProjectionMatrix();
    }

    _onPointerLockChange() {
        this.pointerLocked = document.pointerLockElement === this.domElement;
        if (this.active && !this.pointerLocked && !this._touring) this.exit();
    }

    _onMouseMove(event) {
        if (!this.active || !this.pointerLocked || this._touring) return;
        const sensitivity = 0.0022;
        this.yaw -= event.movementX * sensitivity;
        this.pitch -= event.movementY * sensitivity;
        const limit = Math.PI * 0.49;
        this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    }

    _onKeyDown(event) {
        if (event.key === 'Escape' && this.active) {
            event.preventDefault();
            this.exit();
            return;
        }
        if (!this.active) return;
        const key = event.key.toLowerCase();
        if (['w','a','s','d','shift','q','e'].includes(key)) {
            event.preventDefault();
            this.keys.add(key);
        }
    }

    _onKeyUp(event) {
        if (!this.active) return;
        this.keys.delete(event.key.toLowerCase());
    }

    _moveToTarget(target) {
        const desired = this.position.clone().add(target.clone().sub(this.position));
        const result = this.query.moveAlongSurface(
            this.nodeRef,
            { x: this.position.x, y: this.position.y, z: this.position.z },
            { x: desired.x, y: desired.y, z: desired.z },
            { filter: this.filter, maxVisitedSize: 64 }
        );
        if (result.success) {
            this.position.set(result.resultPosition.x, result.resultPosition.y, result.resultPosition.z);
            if (result.visited && result.visited.length) this.nodeRef = result.visited[result.visited.length - 1];
            return true;
        }
        return false;
    }

    async travelTo(targetWorld) {
        if (!this.active || !this.ready || !this.query) return false;
        const target = this.query.findClosestPoint(
            { x: targetWorld[0], y: targetWorld[1], z: targetWorld[2] },
            { halfExtents: {
                x: 3 * this.physicalMetersPerUnit,
                y: 2 * this.physicalMetersPerUnit,
                z: 3 * this.physicalMetersPerUnit
            }, filter: this.filter }
        );
        if (!target.success) return false;

        const pathResult = this.query.computePath(
            { x: this.position.x, y: this.position.y, z: this.position.z },
            { x: target.point.x, y: target.point.y, z: target.point.z },
            { filter: this.filter, maxStraightPathSize: 256, maxPathSize: 256 }
        );
        if (!pathResult.success || !pathResult.path || pathResult.path.length === 0) return false;

        this._travelPath = pathResult.path.map(p => ({ x: p.x, y: p.y, z: p.z }));
        this._travelIndex = 0;
        this._touring = true;
        this.keys.clear();
        if (document.pointerLockElement === this.domElement) document.exitPointerLock();
        return true;
    }

    async _updateTravel(dt) {
        if (!this._travelPath || this._travelIndex >= this._travelPath.length) {
            this._travelPath = null;
            this._touring = false;
            return;
        }
        const waypoint = this._travelPath[this._travelIndex];
        const target = new THREE.Vector3(waypoint.x, waypoint.y, waypoint.z);
        const delta = target.clone().sub(this.position);
        delta.y = 0;
        const threshold = 0.06 * this.physicalMetersPerUnit;
        if (delta.length() <= threshold) {
            this._travelIndex += 1;
            if (this._travelIndex >= this._travelPath.length) {
                this._travelPath = null;
                this._touring = false;
                document.getElementById('info').textContent = 'Walk Mode — click to capture mouse · WASD move · Shift run · Q/E camera height · Esc exit';
                if (this.active && document.pointerLockElement !== this.domElement) this.domElement.requestPointerLock();
                return;
            }
        }
        const next = this._travelPath[this._travelIndex];
        const nextTarget = new THREE.Vector3(next.x, next.y, next.z);
        const direction = nextTarget.clone().sub(this.position);
        direction.y = 0;
        if (direction.lengthSq() < 1e-8) return;
        direction.normalize();

        this.yaw = Math.atan2(-direction.x, -direction.z);
        const speed = this.walkSpeed;
        const desired = this.position.clone().addScaledVector(direction, speed * dt);
        const result = this.query.moveAlongSurface(
            this.nodeRef,
            { x: this.position.x, y: this.position.y, z: this.position.z },
            { x: desired.x, y: desired.y, z: desired.z },
            { filter: this.filter, maxVisitedSize: 64 }
        );
        if (result.success) {
            this.position.set(result.resultPosition.x, result.resultPosition.y, result.resultPosition.z);
            if (result.visited && result.visited.length) this.nodeRef = result.visited[result.visited.length - 1];
        }
    }

    _updateMovement(dt) {
        if (!this.active || !this.ready || !this.query) return;
        if (this._touring) return;

        const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        const wish = new THREE.Vector3();
        if (this.keys.has('w')) wish.add(forward);
        if (this.keys.has('s')) wish.sub(forward);
        if (this.keys.has('d')) wish.add(right);
        if (this.keys.has('a')) wish.sub(right);

        const heightDeltaMeters = this.heightSpeedMeters * dt;
        if (this.keys.has('q')) this.heightOffset = Math.min(this.heightOffset + heightDeltaMeters, this.maxHeightOffsetMeters);
        if (this.keys.has('e')) this.heightOffset = Math.max(this.heightOffset - heightDeltaMeters, this.minHeightOffsetMeters);

        const moving = wish.lengthSq() > 0.000001;
        if (moving) wish.normalize();
        const speed = this.keys.has('shift') ? this.runSpeed : this.walkSpeed;
        const targetVelocity = wish.multiplyScalar(speed);
        const response = moving ? this.acceleration : this.deceleration;
        const blend = Math.min(1, response * dt);
        this.velocity.lerp(targetVelocity, blend);

        if (!moving && this.velocity.lengthSq() < 0.00001) {
            this.velocity.set(0,0,0);
            this._syncCamera();
            return;
        }

        const desired = this.position.clone().addScaledVector(this.velocity, dt);
        const result = this.query.moveAlongSurface(
            this.nodeRef,
            { x: this.position.x, y: this.position.y, z: this.position.z },
            { x: desired.x, y: desired.y, z: desired.z },
            { filter: this.filter, maxVisitedSize: 64 }
        );

        if (result.success) {
            this.position.set(result.resultPosition.x, result.resultPosition.y, result.resultPosition.z);
            if (result.visited && result.visited.length) this.nodeRef = result.visited[result.visited.length - 1];
        }

        this._syncCamera();
    }

    update(now) {
        if (!this.active) return;
        const dt = Math.min(0.05, Math.max(0.001, (now - this._lastTime) / 1000));
        this._lastTime = now;
        if (this._touring) {
            this._updateTravel(dt);
        } else {
            this._updateMovement(dt);
        }
    }

    destroy() {
        this.exit();
        if (this.query) this.query.destroy?.();
        if (this.navMesh && this.navMesh.destroy) this.navMesh.destroy();
    }
}

const walkController = new ContinuousWalkController(camera, renderer.domElement);

class WalkPortalManager {
    constructor(scene, camera, controller) {
        this.scene = scene;
        this.camera = camera;
        this.controller = controller;
        this.model = null;
        this.areas = [];
        this.portals = [];
        this.raycaster = new THREE.Raycaster();
        this.hovered = null;
        this._clickBound = this._onClick.bind(this);
        window.addEventListener('mousedown', this._clickBound);
    }

    _texture(label, accent = false) {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 110;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,320,110);
        ctx.fillStyle = accent ? 'rgba(255,115,0,.94)' : 'rgba(18,24,29,.84)';
        ctx.beginPath();
        ctx.roundRect(16,12,288,72,14);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '600 22px Arial';
        ctx.fillText(label, 52, 58);
        ctx.beginPath();
        ctx.moveTo(34,70); ctx.lineTo(46,58); ctx.lineTo(58,70);
        ctx.fill();
        return new THREE.CanvasTexture(canvas);
    }

    _makePortal(target, label, position, kind='area') {
        const material = new THREE.SpriteMaterial({
            map: this._texture(label, kind === 'door'),
            transparent: true,
            depthTest: true,
            depthWrite: false,
        });
        const sprite = new THREE.Sprite(material);
        const baseScale = new THREE.Vector3(0.9 * this.controller.physicalMetersPerUnit, 0.31 * this.controller.physicalMetersPerUnit, 1);
        sprite.scale.copy(baseScale);
        sprite.position.set(position[0], position[1], position[2]);
        sprite.userData = { target, label, kind };
        this.scene.add(sprite);
        this.portals.push({ sprite, target, label, kind, base: sprite.position.clone(), baseScale });
    }

    clear() {
        this.portals.forEach(p => {
            if (p.sprite.parent) p.sprite.parent.remove(p.sprite);
            p.sprite.material.map?.dispose();
            p.sprite.material.dispose();
        });
        this.portals = [];
    }

    setAreas(areas, model) {
        this.clear();
        this.areas = areas || [];
        this.model = model || null;
        // A light presentation layer: show destination pointers near area centres.
        this.areas.forEach(area => {
            const p = area.center.slice();
            p[1] = this.controller.position.y + this.controller.eyeHeightMeters * this.controller.physicalMetersPerUnit * 0.55;
            this._makePortal(area.center, area.label, p, 'area');
        });
        this._addDoorSidePortals();
    }

    _addDoorSidePortals() {
        if (!this.model || !this.controller.query) return;
        const doors = [];
        this.model.traverse(obj => {
            if (!obj.isMesh) return;
            const name = (obj.name || '').toLowerCase();
            if (!name.includes('door') && !name.includes('sliding')) return;
            const box = new THREE.Box3().setFromObject(obj);
            if (box.isEmpty()) return;
            const size = box.getSize(new THREE.Vector3());
            if (size.x < 0.02 && size.z < 0.02) return;
            const center = box.getCenter(new THREE.Vector3());
            const normal = size.x >= size.z ? new THREE.Vector3(0,0,1) : new THREE.Vector3(1,0,0);
            doors.push({ center, normal });
        });

        const offset = Math.max(0.55, this.controller.radiusMeters * 3) * this.controller.physicalMetersPerUnit;
        doors.slice(0, 16).forEach((door, i) => {
            [-1, 1].forEach(side => {
                const sample = door.center.clone().addScaledVector(door.normal, side * offset);
                const closest = this.controller.query.findClosestPoint(
                    {x:sample.x,y:sample.y,z:sample.z},
                    {halfExtents:{x:1.5*this.controller.physicalMetersPerUnit,y:2*this.controller.physicalMetersPerUnit,z:1.5*this.controller.physicalMetersPerUnit},filter:this.controller.filter}
                );
                if (!closest.success) return;
                const target = [closest.point.x, closest.point.y, closest.point.z];
                const label = this._nearestAreaLabel(target) || ('Room ' + (i + 1));
                const p = [closest.point.x, closest.point.y + this.controller.eyeHeightMeters * this.controller.physicalMetersPerUnit * 0.55, closest.point.z];
                this._makePortal(target, label, p, 'door');
            });
        });
    }

    _nearestAreaLabel(target) {
        let best = Infinity, label = null;
        this.areas.forEach(a => {
            const dx = a.center[0]-target[0], dz=a.center[2]-target[2];
            const d = dx*dx+dz*dz;
            if (d < best) { best = d; label = a.label; }
        });
        return label;
    }

    update() {
        if (!this.controller.active) {
            this.portals.forEach(p => p.sprite.visible = false);
            return;
        }
        const camForward = new THREE.Vector3(0,0,-1).applyQuaternion(this.camera.quaternion).normalize();
        let best = null, bestScore = -Infinity;
        this.portals.forEach(p => {
            const world = p.sprite.position;
            const delta = world.clone().sub(this.camera.position);
            const dist = delta.length();
            if (dist > 12 * this.controller.physicalMetersPerUnit) { p.sprite.visible = false; return; }
            delta.normalize();
            const dot = camForward.dot(delta);
            p.sprite.visible = dot > 0.02 || dist < 1.5 * this.controller.physicalMetersPerUnit;
            if (!p.sprite.visible) return;
            p.sprite.quaternion.copy(this.camera.quaternion);
            const pulse = 1 + Math.sin(performance.now()*0.003 + p.base.x)*0.035;
            p.sprite.scale.copy(p.baseScale).multiplyScalar(pulse);
            if (dot > bestScore) { bestScore = dot; best = p; }
        });
        this.hovered = best && bestScore > 0.55 ? best : null;
    }

    _onClick() {
        if (!this.controller.active || !this.controller.pointerLocked || !this.hovered) return;
        this.controller.travelTo(this.hovered.target);
    }

    destroy() {
        window.removeEventListener('mousedown', this._clickBound);
        this.clear();
    }
}

const walkPortalManager = new WalkPortalManager(scene, camera, walkController);

const ROOM_SPLIT_GAP_THRESHOLD = 1.2;
const ROOM_MIN_CLUSTER_SIZE = 3;

function splitClusterByGaps(members) {
    if (members.length <= ROOM_MIN_CLUSTER_SIZE) return [members];

    function findAxisGapSplit(axisIndex) {
        const sorted = members.slice().sort((a, b) => a.position[axisIndex] - b.position[axisIndex]);
        let bestGap = 0;
        let bestSplitIdx = -1;
        for (let i = 1; i < sorted.length; i++) {
            const gap = sorted[i].position[axisIndex] - sorted[i - 1].position[axisIndex];
            if (gap > bestGap) {
                bestGap = gap;
                bestSplitIdx = i;
            }
        }
        return { sorted, bestGap, bestSplitIdx };
    }

    const xSplit = findAxisGapSplit(0);
    const zSplit = findAxisGapSplit(2);
    const chosen = xSplit.bestGap >= zSplit.bestGap ? xSplit : zSplit;

    if (
        chosen.bestGap < ROOM_SPLIT_GAP_THRESHOLD ||
        chosen.bestSplitIdx < ROOM_MIN_CLUSTER_SIZE ||
        (chosen.sorted.length - chosen.bestSplitIdx) < ROOM_MIN_CLUSTER_SIZE
    ) {
        return [members];
    }

    const left = chosen.sorted.slice(0, chosen.bestSplitIdx);
    const right = chosen.sorted.slice(chosen.bestSplitIdx);
    return splitClusterByGaps(left).concat(splitClusterByGaps(right));
}

function clusterViewpointsIntoRooms(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];
    const valid = nodes.map((n, i) => {
        const x = Number(n?.position?.[0]);
        const z = Number(n?.position?.[2]);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
        return { id:n.id || ('node-'+i), position:[x,0,z] };
    }).filter(Boolean);
    if (!valid.length) return [];
    const cellSize = 3.0 * Math.max(0.000001, walkController.physicalMetersPerUnit || 1);
    const minX = Math.min(...valid.map(n=>n.position[0]));
    const minZ = Math.min(...valid.map(n=>n.position[2]));
    const buckets = new Map();
    valid.forEach(n=>{
        const key = Math.floor((n.position[0]-minX)/cellSize)+':'+Math.floor((n.position[2]-minZ)/cellSize);
        if(!buckets.has(key)) buckets.set(key,[]);
        buckets.get(key).push(n);
    });
    return Array.from(buckets.values()).map((members,idx)=>{
        const x=members.reduce((a,m)=>a+m.position[0],0)/members.length;
        const z=members.reduce((a,m)=>a+m.position[2],0)/members.length;
        return { roomId:'area_'+(idx+1), label:'Room '+(idx+1), representativeId:members[0].id, center:[x,0,z], memberIds:members.map(m=>m.id) };
    }).sort((a,b)=>a.center[2]-b.center[2] || a.center[0]-b.center[0]);
}

async function loadWalkAreas() {
    try {
        const res = await fetch('walk_areas.json', {cache:'no-store'});
        if (res.ok) {
            const payload = await res.json();
            if (Array.isArray(payload.areas) && payload.areas.length) return payload.areas;
        }
    } catch (_) {}
    try {
        const res = await fetch('navigation.json', {cache:'no-store'});
        if (!res.ok) return [];
        return clusterViewpointsIntoRooms(await res.json());
    } catch (_) {
        return [];
    }
}

function buildRoomPanel(rooms) {
    const panel = document.getElementById('room-panel');
    const list = document.getElementById('room-list');
    if (!panel || !list) return;

    list.innerHTML = '';
    rooms.forEach(room => {
        const li = document.createElement('li');
        li.className = 'room-item';
        li.dataset.roomId = room.roomId;
        li.textContent = room.label;
        li.addEventListener('click', () => jumpToRoom(room));
        list.appendChild(li);
    });

    panel.style.display = rooms.length > 0 ? 'block' : 'none';
}

function highlightActiveRoom(nodeId) {
    let room = null;
    if (walkController.active && walkAreas.length) {
        let best = Infinity;
        walkAreas.forEach(a => {
            const dx=a.center[0]-walkController.position.x;
            const dz=a.center[2]-walkController.position.z;
            const d=dx*dx+dz*dz;
            if(d<best){best=d; room=a;}
        });
    }
    document.querySelectorAll('.room-item').forEach(el => {
        el.classList.toggle('active', !!room && el.dataset.roomId === room.id);
    });
}

async function jumpToRoom(room) {
    if (!walkController.active) await toggleWalkMode();
    if (!walkController.active) return;
    const started = await walkController.travelTo(room.center);
    if (!started) console.warn('[Walk] Could not compute a path to', room.label);
    else document.getElementById('info').textContent = 'Walking to ' + room.label + '…';
}

function toggleRoomPanel() {
    const panel = document.getElementById('room-panel');
    if (panel) panel.classList.toggle('collapsed');
}

navManager.onNodeChange = highlightActiveRoom;

window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        toggleRoomPanel();
    }
});

const roomPanelToggleBtn = document.getElementById('room-panel-toggle');
if (roomPanelToggleBtn) {
    roomPanelToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRoomPanel();
    });
}
const roomPanelHeader = document.getElementById('room-panel-header');
if (roomPanelHeader) roomPanelHeader.addEventListener('click', toggleRoomPanel);

function setView(name) {
    if (walkController.active) walkController.exit();
    const d = modelSize * 2;
    const views = {
        top:         [0, d * 1.5, 0.01],
        front:       [0, d * 0.3, d],
        side:        [d, d * 0.3, 0],
        perspective: [d * 0.7, d * 0.8, d * 0.7]
    };
    const p = views[name] || views.perspective;
    camera.position.copy(modelCenter).add(new THREE.Vector3(p[0], p[1], p[2]));
    controls.target.copy(modelCenter);
    navManager.hotspotManager.clearHotspots();
    controls.update();
}

function resetView() {
    if (walkController.active) walkController.exit();
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
    controls.autoRotate = false;
    navManager.hotspotManager.clearHotspots();
    setView('perspective');
}

function toggleAutoRotate() { controls.autoRotate = !controls.autoRotate; }

function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
}

let walkSurfacePayload = null;
let navigationNavMeshBytes = null;
let modelCenter = new THREE.Vector3();

async function toggleWalkMode() {
    if (walkController.active) {
        walkController.exit();
        return;
    }
    try {
        if (!walkSurfacePayload) {
            const response = await fetch('navigation_surface.json', { cache: 'no-store' });
            if (!response.ok) throw new Error('navigation_surface.json not found.');
            walkSurfacePayload = await response.json();
        }
        if (!navigationNavMeshBytes) {
            const response = await fetch('navigation_navmesh.bin', { cache: 'no-store' });
            if (!response.ok) throw new Error('navigation_navmesh.bin not found. Re-run the compiler.');
            navigationNavMeshBytes = new Uint8Array(await response.arrayBuffer());
        }
        await walkController.enter(navigationNavMeshBytes, walkSurfacePayload, navManager.model);
        if (!walkAreas.length) walkAreas = await loadWalkAreas();
        buildRoomPanel(walkAreas);
        walkPortalManager.setAreas(walkAreas, navManager.model);
    } catch (error) {
        console.error('[Walk] Failed to start:', error);
        document.getElementById('info').textContent = 'Walk mode unavailable — generate navigation_navmesh.bin first.';
    }
}

async function startNavigation() {
    if (!walkController.active) {
        await toggleWalkMode();
    }
    if (!walkController.active || !roomList.length) return;
    const ordered = walkAreas.slice();
    let index = 0;
    const visitNext = async () => {
        if (!walkController.active || index >= ordered.length) return;
        const room = ordered[index++];
        await walkController.travelTo(room.center);
        const wait = () => {
            if (!walkController.active) return;
            if (!walkController._touring) {
                setTimeout(visitNext, 700);
            } else {
                setTimeout(wait, 250);
            }
        };
        wait();
    };
    visitNext();
}

window.resetView = resetView;
window.toggleAutoRotate = toggleAutoRotate;
window.setView = setView;
window.toggleFullscreen = toggleFullscreen;
window.startNavigation = startNavigation;
window.toggleWalkMode = toggleWalkMode;

const loadingEl = document.getElementById('loading');
const loader = new GLTFLoader();

loader.load(
    'output.glb',
    (gltf) => {
        const model = gltf.scene;
        model.updateMatrixWorld(true);

        model.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        modelCenter.copy(center);
        const size = box.getSize(new THREE.Vector3());
        modelSize = Math.max(size.x, size.y, size.z) || 1;

        // Keep the GLB in its original world frame. The serialized Recast NavMesh
        // uses the same frame; centering the model here would make runtime queries
        // and collision coordinates diverge.
        model.updateMatrixWorld(true);
        ground.position.y = -size.y / 2 - 0.01;
        grid.position.y = ground.position.y;

        const ss = modelSize * 2;
        keyLight.shadow.camera.left = -ss;
        keyLight.shadow.camera.right = ss;
        keyLight.shadow.camera.top = ss;
        keyLight.shadow.camera.bottom = -ss;
        keyLight.shadow.camera.updateProjectionMatrix();

        scene.add(model);
        navManager.setModel(model);
        setView('perspective');

        navManager.floorY = 0;
        ground.visible = false;
        if (grid) grid.visible = false;
        navManager.hotspotSize = Math.max(modelSize * 0.05, 0.2);

        loadWalkAreas().then(areas => {
            walkAreas = areas;
            roomList = areas;
            if (areas.length) {
                document.getElementById('tour-btn').style.display = 'inline-block';
                buildRoomPanel(areas);
            }
        });

        if (loadingEl) loadingEl.remove();
    },
    undefined,
    (error) => {
        console.error('Failed to load output.glb:', error);
        if (loadingEl) loadingEl.textContent = 'Failed to load model.';
    }
);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

(function animate(time) {
    requestAnimationFrame(animate);
    if (!walkController.active) controls.update();
    walkController.update(time);
    walkPortalManager.update();
    if (!walkController.active && navManager.hotspotManager) navManager.hotspotManager.update(time);
    renderer.render(scene, camera);
})();
</script>
</body>
</html>`;

    const htmlOutPath = path.join(jobDir, "360_viewer.html");
    fs.writeFileSync(htmlOutPath, html);
    console.log(`\n=================================================`);
    console.log(`360 VIEWER (GLB) GENERATED WITH NAVIGATION!`);
    console.log(`Output: ${htmlOutPath}`);
    console.log(`=================================================`);

    return htmlOutPath;
}

// --- MAIN PIPELINE LOGIC REMAINS UNCHANGED BELOW ---
async function runPipeline() {
    try {
        if (CAMERA_ANGLE === '360') {
            generate360ViewerFromGLB(JOB_DIR);
            return;
        }

        console.log("\n--- Merging IFC + Furniture + Materials (Coohom-style compositor) ---");
        console.log("    Reads input.ifc + project_state.json, applies Z-up -> Y-up fix.");

        const mergeArgs = [
            'scene_merger.py',
            '--ifc', LOCAL_IFC_PATH,
            '--state', LOCAL_STATE_PATH,
            '--output', LOCAL_OBJ_PATH,
            '--job-dir', JOB_DIR
        ];

        if (process.env.ASSET_DIR) {
            mergeArgs.push('--asset-dir', process.env.ASSET_DIR);
        }

        const merge = spawnSync('python', mergeArgs, { encoding: 'utf-8' });

        if (merge.stderr && merge.stderr.trim()) {
            console.log(merge.stderr.trim());
        }
        if (merge.error) {
            throw new Error(`Failed to launch scene_merger.py: ${merge.error.message}`);
        }
        if (!merge.stdout || !merge.stdout.trim()) {
            throw new Error(`scene_merger.py produced no output (exit code ${merge.status}).`);
        }

        let mergeInfo;
        try {
            mergeInfo = JSON.parse(merge.stdout.trim());
        } catch (e) {
            throw new Error(`scene_merger.py returned non-JSON output: ${merge.stdout}`);
        }
        if (!mergeInfo.success) {
            throw new Error(`Scene merge failed: ${mergeInfo.error}`);
        }

        console.log(`✔️ Merged scene ready — ${mergeInfo.furniture_count} furniture item(s), ` +
            `${mergeInfo.materials_applied} material override(s) applied.`);
        if (mergeInfo.warnings && mergeInfo.warnings.length) {
            mergeInfo.warnings.forEach(w => console.warn(`   ⚠️  ${w}`));
        }

        const BBOX_CENTER = mergeInfo.bbox.center;
        const BBOX_SIZE = mergeInfo.bbox.size;

        const authBody = `client_id=${process.env.APS_CLIENT_ID}&client_secret=${process.env.APS_CLIENT_SECRET}&grant_type=client_credentials&scope=code:all data:write data:read bucket:create bucket:read`;
        const authRes = await axios.post('https://developer.api.autodesk.com/authentication/v2/token', authBody, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const token = authRes.data.access_token;

        const nickRes = await axios.get('https://developer.api.autodesk.com/da/us-east/v3/forgeapps/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const nickname = nickRes.data;

       console.log("\n--- Setting up AppBundle ---");

        if (!fs.existsSync(LOCAL_BUNDLE_PATH)) {
            throw new Error(`❌ MISSING ZIP FILE: Cannot find ${LOCAL_BUNDLE_PATH} in the current directory.`);
        }
        const zipStats = fs.statSync(LOCAL_BUNDLE_PATH);
        console.log(`✔️ Found AppBundle ZIP: ${zipStats.size} bytes`);
        if (zipStats.size < 100) {
            throw new Error(`❌ INVALID ZIP FILE: File is only ${zipStats.size} bytes. It is empty or corrupted.`);
        }

        let bundleParams, bundleVer = 1;
        try {
            const bundleReg = await axios.post('https://developer.api.autodesk.com/da/us-east/v3/appbundles',
                { id: BUNDLE_ID, engine: ENGINE }, { headers: { 'Authorization': `Bearer ${token}` } });
            bundleParams = bundleReg.data.uploadParameters;
        }
        catch (err) {
            if (err.response && err.response.status === 409) {
                const verRes = await axios.post(`https://developer.api.autodesk.com/da/us-east/v3/appbundles/${BUNDLE_ID}/versions`,
                    { engine: ENGINE }, { headers: { 'Authorization': `Bearer ${token}` } });
                bundleParams = verRes.data.uploadParameters;
                bundleVer = verRes.data.version;
            } else throw err;
        }

        const bundleForm = new FormData();
        Object.keys(bundleParams.formData).forEach(k => bundleForm.append(k, bundleParams.formData[k]));
        bundleForm.append('file', fs.createReadStream(LOCAL_BUNDLE_PATH));
        await axios.post(bundleParams.endpointURL, bundleForm, { headers: bundleForm.getHeaders() });
        await ensureAlias(token, 'appbundles', BUNDLE_ID, ALIAS, bundleVer);

        console.log("\n--- Registering Activity ---");
        const activitySpec = {
            id: ACTIVITY_ID,
            commandLine: [
                `"cmd.exe" /c copy "$(appbundles[${BUNDLE_ID}].path)\\\\render.ms" "$(args[InputFile].path)\\\\..\\\\render.ms"`,
                `"$(engine.path)/3dsmaxbatch.exe" -v 5 "$(args[InputFile].path)\\\\..\\\\render.ms"`
            ],
            parameters: {
                InputFile: { verb: "get", localName: "input.obj" },
                MaterialFile: { verb: "get", localName: "input.mtl", required: false },
                CameraConfig: { verb: "get", localName: "camera.json" },
                OutputFile: { verb: "put", localName: "output.png", required: false },
                DiagLog: { verb: "put", localName: "diag.txt", required: false }
            },
            engine: ENGINE,
            appbundles: [`${nickname}.${BUNDLE_ID}+${ALIAS}`],
            description: "IFC High-Fidelity Rendering Pipeline."
        };

        let activityVer = 1;
        try {
            const actRes = await axios.post('https://developer.api.autodesk.com/da/us-east/v3/activities', activitySpec, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            activityVer = actRes.data.version;
        } catch (err) {
            if (err.response && err.response.status === 409) {
                const { id, ...versionSpec } = activitySpec;
                const verRes = await axios.post(`https://developer.api.autodesk.com/da/us-east/v3/activities/${ACTIVITY_ID}/versions`,
                    versionSpec, { headers: { 'Authorization': `Bearer ${token}` } });
                activityVer = verRes.data.version;
            } else throw err;
        }
        await ensureAlias(token, 'activities', ACTIVITY_ID, ALIAS, activityVer);

        console.log("\n--- Preparing Storage & Upload ---");
        try {
            await axios.post('https://developer.api.autodesk.com/oss/v2/buckets',
                { bucketKey: BUCKET_KEY, policyKey: 'transient' }, { headers: { 'Authorization': `Bearer ${token}` } });
        } catch (e) {}

        await uploadFileToOSS(token, BUCKET_KEY, CLOUD_OBJ_KEY, LOCAL_OBJ_PATH);

        const hasMtl = fs.existsSync(LOCAL_MTL_PATH);
        if (hasMtl) {
            await uploadFileToOSS(token, BUCKET_KEY, CLOUD_MTL_KEY, LOCAL_MTL_PATH);
            console.log("✔️ Uploaded input.mtl (material overrides).");
        } else {
            console.log("ℹ️  No input.mtl produced by scene_merger.py — scene has no material overrides, skipping.");
        }

        const renderCfg = JSON.parse(fs.readFileSync('./render-config.json', 'utf-8'));
        renderCfg.angle = CAMERA_ANGLE;
        renderCfg.interiorCenter = BBOX_CENTER;
        renderCfg.interiorSize = BBOX_SIZE;
        fs.writeFileSync(CAMERA_JSON_PATH, JSON.stringify(renderCfg));
        await uploadFileToOSS(token, BUCKET_KEY, CLOUD_CAM_KEY, CAMERA_JSON_PATH);

        console.log("\n--- Submitting Final Render Job ---");
        const workItemArgs = {
            InputFile: {
                url: `urn:adsk.objects:os.object:${BUCKET_KEY}/${CLOUD_OBJ_KEY}`,
                headers: { "Authorization": `Bearer ${token}` }
            },
            CameraConfig: {
                url: `urn:adsk.objects:os.object:${BUCKET_KEY}/${CLOUD_CAM_KEY}`,
                headers: { "Authorization": `Bearer ${token}` }
            },
            OutputFile: {
                url: `urn:adsk.objects:os.object:${BUCKET_KEY}/${CLOUD_OUT_KEY}`,
                verb: "put", headers: { "Authorization": `Bearer ${token}` }
            },
            DiagLog: {
                url: `urn:adsk.objects:os.object:${BUCKET_KEY}/${CLOUD_DIAG_KEY}`,
                verb: "put", headers: { "Authorization": `Bearer ${token}` }
            }
        };
        if (hasMtl) {
            workItemArgs.MaterialFile = {
                url: `urn:adsk.objects:os.object:${BUCKET_KEY}/${CLOUD_MTL_KEY}`,
                headers: { "Authorization": `Bearer ${token}` }
            };
        }

        const workItemRes = await axios.post('https://developer.api.autodesk.com/da/us-east/v3/workitems', {
            activityId: `${nickname}.${ACTIVITY_ID}+${ALIAS}`,
            arguments: workItemArgs
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        console.log(`\n--- Polling WorkItem: ${workItemRes.data.id} ---`);
        let status = 'pending';
        while (status === 'pending' || status === 'inprogress') {
            await new Promise(r => setTimeout(r, 5000));
            const pollRes = await axios.get(`https://developer.api.autodesk.com/da/us-east/v3/workitems/${workItemRes.data.id}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            status = pollRes.data.status;
            console.log(`    Status: ${status}`);
        }

        if (status !== 'success') {
            try {
                const diagUrl = `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET_KEY}/objects/${CLOUD_DIAG_KEY}/signeds3download`;
                const diagRes = await axios.get(diagUrl, { headers: { 'Authorization': `Bearer ${token}` } });
                const diagData = await axios.get(diagRes.data.url);
                console.log(`\n=== DIAGNOSTIC LOG ===\n${diagData.data}\n=== END LOG ===`);
            } catch (e) { console.log('Could not download diag log:', e.message); }
            throw new Error(`WorkItem failed with status: ${status}`);
        }

        console.log(`\n--- Downloading result.png ---`);
        const downloadUrl = `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET_KEY}/objects/${CLOUD_OUT_KEY}/signeds3download`;
        const dlRes = await axios.get(downloadUrl, { headers: { 'Authorization': `Bearer ${token}` } });
        const fileRes = await axios.get(dlRes.data.url, { responseType: 'arraybuffer' });

        fs.writeFileSync(RESULT_PNG_PATH, Buffer.from(fileRes.data));

        console.log(`\n=================================================`);
        console.log(`PIPELINE SUCCESSFUL!`);
        console.log(`Output saved to: ${RESULT_PNG_PATH}`);
        console.log(`=================================================`);

    } catch (err) {
        console.error("\n=================================================");
        console.error("🛑 CRITICAL PIPELINE FAILURE");
        console.error("=================================================");

        if (err.response) {
            console.error(`HTTP Status: ${err.response.status} ${err.response.statusText}`);
            console.error(`Endpoint Failed: ${err.config.url}`);
            console.error("\n--- AUTODESK ERROR DETAILS ---");
            console.error(JSON.stringify(err.response.data, null, 2));
            console.error("------------------------------\n");

            if (err.response.status === 403) {
                const errorStr = JSON.stringify(err.response.data);
                if (errorStr.includes("Developer is not subscribed") || errorStr.includes("Not Authorized")) {
                    console.error("💡 DIAGNOSIS: Design Automation API is NOT enabled in your Autodesk Developer Portal for this Client ID.");
                } else if (errorStr.includes("SignatureDoesNotMatch")) {
                    console.error("💡 DIAGNOSIS: S3 Upload URL signature mismatch. The AppBundle zip might be corrupted or the S3 endpoint rejected the form data.");
                } else {
                    console.error("💡 DIAGNOSIS: Permission denied. Check your Forge App permissions or bucket naming.");
                }
            }
        } else if (err.request) {
            console.error("No response received from Autodesk. Check network connection.");
        } else {
            console.error("Error setting up request:", err.message);
        }
    }
}

module.exports = { generate360ViewerFromGLB };

if (require.main === module) {
    runPipeline();
}