const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const sharp = require('sharp');
const db = require('./db');

const uploadsBase = path.join(__dirname, 'uploads', 'catalog');
const materialAssetsDir = path.join(__dirname, 'assets', 'materials');

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
    const { name, slug, description, parent_id, sort_order, is_active } = req.body;
    const image_url = req.file ? `/uploads/catalog/thumbnails/${req.file.filename}` : null;
    const active = is_active !== undefined ? is_active === 'true' || is_active === true : true;
    const { rows } = await db.query(
      `INSERT INTO categories (name, slug, description, parent_id, image_url, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, slug, description || null, parent_id || null, image_url, sort_order || 0, active]
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
    const { name, slug, description, parent_id, sort_order, is_active } = req.body;
    const updates = { name, slug, description, parent_id, sort_order };
    if (is_active !== undefined) updates.is_active = is_active === 'true' || is_active === true;
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

// PATCH /api/admin/categories/:id/toggle
router.patch('/categories/:id/toggle', async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE categories SET is_active = NOT is_active WHERE id = $1 RETURNING *`,
      [req.params.id]
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
    const { category_id, name, slug, description, color_rgb, attributes, sort_order, is_active } = req.body;

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
    const active = is_active !== undefined ? is_active === 'true' || is_active === true : true;

    const { rows } = await db.query(
      `INSERT INTO catalog_items
         (category_id, name, slug, description, color_rgb, thumbnail_url, model_url, file_type, attributes, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        category_id, name, slug, description || null,
        color_rgb ? JSON.stringify(JSON.parse(color_rgb)) : JSON.stringify([0.8, 0.8, 0.8]),
        thumbnail_url, model_url, file_type,
        attributes ? JSON.stringify(JSON.parse(attributes)) : JSON.stringify({}),
        sort_order || 0, active,
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
    const { name, slug, description, color_rgb, attributes, sort_order, category_id, is_active } = req.body;
    const updates = { name, slug, description, sort_order, category_id };
    if (is_active !== undefined) updates.is_active = is_active === 'true' || is_active === true;

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

// PATCH /api/admin/items/:id/toggle
router.patch('/items/:id/toggle', async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE catalog_items SET is_active = NOT is_active WHERE id = $1 RETURNING *`,
      [req.params.id]
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


// ── SURFACE MATERIAL ROUTES ───────────────────────────────────
// Materials use a dedicated table and image directory instead of catalog_items:
// a fabric/tile is a reusable surface material, not a placeable GLB/IFC asset.
// Run migrations/20261015_create_material_assets.sql before using these routes.

const materialImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    if (!allowed.includes(ext)) {
      return cb(new Error('Material image must be PNG, JPG, JPEG or WebP.'));
    }
    cb(null, true);
  },
});

function parseMaterialUpload(req, res, next) {
  materialImageUpload.single('image')(req, res, (error) => {
    if (!error) return next();
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: error.message || 'Material image upload failed.' });
  });
}

function slugifyMaterial(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  throw new Error('is_active must be true or false.');
}

