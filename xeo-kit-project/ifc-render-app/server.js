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
        { id: 'sofa_modern', name: 'Modern Sofa', type: 'furniture', url: '/assets/sofa_modern.ifc' },
        { id: 'bed_king', name: 'King Bed', type: 'furniture', url: '/assets/bed_king.ifc' },
        { id: 'plant_monstera', name: 'Monstera Plant', type: 'decor', url: '/assets/plant_monstera.ifc' },
        { id: 'partition_wall', name: 'Partition Wall', type: 'structural', url: '/assets/wall.ifc' }
    ];
    res.json(catalog);
});

app.post('/api/projects/:jobId/save', (req, res) => {
    try {
        const jobId = req.params.jobId;
        const statePath = path.join(jobsDir, jobId, 'project_state.json');
        
        if (!fs.existsSync(path.dirname(statePath))) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        fs.writeFileSync(statePath, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'Design saved successfully' });
    } catch (error) {
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