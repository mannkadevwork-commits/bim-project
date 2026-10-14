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
const LIGHTING = process.argv[4] || "daylight";
const QUALITY = process.argv[5] || "high";
const JOB_ID = path.basename(JOB_DIR) || "default";

const LOCAL_IFC_PATH = path.join(JOB_DIR, "input.ifc");
const LOCAL_STATE_PATH = path.join(JOB_DIR, "project_state.json");
const LOCAL_OBJ_PATH = path.join(JOB_DIR, "input.obj");
const LOCAL_MTL_PATH = path.join(JOB_DIR, "input.mtl");
const CAMERA_JSON_PATH = path.join(JOB_DIR, "camera.json");
const RESULT_PNG_PATH = path.join(JOB_DIR, "result.png");
const LOCAL_BUNDLE_PATH = path.join(__dirname, "IFCRenderBundle.zip");

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

async function runPipeline() {
    try {
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

        const renderConfigPath = path.join(__dirname, 'render-config.json');
        const renderCfg = JSON.parse(fs.readFileSync(renderConfigPath, 'utf-8'));
        renderCfg.angle = CAMERA_ANGLE;
        renderCfg.lighting = LIGHTING === 'night' ? 'night' : 'daylight';
        renderCfg.quality = ['low', 'medium', 'high'].includes(QUALITY) ? QUALITY : 'high';
        renderCfg.interiorCenter = BBOX_CENTER;
        renderCfg.interiorSize = BBOX_SIZE;
        renderCfg.fov = Number.isFinite(Number(renderCfg.camera?.fov)) ? Number(renderCfg.camera.fov) : 45;
        renderCfg.staticResolution = { width: 3840, height: 2160 };
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
        if (!fs.existsSync(RESULT_PNG_PATH) || fs.statSync(RESULT_PNG_PATH).size < 1024) {
            throw new Error(`Autodesk completed but result.png is missing or unexpectedly small.`);
        }

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

if (require.main === module) {
    runPipeline();
}