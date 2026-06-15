require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// --- 1. CONFIGURATION ---
const BUNDLE_ID = "IFCRenderBundle";
const ACTIVITY_ID = "IFCRenderActivity";
const ALIAS = "prod";
const ENGINE = "Autodesk.3dsMax+2024";
const BUCKET_KEY = (process.env.APS_CLIENT_ID + "_render_storage").toLowerCase();

const CAMERA_ANGLE = process.argv[2] || "top-front-right";
const JOB_DIR = process.argv[3] || "."; 
const LIGHTING_MODE = process.argv[4] || "daylight"; 
const JOB_ID = path.basename(JOB_DIR) || "default";

const LOCAL_IFC_PATH = path.join(JOB_DIR, "input.ifc");
const LOCAL_OBJ_PATH = path.join(JOB_DIR, "input.obj");
const CAMERA_JSON_PATH = path.join(JOB_DIR, "camera.json");
const RESULT_PNG_PATH = path.join(JOB_DIR, "result.png");
const HTML_OUT_PATH = path.join(JOB_DIR, "360_viewer.html");
const LOCAL_BUNDLE_PATH = "./IFCRenderBundle.zip"; 

const CLOUD_OBJ_KEY = `${JOB_ID}_input.obj`;
const CLOUD_CAM_KEY = `${JOB_ID}_camera.json`;
const CLOUD_OUT_KEY = `${JOB_ID}_result.png`;
const CLOUD_DIAG_KEY = `${JOB_ID}_diag.txt`;

const VALID_ANGLES = ["top-front-right", "top-front-left", "front", "rear", "left", "right", "birds-eye", "top-down", "eye-level", "isometric", "360"];
if (!VALID_ANGLES.includes(CAMERA_ANGLE)) { console.error(`Invalid angle`); process.exit(1); }

