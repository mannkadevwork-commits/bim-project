require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('./db');
const catalogRoutes = require('./catalog-routes');
const adminRoutes = require('./admin-routes');

const app = express();
app.use(cors());
app.use(express.json()); 

const { generate360ViewerFromGLB } = require('./aps-pipeline');

// 1. Ensure dynamic directories exist
const jobsDir = path.join(__dirname, 'jobs');
const assetsDir = path.join(__dirname, 'assets'); 
if (!fs.existsSync(jobsDir)) fs.mkdirSync(jobsDir);
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

// 2. Serve static folders publicly
app.use('/jobs', express.static(jobsDir));
app.use('/assets', express.static(assetsDir));

// Serve uploaded catalog files
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Mount catalog and admin API routes
app.use('/api/catalog', catalogRoutes);
app.use('/api/admin', adminRoutes);

// 3. Configure Multer for Dynamic Folders
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uniqueFolder = path.join(jobsDir, `job_${Date.now()}`);
    fs.mkdirSync(uniqueFolder, { recursive: true });
    
    const initialState = { materials: {}, furniture: [] };
    fs.writeFileSync(path.join(uniqueFolder, 'project_state.json'), JSON.stringify(initialState));
    
    cb(null, uniqueFolder);
  },
  filename: function (req, file, cb) {
    cb(null, 'input.ifc'); 
  }
});
const upload = multer({ storage: storage });

// ==========================================
// ASSETS & STATE API
// ==========================================
app.get('/api/assets', (req, res) => {
    const catalog = [
        { id: 'sofa', name: 'Modern Sofa', type: 'furniture', category: 'Furniture', url: '/assets/sofa.ifc' },
        { id: 'chair', name: 'Chair', type: 'furniture', category: 'Furniture', url: '/assets/chair.ifc' },
        { id: 'cabinet', name: 'Cabinet', type: 'furniture', category: 'Furniture', url: '/assets/cabinet.ifc' },
        { id: 'sink_mirror', name: 'Sink & Mirror', type: 'furniture', category: 'Furniture', url: '/assets/sink_mirror.ifc' },
        { id: 'commode', name: 'Commode', type: 'furniture', category: 'Furniture', url: '/assets/commode.ifc' },
        { id: 'wall', name: 'Wall', type: 'furniture', category: 'Furniture', url: '/assets/wall.ifc' },
        

        { id: 'door_3bhk', name: '3BHK Interior Door', type: 'door', category: 'Structural', url: '/assets/3BHK_Interior_Door.ifc' },
        { id: 'door_single', name: 'Single Flush Door', type: 'door', category: 'Structural', url: '/assets/Single_Flush_Door.ifc' },
        { id: 'door_double', name: 'Double Leaf Swing', type: 'door', category: 'Structural', url: '/assets/Double_Leaf_Swing_Door.ifc' },
        { id: 'door_sliding', name: 'Auto Sliding Door', type: 'door', category: 'Structural', url: '/assets/Automatic_Sliding_Door.ifc' },
        { id: 'door_revolving', name: 'Revolving Door', type: 'door', category: 'Structural', url: '/assets/Revolving_Commercial_Door.ifc' },
        { id: 'door_fire', name: 'Fire-Rated Door', type: 'door', category: 'Structural', url: '/assets/Fire_Rated_Door.ifc' },
        { id: 'bed_glb', name: 'Bed (GLB)', type: 'furniture', category: 'Furniture', url: '/assets/Bed.glb' },

    ];
    res.json(catalog);
});

app.post('/api/projects/:jobId/save', (req, res) => {
    try {
        const jobId = req.params.jobId;
        const jobDirPath = path.join(jobsDir, jobId);
        const statePath = path.join(jobDirPath, 'project_state.json');
        
        // FIX: If the directory for this job doesn't exist, create it dynamically
        if (!fs.existsSync(jobDirPath)) {
            fs.mkdirSync(jobDirPath, { recursive: true });
        }
        
        // FIX: accept both shapes callers use in this codebase —
        // useProjectSync's own autosave posts the state flat
        // ({ materials, furniture, structural_edits }), while
        // BIMViewer's manual-save/15s-interval autosave wraps it as
        // { projectState: {...} }. Writing req.body unconditionally
        // meant the wrapped shape landed in project_state.json verbatim,
        // so scene_merger.py's state.get("structural_edits"/"materials"/
        // "furniture") at the top level silently resolved to {}/[] and
        // every edit vanished from the render.
        const incomingState = req.body && req.body.projectState ? req.body.projectState : req.body;

        // Now safely write the state file
        fs.writeFileSync(statePath, JSON.stringify(incomingState, null, 2));
        res.json({ success: true, message: 'Design saved successfully' });
    } catch (error) {
        console.error("Save Error:", error);
        res.status(500).json({ error: 'Failed to save project state' });
    }
});

