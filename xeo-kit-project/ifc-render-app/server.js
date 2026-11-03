require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const sharp = require('sharp');
const db = require('./db');
const catalogRoutes = require('./catalog-routes');
const adminRoutes = require('./admin-routes');
const ifcEditorRoutes = require('./ifc-editor-routes');

const app = express();
app.use(cors());
app.use(express.json()); 


// 1. Ensure dynamic directories exist
const jobsDir = path.join(__dirname, 'jobs');
const assetsDir = path.join(__dirname, 'assets'); 
if (!fs.existsSync(jobsDir)) fs.mkdirSync(jobsDir);
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
const materialAssetsDir = path.join(assetsDir, 'materials');
if (!fs.existsSync(materialAssetsDir)) fs.mkdirSync(materialAssetsDir, { recursive: true });
const materialLibraryPath = path.join(__dirname, 'material-library.json');

// Global saved-layout index. Saved layouts belong to the Layouts left panel,
// not to whichever base project is currently active.
const savedLayoutsRegistryDir = path.join(jobsDir, 'saved_layouts_registry');
if (!fs.existsSync(savedLayoutsRegistryDir)) fs.mkdirSync(savedLayoutsRegistryDir, { recursive: true });

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

// Write durable JSON snapshots atomically. A browser continuing a project must
// never observe a partially-written project_state.json while an autosave/render
// request is replacing it.
function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
  return fs.statSync(filePath).mtimeMs;
}

function readProjectStateMetadata(jobDir) {
  const statePath = path.join(jobDir, 'project_state.json');
  const metaPath = path.join(jobDir, 'project_state_meta.json');
  let sidecar = null;
  try {
    if (fs.existsSync(metaPath)) sidecar = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (error) {
    console.warn('[ProjectState] Ignoring unreadable metadata sidecar:', error.message);
  }
  const fileSavedAt = fs.existsSync(statePath) ? fs.statSync(statePath).mtimeMs : 0;
  return {
    exists: fs.existsSync(statePath),
    savedAt: Number(sidecar?.savedAt) || fileSavedAt,
    clientRevision: Number(sidecar?.clientRevision) || 0,
  };
}

function writeProjectStateSnapshot(jobDir, state, revisionValue) {
  const current = readProjectStateMetadata(jobDir);
  const statePath = path.join(jobDir, 'project_state.json');
  const revisionParsed = Number(revisionValue);
  const hasRevision = Number.isFinite(revisionParsed) && revisionParsed > 0;

  // Once revisioned snapshots exist, require the client to identify its version.
  // This blocks a late render request or older frontend tab from overwriting newer furniture.
  if (current.clientRevision > 0 && (!hasRevision || revisionParsed < current.clientRevision)) {
    return { stale: true, ...current };
  }

  const savedAt = atomicWriteJson(statePath, state);
  const clientRevision = hasRevision ? revisionParsed : 0;
  atomicWriteJson(path.join(jobDir, 'project_state_meta.json'), {
    version: 1,
    clientRevision,
    savedAt,
  });
  touchManifest(jobDir);
  return { stale: false, exists: true, savedAt, clientRevision };
}

function generateSavedLayoutId() {
  let id;
  do {
    id = `layout_${crypto.randomBytes(6).toString('hex')}`;
  } while (fs.existsSync(path.join(jobsDir, id)));
  return id;
}

function normalizeSavedLayoutMetadata(body = {}) {
  const categoryType = body.categoryType === 'project' ? 'project' : 'floorplan';
  const categoryName = String(body.categoryName || '').trim();
  const subCategory = String(body.subCategory || '').trim();

  if (!categoryName) throw new Error('Layout category is required.');
  if (!subCategory) throw new Error('Layout sub-category is required.');
  if (categoryName.length > 60) throw new Error('Category name must be 60 characters or fewer.');
  if (subCategory.length > 60) throw new Error('Sub-category must be 60 characters or fewer.');

  return { categoryType, categoryName, subCategory };
}

function findSavedLayout(layoutId) {
  return readAllSavedLayouts().find(item => item.id === layoutId || item.renderJobId === layoutId) || null;
}

function writeSavedLayoutRecord(record) {
  const json = JSON.stringify(record, null, 2);
  fs.writeFileSync(path.join(savedLayoutsRegistryDir, `${record.id}.json`), json);

  if (record.parentJobId) {
    const parentLayoutsDir = path.join(jobsDir, record.parentJobId, 'saved_layouts');
    if (fs.existsSync(parentLayoutsDir)) {
      fs.writeFileSync(path.join(parentLayoutsDir, `${record.id}.json`), json);
    }
  }
}

function removeSavedLayoutRecord(record) {
  const registryPath = path.join(savedLayoutsRegistryDir, `${record.id}.json`);
  if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);

  if (record.parentJobId) {
    const parentRecordPath = path.join(jobsDir, record.parentJobId, 'saved_layouts', `${record.id}.json`);
    if (fs.existsSync(parentRecordPath)) fs.unlinkSync(parentRecordPath);
  }

  const snapshotDir = path.join(jobsDir, record.renderJobId || record.id);
  if (fs.existsSync(snapshotDir)) fs.rmSync(snapshotDir, { recursive: true, force: true });
}

function parseSavedLayoutFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    console.warn(`[SavedLayouts] Failed to read ${path.basename(filePath)}:`, error.message);
    return null;
  }
}

function readSavedLayouts(jobId) {
  const layoutsDir = path.join(jobsDir, jobId, 'saved_layouts');
  if (!fs.existsSync(layoutsDir)) return [];

  return fs.readdirSync(layoutsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => parseSavedLayoutFile(path.join(layoutsDir, entry.name)))
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

function readAllSavedLayouts() {
  const byId = new Map();

  // New layouts: global durable registry.
  if (fs.existsSync(savedLayoutsRegistryDir)) {
    fs.readdirSync(savedLayoutsRegistryDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .forEach(entry => {
        const record = parseSavedLayoutFile(path.join(savedLayoutsRegistryDir, entry.name));
        if (record?.id) byId.set(record.id, record);
      });
  }

  // Legacy compatibility: layouts created before the global registry existed.
  fs.readdirSync(jobsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'saved_layouts_registry')
    .forEach(entry => {
      readSavedLayouts(entry.name).forEach(record => {
        if (record?.id && !byId.has(record.id)) byId.set(record.id, record);
      });
    });

  return Array.from(byId.values())
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

function decorateSavedLayout(layout) {
  return {
    ...layout,
    thumbnailUrl: layout.thumbnailFile
      ? `/jobs/${encodeURIComponent(layout.renderJobId)}/${encodeURIComponent(layout.thumbnailFile)}`
      : null,
    modelUrl: `/jobs/${encodeURIComponent(layout.renderJobId)}/output.glb`,
    walkthroughUrl: `/walkthrough/${encodeURIComponent(layout.renderJobId)}`,
  };
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
app.use('/jobs', (req, res, next) => {
    if (req.path.endsWith('/360_viewer.html') || req.path === '/360_viewer.html') {
        return res.status(410).json({ error: 'Legacy 360 viewer has been removed. Use /walkthrough/:jobId.' });
    }
    return express.static(jobsDir)(req, res, next);
});
app.use('/assets', express.static(assetsDir));

// User-uploaded tile and fabric textures are stored in assets/materials so
// both the editor and the GLB compiler can access the same durable file.
const MAX_MATERIAL_UPLOAD_BYTES = 10 * 1024 * 1024;
const MATERIAL_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const materialUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MATERIAL_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!MATERIAL_IMAGE_MIMES.has(file.mimetype)) {
      return callback(new Error('Only PNG, JPG and WebP texture images are supported.'));
    }
    callback(null, true);
  },
});