// --- 5. GENERATE STATE-AWARE 360 THREE.JS VIEWER ---
function generate360Viewer(mode) {
    let bgColor = [248, 250, 252]; 
    let ambientSky = [255, 255, 255];
    let ambientGround = [200, 200, 200];
    let keyLightColor = [255, 255, 255];
    let keyIntensity = 1.2;

    if (mode === 'night') {
        bgColor = [15, 23, 42]; 
        ambientSky = [20, 30, 60]; 
        ambientGround = [10, 15, 30];
        keyLightColor = [150, 180, 255]; 
        keyIntensity = 0.5;
    }

    const c = (arr) => `0x${arr.map(v => v.toString(16).padStart(2,'0')).join('')}`;
    const cf = (arr) => arr.map(v => (v/255).toFixed(3));
    
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>360 Premium IFC Viewer</title>
<style>
  body { margin: 0; overflow: hidden; background: ${mode === 'night' ? '#0f172a' : '#f8fafc'}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  canvas { display: block; touch-action: none; outline: none; }
  
  #info { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); color: #334155; font-size: 13px; font-weight: 500; background: rgba(255,255,255,0.8); padding: 8px 24px; border-radius: 20px; pointer-events: none; z-index: 10; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); backdrop-filter: blur(8px); border: 1px solid rgba(0,0,0,0.05); }
  #controls { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; align-items: center; z-index: 10; background: rgba(255,255,255,0.9); padding: 8px; border-radius: 16px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); backdrop-filter: blur(8px); }
  button { padding: 8px 16px; border: none; border-radius: 10px; background: #f1f5f9; color: #475569; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.2s; }
  button:hover, button.active { background: #4f46e5; color: white; }
  
  #loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; border: 1px solid #e2e8f0; color: #0f172a; padding: 40px 50px; border-radius: 24px; display: flex; flex-direction: column; align-items: center; gap: 20px; z-index: 50; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25); }
  .spinner { width: 48px; height: 48px; border: 4px solid #e2e8f0; border-left-color: #4f46e5; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="loading"><div class="spinner"></div><div id="loading-text" style="font-weight: 600;">Processing Geometry...</div></div>
<div id="info">Drag to rotate | Scroll to zoom</div>

<div id="controls">
  <button onclick="resetView()">Reset</button>
  <button id="btn-rotate" onclick="toggleAutoRotate()">Auto-Rotate</button>
  <div style="width: 1px; height: 24px; background: #e2e8f0; margin: 0 4px;"></div>
  <button onclick="setView('top')">Top</button>
  <button onclick="setView('perspective')">3D</button>
</div>

<script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/" } }
</script>

<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(${c(bgColor)});
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 10000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

scene.add(new THREE.HemisphereLight(new THREE.Color(${cf(ambientSky).join(',')}), new THREE.Color(${cf(ambientGround).join(',')}), 1.0));
const keyLight = new THREE.DirectionalLight(new THREE.Color(${cf(keyLightColor).join(',')}), ${keyIntensity});
keyLight.position.set(1, 2, 1).normalize().multiplyScalar(50);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.bias = -0.0005;
scene.add(keyLight);

const defaultMat = new THREE.MeshStandardMaterial({ 
    color: 0xf1f5f9, roughness: 0.8, metalness: 0.0, 
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 
});

const grid = new THREE.GridHelper(200, 100, 0x94a3b8, 0xe2e8f0);
grid.material.opacity = ${mode === 'night' ? '0.1' : '0.5'}; 
grid.material.transparent = true;
scene.add(grid);

window.modelSize = 1; 
const modelGroup = new THREE.Group();
scene.add(modelGroup);

let projectState = { materials: {}, furniture: [] };
fetch('./project_state.json')
    .then(res => res.json())
    .then(data => { projectState = data; })
    .catch(err => console.log("No custom state found, using defaults."))
    .finally(() => {
        // 1. Load the Building Structure
        const loader = new OBJLoader();
        loader.load('./input.obj', function (obj) {
            document.getElementById('loading').style.display = 'none';
            obj.traverse(child => {
                if (child.isMesh) {
                    child.geometry.computeVertexNormals();
                    child.material = defaultMat.clone(); 
                    child.castShadow = true; 
                    child.receiveShadow = true;
                    
                    const objName = child.name || "";
                    if (projectState.materials[objName]) {
                        child.material.color.setHex(projectState.materials[objName].color);
                    }

                    const edges = new THREE.EdgesGeometry(child.geometry, 20);
                    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x64748b, linewidth: 1, transparent: true, opacity: 0.5 }));
                    child.add(line);
                }
            });
            const box = new THREE.Box3().setFromObject(obj);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            window.modelSize = Math.max(size.x, size.y, size.z);
            obj.position.sub(center);
            grid.position.y = -size.y / 2 - 0.01;
            
            const ss = window.modelSize * 1.5;
            keyLight.shadow.camera.left = -ss; keyLight.shadow.camera.right = ss; keyLight.shadow.camera.top = ss; keyLight.shadow.camera.bottom = -ss;
            keyLight.shadow.camera.updateProjectionMatrix();
            modelGroup.add(obj);
            setView('perspective'); 
        });

        // 2. NEW FIX: PROCEDURAL FURNITURE PROXIES
        // Instead of a GLTFLoader, we generate proxy geometry to represent the missing files
        projectState.furniture.forEach(item => {
            let geometry, material;
            
            if (item.id === 'sofa_modern') {
                geometry = new THREE.BoxGeometry(2, 0.8, 1);
                material = new THREE.MeshStandardMaterial({ color: 0x6366f1, roughness: 0.9 }); // Indigo proxy
            } else if (item.id === 'bed_king') {
                geometry = new THREE.BoxGeometry(2.2, 0.4, 2.2);
                material = new THREE.MeshStandardMaterial({ color: 0x10b981, roughness: 0.9 }); // Emerald proxy
            } else if (item.id === 'plant_monstera') {
                geometry = new THREE.CylinderGeometry(0.4, 0.4, 1.5, 16);
                material = new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.7 }); // Green proxy
            } else {
                geometry = new THREE.BoxGeometry(1, 1, 1);
                material = new THREE.MeshStandardMaterial({ color: 0x94a3b8 });
            }

            const mesh = new THREE.Mesh(geometry, material);
            // Lift the object so it sits ON the floor instead of intersecting it
            const heightOffset = geometry.parameters.height ? geometry.parameters.height / 2 : 0.5;
            
            mesh.position.set(item.position[0], item.position[1] + heightOffset, item.position[2]);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            
            // Add proxy edge lines for a polished CAD look
            const edges = new THREE.EdgesGeometry(geometry);
            mesh.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 })));
            
            scene.add(mesh);
        });
    });

function setView(name) {
    const d = window.modelSize * 1.5;
    const views = { top: [0, d * 1.2, 0.01], perspective: [d * 0.8, d * 0.7, d * 0.8] };
    const p = views[name] || views.perspective;
    camera.position.set(p[0], p[1], p[2]);
    controls.target.set(0, 0, 0);
    controls.update();
}
window.setView = setView;
window.resetView = () => { controls.autoRotate = false; document.getElementById('btn-rotate').classList.remove('active'); setView('perspective'); };
window.toggleAutoRotate = () => { controls.autoRotate = !controls.autoRotate; document.getElementById('btn-rotate').classList.toggle('active'); };