app.get('/api/projects/:jobId/load', (req, res) => {
    try {
        const jobId = req.params.jobId;
        const statePath = path.join(jobsDir, jobId, 'project_state.json');
        
        if (fs.existsSync(statePath)) {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            res.json(state);
        } else {
            res.json({ materials: {}, furniture: [] });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to load project state' });
    }
});


// Add a temporary upload handler
const tempUpload = multer({ dest: path.join(jobsDir, 'temp_uploads') });

// New endpoint to silently receive the IFC file from the frontend
app.post('/api/projects/:jobId/upload-ifc', tempUpload.single('file'), (req, res) => {
    try {
        const jobId = req.params.jobId;
        const jobDirPath = path.join(jobsDir, jobId);
        
        // Ensure the directory for this specific job exists
        if (!fs.existsSync(jobDirPath)) {
            fs.mkdirSync(jobDirPath, { recursive: true });
        }
        
        // Move the file from temp storage to the correct folder as 'input.ifc'
        const finalPath = path.join(jobDirPath, 'input.ifc');
        fs.renameSync(req.file.path, finalPath);
        
        res.json({ success: true, message: 'IFC synced to server for Python processing.' });
    } catch (error) {
        console.error("[Server] Sync Error:", error);
        res.status(500).json({ error: 'Failed to sync IFC file.' });
    }
});
// ==========================================
// AI FLOORPLAN CONVERSION API
// ==========================================

// Toggle between the legacy Gemini python script (spawn, blocking) and the
// new FastAPI YOLOv8 + IFC microservice (webhook, async).
const USE_ML_MODULE = false;
const ML_MODULE_URL = process.env.ML_MODULE_URL || 'http://localhost:8001';

// jobId -> { resolve, reject, timeout }
// Holds the original Express `res` handler open while we wait for the
// FastAPI microservice to POST the finished .ifc file back to our webhook.
const pendingFloorplanJobs = new Map();
const FLOORPLAN_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const floorplanStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uniqueFolder = path.join(jobsDir, `floorplan_${Date.now()}`);
    fs.mkdirSync(uniqueFolder, { recursive: true });
    cb(null, uniqueFolder);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `input_image${ext}`); 
  }
});
const uploadFloorplan = multer({ storage: floorplanStorage });

// ------------------------------------------
// Legacy pipeline: local Gemini python script via spawn.
// Wrapped in a Promise so it can share the same await-based route handler
// as the ML module branch below.
// ------------------------------------------
function runGeminiPipeline({ jobId, jobDir, imagePath, ifcFileName, ifcOutputPath }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'latest_interior_v2', 'automated_bim_v4_connected.py');
    const cachePath = path.join(jobDir, `${jobId}_cache.json`);

    console.log(`\n--- [ASYNC][GEMINI] AI Conversion Request | Job ID: ${jobId} ---`);

    const pythonProcess = spawn('python', [
      scriptPath,
      '--image', imagePath,
      '--output', ifcOutputPath,
      '--cache', cachePath,
      '--assets', assetsDir,
    ]);

    let pythonLogs = '';

    pythonProcess.stdout.on('data', (data) => {
      console.log(`[Python]: ${data}`);
      pythonLogs += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error(`[Python Error]: ${data}`);
      pythonLogs += data.toString();
    });

    pythonProcess.on('close', (code) => {
      console.log(`[Python] Process exited with code ${code}`);

      if (code !== 0 || !fs.existsSync(ifcOutputPath)) {
        return reject({ status: 500, body: { error: 'IFC file was not generated by the AI.', logs: pythonLogs } });
      }

      resolve({ ifcFileName });
    });
  });
}

