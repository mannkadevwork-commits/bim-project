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
// RENDER API (Fully Asynchronous)
// ==========================================
// app.post('/api/render', upload.single('ifcFile'), (req, res) => {
//   try {
//     const angle = req.body.angle || 'all';
//     // const angle = 'top_down'; 
//     // const angle = 'auto_rotation';
//     const lighting = req.body.lighting || 'daylight';
//     // const angle = req.body.angle || '360';
//     // const lighting = req.body.lighting || 'daylight'; 
    
//     let jobDir, jobId;

//     if (req.file) {
//         jobDir = req.file.destination; 
//         jobId = path.basename(jobDir); 
//     } else if (req.body.jobId) {
//         jobId = req.body.jobId;
//         jobDir = path.join(jobsDir, jobId);
//         if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'Job directory not found.' });
//     } else {
//         return res.status(400).json({ error: 'Missing IFC file or jobId for rendering.' });
//     }

//     const inputIfcPath = path.join(jobDir, 'input.ifc');
//     if (!fs.existsSync(inputIfcPath)) {
//         const generatedIfcPath = path.join(jobDir, `${jobId}_Generated.ifc`);
//         if (fs.existsSync(generatedIfcPath)) {
//             fs.copyFileSync(generatedIfcPath, inputIfcPath);
//         } else {
//             return res.status(400).json({ error: 'input.ifc or AI-generated IFC not found.' });
//         }
//     }

//     const projectStatePath = path.join(jobDir, 'project_state.json');
//     if (req.body.projectState) {
//         const stateData = typeof req.body.projectState === 'string' 
//             ? req.body.projectState 
//             : JSON.stringify(req.body.projectState);
//         fs.writeFileSync(projectStatePath, stateData);
//     } else if (!fs.existsSync(projectStatePath)) {
//         fs.writeFileSync(projectStatePath, JSON.stringify({ materials: {}, furniture: [] }));
//     }
    
//     console.log(`\n--- Async Render Request | Angle: ${angle} | Lighting: ${lighting} | Job ID: ${jobId} ---`);

//     const blenderScriptPath = path.join(__dirname, 'blender_render.py');
//     // const resultImgPath = path.join(jobDir, 'result.png');
//     let outputFileName = 'result.png';
//     if (angle === 'top_down') outputFileName = 'top_down_plan.png';
//     else if (angle === '360') outputFileName = 'pano_360.png';
//     else if (angle === 'side') outputFileName = 'side_elevation.png';
    
//     const resultImgPath = path.join(jobDir, outputFileName);
    
//     // Using exec asynchronously so Node can keep serving furniture on port 3000!
//     const { exec } = require('child_process');
//     // FIX: this used to hard-code --angle "top_down" regardless of what the
//     // frontend actually requested, AND blender_render.py had no --angle/
//     // --lighting flags at all -- argparse rejected the command line before
//     // any scene setup ran, so no new render ever happened; whatever
//     // result.png/pano_render.html already existed in the job folder just
//     // sat there, which is what made renders look "stuck" on a broken image.
//     const blenderCmd = `blender --background --python "${blenderScriptPath}" -- --ifc "${inputIfcPath}" --state "${projectStatePath}" --output "${resultImgPath}" --job-dir "${jobDir}" --angle "${angle}" --lighting "${lighting}"`;

//     exec(blenderCmd, { maxBuffer: 1024 * 1024 * 50 }, (pipelineError, stdout, stderr) => {
//       if (pipelineError) {
//         console.error("Blender pipeline failed:", pipelineError.message);
//         if (stdout) console.error("--- BLENDER STDOUT ---\n", stdout.toString());
//         if (stderr) console.error("--- BLENDER STDERR ---\n", stderr.toString());
//         return res.status(500).json({ error: 'Failed to execute Blender render pipeline.' });
//       }

//       const resultLines = stdout.split('\n').filter(line => line.startsWith('RENDER_RESULT_JSON:'));
//       if (resultLines.length === 0) {
//         console.error('[Blender] No JSON payload found. STDOUT:', stdout);
//         return res.status(500).json({ error: 'Blender produced no result payload.' });
//       }

//       const renderResult = JSON.parse(resultLines[resultLines.length - 1].slice('RENDER_RESULT_JSON:'.length));

//       if (!renderResult.success) {
//         console.error('[Blender] Render failed:', renderResult.error);
//         return res.status(500).json({ error: renderResult.error || 'Blender render failed.' });
//       }

//       // ── 4. GENERATE A SEPARATE PANNELLUM VIEWER (DO NOT OVERWRITE 360_VIEWER.HTML) ──
//       const htmlOutPath = path.join(jobDir, 'pano_render.html');
//       const viewerHtml = `<!DOCTYPE HTML>
// <html>
// <head>
//     <meta charset="utf-8">
//     <meta name="viewport" content="width=device-width, initial-scale=1.0">
//     <title>High-Res 360 Render</title>
//     <link rel="stylesheet" href="https://cdn.pannellum.org/2.5/pannellum.css"/>
//     <script type="text/javascript" src="https://cdn.pannellum.org/2.5/pannellum.js"></script>
//     <style>body { margin: 0; overflow: hidden; background: #000; } #panorama { width: 100vw; height: 100vh; }</style>
// </head>
// <body>
//     <div id="panorama"></div>
//     <script>
//         pannellum.viewer('panorama', {
//             "type": "equirectangular",
//       "panorama": "${outputFileName}?v=${Date.now()}",
//             "autoLoad": true,
//             "compass": false,
//             "showFullscreenCtrl": true,
//             "mouseZoom": false
//         });
//     </script>
// </body>
// </html>`;
      