function readMaterialLibraryRecords() {
  if (!fs.existsSync(materialLibraryPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(materialLibraryPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[Materials] Could not read the uploaded material catalog:', error.message);
    return [];
  }
}

function writeMaterialLibraryRecords(records) {
  const temporaryPath = `${materialLibraryPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2), 'utf8');
  fs.renameSync(temporaryPath, materialLibraryPath);
}

function serializeUploadedMaterial(record) {
  return {
    id: record.id,
    name: record.name,
    category: record.category,
    kind: record.kind,
    texturePath: record.texturePath,
    color: record.color || '#FFFFFF',
    rgb: Array.isArray(record.rgb) ? record.rgb : [1, 1, 1],
    repeat: Array.isArray(record.repeat) ? record.repeat : (record.kind === 'fabric' ? [5, 5] : [2, 2]),
    roughness: Number.isFinite(record.roughness) ? record.roughness : (record.kind === 'fabric' ? 0.92 : 0.78),
    metallic: Number.isFinite(record.metallic) ? record.metallic : 0,
    createdAt: record.createdAt,
  };
}

app.get('/api/materials', (_req, res) => {
  try {
    const materials = readMaterialLibraryRecords()
      .filter((record) => record?.fileName && fs.existsSync(path.join(materialAssetsDir, record.fileName)))
      .map(serializeUploadedMaterial);
    res.json({ materials });
  } catch (error) {
    console.error('[Materials] Failed to list uploaded materials:', error);
    res.status(500).json({ error: 'Failed to load uploaded materials.' });
  }
});

app.post('/api/materials/upload', (req, res, next) => {
  materialUpload.single('texture')(req, res, (error) => {
    if (!error) return next();
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Texture images must be 10 MB or smaller.'
      : (error.message || 'Invalid texture upload.');
    res.status(status).json({ error: message });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a texture image to upload.' });

  const name = String(req.body?.name || '').trim();
  const kind = String(req.body?.kind || '').trim().toLowerCase();
  if (!name || name.length > 80) {
    return res.status(400).json({ error: 'Material name is required and must be 80 characters or fewer.' });
  }
  if (!['fabric', 'texture'].includes(kind)) {
    return res.status(400).json({ error: 'Material type must be fabric or texture.' });
  }

  let outputPath = null;
  try {
    const metadata = await sharp(req.file.buffer, { limitInputPixels: 64000000 }).metadata();
    const extensionByFormat = { png: 'png', jpeg: 'jpg', webp: 'webp' };
    const extension = extensionByFormat[metadata.format];
    if (!extension || !MATERIAL_IMAGE_MIMES.has(req.file.mimetype)) {
      return res.status(400).json({ error: 'The uploaded file is not a supported PNG, JPG or WebP image.' });
    }
    if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || metadata.width * metadata.height > 64000000) {
      return res.status(400).json({ error: 'Texture dimensions must be at most 8192 × 8192 pixels.' });
    }
    if (Number(metadata.pages || 1) > 1) {
      return res.status(400).json({ error: 'Animated images cannot be used as material textures.' });
    }

    const fileName = `uploaded_${crypto.randomBytes(10).toString('hex')}.${extension}`;
    outputPath = path.join(materialAssetsDir, fileName);
    fs.writeFileSync(outputPath, req.file.buffer, { flag: 'wx' });

    const record = {
      id: `uploaded-${crypto.randomBytes(8).toString('hex')}`,
      name,
      category: kind === 'fabric' ? 'Uploaded Fabric' : 'Uploaded Texture',
      kind,
      fileName,
      texturePath: `/assets/materials/${fileName}`,
      color: '#FFFFFF',
      rgb: [1, 1, 1],
      repeat: kind === 'fabric' ? [5, 5] : [2, 2],
      roughness: kind === 'fabric' ? 0.92 : 0.78,
      metallic: 0,
      createdAt: new Date().toISOString(),
    };

    const records = readMaterialLibraryRecords();
    records.unshift(record);
    writeMaterialLibraryRecords(records);

    res.status(201).json({ success: true, material: serializeUploadedMaterial(record) });
  } catch (error) {
    if (outputPath && fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch (_) {}
    }
    console.error('[Materials] Texture upload failed:', error);
    res.status(400).json({ error: 'Could not process this image. Use a valid PNG, JPG or WebP texture.' });
  }
});

// Serve uploaded catalog files
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Mount catalog and admin API routes
app.use('/api/catalog', catalogRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ifc-editor', ifcEditorRoutes);

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
// SAVED 360 LAYOUT SNAPSHOT CONTRACT
// ==========================================
// Current WalkNavigationPipeline writes walk_hotspots.json (areas + hotspots).
// walk_areas.json is retained as an optional legacy artifact only; it is not
// produced by the current compiler and must never block a valid layout update.
const SAVED_LAYOUT_REQUIRED_RENDER_FILES = [
  'output.glb',
  'navigation_surface.json',
  'navigation_navmesh.bin',
  'walk_hotspots.json',
  'input.ifc',
];

const SAVED_LAYOUT_OPTIONAL_RENDER_FILES = [
  'original.ifc',
  'walk_areas.json', // Legacy compatibility only.
  'presentation_rooms.json',
  'presentation_portals.json',
  'presentation_room_graph.json',
  'navigation_meta.json',
  'room_connectivity.json',
  'doorway_traversability.json',
  'hosted_door_portals.json',
  'performance_report.json',
  'optimization_report.json',
  'presentation_manifest.json',
];

function inspectSavedLayoutRenderSnapshot(sourceJobDir) {
  const missingFiles = SAVED_LAYOUT_REQUIRED_RENDER_FILES.filter((fileName) => (
    !fs.existsSync(path.join(sourceJobDir, fileName))
    || !fs.statSync(path.join(sourceJobDir, fileName)).isFile()
    || fs.statSync(path.join(sourceJobDir, fileName)).size <= 0
  ));
  if (missingFiles.length) return { files: [], missingFiles };

  const files = [
    ...SAVED_LAYOUT_REQUIRED_RENDER_FILES,
    ...SAVED_LAYOUT_OPTIONAL_RENDER_FILES.filter((fileName) => (
      fs.existsSync(path.join(sourceJobDir, fileName))
      && fs.statSync(path.join(sourceJobDir, fileName)).isFile()
    )),
  ];

  // A few older working jobs do not retain original.ifc separately. Keep the
  // restore contract intact by using the exact rendered input as the fallback.
  if (!files.includes('original.ifc')) files.push('original.ifc');
  return { files, missingFiles: [] };
}

function copySavedLayoutRenderSnapshot(sourceJobDir, destinationJobDir, files) {
  fs.mkdirSync(destinationJobDir, { recursive: true });
  for (const fileName of files) {
    const sourceName = fileName === 'original.ifc'
      && !fs.existsSync(path.join(sourceJobDir, 'original.ifc'))
      ? 'input.ifc'
      : fileName;
    fs.copyFileSync(
      path.join(sourceJobDir, sourceName),
      path.join(destinationJobDir, fileName),
    );
  }
}

// ==========================================
// SAVED 360 LAYOUTS API
// ==========================================
// Each saved layout is an immutable snapshot of the already-rendered scene.
// Its private render job contains the exact GLB + navigation artifacts used by
// the React walkthrough, so reopening a saved layout does not mutate the active project.
app.get('/api/saved-layouts', (req, res) => {
  try {
    res.json({ layouts: readAllSavedLayouts().map(decorateSavedLayout) });
  } catch (error) {
    console.error('[SavedLayouts] Global List Error:', error);
    res.status(500).json({ error: 'Failed to list saved layouts.' });
  }
});

// Backward-compatible route. It intentionally returns the GLOBAL collection.
app.get('/api/projects/:jobId/saved-layouts', (req, res) => {
  try {
    const { jobId } = req.params;
    if (!fs.existsSync(path.join(jobsDir, jobId))) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    res.json({ layouts: readAllSavedLayouts().map(decorateSavedLayout) });
  } catch (error) {
    console.error('[SavedLayouts] List Error:', error);
    res.status(500).json({ error: 'Failed to list saved layouts.' });
  }
});

app.post('/api/projects/:jobId/saved-layouts', renderUpload.single('thumbnail'), (req, res) => {
  try {
    const { jobId } = req.params;
    if (!requireActiveProject(jobId, res)) return;

    const parentJobDir = path.join(jobsDir, jobId);
    const snapshot = inspectSavedLayoutRenderSnapshot(parentJobDir);
    if (snapshot.missingFiles.length) {
      return res.status(409).json({
        error: `The 360 render is not ready to save. Missing required artifacts: ${snapshot.missingFiles.join(', ')}. Run a fresh 360 render and try again.`,
        missingFiles: snapshot.missingFiles,
      });
    }

    const rawName = String(req.body?.name || '').trim();
    if (!rawName) return res.status(400).json({ error: 'Layout name is required.' });
    if (rawName.length > 80) return res.status(400).json({ error: 'Layout name must be 80 characters or fewer.' });

    let metadata;
    try {
      metadata = normalizeSavedLayoutMetadata(req.body || {});
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    let projectState = {};
    let renderConfig = {};
    try { projectState = req.body?.projectState ? JSON.parse(req.body.projectState) : {}; }
    catch (_) { return res.status(400).json({ error: 'Invalid projectState JSON.' }); }
    try { renderConfig = req.body?.renderConfig ? JSON.parse(req.body.renderConfig) : {}; }
    catch (_) { return res.status(400).json({ error: 'Invalid renderConfig JSON.' }); }

    const renderJobId = generateSavedLayoutId();
    const renderJobDir = path.join(jobsDir, renderJobId);
    const layoutsDir = path.join(parentJobDir, 'saved_layouts');
    fs.mkdirSync(renderJobDir, { recursive: true });
    fs.mkdirSync(layoutsDir, { recursive: true });

    // Freeze the exact compiled scene and the artifacts consumed by the React
    // walkthrough. Current navigation uses walk_hotspots.json; walk_areas.json
    // is copied only when found on legacy jobs.
    copySavedLayoutRenderSnapshot(parentJobDir, renderJobDir, snapshot.files);

    if (req.file?.buffer) fs.writeFileSync(path.join(renderJobDir, 'thumbnail.jpg'), req.file.buffer);

    const now = new Date().toISOString();
    const manifest = {
      jobId: renderJobId,
      type: 'saved_layout',
      parentJobId: jobId,
      name: rawName,
      originalFileName: `Saved Layout - ${rawName}.ifc`,
      ...metadata,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };
    writeManifest(renderJobDir, manifest);
    fs.writeFileSync(path.join(renderJobDir, 'project_state.json'), JSON.stringify(projectState, null, 2));
    fs.writeFileSync(path.join(renderJobDir, 'saved_layout_state.json'), JSON.stringify({ projectState, renderConfig, ...metadata, name: rawName }, null, 2));

    const layoutRecord = {
      id: renderJobId,
      renderJobId,
      parentJobId: jobId,
      name: rawName,
      createdAt: now,
      updatedAt: now,
      renderType: '360',
      categoryType: metadata.categoryType,
      categoryName: metadata.categoryName,
      subCategory: metadata.subCategory,
      thumbnailFile: fs.existsSync(path.join(renderJobDir, 'thumbnail.jpg')) ? 'thumbnail.jpg' : null,
    };
    const layoutRecordJson = JSON.stringify(layoutRecord, null, 2);
    fs.writeFileSync(path.join(layoutsDir, `${renderJobId}.json`), layoutRecordJson);
    fs.writeFileSync(path.join(savedLayoutsRegistryDir, `${renderJobId}.json`), layoutRecordJson);
    touchManifest(parentJobDir);

    res.json({
      success: true,
      layout: {
        ...decorateSavedLayout(layoutRecord),
      },
    });
  } catch (error) {
    console.error('[SavedLayouts] Create Error:', error);
    res.status(500).json({ error: 'Failed to save 360 layout.' });
  }
});

// Update a saved layout with the latest rendered state from a working project.
// The public saved-layout id remains stable while a new immutable render snapshot
// is created and atomically promoted as the latest version.
app.put('/api/saved-layouts/:layoutId/snapshot', renderUpload.single('thumbnail'), (req, res) => {
  let newSnapshotDir = null;
  try {
    const { layoutId } = req.params;
    const sourceJobId = String(req.body?.sourceJobId || '').trim();
    if (!sourceJobId) return res.status(400).json({ error: 'sourceJobId is required.' });

    const layout = findSavedLayout(layoutId);
    if (!layout) return res.status(404).json({ error: 'Saved layout not found.' });

    const sourceJobDir = path.join(jobsDir, sourceJobId);
    if (!fs.existsSync(sourceJobDir)) {
      return res.status(404).json({ error: 'Source working project not found.' });
    }

    const sourceManifest = readManifest(sourceJobDir);
    if (sourceManifest?.status === 'archived') {
      return res.status(403).json({ error: 'The current working project is archived and cannot update a saved layout.' });
    }

    const snapshot = inspectSavedLayoutRenderSnapshot(sourceJobDir);
    if (snapshot.missingFiles.length) {
      return res.status(409).json({
        error: `The current 360 render is incomplete. Missing required artifacts: ${snapshot.missingFiles.join(', ')}. Generate a fresh 360 render before updating this layout.`,
        missingFiles: snapshot.missingFiles,
      });
    }
    const snapshotFiles = snapshot.files;

    let renderConfig = {};
    if (req.body?.renderConfig) {
      try {
        renderConfig = JSON.parse(req.body.renderConfig);
      } catch (_) {
        return res.status(400).json({ error: 'Invalid renderConfig JSON.' });
      }
    }

    let projectState = {};
    const sourceStatePath = path.join(sourceJobDir, 'project_state.json');
    if (fs.existsSync(sourceStatePath)) {
      try {
        projectState = JSON.parse(fs.readFileSync(sourceStatePath, 'utf-8'));
      } catch (_) {
        return res.status(409).json({ error: 'Current project state is invalid JSON.' });
      }
    }

    // Stage the complete new immutable snapshot before touching the live layout
    // record. A failure therefore leaves the previous saved version usable.
    const newRenderJobId = generateSavedLayoutId();
    newSnapshotDir = path.join(jobsDir, newRenderJobId);
    copySavedLayoutRenderSnapshot(sourceJobDir, newSnapshotDir, snapshotFiles);

    if (req.file?.buffer) {
      fs.writeFileSync(path.join(newSnapshotDir, 'thumbnail.jpg'), req.file.buffer);
    } else {
      const previousThumbnail = layout.thumbnailFile
        ? path.join(jobsDir, layout.renderJobId || layout.id, layout.thumbnailFile)
        : null;
      if (previousThumbnail && fs.existsSync(previousThumbnail)) {
        fs.copyFileSync(previousThumbnail, path.join(newSnapshotDir, 'thumbnail.jpg'));
      }
    }

    const now = new Date().toISOString();
    writeManifest(newSnapshotDir, {
      jobId: newRenderJobId,
      type: 'saved_layout',
      parentJobId: layout.parentJobId || sourceJobId,
      name: layout.name,
      originalFileName: `Saved Layout - ${layout.name}.ifc`,
      categoryType: layout.categoryType,
      categoryName: layout.categoryName,
      subCategory: layout.subCategory,
      createdAt: layout.createdAt || now,
      updatedAt: now,
      status: 'active',
      updatedFromProjectJobId: sourceJobId,
    });

    fs.writeFileSync(
      path.join(newSnapshotDir, 'project_state.json'),
      JSON.stringify(projectState, null, 2)
    );
    fs.writeFileSync(
      path.join(newSnapshotDir, 'saved_layout_state.json'),
      JSON.stringify({
        projectState,
        renderConfig,
        categoryType: layout.categoryType,
        categoryName: layout.categoryName,
        subCategory: layout.subCategory,
        name: layout.name,
        updatedAt: now,
      }, null, 2)
    );

    const nextLayout = {
      ...layout,
      renderJobId: newRenderJobId,
      updatedAt: now,
      thumbnailFile: fs.existsSync(path.join(newSnapshotDir, 'thumbnail.jpg')) ? 'thumbnail.jpg' : null,
    };

    // Promote the new snapshot only after all files are present.
    writeSavedLayoutRecord(nextLayout);

    const previousRenderJobId = layout.renderJobId || layout.id;
    const previousSnapshotDir = path.join(jobsDir, previousRenderJobId);
    if (previousRenderJobId !== newRenderJobId && previousRenderJobId !== sourceJobId && fs.existsSync(previousSnapshotDir)) {
      fs.rmSync(previousSnapshotDir, { recursive: true, force: true });
    }

    return res.json({ success: true, layout: decorateSavedLayout(nextLayout) });
  } catch (error) {
    if (newSnapshotDir && fs.existsSync(newSnapshotDir)) {
      try { fs.rmSync(newSnapshotDir, { recursive: true, force: true }); } catch (_) {}
    }
    console.error('[SavedLayouts] Snapshot Update Error:', error);
    return res.status(500).json({ error: 'Failed to update saved layout snapshot.' });
  }
});

// Edit saved-layout metadata without changing the frozen render snapshot.
app.patch('/api/saved-layouts/:layoutId', (req, res) => {
  try {
    const layout = findSavedLayout(req.params.layoutId);
    if (!layout) return res.status(404).json({ error: 'Saved layout not found.' });

    const rawName = String(req.body?.name || '').trim();
    if (!rawName) return res.status(400).json({ error: 'Layout name is required.' });
    if (rawName.length > 80) return res.status(400).json({ error: 'Layout name must be 80 characters or fewer.' });

    let metadata;
    try {
      metadata = normalizeSavedLayoutMetadata(req.body || {});
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const updated = {
      ...layout,
      name: rawName,
      ...metadata,
      updatedAt: new Date().toISOString(),
    };

    // Keep the snapshot metadata aligned with the visible layout record.
    const snapshotDir = path.join(jobsDir, updated.renderJobId || updated.id);
    const savedLayoutStatePath = path.join(snapshotDir, 'saved_layout_state.json');
    if (fs.existsSync(savedLayoutStatePath)) {
      try {
        const savedLayoutState = JSON.parse(fs.readFileSync(savedLayoutStatePath, 'utf-8'));
        fs.writeFileSync(
          savedLayoutStatePath,
          JSON.stringify({ ...savedLayoutState, ...metadata, name: rawName }, null, 2)
        );
      } catch (_) {
        console.warn(`[SavedLayouts] Could not update saved_layout_state.json for ${updated.id}`);
      }
    }

    const snapshotManifest = readManifest(snapshotDir);
    if (snapshotManifest) {
      snapshotManifest.name = updated.name;
      snapshotManifest.originalFileName = `Saved Layout - ${updated.name}.ifc`;
      snapshotManifest.categoryType = updated.categoryType;
      snapshotManifest.categoryName = updated.categoryName;
      snapshotManifest.subCategory = updated.subCategory;
      snapshotManifest.updatedAt = updated.updatedAt;
      writeManifest(snapshotDir, snapshotManifest);
    }

    writeSavedLayoutRecord(updated);
    res.json({ success: true, layout: decorateSavedLayout(updated) });
  } catch (error) {
    console.error('[SavedLayouts] Update Error:', error);
    res.status(500).json({ error: 'Failed to update saved layout.' });
  }
});

// Delete a saved layout and its immutable render snapshot.
app.delete('/api/saved-layouts/:layoutId', (req, res) => {
  try {
    const layout = findSavedLayout(req.params.layoutId);
    if (!layout) return res.status(404).json({ error: 'Saved layout not found.' });

    removeSavedLayoutRecord(layout);
    res.json({ success: true, deletedLayoutId: layout.id });
  } catch (error) {
    console.error('[SavedLayouts] Delete Error:', error);
    res.status(500).json({ error: 'Failed to delete saved layout.' });
  }
});

// Restore a saved layout as a normal working project.
// The saved layout itself remains untouched; the user gets a fresh project
// containing the exact IFC + project state captured when the layout was saved.
app.post('/api/projects/:jobId/saved-layouts/:layoutId/restore', (req, res) => {
  try {
    const { jobId, layoutId } = req.params;
    if (!requireActiveProject(jobId, res)) return;

    const layouts = readAllSavedLayouts();
    const layout = layouts.find(item => item.id === layoutId || item.renderJobId === layoutId);
    if (!layout) {
      return res.status(404).json({ error: 'Saved layout not found.' });
    }

    const sourceJobId = layout.renderJobId;
    const sourceJobDir = path.join(jobsDir, sourceJobId);
    if (!fs.existsSync(sourceJobDir)) {
      return res.status(404).json({ error: 'Saved layout render snapshot is missing.' });
    }

    const inputIfcPath = path.join(sourceJobDir, 'input.ifc');
    const originalIfcPath = path.join(sourceJobDir, 'original.ifc');
    const statePath = path.join(sourceJobDir, 'project_state.json');

    if (!fs.existsSync(inputIfcPath) || !fs.existsSync(statePath)) {
      return res.status(409).json({ error: 'Saved layout snapshot is incomplete.' });
    }

    const newJobId = generateJobId();
    const newJobDir = path.join(jobsDir, newJobId);
    fs.mkdirSync(newJobDir, { recursive: true });

    // The restored workspace must start from the exact IFC captured by the
    // saved layout, not the currently active project's IFC.
    fs.copyFileSync(inputIfcPath, path.join(newJobDir, 'input.ifc'));
    fs.copyFileSync(
      fs.existsSync(originalIfcPath) ? originalIfcPath : inputIfcPath,
      path.join(newJobDir, 'original.ifc')
    );
    fs.copyFileSync(statePath, path.join(newJobDir, 'project_state.json'));

    const now = new Date().toISOString();
    const sourceManifest = readManifest(sourceJobDir);
    writeManifest(newJobDir, {
      jobId: newJobId,
      originalFileName: (() => {
        const n = sourceManifest?.originalFileName || `Saved Layout - ${layout.name}`;
        return /\.ifc$/i.test(n) ? n : `${n}.ifc`;
      })(),
      createdAt: now,
      updatedAt: now,
      status: 'active',
      restoredFromSavedLayoutId: layout.id,
      restoredFromLayoutName: layout.name,
      savedLayoutsSourceJobId: jobId,
    });

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;

    return res.json({
      success: true,
      sourceJobId,
      newJobId,
      fileName: (() => {
        const n = sourceManifest?.originalFileName || `Saved Layout - ${layout.name}`;
        return /\.ifc$/i.test(n) ? n : `${n}.ifc`;
      })(),
      fileUrl: `${protocol}://${host}/jobs/${newJobId}/input.ifc`,
      savedLayoutsSourceJobId: jobId,
      savedLayoutId: layout.id,
      savedLayoutName: layout.name,
    });
  } catch (error) {
    console.error('[SavedLayouts] Restore Error:', error);
    res.status(500).json({ error: 'Failed to restore saved layout.' });
  }
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
        atomicWriteJson(path.join(jobDir, 'project_state.json'), { materials: {}, furniture: [] });

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
            .filter((manifest) => manifest.type !== 'saved_layout')
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
        const incomingState = req.body && req.body.projectState ? req.body.projectState : req.body;
        if (!incomingState || typeof incomingState !== 'object' || Array.isArray(incomingState)) {
            return res.status(400).json({ success: false, error: 'Project state must be a JSON object.' });
        }

        const clientRevision = req.get('X-HCI-Project-Revision');
        const result = writeProjectStateSnapshot(jobDirPath, incomingState, clientRevision);
        if (result.stale) {
            return res.status(409).json({
                success: false,
                error: 'This save is older than the current project snapshot. The newer state was kept; reload the project before saving again.',
                savedAt: result.savedAt,
                clientRevision: result.clientRevision,
            });
        }
        res.json({
            success: true,
            message: 'Design saved successfully',
            savedAt: result.savedAt,
            clientRevision: result.clientRevision,
        });
    } catch (error) {
        console.error('Save Error:', error);
        res.status(500).json({ error: 'Failed to save project state' });
    }
});

