require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
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
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
const materialAssetsDir = path.join(assetsDir, 'materials');
if (!fs.existsSync(materialAssetsDir)) fs.mkdirSync(materialAssetsDir, { recursive: true });

// Project/job identity + manifest helpers.
function generateJobId() {
  let id;
  do {
    id = `job_${crypto.randomBytes(6).toString('hex')}`;
  } while (fs.existsSync(path.join(jobsDir, id)));
  return id;
}

function readManifest(jobDir) {
  const manifestPath = path.join(jobDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function writeManifest(jobDir, manifest) {
  fs.writeFileSync(path.join(jobDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function touchManifest(jobDir) {
  const manifest = readManifest(jobDir);
  if (manifest) {
    manifest.updatedAt = new Date().toISOString();
    writeManifest(jobDir, manifest);
  }
}

// HELPER: Require active project to block archived edits
function requireActiveProject(jobId, res) {
    const jobDir = path.join(jobsDir, jobId);
    if (!fs.existsSync(jobDir)) {
        res.status(404).json({ error: `Project ${jobId} not found. Create a project via POST /api/projects first.` });
        return false;
    }
    const manifest = readManifest(jobDir);
    if (manifest && manifest.status === 'archived') {
        res.status(403).json({ error: `Project ${jobId} is archived and cannot be modified.` });
        return false;
    }
    return true;
}

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

const renderUpload = multer({ storage: multer.memoryStorage() });
const projectCreateUpload = multer({ storage: multer.memoryStorage() });

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


// ==========================================
// PREDEFINED IFC LAYOUTS API
// ==========================================

// These are the same IFC files used by the initial UploadModal.
const PREDEFINED_LAYOUTS = [
    {
        id: '1bhk',
        name: '1 BHK Layout',
        description: 'Compact single bedroom structure',
        fileName: '1_BHK_Detailed.ifc',
        assetPath: path.join(assetsDir, '1_BHK_Detailed.ifc'),
        fileUrl: '/assets/1_BHK_Detailed.ifc',
    },
    {
        id: '3bhk',
        name: '3 BHK Layout',
        description: 'Spacious three bedroom family home',
        fileName: '3_BHK.ifc',
        assetPath: path.join(assetsDir, '3_BHK.ifc'),
        fileUrl: '/assets/3_BHK.ifc',
    },
];

app.get('/api/layouts', (req, res) => {
    res.json({
        layouts: PREDEFINED_LAYOUTS.map(({ assetPath, ...layout }) => ({
            ...layout,
            available: fs.existsSync(assetPath),
        })),
    });
});

// ==========================================
// SWITCH PROJECT LAYOUT API
// ==========================================
// ==========================================
// SWITCH PROJECT LAYOUT API
// ==========================================
app.post('/api/projects/:jobId/layout', (req, res) => {
    try {
        const oldJobId = req.params.jobId;
        const { layoutId } = req.body;

        const layout = PREDEFINED_LAYOUTS.find(l => l.id === layoutId);
        if (!layout) {
            return res.status(404).json({ error: 'Requested layout not found.' });
        }

        const oldJobDir = path.join(jobsDir, oldJobId);

        if (fs.existsSync(oldJobDir)) {
            const oldManifest = readManifest(oldJobDir) || {
                jobId: oldJobId,
                originalFileName: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                status: 'active'
            };

            if (oldManifest.status !== 'archived') {
                oldManifest.status = 'archived';
                oldManifest.updatedAt = new Date().toISOString();
                writeManifest(oldJobDir, oldManifest);
            }
        }

        const newJobId = generateJobId();
        const newJobDir = path.join(jobsDir, newJobId);
        fs.mkdirSync(newJobDir, { recursive: true });

        if (fs.existsSync(layout.assetPath)) {
            fs.copyFileSync(layout.assetPath, path.join(newJobDir, 'original.ifc'));
            fs.copyFileSync(layout.assetPath, path.join(newJobDir, 'input.ifc'));
        } else {
            return res.status(500).json({ error: `Layout IFC file missing on server: ${layout.fileName}` });
        }

        fs.writeFileSync(
            path.join(newJobDir, 'project_state.json'),
            JSON.stringify({ materials: {}, furniture: [] }, null, 2)
        );

        const now = new Date().toISOString();
        writeManifest(newJobDir, {
            jobId: newJobId,
            originalFileName: layout.fileName,
            createdAt: now,
            updatedAt: now,
            status: 'active'
        });

        // Construct absolute URL so frontend routes to port 3000 instead of 5173
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers.host;
        
        res.json({ 
            success: true, 
            archivedJobId: oldJobId, 
            newJobId: newJobId,
            fileName: layout.fileName,
            fileUrl: `${protocol}://${host}/jobs/${newJobId}/original.ifc`
        });

    } catch (error) {
        console.error("Layout Switch Error:", error);
        res.status(500).json({ error: 'Failed to switch layout' });
    }
});

// ==========================================
// PROJECT LIFECYCLE API
// ==========================================

// Creates exactly one new project for one uploaded IFC. 
app.post('/api/projects', projectCreateUpload.single('ifcFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No IFC file uploaded (expected field "ifcFile").' });
        }

        const jobId = generateJobId();
        const jobDir = path.join(jobsDir, jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        // original.ifc is strictly immutable
        fs.writeFileSync(path.join(jobDir, 'original.ifc'), req.file.buffer);
        fs.writeFileSync(path.join(jobDir, 'input.ifc'), req.file.buffer);
        fs.writeFileSync(path.join(jobDir, 'project_state.json'), JSON.stringify({ materials: {}, furniture: [] }, null, 2));

        const now = new Date().toISOString();
        const manifest = {
            jobId,
            originalFileName: req.file.originalname || null,
            createdAt: now,
            updatedAt: now,
            status: 'active'
        };
        writeManifest(jobDir, manifest);

        res.json({ success: true, jobId, manifest });
    } catch (error) {
        console.error("Project Create Error:", error);
        res.status(500).json({ error: 'Failed to create project' });
    }
});

app.get('/api/projects', (req, res) => {
    try {
        const entries = fs.readdirSync(jobsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);

        const projects = entries
            .map((name) => readManifest(path.join(jobsDir, name)))
            .filter(Boolean)
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        res.json({ projects });
    } catch (error) {
        console.error("List Projects Error:", error);
        res.status(500).json({ error: 'Failed to list projects' });
    }
});

app.post('/api/projects/:jobId/save', (req, res) => {
    try {
        const jobId = req.params.jobId;
        if (!requireActiveProject(jobId, res)) return;

        const jobDirPath = path.join(jobsDir, jobId);
        const statePath = path.join(jobDirPath, 'project_state.json');

        const incomingState = req.body && req.body.projectState ? req.body.projectState : req.body;
        fs.writeFileSync(statePath, JSON.stringify(incomingState, null, 2));
        
        touchManifest(jobDirPath);
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

const tempUpload = multer({ dest: path.join(jobsDir, 'temp_uploads') });

app.post('/api/projects/:jobId/upload-ifc', tempUpload.single('file'), (req, res) => {
    try {
        const jobId = req.params.jobId;
        if (!requireActiveProject(jobId, res)) {
            if (req.file) fs.unlink(req.file.path, () => {});
            return;
        }

        const jobDirPath = path.join(jobsDir, jobId);
        const finalPath = path.join(jobDirPath, 'input.ifc');
        
        fs.renameSync(req.file.path, finalPath);
        touchManifest(jobDirPath);

        res.json({ success: true, message: 'IFC synced to server for Python processing.' });
    } catch (error) {
        console.error("[Server] Sync Error:", error);
        res.status(500).json({ error: 'Failed to sync IFC file.' });
    }
});

// ==========================================
// AI FLOORPLAN CONVERSION API
// ==========================================
const USE_ML_MODULE = false;
const ML_MODULE_URL = process.env.ML_MODULE_URL || 'http://localhost:8001';
const pendingFloorplanJobs = new Map();
const FLOORPLAN_JOB_TIMEOUT_MS = 10 * 60 * 1000;

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

function runGeminiPipeline({ jobId, jobDir, imagePath, ifcFileName, ifcOutputPath }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'latest_interior_v2', 'automated_bim_v4_connected.py');
    const cachePath = path.join(jobDir, `${jobId}_cache.json`);

    const pythonProcess = spawn('python', [
      scriptPath, '--image', imagePath, '--output', ifcOutputPath, '--cache', cachePath, '--assets', assetsDir,
    ]);

    let pythonLogs = '';
    pythonProcess.stdout.on('data', (data) => { pythonLogs += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { pythonLogs += data.toString(); });

    pythonProcess.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(ifcOutputPath)) {
        return reject({ status: 500, body: { error: 'IFC file was not generated by the AI.', logs: pythonLogs } });
      }
      resolve({ ifcFileName });
    });
  });
}