window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
(function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); })();
</script>
</body>
</html>`;

    fs.writeFileSync(HTML_OUT_PATH, html);
    console.log(`\n=================================================`);
    console.log(`360 VIEWER GENERATED WITH MODE: ${mode.toUpperCase()}`);
    console.log(`=================================================`);
}

// --- MAIN PIPELINE EXECUTION ---
async function runPipeline() {
    try {
        console.log("\n--- Converting IFC to OBJ ---");
        execSync(`python ifc2obj.py "${LOCAL_IFC_PATH}" "${LOCAL_OBJ_PATH}"`, { stdio: 'inherit' });

        if (CAMERA_ANGLE === '360') {
            generate360Viewer(LIGHTING_MODE); 
            return;
        }

        const authBody = `client_id=${process.env.APS_CLIENT_ID}&client_secret=${process.env.APS_CLIENT_SECRET}&grant_type=client_credentials&scope=code:all data:write data:read bucket:create bucket:read`;
        const authRes = await axios.post('https://developer.api.autodesk.com/authentication/v2/token', authBody, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const token = authRes.data.access_token;

        const nickRes = await axios.get('https://developer.api.autodesk.com/da/us-east/v3/forgeapps/me', { headers: { 'Authorization': `Bearer ${token}` } });
        const nickname = nickRes.data;

        console.log("\n--- Setting up AppBundle ---");
        let bundleParams, bundleVer = 1;
        try {
            const bundleReg = await axios.post('https://developer.api.autodesk.com/da/us-east/v3/appbundles', { id: BUNDLE_ID, engine: ENGINE }, { headers: { 'Authorization': `Bearer ${token}` } });
            bundleParams = bundleReg.data.uploadParameters;
        } catch (err) {
            if (err.response && err.response.status === 409) {
                const verRes = await axios.post(`https://developer.api.autodesk.com/da/us-east/v3/appbundles/${BUNDLE_ID}/versions`, { engine: ENGINE }, { headers: { 'Authorization': `Bearer ${token}` } });
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
            const actRes = await axios.post('https://developer.api.autodesk.com/da/us-east/v3/activities', activitySpec, { headers: { 'Authorization': `Bearer ${token}` } });
            activityVer = actRes.data.version;
        } catch (err) {
            if (err.response && err.response.status === 409) {
                const { id, ...versionSpec } = activitySpec;
                const verRes = await axios.post(`https://developer.api.autodesk.com/da/us-east/v3/activities/${ACTIVITY_ID}/versions`, versionSpec, { headers: { 'Authorization': `Bearer ${token}` } });
                activityVer = verRes.data.version;
            } else throw err;
        }
        await ensureAlias(token, 'activities', ACTIVITY_ID, ALIAS, activityVer);

        console.log("\n--- Preparing Storage & Upload ---");
        try { await axios.post('https://developer.api.autodesk.com/oss/v2/buckets', { bucketKey: BUCKET_KEY, policyKey: 'transient' }, { headers: { 'Authorization': `Bearer ${token}` } }); } catch (e) {}
        await uploadFileToOSS(token, BUCKET_KEY, CLOUD_OBJ_KEY, LOCAL_OBJ_PATH);

        const renderCfg = JSON.parse(fs.readFileSync('./render-config.json', 'utf-8'));
        renderCfg.angle = CAMERA_ANGLE;
        fs.writeFileSync(CAMERA_JSON_PATH, JSON.stringify(renderCfg));
        await uploadFileToOSS(token, BUCKET_KEY, CLOUD_CAM_KEY, CAMERA_JSON_PATH);

        console.log("\n--- Submitting Final Render Job ---");
        const workItemRes = await axios.post('https://developer.api.autodesk.com/da/us-east/v3/workitems', {
            activityId: `${nickname}.${ACTIVITY_ID}+${ALIAS}`,
            arguments: {
                InputFile: { url: `urn:adsk.objects:os.object:${BUCKET_KEY}/${CLOUD_OBJ_KEY}`, headers: { "Authorization": `Bearer ${token}` } },
                CameraConfig: { url: `urn:adsk.objects:os.object:${BUCKET_KEY}/${CLOUD_CAM_KEY}`, headers: { "Authorization": `Bearer ${token}` } },
                OutputFile: { url: `urn:adsk.objects:os.object:${BUCKET_KEY}/${CLOUD_OUT_KEY}`, verb: "put", headers: { "Authorization": `Bearer ${token}` } },
                DiagLog: { url: `urn:adsk.objects:os.object:${BUCKET_KEY}/${CLOUD_DIAG_KEY}`, verb: "put", headers: { "Authorization": `Bearer ${token}` } }
            }
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        let status = 'pending';
        while (status === 'pending' || status === 'inprogress') {
            await new Promise(r => setTimeout(r, 5000));
            const pollRes = await axios.get(`https://developer.api.autodesk.com/da/us-east/v3/workitems/${workItemRes.data.id}`, { headers: { 'Authorization': `Bearer ${token}` } });
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
        console.log(`=================================================`);
    } catch (err) {
        console.error("\nCRITICAL PIPELINE FAILURE.", err.message || err);
    }
}

async function ensureAlias(token, type, resourceId, aliasId, version) {
    const url = `https://developer.api.autodesk.com/da/us-east/v3/${type}/${resourceId}/aliases`;
    try { await axios.post(url, { id: aliasId, version }, { headers: { 'Authorization': `Bearer ${token}` } }); } 
    catch (err) { if (err.response && err.response.status === 409) { await axios.patch(`${url}/${aliasId}`, { version }, { headers: { 'Authorization': `Bearer ${token}` } }); } else throw err; }
}

async function uploadFileToOSS(token, bucketKey, objectKey, filePath) {
    const getUrl = `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${objectKey}/signeds3upload`;
    const getRes = await axios.get(getUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    await axios.put(getRes.data.urls[0], fs.readFileSync(filePath), { headers: { 'Content-Type': 'application/octet-stream' } });
    await axios.post(getUrl, { uploadKey: getRes.data.uploadKey }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
}

runPipeline();