// Versioned room/ceiling analysis API. The legacy /ceiling-rooms route below
// remains for older editor builds; new clients use this versioned contract.
function resolveLocalTsxCli() {
    const candidates = [
        'tsx/cli',
        'tsx/dist/cli.mjs',
    ];
    for (const candidate of candidates) {
        try { return require.resolve(candidate, { paths: [__dirname] }); }
        catch (_) { /* try the next package entry */ }
    }
    const directCandidates = [
        path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.js'),
    ];
    return directCandidates.find((candidate) => fs.existsSync(candidate)) || null;
}

app.post('/api/projects/:jobId/ceiling-analysis', (req, res) => {
    const { jobId } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return res.status(400).json({ error: 'Invalid project id.' });
    if (!requireActiveProject(jobId, res)) return;

    const jobDir = path.join(jobsDir, jobId);
    const inputIfcPath = [path.join(jobDir, 'input.ifc'), path.join(jobDir, 'original.ifc')]
        .find((candidate) => fs.existsSync(candidate));
    const statePath = path.join(jobDir, 'project_state.json');
    if (!inputIfcPath) return res.status(404).json({ error: 'Project IFC source was not found.' });
    if (!fs.existsSync(statePath)) return res.status(409).json({ error: 'Project state is not ready yet. Save the project and retry.' });

    const tsxCliPath = resolveLocalTsxCli();
    if (!tsxCliPath) {
        return res.status(500).json({
            error: 'The local tsx runtime was not found. Install backend dependencies with npm install before running ceiling analysis.',
        });
    }

    const outputPath = path.join(jobDir, 'ceiling_analysis.json');
    const scriptPath = path.join(__dirname, 'compiler', 'analyze-ceiling-rooms.ts');
    if (!fs.existsSync(scriptPath)) return res.status(500).json({ error: 'Ceiling analysis script is missing.', details: scriptPath });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const MAX_OUTPUT = 8 * 1024 * 1024;
    const child = spawn(process.execPath, [
        tsxCliPath,
        scriptPath,
        jobDir,
        inputIfcPath,
        outputPath,
        req.body?.forceRebuild === true ? '--force' : '',
    ].filter(Boolean), {
        cwd: __dirname,
        windowsHide: true,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
        if (settled) return;
        child.kill();
        settled = true;
        if (!res.headersSent) res.status(504).json({ error: 'Ceiling analysis timed out. Check the IFC geometry and retry.' });
    }, 120000);

    const finish = (status, payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (!res.headersSent) res.status(status).json(payload);
    };

    child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString().slice(0, MAX_OUTPUT - stdout.length);
    });
    child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString().slice(0, MAX_OUTPUT - stderr.length);
    });
    child.on('error', (error) => {
        console.error('[CeilingAnalysis] Failed to start local tsx process:', error);
        finish(500, { error: 'Could not start ceiling analysis.', details: error.message });
    });
    child.on('close', (code, signal) => {
        if (settled) return;
        if (code !== 0) {
            console.error('[CeilingAnalysis] Detector failed:', stderr || stdout || signal);
            return finish(500, {
                error: 'Room and ceiling analysis failed for this IFC model.',
                details: (stderr || stdout || `Process exited with ${code ?? signal}`).slice(-5000),
            });
        }
        try {
            const responseText = stdout.trim();
            const result = responseText ? JSON.parse(responseText) : JSON.parse(fs.readFileSync(outputPath, 'utf8'));
            // CeilingAnalysisService currently emits schemaVersion 2. Keep
            // accepting v1 during the migration window so older cached outputs
            // and compatible workers remain usable, while validating the same
            // required rooms/levels arrays for both response versions.
            const schemaVersion = Number(result?.schemaVersion);
            const supportedSchemaVersions = [1, 2];
            if (
                !supportedSchemaVersions.includes(schemaVersion) ||
                !Array.isArray(result?.rooms) ||
                !Array.isArray(result?.levels)
            ) {
                const details = [
                    `schemaVersion=${String(result?.schemaVersion ?? 'missing')}`,
                    `rooms=${Array.isArray(result?.rooms) ? 'array' : typeof result?.rooms}`,
                    `levels=${Array.isArray(result?.levels) ? 'array' : typeof result?.levels}`,
                    `supported=${supportedSchemaVersions.join(',')}`,
                ].join('; ');
                console.error('[CeilingAnalysis] Unsupported response contract:', details);
                return finish(500, {
                    error: 'Ceiling analysis returned an unsupported response contract.',
                    details,
                });
            }
            finish(200, result);
        } catch (error) {
            console.error('[CeilingAnalysis] Invalid detector response:', error.message, stdout.slice(-1000));
            finish(500, { error: 'Ceiling analysis returned invalid JSON.', details: error.message });
        }
    });

    res.on('close', () => {
        if (!res.writableEnded && !settled) {
            settled = true;
            clearTimeout(timeout);
            child.kill();
        }
    });
});

