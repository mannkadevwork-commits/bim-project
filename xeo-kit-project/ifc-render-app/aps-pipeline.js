require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

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
// Every Autodesk submission gets unique OSS object keys, even when it renders the same project.
const RENDER_ID = process.env.RENDER_ID || `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

const LOCAL_IFC_PATH = path.join(JOB_DIR, "input.ifc");
const LOCAL_STATE_PATH = path.join(JOB_DIR, "project_state.json");
const LOCAL_OBJ_PATH = path.join(JOB_DIR, "input.obj");
const LOCAL_MTL_PATH = path.join(JOB_DIR, "input.mtl");
const LOCAL_SCENE_PACKAGE_PATH = path.join(JOB_DIR, "scene_package.zip");
const CAMERA_JSON_PATH = path.join(JOB_DIR, "camera.json");
const RESULT_PNG_PATH = process.env.RENDER_OUTPUT_PATH
    ? path.resolve(process.env.RENDER_OUTPUT_PATH)
    : path.join(JOB_DIR, "result.png");
const LOCAL_BUNDLE_PATH = path.join(__dirname, "IFCRenderBundle.zip");

const CLOUD_OBJ_KEY = `${JOB_ID}_${RENDER_ID}_input.obj`;
const CLOUD_PACKAGE_KEY = `${JOB_ID}_${RENDER_ID}_scene_package.zip`;
const CLOUD_CAM_KEY = `${JOB_ID}_${RENDER_ID}_camera.json`;
const CLOUD_OUT_KEY = `${JOB_ID}_${RENDER_ID}_result.png`;
const CLOUD_DIAG_KEY = `${JOB_ID}_${RENDER_ID}_diag.txt`;

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

const APS_DA_BASE = 'https://developer.api.autodesk.com/da/us-east/v3';
const APS_DEPLOY_BUNDLE = process.env.APS_DEPLOY_RENDER_BUNDLE === '1';
const APS_DEPLOY_ACTIVITY = process.env.APS_DEPLOY_RENDER_ACTIVITY === '1';

function apsHeaders(token) {
    return { Authorization: `Bearer ${token}` };
}

async function getOptionalApsResource(url, token) {
    try {
        const response = await axios.get(url, { headers: apsHeaders(token) });
        return response.data;
    } catch (error) {
        if (error.response?.status === 404) return null;
        throw error;
    }
}

async function getAliasVersion(token, resourceType, resourceId, aliasId) {
    const url = `${APS_DA_BASE}/${resourceType}/${resourceId}/aliases/${aliasId}`;
    const alias = await getOptionalApsResource(url, token);
    const version = Number(alias?.version);
    return Number.isInteger(version) && version > 0 ? version : null;
}

async function getLatestVersion(token, resourceType, resourceId) {
    const url = `${APS_DA_BASE}/${resourceType}/${resourceId}/versions`;
    const result = await getOptionalApsResource(url, token);
    const entries = Array.isArray(result?.data) ? result.data : [];
    const versions = entries
        .map(entry => Number(typeof entry === 'object' ? entry?.version : entry))
        .filter(value => Number.isInteger(value) && value > 0);
    return versions.length ? Math.max(...versions) : null;
}

async function ensureAlias(token, resourceType, resourceId, aliasId, targetVersion) {
    if (!Number.isInteger(Number(targetVersion)) || Number(targetVersion) < 1) {
        throw new Error(`Cannot assign ${resourceType}/${resourceId}+${aliasId}: invalid version ${targetVersion}.`);
    }
    const root = `${APS_DA_BASE}/${resourceType}/${resourceId}`;
    const aliasUrl = `${root}/aliases/${aliasId}`;
    const currentVersion = await getAliasVersion(token, resourceType, resourceId, aliasId);
    if (currentVersion === Number(targetVersion)) return;

    if (currentVersion !== null) {
        await axios.patch(aliasUrl, { version: Number(targetVersion) }, { headers: apsHeaders(token) });
        return;
    }

    try {
        await axios.post(`${root}/aliases`, { id: aliasId, version: Number(targetVersion) }, { headers: apsHeaders(token) });
    } catch (error) {
        // A concurrent deployment may have created the alias after our GET.
        if (error.response?.status !== 409) throw error;
        await axios.patch(aliasUrl, { version: Number(targetVersion) }, { headers: apsHeaders(token) });
    }
}

function validateBundleZip() {
    if (!fs.existsSync(LOCAL_BUNDLE_PATH)) {
        throw new Error(`Missing AppBundle ZIP: ${LOCAL_BUNDLE_PATH}. It is only required when creating/deploying the bundle.`);
    }
    const zipStats = fs.statSync(LOCAL_BUNDLE_PATH);
    if (zipStats.size < 100) {
        throw new Error(`Invalid AppBundle ZIP: file is only ${zipStats.size} bytes.`);
    }
    return zipStats.size;
}

async function uploadAppBundleVersion(token, uploadParameters) {
    if (!uploadParameters?.endpointURL || !uploadParameters?.formData) {
        throw new Error('Autodesk did not return valid AppBundle upload parameters.');
    }
    const bundleForm = new FormData();
    Object.keys(uploadParameters.formData).forEach(key => bundleForm.append(key, uploadParameters.formData[key]));
    bundleForm.append('file', fs.createReadStream(LOCAL_BUNDLE_PATH));
    await axios.post(uploadParameters.endpointURL, bundleForm, { headers: bundleForm.getHeaders() });
}

async function ensureAppBundle(token) {
    const root = `${APS_DA_BASE}/appbundles`;
    const aliasVersion = await getAliasVersion(token, 'appbundles', BUNDLE_ID, ALIAS);

    // Normal renders must reuse the approved alias; never publish a new version per render.
    if (aliasVersion !== null && !APS_DEPLOY_BUNDLE) {
        console.log(`✔️ Reusing AppBundle ${BUNDLE_ID}+${ALIAS} (version ${aliasVersion}).`);
        return aliasVersion;
    }

    // IMPORTANT: GET /appbundles/:id requires a fully qualified ID
    // (nickname.bundle+alias). The version-list endpoint accepts the unqualified
    // bundle ID, so use it to discover existing versions and avoid an invalid
    // GET /appbundles/IFCRenderBundle_v2 request (400: "Cannot parse id.").
    const latest = await getLatestVersion(token, 'appbundles', BUNDLE_ID);
    if (latest !== null && !APS_DEPLOY_BUNDLE) {
        await ensureAlias(token, 'appbundles', BUNDLE_ID, ALIAS, latest);
        console.log(`✔️ Restored missing AppBundle alias ${ALIAS} -> version ${latest}; no version was created.`);
        return latest;
    }

    const zipSize = validateBundleZip();
    console.log(`✔️ AppBundle ZIP ready (${zipSize} bytes).`);

    let registration;
    if (latest !== null) {
        console.log('⚙️ Explicit AppBundle deployment requested; creating one controlled new version.');
        registration = await axios.post(`${root}/${BUNDLE_ID}/versions`, { engine: ENGINE }, { headers: apsHeaders(token) });
    } else {
        console.log('⚙️ AppBundle has no existing versions; creating its first version.');
        try {
            registration = await axios.post(root, { id: BUNDLE_ID, engine: ENGINE }, { headers: apsHeaders(token) });
        } catch (error) {
            if (error.response?.status !== 409) throw error;
            // Another process may have created the first version concurrently.
            const concurrentlyCreatedVersion = await getLatestVersion(token, 'appbundles', BUNDLE_ID);
            if (!concurrentlyCreatedVersion) throw error;
            await ensureAlias(token, 'appbundles', BUNDLE_ID, ALIAS, concurrentlyCreatedVersion);
            console.log(`✔️ Reused concurrently-created AppBundle version ${concurrentlyCreatedVersion}.`);
            return concurrentlyCreatedVersion;
        }
    }

    await uploadAppBundleVersion(token, registration.data.uploadParameters);
    let version = Number(registration.data.version);
    if (!Number.isInteger(version) || version < 1) {
        version = await getLatestVersion(token, 'appbundles', BUNDLE_ID);
    }
    if (!Number.isInteger(version) || version < 1) {
        throw new Error('Autodesk AppBundle upload completed but its version could not be identified.');
    }
    await ensureAlias(token, 'appbundles', BUNDLE_ID, ALIAS, version);
    console.log(`✔️ AppBundle ${BUNDLE_ID}+${ALIAS} now points to version ${version}.`);
    return version;
}

async function ensureActivity(token, activitySpec) {
    const root = `${APS_DA_BASE}/activities`;
    const aliasVersion = await getAliasVersion(token, 'activities', ACTIVITY_ID, ALIAS);

    if (aliasVersion !== null && !APS_DEPLOY_ACTIVITY) {
        console.log(`✔️ Reusing Activity ${ACTIVITY_ID}+${ALIAS} (version ${aliasVersion}).`);
        return aliasVersion;
    }

    // As with AppBundles, GET /activities/:id needs a qualified ID. Use the
    // unqualified versions endpoint for safe existence/version discovery.
    const latest = await getLatestVersion(token, 'activities', ACTIVITY_ID);
    if (latest !== null && !APS_DEPLOY_ACTIVITY) {
        await ensureAlias(token, 'activities', ACTIVITY_ID, ALIAS, latest);
        console.log(`✔️ Restored missing Activity alias ${ALIAS} -> version ${latest}; no version was created.`);
        return latest;
    }

    let registration;
    if (latest !== null) {
        const { id, ...versionSpec } = activitySpec;
        console.log('⚙️ Explicit Activity deployment requested; creating one controlled new version.');
        registration = await axios.post(`${root}/${ACTIVITY_ID}/versions`, versionSpec, { headers: apsHeaders(token) });
    } else {
        try {
            registration = await axios.post(root, activitySpec, { headers: apsHeaders(token) });
        } catch (error) {
            if (error.response?.status !== 409) throw error;
            const concurrentlyCreatedVersion = await getLatestVersion(token, 'activities', ACTIVITY_ID);
            if (!concurrentlyCreatedVersion) throw error;
            await ensureAlias(token, 'activities', ACTIVITY_ID, ALIAS, concurrentlyCreatedVersion);
            console.log(`✔️ Reused concurrently-created Activity version ${concurrentlyCreatedVersion}.`);
            return concurrentlyCreatedVersion;
        }
    }

    let version = Number(registration.data.version);
    if (!Number.isInteger(version) || version < 1) {
        version = await getLatestVersion(token, 'activities', ACTIVITY_ID);
    }
    if (!Number.isInteger(version) || version < 1) {
        throw new Error('Autodesk Activity was registered but its version could not be identified.');
    }
    await ensureAlias(token, 'activities', ACTIVITY_ID, ALIAS, version);
    console.log(`✔️ Activity ${ACTIVITY_ID}+${ALIAS} now points to version ${version}.`);
    return version;
}

async function runPipeline() {
    try {
        console.log(`\n--- Preparing render snapshot ${RENDER_ID} for job ${JOB_ID} ---`);
        if (!fs.existsSync(LOCAL_IFC_PATH)) {
            throw new Error(`Render input IFC is missing: ${LOCAL_IFC_PATH}`);
        }
        if (!fs.existsSync(LOCAL_STATE_PATH)) {
            throw new Error(`Saved editor state is missing: ${LOCAL_STATE_PATH}. Still renders must use the current job_id project_state.json.`);
        }

        // OBJ/MTL/camera files are generated artifacts. Remove them first so a failed or
        // material-free compositor run cannot accidentally reuse files from an older render.
        for (const generatedPath of [LOCAL_OBJ_PATH, LOCAL_MTL_PATH, LOCAL_SCENE_PACKAGE_PATH, CAMERA_JSON_PATH]) {
            try { if (fs.existsSync(generatedPath)) fs.unlinkSync(generatedPath); } catch (cleanupError) {
                throw new Error(`Cannot clear stale render artifact ${generatedPath}: ${cleanupError.message}`);
            }
        }

        let snapshotState;
        try {
            snapshotState = JSON.parse(fs.readFileSync(LOCAL_STATE_PATH, 'utf8')) || {};
        } catch (stateError) {
            throw new Error(`project_state.json is not valid JSON: ${stateError.message}`);
        }
        const expectedFurnitureCount = Array.isArray(snapshotState.furniture) ? snapshotState.furniture.length : 0;
        const expectedMaterialCount = snapshotState.materials && typeof snapshotState.materials === 'object'
            ? Object.keys(snapshotState.materials).length : 0;
        console.log(`Snapshot inventory: ${expectedFurnitureCount} placed asset(s), ${expectedMaterialCount} material definition(s), ` +
            `${Object.keys(snapshotState.structural_edits || {}).length} structural edit(s).`);

        console.log("--- Merging IFC + saved editor state (GLB/IFC assets, transforms, colors and textures) ---");
        console.log("    Reads input.ifc + current job_id/project_state.json and prepares OBJ + MTL + texture package for Autodesk 3ds Max.");

        const mergeArgs = [
            path.join(__dirname, 'scene_merger.py'),
            '--ifc', LOCAL_IFC_PATH,
            '--state', LOCAL_STATE_PATH,
            '--output', LOCAL_OBJ_PATH,
            '--job-dir', JOB_DIR
        ];

        if (process.env.ASSET_DIR) {
            mergeArgs.push('--asset-dir', process.env.ASSET_DIR);
        }

        const merge = spawnSync('python', mergeArgs, { encoding: 'utf-8', cwd: __dirname });

        if (merge.stderr && merge.stderr.trim()) {
            console.log(merge.stderr.trim());
        }
        if (merge.error) {
            throw new Error(`Failed to launch scene_merger.py: ${merge.error.message}`);
        }
        if (merge.status !== 0) {
            throw new Error(`scene_merger.py exited with code ${merge.status}. Check the diagnostics printed above.`);
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

        console.log(`✔️ Merged scene ready — ${mergeInfo.furniture_count} placed asset(s), ` +
            `${mergeInfo.materials_applied} material override(s), ${mergeInfo.texture_count || 0} exported texture image(s).`);
        if (!fs.existsSync(LOCAL_OBJ_PATH) || fs.statSync(LOCAL_OBJ_PATH).size < 1024) {
            throw new Error(`Scene merger reported success but input.obj is missing or too small at ${LOCAL_OBJ_PATH}.`);
        }
        if (!fs.existsSync(LOCAL_SCENE_PACKAGE_PATH) || fs.statSync(LOCAL_SCENE_PACKAGE_PATH).size < 100) {
            throw new Error(`Scene merger did not create the texture/material package at ${LOCAL_SCENE_PACKAGE_PATH}.`);
        }
        if (expectedFurnitureCount > 0 && Number(mergeInfo.furniture_count) !== expectedFurnitureCount) {
            const warningList = Array.isArray(mergeInfo.warnings) ? mergeInfo.warnings.join(' | ') : '';
            throw new Error(`Incomplete scene refused: saved state has ${expectedFurnitureCount} placed asset(s), but only ${mergeInfo.furniture_count} merged. No Autodesk render was submitted. ${warningList}`);
        }
        if (mergeInfo.warnings && mergeInfo.warnings.length) {
            mergeInfo.warnings.forEach(w => console.warn(`   ⚠️  ${w}`));
            const materialFailures = mergeInfo.warnings.filter(w => /material override failed/i.test(String(w)));
            if (materialFailures.length) {
                throw new Error(
                    `Render refused because ${materialFailures.length} saved material/texture override(s) could not be applied. ` +
                    `No Autodesk render was submitted. Details: ${materialFailures.join(' | ')}`
                );
            }
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

        console.log("\n--- Resolving Autodesk AppBundle ---");
        const bundleVersion = await ensureAppBundle(token);
        console.log(`✔️ AppBundle ready at version ${bundleVersion}.`);

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
        const activityVersion = await ensureActivity(token, activitySpec);
        console.log(`✔️ Activity ready at version ${activityVersion}.`);

        console.log("\n--- Preparing Storage & Upload ---");
        try {
            await axios.post('https://developer.api.autodesk.com/oss/v2/buckets',
                { bucketKey: BUCKET_KEY, policyKey: 'transient' }, { headers: { 'Authorization': `Bearer ${token}` } });
        } catch (e) {}

        await uploadFileToOSS(token, BUCKET_KEY, CLOUD_OBJ_KEY, LOCAL_OBJ_PATH);
        // The already-deployed APS Activity exposes only one optional material
        // input. Send a ZIP scene package through that slot: the updated render.ms
        // recognizes and extracts it, so all texture images travel with the MTL.
        // This keeps the Activity schema stable; only AppBundle code needs updating.
        await uploadFileToOSS(token, BUCKET_KEY, CLOUD_PACKAGE_KEY, LOCAL_SCENE_PACKAGE_PATH);
        console.log(`✔️ Uploaded self-contained scene package (${fs.statSync(LOCAL_SCENE_PACKAGE_PATH).size} bytes).`);

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
        workItemArgs.MaterialFile = {
            url: `urn:adsk.objects:os.object:${BUCKET_KEY}/${CLOUD_PACKAGE_KEY}`,
            headers: { "Authorization": `Bearer ${token}` }
        };

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

        fs.mkdirSync(path.dirname(RESULT_PNG_PATH), { recursive: true });
        fs.writeFileSync(RESULT_PNG_PATH, Buffer.from(fileRes.data));
        if (!fs.existsSync(RESULT_PNG_PATH) || fs.statSync(RESULT_PNG_PATH).size < 1024) {
            throw new Error(`Autodesk completed but the output PNG is missing or unexpectedly small.`);
        }
        const imageMetadata = await sharp(RESULT_PNG_PATH).metadata();
        if (imageMetadata.format !== 'png') {
            throw new Error(`Autodesk output is not a valid PNG (detected format: ${imageMetadata.format || 'unknown'}).`);
        }
        if (imageMetadata.width !== 3840 || imageMetadata.height !== 2160) {
            throw new Error(`Autodesk output is ${imageMetadata.width}x${imageMetadata.height}; expected 3840x2160 UHD. The render bundle must apply camera.json staticResolution.`);
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
            console.error(`Endpoint Failed: ${err.config?.url || 'unknown endpoint'}`);
            console.error("\n--- AUTODESK ERROR DETAILS ---");
            console.error(JSON.stringify(err.response.data, null, 2));
            console.error("------------------------------\n");

            if (err.response.status === 403) {
                const errorStr = JSON.stringify(err.response.data);
                if (errorStr.includes("Maximum number of versions is 100")) {
                    console.error("\n💡 APS deployment quota is exhausted. Normal renders now reuse existing prod aliases. To deploy new code, clean up unused APS AppBundle/Activity versions, then set APS_DEPLOY_RENDER_BUNDLE=1 and/or APS_DEPLOY_RENDER_ACTIVITY=1 for one deliberate deployment.");
                } else if (errorStr.includes("Developer is not subscribed") || errorStr.includes("Not Authorized")) {
                    console.error("💡 Design Automation API is not enabled for this APS Client ID.");
                } else if (errorStr.includes("SignatureDoesNotMatch")) {
                    console.error("💡 APS signed upload was rejected; verify the upload parameters and bundle ZIP.");
                } else {
                    console.error("💡 APS denied the request. See the response details above; check permissions and resource IDs.");
                }
            }
        } else if (err.request) {
            console.error("No response received from Autodesk. Check network connection.");
        } else {
            console.error("Error setting up request:", err.message);
        }
        // Critical: the Express caller must receive a non-zero child exit status on failure.
        process.exitCode = 1;
    }
}

if (require.main === module) {
    runPipeline().catch(error => {
        console.error('[APS pipeline] Unhandled failure:', error?.stack || error);
        process.exitCode = 1;
    });
}