// ------------------------------------------
// New pipeline: trigger the FastAPI ML microservice and hold the request
// open until it calls back our webhook with the finished .ifc file.
// ------------------------------------------
async function runMlModulePipeline({ jobId, jobDir, imagePath, req }) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers.host;
  const callbackUrl = `${protocol}://${host}/api/webhooks/ifc-ready/${jobId}`;

  console.log(`\n--- [ASYNC][ML MODULE] AI Conversion Request | Job ID: ${jobId} ---`);

  // Build the held-open promise BEFORE triggering the microservice so we
  // can never miss a webhook that fires unusually fast.
  const jobPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingFloorplanJobs.delete(jobId);
      reject({ status: 504, body: { error: 'Timed out waiting for ML module to generate IFC file.' } });
    }, FLOORPLAN_JOB_TIMEOUT_MS);

    pendingFloorplanJobs.set(jobId, { resolve, reject, timeout });
  });

  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const form = new FormData();
    form.append('image', new Blob([imageBuffer]), path.basename(imagePath));
    form.append('job_id', jobId);
    form.append('callback_url', callbackUrl);

    const triggerResponse = await fetch(`${ML_MODULE_URL}/api/generate-ifc-webhook`, {
      method: 'POST',
      body: form,
    });

    if (triggerResponse.status !== 202) {
      const pending = pendingFloorplanJobs.get(jobId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingFloorplanJobs.delete(jobId);
      }
      const errText = await triggerResponse.text().catch(() => '');
      throw { status: 502, body: { error: 'ML module rejected the conversion request.', details: errText } };
    }
  } catch (err) {
    const pending = pendingFloorplanJobs.get(jobId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingFloorplanJobs.delete(jobId);
    }
    if (err && err.status) throw err;
    throw { status: 502, body: { error: 'Failed to reach ML module.', details: err.message } };
  }

  // Held open here until /api/webhooks/ifc-ready/:jobId resolves it.
  return jobPromise;
}

app.post('/api/convert-floorplan', uploadFloorplan.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }

  const jobDir = req.file.destination;
  const jobId = path.basename(jobDir);
  const imagePath = path.join(jobDir, req.file.filename);
  const ifcFileName = `${jobId}_Generated.ifc`;
  const ifcOutputPath = path.join(jobDir, ifcFileName);

  try {
    let result;
    if (USE_ML_MODULE) {
      result = await runMlModulePipeline({ jobId, jobDir, imagePath, req });
    } else {
      result = await runGeminiPipeline({ jobId, jobDir, imagePath, ifcFileName, ifcOutputPath });
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const fileUrl = `${protocol}://${host}/jobs/${jobId}/${result.ifcFileName}`;

    res.json({
      success: true,
      message: 'Conversion successful',
      fileUrl: fileUrl,
      jobId: jobId
    });
  } catch (err) {
    const status = (err && err.status) || 500;
    const body = (err && err.body) || { error: 'Failed to convert floorplan.' };
    res.status(status).json(body);
  }
});

// ------------------------------------------
// Webhook receiver: the FastAPI ML module POSTs the finished .ifc file
// here once background processing completes. This resolves the promise
// that /api/convert-floorplan is still awaiting for the given jobId.
// ------------------------------------------
const webhookUpload = multer({ dest: path.join(jobsDir, 'temp_uploads') });

app.post('/api/webhooks/ifc-ready/:jobId', webhookUpload.single('ifc_file'), (req, res) => {
  const { jobId } = req.params;
  const pending = pendingFloorplanJobs.get(jobId);

  if (!pending) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: `No pending conversion job found for jobId ${jobId}.` });
  }

  clearTimeout(pending.timeout);
  pendingFloorplanJobs.delete(jobId);

  const success = req.body.success === undefined ? true : req.body.success === 'true' || req.body.success === true;

  if (!success || !req.file) {
    pending.reject({
      status: 500,
      body: { error: req.body.error || 'ML module reported failure or sent no IFC file.' }
    });
    return res.json({ received: true });
  }

  try {
    const jobDir = path.join(jobsDir, jobId);
    if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

    const ifcFileName = `${jobId}_Generated.ifc`;
    const finalPath = path.join(jobDir, ifcFileName);
    fs.renameSync(req.file.path, finalPath);

    pending.resolve({ ifcFileName });
    res.json({ received: true });
  } catch (err) {
    console.error(`[Webhook] Failed to save IFC for jobId ${jobId}:`, err);
    pending.reject({ status: 500, body: { error: 'Failed to save IFC file from webhook.' } });
    res.status(500).json({ received: false, error: err.message });
  }
});

