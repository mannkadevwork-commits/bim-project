require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json()); 

// 1. Ensure dynamic directories exist
const jobsDir = path.join(__dirname, 'jobs');
const assetsDir = path.join(__dirname, 'assets'); 
if (!fs.existsSync(jobsDir)) fs.mkdirSync(jobsDir);
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

// 2. Serve static folders publicly
app.use('/jobs', express.static(jobsDir));
app.use('/assets', express.static(assetsDir)); 

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
        { id: 'sofa', name: 'Modern Sofa', type: 'furniture', url: '/assets/sofa.ifc' },
        { id: 'chair', name: 'Chair', type: 'furniture', url: '/assets/chair.ifc' },
        { id: 'cabinet', name: 'Cabinet', type: 'furniture', url: '/assets/cabinet.ifc' },
        { id: 'sink_mirror', name: 'Sink & Mirror', type: 'furniture', url: '/assets/sink_mirror.ifc' },
        { id: 'commode', name: 'Commode', type: 'furniture', url: '/assets/commode.ifc' },
        { id: 'wall', name: 'Wall', type: 'furniture', url: '/assets/wall.ifc' }
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
        
        // Now safely write the state file
        fs.writeFileSync(statePath, JSON.stringify(req.body, null, 2));
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

// ==========================================
// AI FLOORPLAN CONVERSION API
// ==========================================

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

app.post('/api/convert-floorplan', uploadFloorplan.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }

  const jobDir = req.file.destination; 
  const jobId = path.basename(jobDir); 
  const imagePath = path.join(jobDir, req.file.filename);
  const ifcFileName = `${jobId}_Generated.ifc`;
  const ifcOutputPath = path.join(jobDir, ifcFileName);

  const scriptPath = path.join(__dirname, 'latest_interior_v1', 'automated_bim_v4_connected.py');
  const cachePath = path.join(jobDir, `${jobId}_cache.json`);
  
  // Note: Using your globally defined 'assetsDir' from the top of your server.js
  console.log(`\n--- [ASYNC] AI Conversion Request | Job ID: ${jobId} ---`);

  // Run Python without blocking the Node Event Loop
  const pythonProcess = spawn('python', [
    scriptPath, 
    '--image', imagePath, 
    '--output', ifcOutputPath, 
    '--cache', cachePath,
    // '--assets', assetsDir 
  ]);

  let pythonLogs = '';

  // Listen for standard output from Python
  pythonProcess.stdout.on('data', (data) => {
    console.log(`[Python]: ${data}`);
    pythonLogs += data.toString();
  });

  // Listen for error output from Python
  pythonProcess.stderr.on('data', (data) => {
    console.error(`[Python Error]: ${data}`);
    pythonLogs += data.toString();
  });

  // WAIT for the Python script to completely finish before responding
  pythonProcess.on('close', (code) => {
    console.log(`[Python] Process exited with code ${code}`);
    
    if (code !== 0 || !fs.existsSync(ifcOutputPath)) {
      return res.status(500).json({ 
        error: 'IFC file was not generated by the AI.',
        logs: pythonLogs 
      });
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host; 
    const fileUrl = `${protocol}://${host}/jobs/${jobId}/${ifcFileName}`;

    // Return the URL so the frontend can download and render it
    res.json({ 
      success: true, 
      message: 'Conversion successful',
      fileUrl: fileUrl,
      jobId: jobId 
    });
  });
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

// ==========================================
// RENDER API
// ==========================================

app.post('/api/render', upload.single('ifcFile'), (req, res) => {
  try {
    const angle = req.body.angle || '360';
    const lighting = req.body.lighting || 'daylight'; 
    
    let jobDir, jobId;

    // Support both fresh IFC uploads and existing jobIds (from the AI floorplan generator)
    if (req.file) {
        jobDir = req.file.destination; 
        jobId = path.basename(jobDir); 
    } else if (req.body.jobId) {
        jobId = req.body.jobId;
        jobDir = path.join(jobsDir, jobId);
        
        if (!fs.existsSync(jobDir)) {
             return res.status(404).json({ error: 'Job directory not found.' });
        }
    } else {
        return res.status(400).json({ error: 'Missing IFC file or jobId for rendering.' });
    }

    // Ensure aps-pipeline.js can find 'input.ifc' even if the file was generated by the AI floorplan script
    const inputIfcPath = path.join(jobDir, 'input.ifc');
    if (!fs.existsSync(inputIfcPath)) {
        const generatedIfcPath = path.join(jobDir, `${jobId}_Generated.ifc`);
        if (fs.existsSync(generatedIfcPath)) {
            fs.copyFileSync(generatedIfcPath, inputIfcPath);
        } else {
            return res.status(400).json({ error: 'input.ifc or AI-generated IFC not found in job directory.' });
        }
    }

    // Safely parse projectState whether it's sent as a string (FormData) or an object (JSON body)
    if (req.body.projectState) {
        const stateData = typeof req.body.projectState === 'string' 
            ? req.body.projectState 
            : JSON.stringify(req.body.projectState);
        fs.writeFileSync(path.join(jobDir, 'project_state.json'), stateData);
    }
    
    console.log(`\n--- Render Request | Angle: ${angle} | Lighting: ${lighting} | Job ID: ${jobId} ---`);

    try {
      execSync(`node aps-pipeline.js ${angle} "./jobs/${jobId}" ${lighting}`, { stdio: 'inherit' });
    } catch (pipelineError) {
      console.error("Pipeline script failed.");
      return res.status(500).json({ error: 'Failed to execute Autodesk pipeline.' });
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host; 
    const baseUrl = `${protocol}://${host}`;

    if (angle === '360') {
       res.json({ type: '360', url: `${baseUrl}/jobs/${jobId}/360_viewer.html`, jobId: jobId });
    } else {
       res.json({ type: 'image', url: `${baseUrl}/jobs/${jobId}/result.png`, jobId: jobId });
    }

  } catch (error) {
    console.error("Render API Error:", error.message);
    res.status(500).json({ error: 'Failed to process render request' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 HC Interior Backend running on port ${PORT}`);
});