function parseMaterialInput(body = {}, { partial = false } = {}) {
  const name = String(body.name ?? '').trim();
  if (!partial || body.name !== undefined) {
    if (!name) throw new Error('Material name is required.');
    if (name.length > 120) throw new Error('Material name must be 120 characters or fewer.');
  }

  const kind = body.kind === undefined && partial ? undefined : String(body.kind || 'texture').toLowerCase();
  if (kind !== undefined && !['color', 'fabric', 'texture'].includes(kind)) {
    throw new Error('Material kind must be color, fabric or texture.');
  }

  const slugValue = body.slug === undefined && partial ? undefined : slugifyMaterial(body.slug || name);
  if (slugValue !== undefined && !slugValue) throw new Error('A valid material slug is required.');

  const colorHex = body.color_hex === undefined && partial ? undefined : String(body.color_hex || '#FFFFFF').toUpperCase();
  if (colorHex !== undefined && !/^#[0-9A-F]{6}$/.test(colorHex)) {
    throw new Error('Color must be a six-digit HEX value, such as #D8C6A8.');
  }

  const readNumber = (field, fallback, min, max) => {
    if (body[field] === undefined && partial) return undefined;
    const raw = body[field];
    const number = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`${field} must be between ${min} and ${max}.`);
    }
    return number;
  };

  const readOptionalText = (field, maxLength) => {
    if (body[field] === undefined && partial) return undefined;
    const value = String(body[field] ?? '').trim().slice(0, maxLength);
    return value || null;
  };

  const kindForDefaults = kind || 'texture';
  const active = body.is_active === undefined && partial ? undefined : parseBoolean(body.is_active, true);
  const repeatX = readNumber('repeat_x', kindForDefaults === 'fabric' ? 5 : 2, 0.05, 100);
  const repeatY = readNumber('repeat_y', kindForDefaults === 'fabric' ? 5 : 2, 0.05, 100);
  const roughness = readNumber('roughness', kindForDefaults === 'fabric' ? 0.92 : 0.8, 0, 1);
  const metallic = readNumber('metallic', 0, 0, 1);

  const hexSource = body.hex_source === undefined && partial
    ? undefined
    : String(body.hex_source || 'manual').trim().toLowerCase();
  if (hexSource !== undefined && !['manual', 'sampled_from_pdf', 'manufacturer_provided'].includes(hexSource)) {
    throw new Error('HEX source must be manual, sampled_from_pdf or manufacturer_provided.');
  }

  let sourcePage;
  if (body.source_page === undefined && partial) {
    sourcePage = undefined;
  } else if (body.source_page === undefined || String(body.source_page).trim() === '') {
    sourcePage = null;
  } else {
    sourcePage = Number(body.source_page);
    if (!Number.isInteger(sourcePage) || sourcePage < 1 || sourcePage > 10000) {
      throw new Error('Source page must be a positive page number.');
    }
  }

  const result = {
    ...(name !== '' || body.name !== undefined ? { name } : {}),
    ...(slugValue !== undefined ? { slug: slugValue } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(body.category !== undefined || !partial ? {
      category: String(body.category || (kindForDefaults === 'color' ? 'Paint' : kindForDefaults === 'fabric' ? 'Upholstery' : 'Tile & Surface'))
        .trim().slice(0, 80) || (kindForDefaults === 'color' ? 'Paint' : kindForDefaults === 'fabric' ? 'Upholstery' : 'Tile & Surface')
    } : {}),
    ...(body.description !== undefined || !partial ? { description: String(body.description || '').trim().slice(0, 2000) || null } : {}),
    ...(colorHex !== undefined ? { color_hex: colorHex } : {}),
    ...(repeatX !== undefined ? { repeat_x: repeatX } : {}),
    ...(repeatY !== undefined ? { repeat_y: repeatY } : {}),
    ...(roughness !== undefined ? { roughness } : {}),
    ...(metallic !== undefined ? { metallic } : {}),
    ...(active !== undefined ? { is_active: active } : {}),
    ...(readOptionalText('brand', 120) !== undefined ? { brand: readOptionalText('brand', 120) } : {}),
    ...(readOptionalText('collection', 120) !== undefined ? { collection: readOptionalText('collection', 120) } : {}),
    ...(readOptionalText('shade_code', 80) !== undefined ? { shade_code: readOptionalText('shade_code', 80) } : {}),
    ...(readOptionalText('source_document', 255) !== undefined ? { source_document: readOptionalText('source_document', 255) } : {}),
    ...(sourcePage !== undefined ? { source_page: sourcePage } : {}),
    ...(hexSource !== undefined ? { hex_source: hexSource } : {}),
  };

  if (!partial && !result.name) throw new Error('Material name is required.');
  if (!partial && !result.slug) throw new Error('A valid material slug is required.');
  if (!partial && !result.kind) throw new Error('Material kind is required.');
  return result;
}