// ==========================================
// ELEMENT EDITING API (resize/isolate native IFC elements e.g. walls)
// ==========================================
// Why this exists: xeokit only exposes position/scale/rotation at the
// MODEL level (confirmed in xeokit docs), not per-object, for the
// PerformanceModel representation that WebIFCLoaderPlugin/XKTLoaderPlugin
// use. A wall is one object inside the single big building model, so it
// has no independent transform. Editing it for real means rewriting its
// IFC geometry server-side (via ifcopenshell) and reloading just that
// element — these three routes do that.
const elementEditorScript = path.join(__dirname, 'ifc_element_editor.py');

// Runs the python script and resolves with its parsed JSON stdout.
// NOTE: spawnSync is used here (not the async spawn used for the AI
// floorplan conversion) because these operations are expected to be fast
// (single-element edits, not whole-model AI inference) and the route
// handlers below are written synchronously for simplicity. If element
// edits turn out to be slow in practice on large IFC files, switch this
// to the same async spawn + listener pattern used in /api/convert-floorplan.
const { spawnSync } = require('child_process');
const { log } = require('console');

function runElementEditor(args) {
  const result = spawnSync('python', [elementEditorScript, ...args], { encoding: 'utf-8' });

  if (result.error) {
    throw new Error(`Failed to launch ifc_element_editor.py: ${result.error.message}`);
  }

  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new Error(`ifc_element_editor.py produced no output. stderr: ${result.stderr}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`ifc_element_editor.py returned non-JSON output: ${stdout}`);
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  return parsed;
}

// GET current dimensions of a single element — used by the frontend to
// seed slider defaults with the element's REAL current size instead of
// guessing.
app.get('/api/elements/:jobId/:globalId/inspect', (req, res) => {
  try {
    const { jobId, globalId } = req.params;
    const inputIfcPath = path.join(jobsDir, jobId, 'input.ifc');

    if (!fs.existsSync(inputIfcPath)) {
      return res.status(404).json({ error: 'input.ifc not found for this job.' });
    }

    const data = runElementEditor(['inspect', '--input', inputIfcPath, '--global-id', globalId]);
    res.json(data);
  } catch (error) {
    console.error('[ElementEditor] Inspect failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST new height/width/length for an element. Rewrites a copy of the
// full IFC with that one element's geometry changed (does NOT touch the
// original input.ifc, so the user can discard the edit by just not using
// the new file).
app.post('/api/elements/:jobId/:globalId/resize', (req, res) => {
  try {
    const { jobId, globalId } = req.params;
    const { height, width, length } = req.body;

    if (height === undefined && width === undefined && length === undefined) {
      return res.status(400).json({ error: 'Provide at least one of height, width, length.' });
    }

    const jobDirPath = path.join(jobsDir, jobId);
    const inputIfcPath = path.join(jobDirPath, 'input.ifc');

    if (!fs.existsSync(inputIfcPath)) {
      return res.status(404).json({ error: 'input.ifc not found for this job.' });
    }

    const editsDir = path.join(jobDirPath, 'element_edits');
    if (!fs.existsSync(editsDir)) fs.mkdirSync(editsDir, { recursive: true });

    const outputFileName = `${globalId}_${Date.now()}.ifc`;
    const outputPath = path.join(editsDir, outputFileName);

    const args = ['resize', '--input', inputIfcPath, '--output', outputPath, '--global-id', globalId];
    if (height !== undefined) args.push('--height', String(height));
    if (width !== undefined) args.push('--width', String(width));
    if (length !== undefined) args.push('--length', String(length));

    const data = runElementEditor(args);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    res.json({
      ...data,
      // Frontend can fetch this and reload the model from it.
      fileUrl: `${protocol}://${host}/jobs/${jobId}/element_edits/${outputFileName}`,
    });
  } catch (error) {
    console.error('[ElementEditor] Resize failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST isolate a single element into its own standalone IFC, so the
// frontend can load it as an independent model (same mechanism furniture
// already uses) and get model-level transform sliders for free.
app.post('/api/elements/:jobId/:globalId/isolate', (req, res) => {
  try {
    const { jobId, globalId } = req.params;
    const jobDirPath = path.join(jobsDir, jobId);
    const inputIfcPath = path.join(jobDirPath, 'input.ifc');

    if (!fs.existsSync(inputIfcPath)) {
      return res.status(404).json({ error: 'input.ifc not found for this job.' });
    }

    const editsDir = path.join(jobDirPath, 'element_edits');
    if (!fs.existsSync(editsDir)) fs.mkdirSync(editsDir, { recursive: true });

    const outputFileName = `${globalId}_isolated.ifc`;
    const outputPath = path.join(editsDir, outputFileName);

    const data = runElementEditor(['isolate', '--input', inputIfcPath, '--output', outputPath, '--global-id', globalId]);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    res.json({
      ...data,
      fileUrl: `${protocol}://${host}/jobs/${jobId}/element_edits/${outputFileName}`,
    });
  } catch (error) {
    console.error('[ElementEditor] Isolate failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// POST insert a door into a native wall via CSG boolean difference.
// Node does NOT compute thickness/offset/bounding-box geometry — that's
// Phase 3's job entirely inside ifc_element_editor.py. This route's only
// responsibilities: validate the payload shape, relay it to Python
// verbatim, and hand back a fileUrl. Same "edit a copy, never touch
// input.ifc" pattern as /resize above.
//
// NOTE: spawn, not spawnSync. /resize, /isolate, and /rescale above all
// use spawnSync because they're cheap attribute/matrix edits. A CSG
// boolean difference against a wall's BRep is real geometry-kernel work
// and can run into multi-second territory on a complex wall — spawnSync
// would freeze the whole Node event loop (and every other in-flight
// request on this server) for that entire duration. This mirrors the
// async pattern already used for /api/convert-floorplan, which is the
// other genuinely slow Python call in this file.
app.post('/api/elements/:jobId/:globalId/insert-door', (req, res) => {
  try {
    const { jobId, globalId } = req.params;
    const { assetId, position, rotation, width, height, thickness } = req.body;

    console.log(`\n--- [CSG] Insert Door Request | Wall: ${globalId} | Asset: ${assetId} | Job: ${jobId} ---`);

    if (!assetId) {
      return res.status(400).json({ error: 'assetId is required.' });
    }
    const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));
    if (!isVec3(position)) {
      return res.status(400).json({ error: 'position must be an array of 3 numbers [x, y, z].' });
    }
    if (!isVec3(rotation)) {
      return res.status(400).json({ error: 'rotation must be an array of 3 numbers [x, y, z] in degrees.' });
    }

    const jobDirPath = path.join(jobsDir, jobId);
    const inputIfcPath = path.join(jobDirPath, 'input.ifc');

    if (!fs.existsSync(inputIfcPath)) {
      return res.status(404).json({ error: 'input.ifc not found for this job.' });
    }

    const editsDir = path.join(jobDirPath, 'element_edits');
    if (!fs.existsSync(editsDir)) fs.mkdirSync(editsDir, { recursive: true });

    const outputFileName = `${globalId}_door_${Date.now()}.ifc`;
    const outputPath = path.join(editsDir, outputFileName);

    const args = [
      elementEditorScript,
      'insert-door',
      '--input', inputIfcPath,
      '--output', outputPath,
      '--global-id', globalId,
      '--asset-id', String(assetId),
      '--position', position.join(','),
      '--rotation', rotation.join(','),
    ];

    // Pass-through only — Node performs no math on these, and they're
    // optional since Phase 3 may instead look dimensions up from
    // asset_registry.json via assetId.
    if (width !== undefined) args.push('--width', String(width));
    if (height !== undefined) args.push('--height', String(height));
    if (thickness !== undefined) args.push('--thickness', String(thickness));

    console.log(`\n--- [CSG] Insert Door Request | Wall: ${globalId} | Asset: ${assetId} | Job: ${jobId} ---`);

    const pythonProcess = spawn('python', args);

    let stdoutData = '';
    let stderrData = '';

    pythonProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
    pythonProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
      console.error(`[Python Error]: ${data}`);
    });

    pythonProcess.on('error', (err) => {
      console.error('[DoorInsert] Failed to launch ifc_element_editor.py:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: `Failed to launch Python: ${err.message}` });
      }
    });

    pythonProcess.on('close', (code) => {
      if (res.headersSent) return;

      const trimmedStdout = stdoutData.trim();

      if (code !== 0 || !fs.existsSync(outputPath)) {
        return res.status(500).json({
          error: 'Door insertion failed — no output IFC was produced.',
          logs: stderrData || trimmedStdout,
        });
      }

      // Tolerant JSON parse: the output file existing means the cut
      // succeeded even if stdout wasn't clean JSON (e.g. stray banner
      // text). Same spirit as the RENDER_RESULT_JSON: sentinel used
      // elsewhere in this pipeline — worth adopting here too in Phase 3
      // if ifc_element_editor.py starts printing anything besides JSON.
      let parsed = {};
      try {
        parsed = trimmedStdout ? JSON.parse(trimmedStdout) : {};
      } catch (e) {
        console.warn('[DoorInsert] Non-JSON stdout from ifc_element_editor.py:', trimmedStdout);
      }

      if (parsed.error) {
        return res.status(500).json({ error: parsed.error });
      }

      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers.host;

      res.json({
        ...parsed,
        success: true,
        fileUrl: `${protocol}://${host}/jobs/${jobId}/element_edits/${outputFileName}`,
      });
    });
  } catch (error) {
    console.error('[DoorInsert] Route exception:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// IFC GLOBAL RESCALE API
// ==========================================
app.post('/api/projects/:jobId/rescale', (req, res) => {
    const { jobId } = req.params;
    const { factor } = req.body;
    
    const jobDir = path.join(jobsDir, jobId);
    const inputPath = path.join(jobDir, 'input.ifc');
    const scriptPath = path.join(__dirname, 'ifc_element_editor.py');

    if (!fs.existsSync(inputPath)) {
        return res.status(404).json({ error: 'input.ifc not found for this job.' });
    }

    try {
        // Run python script and overwrite input.ifc with the new scaled version
        const child = require('child_process').spawnSync('python', [
            scriptPath, 'rescale', 
            '--input', inputPath, 
            '--output', inputPath, 
            '--factor', factor
        ], { encoding: 'utf-8' });

        // Safely log Python traceback to your Node console
        if (child.stderr && child.stderr.trim().length > 0) {
            console.error('[Python Error]', child.stderr.toString());
        }

        const stdoutTrimmed = (child.stdout || '').trim();
        
        // If Python crashed completely (empty output), send the stderr to the frontend!
        if (!stdoutTrimmed) {
             return res.status(500).json({ 
                 error: child.stderr ? `Python Crash: ${child.stderr.toString()}` : 'Python script crashed without output.' 
             });
        }
        
        const responseData = JSON.parse(child.stdout.trim());
        if (responseData.error) return res.status(500).json(responseData);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers.host; 
        
        res.json({ 
            success: true, 
            // ?v=Date.now() prevents the browser from caching the old small house
            fileUrl: `${protocol}://${host}/jobs/${jobId}/input.ifc?v=${Date.now()}` 
        });
    } catch (error) {
        console.error('[Server] Rescale route exception:', error.message);
        res.status(500).json({ error: `Server exception: ${error.message}` });
    }
});

// ==========================================
// RENDER API
// ==========================================

// ==========================================
// RENDER API (Reverted to APS Pipeline)
// ==========================================
app.post('/api/render', upload.single('ifcFile'), (req, res) => {
  try {
    const angle = req.body.angle || '360'; 
    const lighting = req.body.lighting || 'daylight';
    
    let jobDir, jobId;

    if (req.file) {
        jobDir = req.file.destination; 
        jobId = path.basename(jobDir); 
    } else if (req.body.jobId) {
        jobId = req.body.jobId;
        jobDir = path.join(jobsDir, jobId);
        if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'Job directory not found.' });
    } else {
        return res.status(400).json({ error: 'Missing IFC file or jobId for rendering.' });
    }

    const inputIfcPath = path.join(jobDir, 'input.ifc');
    if (!fs.existsSync(inputIfcPath)) {
        const generatedIfcPath = path.join(jobDir, `${jobId}_Generated.ifc`);
        if (fs.existsSync(generatedIfcPath)) {
            fs.copyFileSync(generatedIfcPath, inputIfcPath);
        } else {
            return res.status(400).json({ error: 'input.ifc or AI-generated IFC not found.' });
        }
    }

    const projectStatePath = path.join(jobDir, 'project_state.json');
    if (req.body.projectState) {
        const stateData = typeof req.body.projectState === 'string' 
            ? req.body.projectState 
            : JSON.stringify(req.body.projectState);
        fs.writeFileSync(projectStatePath, stateData);
    } else if (!fs.existsSync(projectStatePath)) {
        fs.writeFileSync(projectStatePath, JSON.stringify({ materials: {}, furniture: [] }));
    }
    
    console.log(`\n--- [APS REVERT] Render Request | Angle: ${angle} | Lighting: ${lighting} | Job ID: ${jobId} ---`);

    // ==========================================
    // BLENDER PIPELINE (TEMPORARILY COMMENTED OUT)
    // ==========================================
    /*
    const blenderScriptPath = path.join(__dirname, 'blender_render.py');
    let outputFileName = 'result.png';
    if (angle === 'top_down') outputFileName = 'top_down_plan.png';
    else if (angle === '360') outputFileName = 'pano_360.png';
    else if (angle === 'side') outputFileName = 'side_elevation.png';
    
    const resultImgPath = path.join(jobDir, outputFileName);
    const { exec } = require('child_process');
    const blenderCmd = `blender --background --python "${blenderScriptPath}" -- --ifc "${inputIfcPath}" --state "${projectStatePath}" --output "${resultImgPath}" --job-dir "${jobDir}" --angle "${angle}" --lighting "${lighting}"`;

    exec(blenderCmd, { maxBuffer: 1024 * 1024 * 50 }, (pipelineError, stdout, stderr) => { ... });
    */

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    // ==========================================
    // NEW GLB COMPILER PIPELINE — 360 ONLY
    // ==========================================
    if (angle === "360") {

    const compilerScriptPath = path.join(__dirname, "compiler", "compiler.ts");
    const outputGlbPath = path.join(jobDir, "output.glb");

    console.log(`\n--- [GLB COMPILER] Render Request | Job ID: ${jobId} ---`);

    try {
        execSync(
            `npx tsx "${compilerScriptPath}" "${jobDir}" "${assetsDir}"`,
            {
                stdio: "inherit",
                cwd: __dirname,
                env: { ...process.env }
            }
        );
    } catch (err) {
        console.error("GLB compiler failed.", err.message);
        return res.status(500).json({
            error: "Failed to compile GLB scene."
        });
    }

    if (!fs.existsSync(outputGlbPath)) {
        return res.status(500).json({
            error: "output.glb was not generated."
        });
    }

    try {
        generate360ViewerFromGLB(jobDir);
    } catch (err) {
        console.error(err);
        return res.status(500).json({
            error: "Failed to generate 360 viewer."
        });
    }

    return res.json({
        type: "360",
        url: `${baseUrl}/jobs/${jobId}/360_viewer.html`,
        jobId
    });
}

    // ==========================================
    // APS PIPELINE — UNCHANGED, all non-360 angles
    // ==========================================
    try {
      // Execute the APS script exactly how it was running previously
      execSync(`node aps-pipeline.js ${angle} "${jobDir}" ${lighting}`, { stdio: 'inherit', env: { ...process.env, ASSET_DIR: assetsDir } });
    } catch (pipelineError) {
      console.error("APS Pipeline script failed.");
      return res.status(500).json({ error: 'Failed to execute Autodesk pipeline.' });
    }

    // Return the exact URL the old frontend logic expects for non-360
    res.json({ type: 'image', url: `${baseUrl}/jobs/${jobId}/result.png`, jobId: jobId });

  } catch (error) {
    console.error("Render API Error:", error.message);
    res.status(500).json({ error: 'Failed to process render request' });
  }
});

app.delete('/api/projects/:jobId', (req, res) => {
    try {
        const jobId = req.params.jobId;
        const jobDirPath = path.join(jobsDir, jobId);
        
        // Completely wipe the job folder from the server
        if (fs.existsSync(jobDirPath)) {
            fs.rmSync(jobDirPath, { recursive: true, force: true });
        }
        
        res.json({ success: true, message: 'Project completely wiped from server' });
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ error: 'Failed to delete project from server' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 HC Interior Backend running on port ${PORT}`);
});

// Verify DB connection on startup
db.query('SELECT 1').then(() => {
  console.log('✅ PostgreSQL connected');
}).catch(err => {
  console.error('❌ PostgreSQL connection failed:', err.message);
});