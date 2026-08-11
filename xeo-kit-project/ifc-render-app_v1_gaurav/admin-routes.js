const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const uploadsBase = path.join(__dirname, 'uploads', 'catalog');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sub = file.fieldname === 'thumbnail' ? 'thumbnails' : 'models';
    const dir = path.join(uploadsBase, sub);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});

// 400 MB limit covers large IFC/GLB files
const upload = multer({
  storage,
  limits: { fileSize: 400 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.ifc', '.glb', '.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// ── CATEGORY ROUTES ──────────────────────────────────────────

// GET /api/admin/categories
router.get('/categories', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM categories ORDER BY sort_order, name');
  res.json(rows);
});

// POST /api/admin/categories
router.post('/categories', upload.single('thumbnail'), async (req, res) => {
  try {
    const { name, slug, description, parent_id, sort_order } = req.body;
    const image_url = req.file ? `/uploads/catalog/thumbnails/${req.file.filename}` : null;
    const { rows } = await db.query(
      `INSERT INTO categories (name, slug, description, parent_id, image_url, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, slug, description || null, parent_id || null, image_url, sort_order || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[Admin] Create category error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/categories/:id
router.put('/categories/:id', upload.single('thumbnail'), async (req, res) => {
  try {
    const { name, slug, description, parent_id, sort_order } = req.body;
    const updates = { name, slug, description, parent_id, sort_order };
    if (req.file) updates.image_url = `/uploads/catalog/thumbnails/${req.file.filename}`;

    const fields = Object.keys(updates).filter(k => updates[k] !== undefined);
    const values = fields.map(k => updates[k]);
    const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');

    const { rows } = await db.query(
      `UPDATE categories SET ${setClause} WHERE id = $${fields.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Category not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/categories/:id
router.delete('/categories/:id', async (req, res) => {
  await db.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ── ITEM ROUTES ──────────────────────────────────────────────

// GET /api/admin/items?category_id=5
router.get('/items', async (req, res) => {
  const { category_id } = req.query;
  const { rows } = category_id
    ? await db.query('SELECT * FROM catalog_items WHERE category_id = $1 ORDER BY sort_order, name', [category_id])
    : await db.query('SELECT * FROM catalog_items ORDER BY sort_order, name');
  res.json(rows);
});

// POST /api/admin/items
router.post('/items', upload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'model', maxCount: 1 },
]), async (req, res) => {
  try {
    const { category_id, name, slug, description, color_rgb, attributes, sort_order } = req.body;

    if (!req.files?.model?.[0]) {
      return res.status(400).json({ error: 'model file (.ifc or .glb) is required' });
    }

    const modelFile = req.files.model[0];
    const ext = path.extname(modelFile.originalname).toLowerCase().replace('.', '');
    const file_type = ext === 'glb' ? 'glb' : 'ifc';
    const model_url = `/uploads/catalog/models/${modelFile.filename}`;
    const thumbnail_url = req.files?.thumbnail?.[0]
      ? `/uploads/catalog/thumbnails/${req.files.thumbnail[0].filename}`
      : null;

    const { rows } = await db.query(
      `INSERT INTO catalog_items
         (category_id, name, slug, description, color_rgb, thumbnail_url, model_url, file_type, attributes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        category_id, name, slug, description || null,
        color_rgb ? JSON.stringify(JSON.parse(color_rgb)) : JSON.stringify([0.8, 0.8, 0.8]),
        thumbnail_url, model_url, file_type,
        attributes ? JSON.stringify(JSON.parse(attributes)) : JSON.stringify({}),
        sort_order || 0,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[Admin] Create item error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/items/:id
router.put('/items/:id', upload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'model', maxCount: 1 },
]), async (req, res) => {
  try {
    const { name, slug, description, color_rgb, attributes, sort_order, category_id } = req.body;
    const updates = { name, slug, description, sort_order, category_id };

    if (color_rgb) updates.color_rgb = JSON.stringify(JSON.parse(color_rgb));
    if (attributes) updates.attributes = JSON.stringify(JSON.parse(attributes));
    if (req.files?.thumbnail?.[0]) {
      updates.thumbnail_url = `/uploads/catalog/thumbnails/${req.files.thumbnail[0].filename}`;
    }
    if (req.files?.model?.[0]) {
      const modelFile = req.files.model[0];
      const ext = path.extname(modelFile.originalname).toLowerCase().replace('.', '');
      updates.file_type = ext === 'glb' ? 'glb' : 'ifc';
      updates.model_url = `/uploads/catalog/models/${modelFile.filename}`;
    }

    const fields = Object.keys(updates).filter(k => updates[k] !== undefined);
    const values = fields.map(k => updates[k]);
    const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');

    const { rows } = await db.query(
      `UPDATE catalog_items SET ${setClause} WHERE id = $${fields.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/items/:id
router.delete('/items/:id', async (req, res) => {
  await db.query('DELETE FROM catalog_items WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