async function storeMaterialImage(file) {
  if (!file?.buffer?.length) throw new Error('A material image is required.');

  // Decode the image, rather than trusting the browser-supplied MIME type or extension.
  const input = sharp(file.buffer, { failOn: 'error', limitInputPixels: 40000000 });
  const metadata = await input.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw new Error('Material image content must be PNG, JPEG or WebP.');
  }
  if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || metadata.width * metadata.height > 40000000) {
    throw new Error('Material images must be at most 8192×8192 pixels and 40 megapixels.');
  }

  await fs.promises.mkdir(materialAssetsDir, { recursive: true });
  const fileName = `material_${crypto.randomBytes(16).toString('hex')}.webp`;
  const absolutePath = path.join(materialAssetsDir, fileName);
  const output = await sharp(file.buffer, { failOn: 'error', limitInputPixels: 40000000 })
    .rotate()
    .webp({ quality: 94, effort: 5 })
    .toBuffer();
  await fs.promises.writeFile(absolutePath, output, { flag: 'wx' });

  const finalMetadata = await sharp(output).metadata();
  return {
    absolutePath,
    texture_url: `/assets/materials/${fileName}`,
    original_filename: path.basename(file.originalname || 'material-image'),
    mime_type: 'image/webp',
    image_width: finalMetadata.width || metadata.width,
    image_height: finalMetadata.height || metadata.height,
    file_size_bytes: output.length,
  };
}

function sendMaterialError(res, error, fallbackMessage) {
  const message = String(error?.message || fallbackMessage || 'Material operation failed.');
  if (error?.code === '23505') return res.status(409).json({ error: 'A material with this slug already exists.' });
  if (error instanceof Error && /required|must be|valid|image|slug|name|kind|between|megapixels|characters|hex|source|page|brand|collection/i.test(message)) {
    return res.status(400).json({ error: message });
  }
  console.error('[Admin] Surface material error:', message);
  return res.status(500).json({ error: fallbackMessage || 'Surface material operation failed.' });
}

// GET /api/admin/materials — includes inactive materials for catalog management.
router.get('/materials', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM material_assets ORDER BY kind, category, name'
    );
    res.set('Cache-Control', 'no-store');
    res.json(rows);
  } catch (error) {
    sendMaterialError(res, error, 'Failed to load surface materials. Apply the material library SQL migration first.');
  }
});