//       fs.writeFileSync(htmlOutPath, viewerHtml);

//       // ── 5. RETURN NEW URL TO FRONTEND ──
//       // ── 4. GENERATE COOHOM-STYLE MASTER PRESENTATION ──
//       const protocol = req.headers['x-forwarded-proto'] || req.protocol;
//       const host = req.headers.host; 
//       const baseUrl = `${protocol}://${host}`;

//       const presentationHtmlPath = path.join(jobDir, 'presentation.html');
      
//       const presentationHtml = `<!DOCTYPE html>
//         <html lang="en">
//         <head>
//             <meta charset="UTF-8">
//             <meta name="viewport" content="width=device-width, initial-scale=1.0">
//             <title>HC Interior - Final Presentation</title>
            
//             <link rel="stylesheet" href="https://cdn.pannellum.org/2.5/pannellum.css"/>
//             <script type="text/javascript" src="https://cdn.pannellum.org/2.5/pannellum.js"></script>
            
//             <script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.4.0/model-viewer.min.js"></script>
            
//             <style>
//                 body { margin: 0; font-family: 'Segoe UI', sans-serif; background-color: #1a1a1a; color: #fff; display: flex; height: 100vh; overflow: hidden; }
//                 #sidebar { width: 260px; background-color: #222; padding: 20px; box-shadow: 2px 0 10px rgba(0,0,0,0.5); z-index: 10; display: flex; flex-direction: column; }
//                 #sidebar h2 { font-size: 1.2rem; color: #00d2ff; margin-bottom: 25px; border-bottom: 1px solid #333; padding-bottom: 15px; }
//                 .menu-btn { display: block; width: 100%; padding: 14px; margin-bottom: 12px; background-color: #333; color: #fff; border: 1px solid #444; border-radius: 6px; cursor: pointer; text-align: left; font-size: 15px; transition: 0.2s; }
//                 .menu-btn:hover { background-color: #444; }
//                 .menu-btn.active { background-color: #00d2ff; color: #000; font-weight: 600; border: none; }
                
//                 #viewer-container { flex-grow: 1; position: relative; background: #000; }
//                 .view-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: none; }
//                 .view-layer.active { display: block; }
                
//                 img.static-img { object-fit: contain; width: 100%; height: 100%; }
//                 model-viewer { width: 100%; height: 100%; background-color: #222; }
//             </style>
//         </head>
//         <body>
//             <div id="sidebar">
//                 <h2>HC Interior Deliverables</h2>
//                 <button class="menu-btn active" onclick="switchView('view-3d', this)">🔄 Interactive 3D Model</button>
//                 <button class="menu-btn" onclick="switchView('view-360', this)">🌐 360 Photoreal Walkthrough</button>
//                 <button class="menu-btn" onclick="switchView('view-top', this)">🗺️ Top-Down Floor Plan</button>
//             </div>
            
//             <div id="viewer-container">
//                 <div id="view-3d" class="view-layer active">
//                     <model-viewer src="model_interactive.glb?v=${Date.now()}" camera-controls auto-rotate shadow-intensity="1" exposure="1.2"></model-viewer>
//                 </div>
                
//                 <div id="view-360" class="view-layer">
//                     <div id="panorama" style="width:100%; height:100%;"></div>
//                 </div>
                
//                 <div id="view-top" class="view-layer">
//                     <img class="static-img" src="top_down_plan.png?v=${Date.now()}" />
//                 </div>
//             </div>

//             <script>
//                 // Initialize 360 viewer (loads in background)
//                 pannellum.viewer('panorama', {
//                     "type": "equirectangular",
//                     "panorama": "pano_360.png?v=${Date.now()}",
//                     "autoLoad": true,
//                     "compass": false,
//                     "mouseZoom": false
//                 });

//                 function switchView(viewId, btnElement) {
//                     // Update buttons
//                     document.querySelectorAll('.menu-btn').forEach(btn => btn.classList.remove('active'));
//                     btnElement.classList.add('active');
                    
//                     // Switch layers
//                     document.querySelectorAll('.view-layer').forEach(layer => layer.classList.remove('active'));
//                     document.getElementById(viewId).classList.add('active');
//                 }
//             </script>
//         </body>
//         </html>`;

//       fs.writeFileSync(presentationHtmlPath, presentationHtml);

//       // ALWAYS return the Master Presentation HTML
//       res.json({ 
//           type: 'presentation', 
//           url: `${baseUrl}/jobs/${jobId}/presentation.html`, 
//           jobId: jobId 
//       });
    
//     });

//   } catch (error) {
//     console.error("Render API Error:", error.message);
//     res.status(500).json({ error: 'Failed to process render request' });
//   }
// });

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

    // ==========================================
    // APS PIPELINE (RESTORED)
    // ==========================================
    try {
      // Execute the APS script exactly how it was running previously
      execSync(`node aps-pipeline.js ${angle} "${jobDir}" ${lighting}`, { stdio: 'inherit' });
    } catch (pipelineError) {
      console.error("APS Pipeline script failed.");
      return res.status(500).json({ error: 'Failed to execute Autodesk pipeline.' });
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host; 
    const baseUrl = `${protocol}://${host}`;

    // Return the exact URLs the old frontend logic expects
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