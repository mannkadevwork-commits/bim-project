const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SESSIONS_DIR = path.join(__dirname, 'ifc_editor_sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const JOBS_DIR = path.join(__dirname, 'jobs');

const tempUpload = multer({ dest: path.join(SESSIONS_DIR, 'temp') });

function sessionId() {
  return `eds_${crypto.randomBytes(6).toString('hex')}`;
}

function resolvePython() {
  if (process.platform === 'win32') {
    const probe = spawnSync('py', ['-3', '--version'], { encoding: 'utf-8' });
    if (!probe.error && probe.status === 0) return { cmd: 'py', pre: ['-3'] };
  }
  return { cmd: 'python', pre: [] };
}

function runWorker(args) {
  const script = path.join(__dirname, 'ifc_editor_worker.py');
  const py = resolvePython();
  const result = spawnSync(py.cmd, [...py.pre, script, ...args], { encoding: 'utf-8' });
  if (result.error) throw new Error(`Python launch failed: ${result.error.message}`);
  const out = (result.stdout || '').trim();
  if (!out) throw new Error(`Worker produced no output. stderr: ${result.stderr}`);
  const parsed = JSON.parse(out);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

// POST /api/ifc-editor/upload
router.post('/upload', tempUpload.single('ifc'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No IFC file uploaded.' });
    const id = sessionId();
    const dir = path.join(SESSIONS_DIR, id);
    fs.mkdirSync(dir);
    const dest = path.join(dir, 'working.ifc');
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
    res.json({ sessionId: id, originalName: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ifc-editor/use-project
router.post('/use-project', express.json(), (req, res) => {
  try {
    const { jobId } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'jobId is required.' });
    const src = path.join(JOBS_DIR, jobId, 'input.ifc');
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Project IFC not found.' });
    const id = sessionId();
    const dir = path.join(SESSIONS_DIR, id);
    fs.mkdirSync(dir);
    fs.copyFileSync(src, path.join(dir, 'working.ifc'));
    res.json({ sessionId: id, originalName: `project_${jobId}.ifc` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ifc-editor/define-room
router.post('/define-room', express.json(), (req, res) => {
  try {
    const { sessionId: id, roomName, wallIds } = req.body || {};
    if (!id || !roomName || !Array.isArray(wallIds) || wallIds.length < 1)
      return res.status(400).json({ error: 'sessionId, roomName and wallIds[] are required.' });
    const ifc = path.join(SESSIONS_DIR, id, 'working.ifc');
    if (!fs.existsSync(ifc)) return res.status(404).json({ error: 'Session not found.' });
    const data = runWorker(['define_room', ifc, roomName, JSON.stringify(wallIds)]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ifc-editor/rename-element
router.post('/rename-element', express.json(), (req, res) => {
  try {
    const { sessionId: id, elementId, newName } = req.body || {};
    if (!id || !elementId || !newName)
      return res.status(400).json({ error: 'sessionId, elementId and newName are required.' });
    const ifc = path.join(SESSIONS_DIR, id, 'working.ifc');
    if (!fs.existsSync(ifc)) return res.status(404).json({ error: 'Session not found.' });
    const data = runWorker(['rename_element', ifc, elementId, newName]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ifc-editor/update-space
router.post('/update-space', express.json(), (req, res) => {
  try {
    const { sessionId: id, spaceId, wallIds } = req.body || {};
    if (!id || !spaceId || !Array.isArray(wallIds))
      return res.status(400).json({ error: 'sessionId, spaceId and wallIds[] are required.' });
    const ifc = path.join(SESSIONS_DIR, id, 'working.ifc');
    if (!fs.existsSync(ifc)) return res.status(404).json({ error: 'Session not found.' });
    const data = runWorker(['update_space', ifc, spaceId, JSON.stringify(wallIds)]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ifc-editor/session/:id/rooms
router.get('/session/:id/rooms', (req, res) => {
  try {
    const ifc = path.join(SESSIONS_DIR, req.params.id, 'working.ifc');
    if (!fs.existsSync(ifc)) return res.status(404).json({ error: 'Session not found.' });
    const data = runWorker(['list_rooms', ifc]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ifc-editor/download/:id
router.get('/download/:id', (req, res) => {
  const ifc = path.join(SESSIONS_DIR, req.params.id, 'working.ifc');
  if (!fs.existsSync(ifc)) return res.status(404).json({ error: 'Session not found.' });
  res.download(ifc, 'edited.ifc');
});

// GET /api/ifc-editor/file/:id  — serve IFC for XeoKit to load
router.get('/file/:id', (req, res) => {
  const ifc = path.join(SESSIONS_DIR, req.params.id, 'working.ifc');
  if (!fs.existsSync(ifc)) return res.status(404).json({ error: 'Session not found.' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(ifc);
});

module.exports = router;