// Detect room footprints and estimated ceiling elevations for the editor's
// room-aware ceiling designer. Results are generated from the same IFC room
// topology engine used by the presentation compiler.
app.post('/api/projects/:jobId/ceiling-rooms', (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return res.status(400).json({ error: 'Invalid project id.' });
  if (!requireActiveProject(jobId, res)) return;

  const jobDir = path.join(jobsDir, jobId);
  const inputIfcPath = [path.join(jobDir, 'input.ifc'), path.join(jobDir, 'original.ifc')]
    .find((candidate) => fs.existsSync(candidate));
  const statePath = path.join(jobDir, 'project_state.json');
  if (!inputIfcPath) return res.status(404).json({ error: 'Project IFC source was not found.' });
  if (!fs.existsSync(statePath)) return res.status(409).json({ error: 'Project state is not ready yet. Save the project and retry.' });

  const outputPath = path.join(jobDir, 'ceiling_rooms.json');
  const scriptPath = path.join(__dirname, 'compiler', 'detect-ceiling-rooms.ts');
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(npxCommand, ['tsx', scriptPath, jobDir, inputIfcPath, outputPath], {
    cwd: __dirname,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    console.error('[CeilingDesigner] Room detection failed to start:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start room detection.', details: error.message });
  });
  child.on('close', (code) => {
    if (res.headersSent) return;
    if (code !== 0) {
      console.error('[CeilingDesigner] Room detection failed:', stderr || stdout);
      return res.status(500).json({ error: 'Room detection failed for this IFC model.', details: (stderr || stdout).slice(-3000) });
    }
    try {
      const result = JSON.parse(stdout.trim());
      res.json(result);
    } catch (error) {
      console.error('[CeilingDesigner] Invalid detector response:', error.message, stdout.slice(-1000));
      res.status(500).json({ error: 'Room detector returned an invalid response.' });
    }
  });
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  res.on('close', () => { if (!res.writableEnded) child.kill(); });
});


