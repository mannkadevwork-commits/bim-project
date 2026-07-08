require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');
const path = require('path');

// --- 1. CONFIGURATION ---
const BUNDLE_ID = "IFCRenderBundle_v2";
const ACTIVITY_ID = "IFCRenderActivity_v2";
const ALIAS = "prod";
const ENGINE = "Autodesk.3dsMax+2024";
const BUCKET_KEY = (process.env.APS_CLIENT_ID + "_render_storage").toLowerCase();

const CAMERA_ANGLE = process.argv[2] || "top-front-right";
const JOB_DIR = process.argv[3] || "."; 
const JOB_ID = path.basename(JOB_DIR) || "default";

// --- Absolute Dynamic Local Paths ---
const LOCAL_IFC_PATH = path.join(JOB_DIR, "input.ifc");
const LOCAL_STATE_PATH = path.join(JOB_DIR, "project_state.json");
const LOCAL_OBJ_PATH = path.join(JOB_DIR, "input.obj");
const LOCAL_MTL_PATH = path.join(JOB_DIR, "input.mtl");
const CAMERA_JSON_PATH = path.join(JOB_DIR, "camera.json");
const RESULT_PNG_PATH = path.join(JOB_DIR, "result.png");
const HTML_OUT_PATH = path.join(JOB_DIR, "360_viewer.html");
const LOCAL_BUNDLE_PATH = "./IFCRenderBundle.zip"; 

// --- Unique Cloud Keys ---
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

// --- 2. GLOBAL DEBUG LOGGER ---
axios.interceptors.request.use(request => {
    console.log(`\n================= DEBUG: OUTGOING REQUEST =================`);
    console.log(`METHOD/URL: [${request.method.toUpperCase()}] ${request.url}`);
    return request;
});

axios.interceptors.response.use(response => {
    console.log(`<<< RESPONSE: ${response.status} ${response.statusText}`);
    return response;
}, error => {
    console.log(`<<< FAILED: ${error.response? error.response.status : 'NO_RESPONSE'}`);
    return Promise.reject(error);
});

// --- 3. HELPER: ALIAS MANAGER ---
async function ensureAlias(token, type, resourceId, aliasId, version) {
    const url = `https://developer.api.autodesk.com/da/us-east/v3/${type}/${resourceId}/aliases`;
    try {
        await axios.post(url, { id: aliasId, version }, { headers: { 'Authorization': `Bearer ${token}` } });
    } catch (err) {
        if (err.response && err.response.status === 409) {
            await axios.patch(`${url}/${aliasId}`, { version }, { headers: { 'Authorization': `Bearer ${token}` } });
        } else throw err;
    }
}