async function runMlModulePipeline({ jobId, jobDir, imagePath, req }) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers.host;
  const callbackUrl = `${protocol}://${host}/api/webhooks/ifc-ready/${jobId}`;

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
  return jobPromise;
}

app.post('/api/convert-floorplan', uploadFloorplan.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });

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

    res.json({ success: true, message: 'Conversion successful', fileUrl: fileUrl, jobId: jobId });
  } catch (err) {
    const status = (err && err.status) || 500;
    const body = (err && err.body) || { error: 'Failed to convert floorplan.' };
    res.status(status).json(body);
  }
});

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
    pending.reject({ status: 500, body: { error: req.body.error || 'ML module reported failure or sent no IFC file.' } });
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
// ELEMENT EDITING API
// ==========================================
const elementEditorScript = path.join(__dirname, 'ifc_element_editor.py');
const { spawnSync } = require('child_process');

function resolvePythonCommand() {
  if (process.platform === 'win32') {
    const probe = spawnSync('py', ['-3', '--version'], { encoding: 'utf-8' });
    if (!probe.error && probe.status === 0) return { command: 'py', prefixArgs: ['-3'] };
  }
  return { command: 'python', prefixArgs: [] };
}

function runElementEditor(args) {
  if (!fs.existsSync(elementEditorScript)) {
    throw new Error(`ifc_element_editor.py not found at ${elementEditorScript}`);
  }
  const python = resolvePythonCommand();
  const result = spawnSync(python.command, [...python.prefixArgs, elementEditorScript, ...args], { encoding: 'utf-8' });
  if (result.error) throw new Error(`Failed to launch ifc_element_editor.py: ${result.error.message}`);
  
  const stdout = (result.stdout || '').trim();
  if (!stdout) throw new Error(`ifc_element_editor.py produced no output. stderr: ${result.stderr}`);

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`ifc_element_editor.py returned non-JSON output: ${stdout}`);
  }

  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