// POST /api/admin/materials — create a color swatch or reusable image-based finish.
router.post('/materials', parseMaterialUpload, async (req, res) => {
  let storedImage = null;
  try {
    const input = parseMaterialInput(req.body);
    if (input.kind !== 'color' && !req.file) {
      throw new Error('Upload a cropped PNG, JPG or WebP image for fabric/texture materials.');
    }
    if (req.file && input.kind === 'color') {
      throw new Error('Color palette entries use HEX only; choose Fabric or Texture to upload an image.');
    }

    if (req.file) storedImage = await storeMaterialImage(req.file);
    const imageFields = storedImage || {
      texture_url: null,
      original_filename: null,
      mime_type: 'application/x-color',
      image_width: null,
      image_height: null,
      file_size_bytes: null,
    };

    const { rows } = await db.query(
      `INSERT INTO material_assets
        (name, slug, description, kind, category, texture_url, color_hex, repeat_x, repeat_y, roughness, metallic,
         is_active, original_filename, mime_type, image_width, image_height, file_size_bytes,
         brand, collection, shade_code, source_document, source_page, hex_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING *`,
      [input.name, input.slug, input.description, input.kind, input.category, imageFields.texture_url,
        input.color_hex ?? '#FFFFFF', input.repeat_x, input.repeat_y, input.roughness, input.metallic,
        input.is_active ?? true, imageFields.original_filename, imageFields.mime_type,
        imageFields.image_width, imageFields.image_height, imageFields.file_size_bytes,
        input.brand ?? null, input.collection ?? null, input.shade_code ?? null,
        input.source_document ?? null, input.source_page ?? null, input.hex_source ?? 'manual']
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    if (storedImage?.absolutePath) {
      try { await fs.promises.unlink(storedImage.absolutePath); } catch (_) {}
    }
    sendMaterialError(res, error, 'Failed to create palette or surface material.');
  }
});

// PUT /api/admin/materials/:id — color entries need no image; texture image URLs remain immutable.
router.put('/materials/:id', parseMaterialUpload, async (req, res) => {
  let storedImage = null;
  try {
    const input = parseMaterialInput(req.body, { partial: true });
    const existingResult = await db.query(
      'SELECT id, kind, texture_url FROM material_assets WHERE id = $1',
      [req.params.id]
    );
    if (!existingResult.rows.length) return res.status(404).json({ error: 'Palette or surface material not found.' });
    const existing = existingResult.rows[0];
    const nextKind = input.kind ?? existing.kind;

    if (nextKind !== 'color' && !req.file && (existing.kind === 'color' || !existing.texture_url)) {
      throw new Error('Upload a cropped PNG, JPG or WebP image when changing a color swatch into a fabric/texture.');
    }
    if (req.file && nextKind === 'color') {
      throw new Error('Color palette entries use HEX only; choose Fabric or Texture to upload an image.');
    }
    if (!Object.keys(input).length && !req.file) {
      return res.status(400).json({ error: 'No material changes were provided.' });
    }

    if (req.file) storedImage = await storeMaterialImage(req.file);
    if (storedImage) {
      input.texture_url = storedImage.texture_url;
      input.original_filename = storedImage.original_filename;
      input.mime_type = storedImage.mime_type;
      input.image_width = storedImage.image_width;
      input.image_height = storedImage.image_height;
      input.file_size_bytes = storedImage.file_size_bytes;
    } else if (nextKind === 'color') {
      // A color palette entry is a data-only swatch. Preserve old files on disk
      // because previously saved project states may still reference them.
      input.texture_url = null;
      input.original_filename = null;
      input.mime_type = 'application/x-color';
      input.image_width = null;
      input.image_height = null;
      input.file_size_bytes = null;
    }

    const fields = Object.keys(input).filter((key) => input[key] !== undefined);
    if (!fields.length) return res.status(400).json({ error: 'No material changes were provided.' });
    const values = fields.map((key) => input[key]);
    const setClause = fields.map((field, index) => `${field} = $${index + 1}`).join(', ');
    const { rows } = await db.query(
      `UPDATE material_assets SET ${setClause}, updated_at = NOW() WHERE id = $${fields.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!rows.length) {
      if (storedImage?.absolutePath) { try { await fs.promises.unlink(storedImage.absolutePath); } catch (_) {} }
      return res.status(404).json({ error: 'Palette or surface material not found.' });
    }
    res.json(rows[0]);
  } catch (error) {
    if (storedImage?.absolutePath) {
      try { await fs.promises.unlink(storedImage.absolutePath); } catch (_) {}
    }
    sendMaterialError(res, error, 'Failed to update palette or surface material.');
  }
});

// PATCH /api/admin/materials/:id/toggle — hidden materials stop appearing in the editor,
// but already-saved projects can continue resolving their immutable image URL.
router.patch('/materials/:id/toggle', async (req, res) => {
  try {
    const { rows } = await db.query(
      'UPDATE material_assets SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Surface material not found.' });
    res.json(rows[0]);
  } catch (error) {
    sendMaterialError(res, error, 'Failed to update surface material status.');
  }
});

// DELETE removes the library record only. Do not unlink its image: projects already
// using that material store its URL in project_state.json and must remain renderable.
router.delete('/materials/:id', async (req, res) => {
  try {
    const { rows } = await db.query('DELETE FROM material_assets WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Surface material not found.' });
    res.json({ success: true, retainedImageForExistingProjects: true });
  } catch (error) {
    sendMaterialError(res, error, 'Failed to delete surface material.');
  }
});


// ── CATALOGUE PDF EXTRACTION (deterministic computer vision; no AI services) ──
const catalogueScanRoot = path.join(__dirname, 'uploads', 'catalogue-scans');
const cataloguePdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 35 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.pdf') return cb(new Error('Upload a PDF catalogue file.'));
    cb(null, true);
  },
});

function parseCataloguePdfUpload(req, res, next) {
  cataloguePdfUpload.single('pdf')(req, res, (error) => {
    if (!error) return next();
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: error.code === 'LIMIT_FILE_SIZE' ? 'PDF catalogues must be 35 MB or smaller.' : (error.message || 'PDF upload failed.'),
    });
  });
}

function validScanId(value) {
  return /^[a-f0-9]{32}$/.test(String(value || ''));
}

// The extractor should emit one JSON object, but some Windows/Python runtimes
// can prepend diagnostic text to stdout. Parse the whole stream first, then
// safely recover the root result object containing pages_scanned if needed.
function findJsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseCatalogueExtractorOutput(output) {
  const text = String(output || '').replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('The catalogue extractor produced empty stdout.');
  try {
    return JSON.parse(text);
  } catch (_) {
    const keyAt = text.indexOf('"pages_scanned"');
    const start = keyAt >= 0 ? text.lastIndexOf('{', keyAt) : -1;
    const end = start >= 0 ? findJsonObjectEnd(text, start) : -1;
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { /* report diagnostics below */ }
    }
    const preview = text.slice(0, 450).replace(/\s+/g, ' ');
    throw new Error(`The catalogue extractor stdout was not valid JSON. Output preview: ${preview}`);
  }
}

async function cleanupOldCatalogueScans() {
  try {
    const entries = await fs.promises.readdir(catalogueScanRoot, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isDirectory() || !validScanId(entry.name)) continue;
      const absolute = path.join(catalogueScanRoot, entry.name);
      const stat = await fs.promises.stat(absolute).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fs.promises.rm(absolute, { recursive: true, force: true }).catch(() => {});
    }
  } catch (_) { /* Scan directory may not exist yet. */ }
}

// POST /api/admin/materials/catalogue-scan — returns editable crop candidates.
router.post('/materials/catalogue-scan', parseCataloguePdfUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a PDF catalogue to scan.' });
  if (!req.file.buffer || req.file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return res.status(400).json({ error: 'The uploaded file does not look like a valid PDF.' });
  }
  await cleanupOldCatalogueScans();
  const scanId = crypto.randomBytes(16).toString('hex');
  const scanDir = path.join(catalogueScanRoot, scanId);
  const cropDir = path.join(scanDir, 'crops');
  const pdfPath = path.join(scanDir, 'catalogue.pdf');
  try {
    await fs.promises.mkdir(cropDir, { recursive: true });
    await fs.promises.writeFile(pdfPath, req.file.buffer, { flag: 'wx' });
    const python = process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'python' : 'python3');
    const scriptPath = path.join(__dirname, 'scripts', 'extract_catalogue_tiles.py');
    console.log(`[Admin] Catalogue extractor runtime: ${python}; script=${scriptPath}`);
    const { stdout, stderr } = await execFileAsync(python, [scriptPath, pdfPath, cropDir], {
      timeout: 180000,
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let result;
    try {
      result = parseCatalogueExtractorOutput(stdout);
    } catch (parseError) {
      const stderrPreview = String(stderr || '').trim().slice(0, 450).replace(/\s+/g, ' ');
      throw new Error(`${parseError.message}${stderrPreview ? `; stderr: ${stderrPreview}` : ''}`);
    }
    if (result.error) throw new Error(result.error);
    if (!Array.isArray(result.candidates) || result.candidates.length === 0) {
      throw new Error('No repeated swatch tiles were detected. Try a catalogue page with a grid of rectangular samples.');
    }
    await fs.promises.unlink(pdfPath).catch(() => {});
    res.status(200).json({
      scan_id: scanId,
      source_document: path.basename(req.file.originalname || 'catalogue.pdf').slice(0, 255),
      pages_scanned: result.pages_scanned,
      candidate_count: result.candidate_count,
      candidates: result.candidates.map((candidate) => ({
        index: candidate.index,
        source_page: candidate.source_page,
        suggested_name: candidate.suggested_name,
        color_hex: candidate.color_hex,
        width: candidate.width,
        height: candidate.height,
        preview_url: `/api/admin/materials/catalogue-scan/${scanId}/crops/${candidate.index}`,
      })),
    });
  } catch (error) {
    await fs.promises.rm(scanDir, { recursive: true, force: true }).catch(() => {});
    const message = String(error?.message || 'Catalogue extraction failed.');
    const missingPythonDependency = /No module named|ModuleNotFoundError|python.*not found|not recognized as an internal/i.test(message);
    console.error('[Admin] Catalogue PDF extraction failed:', message, error?.stderr || '');
    return res.status(missingPythonDependency ? 503 : 400).json({
      error: missingPythonDependency
        ? 'PDF extraction needs the Python packages in requirements-catalogue-extraction.txt. Install them in the backend Python environment and restart the server.'
        : (message.includes('timed out') ? 'Catalogue scanning took too long. Try a smaller PDF or split it into smaller files.' : message),
    });
  }
});

// Serve only generated crop files from a validated temporary scan ID.
router.get('/materials/catalogue-scan/:scanId/crops/:index', async (req, res) => {
  const { scanId } = req.params;
  const index = Number(req.params.index);
  if (!validScanId(scanId) || !Number.isInteger(index) || index < 0 || index > 599) {
    return res.status(400).json({ error: 'Invalid catalogue crop reference.' });
  }
  const absolute = path.join(catalogueScanRoot, scanId, 'crops', `crop_${String(index).padStart(4, '0')}.webp`);
  try {
    await fs.promises.access(absolute, fs.constants.R_OK);
    res.set('Cache-Control', 'private, max-age=3600');
    res.type('image/webp').sendFile(absolute);
  } catch (_) {
    res.status(404).json({ error: 'This catalogue scan has expired. Upload the PDF again.' });
  }
});

// POST /api/admin/materials/catalogue-import — atomically publishes reviewed crops.
router.post('/materials/catalogue-import', async (req, res) => {
  const scanId = String(req.body?.scan_id || '');
  const items = req.body?.items;
  if (!validScanId(scanId)) return res.status(400).json({ error: 'Invalid or expired catalogue scan.' });
  if (!Array.isArray(items) || items.length < 1 || items.length > 600) {
    return res.status(400).json({ error: 'Select between 1 and 600 catalogue samples to import.' });
  }
  const scanDir = path.join(catalogueScanRoot, scanId);
  const cropDir = path.join(scanDir, 'crops');
  const prepared = [];
  const storedImages = [];
  let client = null;
  let transactionStarted = false;
  try {
    for (const item of items) {
      const index = Number(item?.index);
      const sourcePage = Number(item?.source_page);
      const name = String(item?.name || '').trim();
      const kind = String(item?.kind || 'texture').toLowerCase();
      if (!Number.isInteger(index) || index < 0 || index > 599) throw new Error('A selected sample has an invalid crop index.');
      if (!Number.isInteger(sourcePage) || sourcePage < 1 || sourcePage > 10000) throw new Error('A selected sample has an invalid PDF page number.');
      if (!name || name.length > 120) throw new Error('Each selected sample needs a name of 1–120 characters.');
      if (!['color', 'fabric', 'texture'].includes(kind)) throw new Error('Each sample type must be Color, Fabric or Texture.');
      const colorHex = String(item?.color_hex || '#FFFFFF').toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(colorHex)) throw new Error(`Invalid HEX color for “${name}”.`);
      const repeatX = Number(item?.repeat_x ?? (kind === 'fabric' ? 5 : 2));
      const repeatY = Number(item?.repeat_y ?? (kind === 'fabric' ? 5 : 2));
      const roughness = Number(item?.roughness ?? (kind === 'fabric' ? 0.92 : 0.8));
      if (kind !== 'color' && (![repeatX, repeatY].every((n) => Number.isFinite(n) && n >= 0.05 && n <= 100) || !Number.isFinite(roughness) || roughness < 0 || roughness > 1)) {
        throw new Error(`Invalid texture settings for “${name}”.`);
      }
      let imageFields = {
        texture_url: null, original_filename: null, mime_type: 'application/x-color',
        image_width: null, image_height: null, file_size_bytes: null, absolutePath: null,
      };
      if (kind !== 'color') {
        const cropPath = path.join(cropDir, `crop_${String(index).padStart(4, '0')}.webp`);
        const buffer = await fs.promises.readFile(cropPath).catch(() => null);
        if (!buffer?.length) throw new Error(`The crop for “${name}” is missing or the scan expired. Upload the PDF again.`);
        imageFields = await storeMaterialImage({ buffer, originalname: `${slugifyMaterial(name) || 'catalogue-sample'}.webp` });
        storedImages.push(imageFields.absolutePath);
      }
      const slug = slugifyMaterial(`${name}-p${sourcePage}-${index + 1}-${crypto.randomBytes(3).toString('hex')}`);
      prepared.push({
        name, slug, kind, imageFields, colorHex,
        category: String(item?.category || (kind === 'color' ? 'Paint' : kind === 'fabric' ? 'Upholstery' : 'Tile & Surface')).trim().slice(0, 80),
        description: String(item?.description || `Extracted from PDF catalogue; review crop and color before production use.`).trim().slice(0, 2000) || null,
        repeatX: kind === 'color' ? 2 : repeatX,
        repeatY: kind === 'color' ? 2 : repeatY,
        roughness: kind === 'color' ? 0.8 : roughness,
        brand: String(item?.brand || req.body?.brand || '').trim().slice(0, 120) || null,
        collection: String(item?.collection || req.body?.collection || '').trim().slice(0, 120) || null,
        shadeCode: String(item?.shade_code || '').trim().slice(0, 80) || null,
        sourceDocument: String(item?.source_document || req.body?.source_document || 'catalogue.pdf').trim().slice(0, 255),
        sourcePage,
        hexSource: kind === 'color' ? 'sampled_from_pdf' : 'manual',
      });
    }

    if (typeof db.connect !== 'function') throw new Error('Database connection does not support batch transactions.');
    client = await db.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    const created = [];
    for (const item of prepared) {
      const f = item.imageFields;
      const { rows } = await client.query(
        `INSERT INTO material_assets
          (name, slug, description, kind, category, texture_url, color_hex, repeat_x, repeat_y, roughness, metallic,
           is_active, original_filename, mime_type, image_width, image_height, file_size_bytes,
           brand, collection, shade_code, source_document, source_page, hex_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING *`,
        [item.name, item.slug, item.description, item.kind, item.category, f.texture_url, item.colorHex,
          item.repeatX, item.repeatY, item.roughness, 0, true, f.original_filename, f.mime_type,
          f.image_width, f.image_height, f.file_size_bytes, item.brand, item.collection, item.shadeCode,
          item.sourceDocument, item.sourcePage, item.hexSource]
      );
      created.push(rows[0]);
    }
    await client.query('COMMIT');
    transactionStarted = false;
    await fs.promises.rm(scanDir, { recursive: true, force: true }).catch(() => {});
    return res.status(201).json({ success: true, created_count: created.length, materials: created });
  } catch (error) {
    if (client && transactionStarted) await client.query('ROLLBACK').catch(() => {});
    for (const imagePath of storedImages) await fs.promises.unlink(imagePath).catch(() => {});
    sendMaterialError(res, error, 'Failed to import catalogue samples. No library records were committed.');
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