app.get('/api/projects/:jobId/load', (req, res) => {
    try {
        const jobId = req.params.jobId;
        const jobDir = path.join(jobsDir, jobId);
        if (!fs.existsSync(jobDir)) {
            return res.status(404).json({ error: 'Project job was not found.' });
        }
        const statePath = path.join(jobDir, 'project_state.json');
        const metadata = readProjectStateMetadata(jobDir);

        if (metadata.exists) {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            const safeState = state && typeof state === 'object' && !Array.isArray(state)
                ? state
                : { materials: {}, furniture: [] };
            res.json({
                ...safeState,
                _persistence: metadata,
            });
        } else {
            res.json({ materials: {}, furniture: [], _persistence: metadata });
        }
    } catch (error) {
        console.error('[ProjectState] Load error:', error.message);
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
    console.error(`[ConvertFloorplan] AI generation failed for jobId ${jobId}:`, (err && err.body) || err);

    const fallbackLayout = PREDEFINED_LAYOUTS.find(l => l.id === '3bhk');
    if (fallbackLayout && fs.existsSync(fallbackLayout.assetPath)) {
      try {
        const fallbackFileName = `${jobId}_Generated.ifc`;
        const fallbackOutputPath = path.join(jobDir, fallbackFileName);
        fs.copyFileSync(fallbackLayout.assetPath, fallbackOutputPath);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers.host;
        const fileUrl = `${protocol}://${host}/jobs/${jobId}/${fallbackFileName}`;

        return res.json({
          success: true,
          fallback: true,
          message: 'AI generation failed. Showing the default 3 BHK layout instead.',
          fileUrl: fileUrl,
          jobId: jobId,
        });
      } catch (copyErr) {
        console.error(`[ConvertFloorplan] Fallback copy failed for jobId ${jobId}:`, copyErr);
      }
    }

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
// RENDER CACHE HELPERS
// ==========================================
const RENDER_CACHE_VERSION = 'hci-render-cache-v3-ceiling-finishes-profiles';
const RENDER_CACHE_REQUIRED_ARTIFACTS = [
    'output.glb',
    'navigation_navmesh.bin',
    'navigation_surface.json',
    'navigation_meta.json',
    'walk_hotspots.json',
    'presentation_rooms.json',
    'presentation_portals.json',
    'optimization_report.json',
    'performance_report.json',
    'presentation_manifest.json',
];
const RENDER_PIPELINE_SOURCE_FILES = [
    'server.js',
    'package.json',
    'scene_merger.py',
    'compiler/compiler.ts',
    'compiler/ceiling/CeilingGeometry.ts',
    'compiler/geometry.ts',
    'compiler/math.ts',
    'compiler/glb-optimizer.ts',
    'compiler/navigation/WalkNavigationPipeline.ts',
    'compiler/navigation/RoomDetector.ts',
    'compiler/performanceReport.ts',
    'compiler/presentationManifest.ts',
];

function sha256File(filePath) {
    // Hash large IFC files in chunks so render-cache checks do not duplicate an
    // entire source IFC in memory.
    const hash = crypto.createHash('sha256');
    const descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest('hex');
}

function fileStamp(filePath, includeHash = false) {
    try {
        const stat = fs.statSync(filePath);
        return {
            path: path.relative(__dirname, filePath).split(path.sep).join('/'),
            size: stat.size,
            ...(includeHash
                ? { sha256: sha256File(filePath) }
                : { mtimeMs: Math.trunc(stat.mtimeMs), ino: Number(stat.ino) || 0 }),
        };
    } catch {
        return null;
    }
}

function resolveRenderDependencyPath(src) {
    if (!src || typeof src !== 'string') return null;
    let clean = src.trim();
    try {
        if (/^https?:\/\//i.test(clean)) clean = new URL(clean).pathname;
    } catch {
        return null;
    }
    clean = clean.split('?')[0].split('#')[0];
    if (!clean) return null;

    let candidate = null;
    if (clean.startsWith('/uploads/')) {
        candidate = path.resolve(__dirname, clean.slice(1));
    } else if (clean.startsWith('/assets/')) {
        candidate = path.resolve(assetsDir, clean.slice('/assets/'.length));
    } else if (clean.startsWith('/materials/')) {
        candidate = path.resolve(__dirname, 'compiler', 'materials', clean.slice('/materials/'.length));
    } else if (clean.startsWith('/jobs/')) {
        const match = clean.match(/^\/jobs\/([^/]+)\/(.+)$/);
        if (!match) return null;
        candidate = path.resolve(jobsDir, match[1], match[2]);
        const jobsRoot = path.resolve(jobsDir);
        if (candidate !== jobsRoot && !candidate.startsWith(`${jobsRoot}${path.sep}`)) return null;
    } else if (path.isAbsolute(clean)) {
        candidate = path.resolve(clean);
    }

    return candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        ? candidate
        : null;
}

function computeRenderInputSignature(jobDir) {
    const inputIfcPath = path.join(jobDir, 'input.ifc');
    const projectStatePath = path.join(jobDir, 'project_state.json');
    if (!fs.existsSync(inputIfcPath) || !fs.existsSync(projectStatePath)) return null;

    let projectState;
    try {
        projectState = JSON.parse(fs.readFileSync(projectStatePath, 'utf8'));
    } catch {
        return null;
    }

    const dependencyPaths = new Set();
    const addDependency = (src) => {
        const resolved = resolveRenderDependencyPath(src);
        if (resolved) dependencyPaths.add(resolved);
    };

    for (const item of Array.isArray(projectState.furniture) ? projectState.furniture : []) {
        addDependency(item?.src);
    }
    // Ceiling texture/fabric finishes are first-class render inputs. Include
    // their files in the cache key so replacing a library texture cannot reuse
    // an older GLB compiled with the previous image.
    const ceilingDesigns = Array.isArray(projectState.ceilingDesigns)
        ? projectState.ceilingDesigns
        : (Array.isArray(projectState.ceilings) ? projectState.ceilings : []);
    for (const ceiling of ceilingDesigns) {
        addDependency(ceiling?.finish?.texture?.src);
        addDependency(ceiling?.finish?.textureSrc);
        addDependency(ceiling?.finish?.textureUrl);
    }
    const materials = projectState.materials && typeof projectState.materials === 'object'
        ? Object.values(projectState.materials)
        : [];
    for (const material of materials) {
        addDependency(material?.texture?.src);
        addDependency(material?.textureSrc);
    }

    const codeStamps = RENDER_PIPELINE_SOURCE_FILES
        .map((relative) => fileStamp(path.join(__dirname, relative), false))
        .filter(Boolean)
        .sort((a, b) => String(a.path).localeCompare(String(b.path)));
    const assetStamps = Array.from(dependencyPaths)
        .map((filePath) => fileStamp(filePath, false))
        .filter(Boolean)
        .sort((a, b) => String(a.path).localeCompare(String(b.path)));

    const payload = {
        version: RENDER_CACHE_VERSION,
        inputIfc: fileStamp(inputIfcPath, true),
        projectState: fileStamp(projectStatePath, true),
        code: codeStamps,
        dependencies: assetStamps,
        optimizer: {
            simplifyRatio: process.env.HCI_GLB_SIMPLIFY_RATIO || '0.70',
            simplifyError: process.env.HCI_GLB_SIMPLIFY_ERROR || '0.001',
            maxTextureSize: process.env.HCI_GLB_MAX_TEXTURE_SIZE || '2048',
            textureQuality: process.env.HCI_GLB_TEXTURE_QUALITY || '86',
        },
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function readReusableRenderCache(jobDir, signature) {
    if (!signature) return null;
    const manifestPath = path.join(jobDir, 'render_cache_manifest.json');
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.version !== RENDER_CACHE_VERSION || manifest.signature !== signature) return null;
        if (!RENDER_CACHE_REQUIRED_ARTIFACTS.every((name) => fs.existsSync(path.join(jobDir, name)))) return null;
        const outputPath = path.join(jobDir, 'output.glb');
        if (!manifest.outputGlbSha256 || sha256File(outputPath) !== manifest.outputGlbSha256) return null;
        return manifest;
    } catch {
        return null;
    }
}

function writeReusableRenderCache(jobDir, signature, compileDurationMs) {
    if (!signature) return;
    const availableArtifacts = RENDER_CACHE_REQUIRED_ARTIFACTS.filter((name) => fs.existsSync(path.join(jobDir, name)));
    if (!RENDER_CACHE_REQUIRED_ARTIFACTS.every((name) => availableArtifacts.includes(name))) {
        console.warn('[Render] Skipping render-cache manifest because required presentation artifacts are missing.');
        return;
    }
    const outputPath = path.join(jobDir, 'output.glb');
    atomicWriteJson(path.join(jobDir, 'render_cache_manifest.json'), {
        version: RENDER_CACHE_VERSION,
        signature,
        generatedAt: new Date().toISOString(),
        compileDurationMs,
        outputGlbSha256: sha256File(outputPath),
        artifacts: availableArtifacts,
    });
}

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
        let stateData;
        try {
            stateData = typeof req.body.projectState === 'string'
                ? JSON.parse(req.body.projectState)
                : req.body.projectState;
        } catch (_) {
            return res.status(400).json({ error: 'projectState must be valid JSON.' });
        }
        if (!stateData || typeof stateData !== 'object' || Array.isArray(stateData)) {
            return res.status(400).json({ error: 'projectState must be a JSON object.' });
        }
        const renderRevision = req.body.projectRevision;
        const snapshotResult = writeProjectStateSnapshot(jobDir, stateData, renderRevision);
        if (snapshotResult.stale) {
            return res.status(409).json({
                error: 'The project changed while this render was being prepared. Reopen/save the latest project state and render again.',
                savedAt: snapshotResult.savedAt,
                clientRevision: snapshotResult.clientRevision,
            });
        }
    } else if (!fs.existsSync(projectStatePath)) {
        atomicWriteJson(projectStatePath, { materials: {}, furniture: [] });
    }
    touchManifest(jobDir);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    if (angle === "360") {
        const compilerScriptPath = path.join(__dirname, "compiler", "compiler.ts");
        const outputGlbPath = path.join(jobDir, "output.glb");
        const compileStartedAt = Date.now();
        let renderSignature = null;
        try {
            renderSignature = computeRenderInputSignature(jobDir);
        } catch (signatureError) {
            console.warn('[Render] Could not compute render cache signature; compiling normally:', signatureError.message);
        }

        const cachedRender = readReusableRenderCache(jobDir, renderSignature);
        if (cachedRender && fs.existsSync(outputGlbPath)) {
            console.log(`[Render] Full scene cache hit for ${jobId}; reusing output.glb and navigation artifacts.`);
            const legacyViewerPath = path.join(jobDir, '360_viewer.html');
            try {
                if (fs.existsSync(legacyViewerPath)) fs.unlinkSync(legacyViewerPath);
            } catch (cleanupError) {
                console.warn('[Render] Unable to remove legacy 360_viewer.html:', cleanupError.message);
            }
            return res.json({
                type: "360",
                url: `/walkthrough/${encodeURIComponent(jobId)}`,
                walkthroughPath: `/walkthrough/${encodeURIComponent(jobId)}`,
                modelUrl: `${baseUrl}/jobs/${encodeURIComponent(jobId)}/output.glb`,
                jobId,
                cacheHit: true,
                compileDurationMs: 0,
            });
        }

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

        const compileDurationMs = Date.now() - compileStartedAt;
        let navigationCacheHit = false;
        try {
            const perfPath = path.join(jobDir, 'performance_report.json');
            if (fs.existsSync(perfPath)) {
                const performanceReport = JSON.parse(fs.readFileSync(perfPath, 'utf8'));
                navigationCacheHit = Boolean(performanceReport?.navigation?.cacheHit);
            }
        } catch (performanceReadError) {
            console.warn('[Render] Could not read navigation cache status:', performanceReadError.message);
        }
        try {
            // The synchronous compile keeps the request's saved-state snapshot stable.
            // Cache only when the exact inputs are unchanged and every artifact exists.
            const completedSignature = computeRenderInputSignature(jobDir);
            writeReusableRenderCache(jobDir, completedSignature, compileDurationMs);
        } catch (cacheError) {
            console.warn('[Render] Could not persist render-cache manifest:', cacheError.message);
        }

        // React /walkthrough/:jobId is the only client-facing presentation runtime.
        // No standalone HTML viewer is generated anymore.
        const legacyViewerPath = path.join(jobDir, '360_viewer.html');
        try {
            if (fs.existsSync(legacyViewerPath)) fs.unlinkSync(legacyViewerPath);
        } catch (cleanupError) {
            console.warn('[Render] Unable to remove legacy 360_viewer.html:', cleanupError.message);
        }

        return res.json({
            type: "360",
            url: `/walkthrough/${encodeURIComponent(jobId)}`,
            walkthroughPath: `/walkthrough/${encodeURIComponent(jobId)}`,
            modelUrl: `${baseUrl}/jobs/${encodeURIComponent(jobId)}/output.glb`,
            jobId,
            cacheHit: false,
            navigationCacheHit,
            compileDurationMs,
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

        // Remove saved render snapshots that belonged to this project.
        try {
            for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const candidateDir = path.join(jobsDir, entry.name);
                const candidateManifest = readManifest(candidateDir);
                if (candidateManifest?.type === 'saved_layout' && candidateManifest.parentJobId === jobId) {
                    fs.rmSync(candidateDir, { recursive: true, force: true });
                }
            }
        } catch (cleanupError) {
            console.warn(`[Delete Project] Saved layout cleanup failed for ${jobId}:`, cleanupError.message);
        }

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