app.get('/api/elements/:jobId/:globalId/inspect', (req, res) => {
  try {
    const { jobId, globalId } = req.params;
    const inputIfcPath = path.join(jobsDir, jobId, 'input.ifc');
    
    if (!fs.existsSync(inputIfcPath)) return res.status(404).json({ error: 'input.ifc not found for this job.' });
    
    const data = runElementEditor(['inspect', '--input', inputIfcPath, '--global-id', globalId]);
    res.json(data);
  } catch (error) {
    // Inspect is advisory: selection should remain fully usable even when a
    // wall uses mesh/profile geometry that cannot be edited parametrically.
    // Return a 200 capability response instead of turning every selection into
    // a red Network error in the browser.
    const message = error?.message || 'Element inspection unavailable.';
    console.warn('[ElementInspect] Non-fatal:', message);
    res.json({
      supported: false,
      error: true,
      height: null,
      width: null,
      length: null,
      message,
    });
    return;
  }
});

app.post('/api/elements/:jobId/:globalId/resize', (req, res) => {
  try {
    const { jobId, globalId } = req.params;
    if (!requireActiveProject(jobId, res)) return;

    const { height, width, length } = req.body;
    if (height === undefined && width === undefined && length === undefined) {
      return res.status(400).json({ error: 'Provide at least one of height, width, length.' });
    }

    const jobDirPath = path.join(jobsDir, jobId);
    const inputIfcPath = path.join(jobDirPath, 'input.ifc');

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
      fileUrl: `${protocol}://${host}/jobs/${jobId}/element_edits/${outputFileName}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/elements/:jobId/:globalId/isolate', (req, res) => {
  try {
    const { jobId, globalId } = req.params;
    if (!requireActiveProject(jobId, res)) return;

    const jobDirPath = path.join(jobsDir, jobId);
    const inputIfcPath = path.join(jobDirPath, 'input.ifc');

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
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/elements/:jobId/:globalId/insert-door', (req, res) => {
  try {
    const { jobId, globalId } = req.params;
    if (!requireActiveProject(jobId, res)) return;

    const { assetId, position, rotation, width, height, thickness } = req.body;
    if (!assetId) return res.status(400).json({ error: 'assetId is required.' });
    
    const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));
    if (!isVec3(position)) return res.status(400).json({ error: 'position must be an array of 3 numbers [x, y, z].' });
    if (!isVec3(rotation)) return res.status(400).json({ error: 'rotation must be an array of 3 numbers [x, y, z] in degrees.' });

    const jobDirPath = path.join(jobsDir, jobId);
    const inputIfcPath = path.join(jobDirPath, 'input.ifc');
    
    const editsDir = path.join(jobDirPath, 'element_edits');
    if (!fs.existsSync(editsDir)) fs.mkdirSync(editsDir, { recursive: true });

    const outputFileName = `${globalId}_door_${Date.now()}.ifc`;
    const outputPath = path.join(editsDir, outputFileName);

    const args = [
      elementEditorScript, 'insert-door',
      '--input', inputIfcPath,
      '--output', outputPath,
      '--global-id', globalId,
      '--asset-id', String(assetId),
      '--position', position.join(','),
      '--rotation', rotation.join(','),
    ];

    if (width !== undefined) args.push('--width', String(width));
    if (height !== undefined) args.push('--height', String(height));
    if (thickness !== undefined) args.push('--thickness', String(thickness));

    const pythonProcess = spawn('python', args);
    let stdoutData = '';
    let stderrData = '';

    pythonProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { stderrData += data.toString(); });
    pythonProcess.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: `Failed to launch Python: ${err.message}` });
    });

    pythonProcess.on('close', (code) => {
      if (res.headersSent) return;
      const trimmedStdout = stdoutData.trim();
      
      if (code !== 0 || !fs.existsSync(outputPath)) {
        return res.status(500).json({ error: 'Door insertion failed.', logs: stderrData || trimmedStdout });
      }

      let parsed = {};
      try { parsed = trimmedStdout ? JSON.parse(trimmedStdout) : {}; } 
      catch (e) { console.warn('[DoorInsert] Non-JSON stdout from Python:', trimmedStdout); }

      if (parsed.error) return res.status(500).json({ error: parsed.error });

      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers.host;
      const responsePayload = {
        ...parsed,
        success: true,
        fileUrl: `${protocol}://${host}/jobs/${jobId}/element_edits/${outputFileName}`,
      };
      if (parsed.previewFileName) {
        responsePayload.previewFileUrl = `${protocol}://${host}/jobs/${jobId}/element_edits/${parsed.previewFileName}`;
      }
      res.json(responsePayload);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// IFC GLOBAL RESCALE API
// ==========================================
app.post('/api/projects/:jobId/rescale', (req, res) => {
    const { jobId } = req.params;
    if (!requireActiveProject(jobId, res)) return;

    const { factor } = req.body;
    const jobDir = path.join(jobsDir, jobId);
    const inputPath = path.join(jobDir, 'input.ifc');
    const scriptPath = path.join(__dirname, 'ifc_element_editor.py');

    try {
        const child = require('child_process').spawnSync('python', [
            scriptPath, 'rescale', 
            '--input', inputPath, 
            '--output', inputPath, 
            '--factor', factor
        ], { encoding: 'utf-8' });

        const stdoutTrimmed = (child.stdout || '').trim();
        if (!stdoutTrimmed) {
             return res.status(500).json({ error: child.stderr ? `Python Crash: ${child.stderr.toString()}` : 'Python script crashed without output.' });
        }
        
        const responseData = JSON.parse(child.stdout.trim());
        if (responseData.error) return res.status(500).json(responseData);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers.host; 
        
        res.json({ 
            success: true, 
            fileUrl: `${protocol}://${host}/jobs/${jobId}/input.ifc?v=${Date.now()}` 
        });
    } catch (error) {
        res.status(500).json({ error: `Server exception: ${error.message}` });
    }
});

// ==========================================
// RENDER API
// ==========================================
app.post('/api/render', renderUpload.single('ifcFile'), (req, res) => {
  try {
    const angle = req.body.angle || '360'; 
    const lighting = req.body.lighting || 'daylight';
    const jobId = req.body.jobId;

    if (!jobId) {
        return res.status(400).json({ error: 'Missing jobId for rendering. Creation via /api/render is strictly forbidden.' });
    }

    if (!requireActiveProject(jobId, res)) return;
    const jobDir = path.join(jobsDir, jobId);

    if (req.file) {
        fs.writeFileSync(path.join(jobDir, 'input.ifc'), req.file.buffer);
    } else {
        const inputIfcPath = path.join(jobDir, 'input.ifc');
        if (!fs.existsSync(inputIfcPath)) {
            const generatedIfcPath = path.join(jobDir, `${jobId}_Generated.ifc`);
            if (fs.existsSync(generatedIfcPath)) {
                fs.copyFileSync(generatedIfcPath, inputIfcPath);
            } else {
                return res.status(400).json({ error: 'input.ifc or AI-generated IFC not found.' });
            }
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
    touchManifest(jobDir);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    if (angle === "360") {
        const compilerScriptPath = path.join(__dirname, "compiler", "compiler.ts");
        const outputGlbPath = path.join(jobDir, "output.glb");

        try {
            execSync(`npx tsx "${compilerScriptPath}" "${jobDir}" "${assetsDir}"`, {
                stdio: "inherit", cwd: __dirname, env: { ...process.env }
            });
        } catch (err) {
            return res.status(500).json({ error: "Failed to compile GLB scene." });
        }

        if (!fs.existsSync(outputGlbPath)) {
            return res.status(500).json({ error: "output.glb was not generated." });
        }

        try {
            generate360ViewerFromGLB(jobDir);
        } catch (err) {
            return res.status(500).json({ error: "Failed to generate 360 viewer." });
        }

        return res.json({
            type: "360",
            url: `${baseUrl}/jobs/${jobId}/360_viewer.html`,
            jobId
        });
    }

    try {
      execSync(`node aps-pipeline.js ${angle} "${jobDir}" ${lighting}`, { stdio: 'inherit', env: { ...process.env, ASSET_DIR: assetsDir } });
    } catch (pipelineError) {
      return res.status(500).json({ error: 'Failed to execute Autodesk pipeline.' });
    }

    res.json({ type: 'image', url: `${baseUrl}/jobs/${jobId}/result.png`, jobId: jobId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process render request' });
  }
});


// ==========================================
// PROJECT VALIDATION API
// Used by the frontend on startup to verify
// whether a saved project still exists.
// ==========================================
app.get('/api/projects/:jobId/validate', (req, res) => {
    try {
        const { jobId } = req.params;
        const jobDir = path.join(jobsDir, jobId);

        if (!fs.existsSync(jobDir)) {
            return res.status(404).json({
                valid: false,
                reason: 'PROJECT_NOT_FOUND',
            });
        }

        const manifest = readManifest(jobDir);

        if (!manifest) {
            return res.status(404).json({
                valid: false,
                reason: 'MANIFEST_NOT_FOUND',
            });
        }

        if (manifest.status === 'archived') {
            return res.status(409).json({
                valid: false,
                reason: 'PROJECT_ARCHIVED',
            });
        }

        const originalIfcPath = path.join(jobDir, 'original.ifc');

        if (!fs.existsSync(originalIfcPath)) {
            return res.status(404).json({
                valid: false,
                reason: 'ORIGINAL_IFC_NOT_FOUND',
            });
        }

        return res.json({
            valid: true,
            jobId,
            fileName: manifest.originalFileName || path.basename(originalIfcPath),
            manifest,
        });

    } catch (error) {
        console.error('[Project Validate] Error:', error);

        return res.status(500).json({
            valid: false,
            reason: 'VALIDATION_ERROR',
        });
    }
});

// ==========================================
// DELETE / RESET PROJECT API
// ==========================================
// ==========================================
// DELETE / RESET PROJECT API
// ==========================================
app.delete('/api/projects/:jobId', (req, res) => {
    try {
        const jobId = req.params.jobId;
        const jobDir = path.join(jobsDir, jobId);

        if (!fs.existsSync(jobDir)) {
            return res.status(404).json({
                error: `Project ${jobId} not found.`,
            });
        }

        const manifest = readManifest(jobDir);

        if (manifest?.status === 'archived') {
            return res.status(409).json({
                error: `Project ${jobId} is already archived.`,
                archivedJobId: jobId,
            });
        }

        const nextManifest = manifest || {
            jobId,
            originalFileName: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'active',
        };

        // Mark the current project as archived.
        nextManifest.status = 'archived';
        nextManifest.updatedAt = new Date().toISOString();

        writeManifest(jobDir, nextManifest);

        // IMPORTANT:
        // Do NOT create a replacement project here.
        // The frontend will clear the current project and open UploadModal.
        res.json({
            success: true,
            archivedJobId: jobId,
        });

    } catch (error) {
        console.error('Delete Project Error:', error);

        res.status(500).json({
            error: 'Failed to delete project',
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 HC Interior Backend running on port ${PORT}`);
});

db.query('SELECT 1').then(() => {
  console.log('✅ PostgreSQL connected');
}).catch(err => {
  console.error('❌ PostgreSQL connection failed:', err.message);
});