// --- 4. HELPER: DIRECT-TO-S3 OSS UPLOAD ---
async function uploadFileToOSS(token, bucketKey, objectKey, filePath) {
    const getUrl = `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${objectKey}/signeds3upload`;
    const getRes = await axios.get(getUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const { uploadKey, urls } = getRes.data;
    await axios.put(urls[0], fs.readFileSync(filePath), { headers: { 'Content-Type': 'application/octet-stream' } });
    await axios.post(getUrl, { uploadKey }, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
}

// --- 5. GENERATE 360 THREE.JS VIEWER ---
function generate360Viewer(objPath, bboxCenter) {
    const objData = fs.readFileSync(objPath, 'utf-8');

    // 2026-07-08: no longer reading/using the .mtl file here at all.
    // Trimesh's Scene->OBJ exporter was verified to collapse every
    // element's material into one shared "material_0" regardless of how
    // many distinct override colors scene_merger.py wrote into each
    // mesh (36 usemtl lines all pointing at a single newmtl block on a
    // real job) -- so MTLLoader had nothing correct to parse in the first
    // place. Colors now come directly from project_state.json, matched by
    // the exact object ("o") name scene_merger.py gives each mesh (its raw
    // IFC GlobalId for structural elements, or its materials_key for
    // furniture -- see scene_merger.py's naming comments).
    const statePath = path.join(path.dirname(objPath), 'project_state.json');
    let projectState = { materials: {} };
    if (fs.existsSync(statePath)) {
        try {
            projectState = JSON.parse(fs.readFileSync(statePath, 'utf-8')) || { materials: {} };
        } catch (e) {
            console.warn(`⚠️  Could not parse project_state.json for material colors: ${e.message}`);
        }
    }

    const cfg = JSON.parse(fs.readFileSync('./render-config.json', 'utf-8'));
    const c = (arr) => `0x${arr.map(v => v.toString(16).padStart(2,'0')).join('')}`;
    const cf = (arr) => arr.map(v => (v/255).toFixed(3));
    
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
  #controls {
    position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 10px; align-items: center;
  }
  button {
    padding: 8px 18px; border: none; border-radius: 4px;
    background: #4a9eff; color: #fff; cursor: pointer; font-size: 13px;
  }
  button:hover { background: #3a8eef; }
</style>
</head>
<body>
<div id="info">Drag to rotate | Scroll to zoom | Right-drag to pan</div>
<div id="controls">
  <button onclick="resetView()">Reset View</button>
  <button onclick="toggleAutoRotate()">Auto-Rotate</button>
  <button onclick="setView('top')">Top</button>
  <button onclick="setView('front')">Front</button>
  <button onclick="setView('side')">Side</button>
  <button onclick="setView('perspective')">Perspective</button>
  <button onclick="enterInteriorView()">Interior 360</button>
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
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

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

const archMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(${cf(cfg.material.color).join(',')}),
    roughness: ${cfg.material.roughness},
    metalness: ${cfg.material.metalness}
});

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

const INTERIOR_CENTER = ${JSON.stringify(bboxCenter || null)};
let interiorMode = false;

// Inject OBJ text and project_state.json material overrides dynamically.
// No .mtl is injected or loaded anymore -- see the note above generate360Viewer().
const objText = ${JSON.stringify(objData)};
const projectState = ${JSON.stringify(projectState)};

const objLoader = new OBJLoader();
const obj = objLoader.parse(objText);

// --- Direct color lookup: project_state.json is the ONLY source of truth ---
//
// scene_merger.py now names every OBJ object ("o" line) with the EXACT,
// unmodified key that would appear in project_state.json["materials"] --
// a structural element's raw IFC GlobalId, or a furniture item's
// materials_key -- so child.name can be looked up in projectState.materials
// directly, with no MTL parsing, no sanitization, and no fuzzy matching.
const projectMaterials = (projectState && projectState.materials) || {};

obj.traverse(child => {
    if (child.isMesh) {
        const matDef = projectMaterials[child.name];
        const matClone = archMat.clone();

        if (matDef && Array.isArray(matDef.rgb) && matDef.rgb.length >= 3) {
            // project_state.json's "rgb" is already normalized 0-1, exactly
            // what THREE.Color.setRGB expects -- no parsing needed.
            const [r, g, b] = matDef.rgb;
            matClone.color.setRGB(r, g, b);
        }
        // No matching entry (or a malformed one) -- keep archMat's default
        // color rather than guessing; this mesh simply has no override.

        if (Array.isArray(child.material)) {
            child.material = child.material.map(() => matClone);
        } else {
            child.material = matClone;
        }
        
        child.castShadow = true;
        child.receiveShadow = true;
    }
});

const box = new THREE.Box3().setFromObject(obj);
const center = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
modelSize = Math.max(size.x, size.y, size.z);

obj.position.sub(center);
ground.position.y = -size.y / 2 - 0.01;
grid.position.y = ground.position.y;

const ss = modelSize * 2;
keyLight.shadow.camera.left = -ss;
keyLight.shadow.camera.right = ss;
keyLight.shadow.camera.top = ss;
keyLight.shadow.camera.bottom = -ss;
keyLight.shadow.camera.updateProjectionMatrix();

scene.add(obj);

function setView(name) {
    const d = modelSize * 2;
    const views = {
        top:         [0, d * 1.5, 0.01],
        front:       [0, d * 0.3, d],
        side:        [d, d * 0.3, 0],
        perspective: [d * 0.7, d * 0.8, d * 0.7]
    };
    const p = views[name] || views.perspective;
    camera.position.set(p[0], p[1], p[2]);
    controls.target.set(0, 0, 0);
    controls.update();
}

function resetView() {
    interiorMode = false;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
    controls.autoRotate = false;
    setView('perspective');
}

function toggleAutoRotate() {
    controls.autoRotate = !controls.autoRotate;
}

function enterInteriorView() {
    interiorMode = true;
    controls.autoRotate = false;
    camera.position.set(0, 0, 0.001);
    controls.target.set(0, 0, 0);
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.minDistance = 0.01;
    controls.maxDistance = 0.01;
    controls.update();
}

window.resetView = resetView;
window.toggleAutoRotate = toggleAutoRotate;
window.setView = setView;
window.enterInteriorView = enterInteriorView;

setView('perspective');

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

(function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
})();
</script>
</body>
</html>`;

    // Save directly to the dynamic JOB_DIR
    const HTML_OUT_PATH = require('path').join(process.argv[3] || ".", "360_viewer.html");
    fs.writeFileSync(HTML_OUT_PATH, html);
    console.log(`\n=================================================`);
    console.log(`360 VIEWER GENERATED!`);
    console.log(`Output: ${HTML_OUT_PATH}`);
    console.log(`=================================================`);
}

// --- 6. MAIN PIPELINE ---
async function runPipeline() {
    try {
        console.log("\n--- Merging IFC + Furniture + Materials (Coohom-style compositor) ---");
        console.log("    Reads input.ifc + project_state.json, applies Z-up -> Y-up fix.");

        const merge = spawnSync('python', [
            'scene_merger.py',
            '--ifc', LOCAL_IFC_PATH,
            '--state', LOCAL_STATE_PATH,
            '--output', LOCAL_OBJ_PATH,
            '--job-dir', JOB_DIR
        ], { encoding: 'utf-8' });

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

        if (CAMERA_ANGLE === '360') {
            generate360Viewer(LOCAL_OBJ_PATH, BBOX_CENTER);
            return;
        }

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
    
runPipeline();