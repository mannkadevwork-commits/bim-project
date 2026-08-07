# Phase 1 — Backend: DB Schema, Migration & API Routes

Prerequisite: PostgreSQL is installed and running per `CATALOG_PHASE1_POSTGRES_SETUP.md`.

---

## Overview of What Gets Built

| What | Where | Purpose |
|---|---|---|
| `migrations/001_catalog.sql` | ifc-render-app | Creates tables + seeds sample data |
| `db.js` | ifc-render-app | PostgreSQL connection pool |
| `catalog-routes.js` | ifc-render-app | Public read-only API (frontend uses this) |
| `admin-routes.js` | ifc-render-app | CRUD + file upload API (CMS uses this) |
| `server.js` | ifc-render-app | Mount new routes + uploads static folder |
| `uploads/` folder | ifc-render-app | Stores thumbnails + IFC/GLB model files |

---

## 1. Database Schema

### Design Decisions
- `categories` is a self-referencing tree (parent_id → itself) — supports unlimited nesting depth
- `catalog_items` belong to a leaf category
- `file_type` column on items: `'ifc'` or `'glb'` — both are supported
- `color_rgb` stored as `[r,g,b]` float array (0–1 range, xeokit native format)
- `sort_order` on both tables for manual ordering in the UI
- Existing flat `/assets` files are seeded as items in the DB so they show in both old and new UI

### Create file: `ifc-render-app/migrations/001_catalog.sql`

```sql
-- ============================================================
-- 001_catalog.sql  —  Furniture Catalog Schema
-- ============================================================

-- Categories table (self-referencing tree)
CREATE TABLE IF NOT EXISTS categories (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    slug        VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    parent_id   INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    image_url   TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_categories_slug   ON categories(slug);

-- Catalog items table
CREATE TABLE IF NOT EXISTS catalog_items (
    id           SERIAL PRIMARY KEY,
    category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name         VARCHAR(150) NOT NULL,
    slug         VARCHAR(150) NOT NULL UNIQUE,
    description  TEXT,
    color_rgb    JSONB NOT NULL DEFAULT '[0.8, 0.8, 0.8]',
    thumbnail_url TEXT,
    model_url    TEXT NOT NULL,
    file_type    VARCHAR(10) NOT NULL DEFAULT 'ifc' CHECK (file_type IN ('ifc', 'glb')),
    attributes   JSONB NOT NULL DEFAULT '{}',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_items_category ON catalog_items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_slug     ON catalog_items(slug);

-- ============================================================
-- Seed Data — mirrors the existing flat /assets catalog
-- so old and new UI both work from day one
-- ============================================================

-- Root category
INSERT INTO categories (name, slug, description, parent_id, sort_order) VALUES
    ('Furniture', 'furniture', 'All furniture items', NULL, 1)
ON CONFLICT (slug) DO NOTHING;

-- Sub-categories under Furniture
INSERT INTO categories (name, slug, description, parent_id, sort_order)
SELECT name, slug, description, (SELECT id FROM categories WHERE slug = 'furniture'), sort_order
FROM (VALUES
    ('Sofa',     'sofa',     'Sofa and couch variants',    1),
    ('Seating',  'seating',  'Chairs and stools',          2),
    ('Storage',  'storage',  'Cabinets, wardrobes, shelves', 3),
    ('Bedroom',  'bedroom',  'Beds and bedroom furniture', 4),
    ('Bathroom', 'bathroom', 'Bathroom fixtures',          5),
    ('Tables',   'tables',   'Dining, center, side tables',6)
) AS t(name, slug, description, sort_order)
ON CONFLICT (slug) DO NOTHING;

-- Structural root category
INSERT INTO categories (name, slug, description, parent_id, sort_order) VALUES
    ('Structural', 'structural', 'Doors, walls and structural elements', NULL, 2)
ON CONFLICT (slug) DO NOTHING;

-- Sub-category under Structural
INSERT INTO categories (name, slug, description, parent_id, sort_order)
SELECT 'Doors', 'doors', 'All door types',
       (SELECT id FROM categories WHERE slug = 'structural'), 1
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Seed Items — existing /assets files mapped into DB
-- ============================================================

-- Sofas
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Modern Sofa', 'sofa-modern', 'Contemporary 3-seater sofa',
       '[0.54, 0.27, 0.07]', '/assets/sofa.ifc', 'ifc',
       '{"seats": 3, "style": "modern"}'
FROM categories WHERE slug = 'sofa'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Sofa Modern V2', 'sofa-modern-v2', 'Modern sofa variant',
       '[0.4, 0.4, 0.6]', '/assets/sofa_modern.ifc', 'ifc',
       '{"seats": 3, "style": "modern"}'
FROM categories WHERE slug = 'sofa'
ON CONFLICT (slug) DO NOTHING;

-- Seating
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Chair', 'chair-standard', 'Standard dining chair',
       '[0.6, 0.4, 0.2]', '/assets/chair.ifc', 'ifc',
       '{"style": "dining"}'
FROM categories WHERE slug = 'seating'
ON CONFLICT (slug) DO NOTHING;

-- Storage
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Cabinet', 'cabinet-standard', 'Standard storage cabinet',
       '[0.7, 0.65, 0.55]', '/assets/cabinet.ifc', 'ifc',
       '{"doors": 2}'
FROM categories WHERE slug = 'storage'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Cabinet 4-Door', 'cabinet-4door', 'Large 4-door cabinet',
       '[0.7, 0.65, 0.55]', '/assets/cabinet_4.ifc', 'ifc',
       '{"doors": 4}'
FROM categories WHERE slug = 'storage'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Open Bookshelf', 'open-bookshelf', 'Open display bookshelf',
       '[0.8, 0.7, 0.5]', '/assets/open_bookshelf.ifc', 'ifc',
       '{"shelves": 5}'
FROM categories WHERE slug = 'storage'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Armoire', 'armoire', 'Large wardrobe armoire',
       '[0.75, 0.7, 0.6]', '/assets/Armoire.ifc', 'ifc',
       '{"doors": 2}'
FROM categories WHERE slug = 'storage'
ON CONFLICT (slug) DO NOTHING;

-- Bedroom
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Bed (IFC)', 'bed-ifc', 'Standard double bed',
       '[0.9, 0.85, 0.75]', '/assets/bed.ifc', 'ifc',
       '{"size": "double"}'
FROM categories WHERE slug = 'bedroom'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Bed (GLB)', 'bed-glb', 'High-detail bed GLB model',
       '[0.9, 0.85, 0.75]', '/assets/Bed.glb', 'glb',
       '{"size": "double"}'
FROM categories WHERE slug = 'bedroom'
ON CONFLICT (slug) DO NOTHING;

-- Bathroom
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Sink & Mirror', 'sink-mirror', 'Bathroom sink with mirror',
       '[0.95, 0.95, 0.95]', '/assets/sink_mirror.ifc', 'ifc',
       '{"type": "wall-mounted"}'
FROM categories WHERE slug = 'bathroom'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Commode', 'commode', 'Bathroom commode / toilet',
       '[0.95, 0.95, 0.95]', '/assets/commode.ifc', 'ifc',
       '{"type": "floor-mounted"}'
FROM categories WHERE slug = 'bathroom'
ON CONFLICT (slug) DO NOTHING;

-- Doors
INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, '3BHK Interior Door', 'door-3bhk-interior', 'Standard interior door for 3BHK',
       '[0.8, 0.7, 0.5]', '/assets/3BHK_Interior_Door.ifc', 'ifc',
       '{"swing": "single"}'
FROM categories WHERE slug = 'doors'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Single Flush Door', 'door-single-flush', 'Single flush door',
       '[0.8, 0.7, 0.5]', '/assets/Single_Flush_Door.ifc', 'ifc',
       '{"swing": "single"}'
FROM categories WHERE slug = 'doors'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Double Leaf Swing Door', 'door-double-leaf', 'Double leaf swing door',
       '[0.8, 0.7, 0.5]', '/assets/Double_Leaf_Swing_Door.ifc', 'ifc',
       '{"swing": "double"}'
FROM categories WHERE slug = 'doors'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Auto Sliding Door', 'door-auto-sliding', 'Automatic sliding door',
       '[0.7, 0.8, 0.9]', '/assets/Automatic_Sliding_Door.ifc', 'ifc',
       '{"mechanism": "automatic"}'
FROM categories WHERE slug = 'doors'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Revolving Door', 'door-revolving', 'Commercial revolving door',
       '[0.7, 0.8, 0.9]', '/assets/Revolving_Commercial_Door.ifc', 'ifc',
       '{"mechanism": "revolving"}'
FROM categories WHERE slug = 'doors'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog_items (category_id, name, slug, description, color_rgb, model_url, file_type, attributes)
SELECT id, 'Fire-Rated Door', 'door-fire-rated', 'Fire-rated safety door',
       '[0.8, 0.3, 0.2]', '/assets/Fire_Rated_Door.ifc', 'ifc',
       '{"fire_rating": "60min"}'
FROM categories WHERE slug = 'doors'
ON CONFLICT (slug) DO NOTHING;
```

---

## 2. New File: `ifc-render-app/db.js`

```js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

module.exports = pool;
```

---

## 3. New File: `ifc-render-app/catalog-routes.js`

This is the **public read-only API** consumed by the frontend left panel.

```js
const express = require('express');
const router = express.Router();
const db = require('./db');

// GET /api/catalog/tree
// Returns the full category tree with items nested inside leaf categories.
// Frontend uses this to render the hierarchical left panel.
router.get('/tree', async (req, res) => {
  try {
    const { rows: categories } = await db.query(
      'SELECT * FROM categories ORDER BY sort_order, name'
    );
    const { rows: items } = await db.query(
      'SELECT * FROM catalog_items ORDER BY sort_order, name'
    );

    // Build id → node map
    const map = {};
    categories.forEach(c => { map[c.id] = { ...c, children: [], items: [] }; });

    // Attach items to their category
    items.forEach(item => {
      if (map[item.category_id]) map[item.category_id].items.push(item);
    });

    // Build tree (children under parent)
    const roots = [];
    categories.forEach(c => {
      if (c.parent_id && map[c.parent_id]) {
        map[c.parent_id].children.push(map[c.id]);
      } else if (!c.parent_id) {
        roots.push(map[c.id]);
      }
    });

    res.json(roots);
  } catch (err) {
    console.error('[Catalog] Tree error:', err.message);
    res.status(500).json({ error: 'Failed to load catalog tree' });
  }
});

// GET /api/catalog/search?q=sofa
// Flat search across all items by name.
router.get('/search', async (req, res) => {
  const q = `%${(req.query.q || '').toLowerCase()}%`;
  try {
    const { rows } = await db.query(
      `SELECT ci.*, c.name AS category_name
       FROM catalog_items ci
       JOIN categories c ON c.id = ci.category_id
       WHERE LOWER(ci.name) LIKE $1
       ORDER BY ci.name
       LIMIT 50`,
      [q]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/catalog/items/:id
// Single item detail — used when frontend needs full attributes before drag.
router.get('/items/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM catalog_items WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch item' });
  }
});

module.exports = router;
```

---

## 4. New File: `ifc-render-app/admin-routes.js`

This is the **CMS API** — add/edit/delete categories and items, upload files.

```js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');

// ── File upload storage ──────────────────────────────────────
const uploadsBase = path.join(__dirname, 'uploads', 'catalog');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Separate folders for thumbnails vs model files
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

// 400 MB limit covers large IFC/GLB files as requested
const upload = multer({
  storage,
  limits: { fileSize: 400 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.ifc', '.glb', '.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// ── Helper: build public URL from absolute path ──────────────
function toPublicUrl(req, absPath) {
  if (!absPath) return null;
  const rel = path.relative(__dirname, absPath).replace(/\\/g, '/');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers.host}/${rel}`;
}

// ── CATEGORY ROUTES ──────────────────────────────────────────

// GET /api/admin/categories  — flat list for dropdowns
router.get('/categories', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM categories ORDER BY sort_order, name');
  res.json(rows);
});

// POST /api/admin/categories
router.post('/categories', upload.single('thumbnail'), async (req, res) => {
  try {
    const { name, slug, description, parent_id, sort_order } = req.body;
    const image_url = req.file
      ? `/uploads/catalog/thumbnails/${req.file.filename}`
      : null;

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

    if (req.file) {
      updates.image_url = `/uploads/catalog/thumbnails/${req.file.filename}`;
    }

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
// Cascades to sub-categories and items via FK ON DELETE CASCADE
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

// POST /api/admin/items  — accepts thumbnail + model file
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
        color_rgb ? JSON.parse(color_rgb) : [0.8, 0.8, 0.8],
        thumbnail_url, model_url, file_type,
        attributes ? JSON.parse(attributes) : {},
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

    if (color_rgb) updates.color_rgb = JSON.parse(color_rgb);
    if (attributes) updates.attributes = JSON.parse(attributes);

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
```

---

## 5. Changes to `ifc-render-app/server.js`

Add these lines in the exact positions shown. Do NOT remove any existing code.

### 5a — After `require('dotenv').config();` at the top, add:

```js
const db = require('./db');
const catalogRoutes = require('./catalog-routes');
const adminRoutes = require('./admin-routes');
```

### 5b — After the existing `app.use('/assets', express.static(assetsDir));` line, add:

```js
// Serve uploaded catalog files (thumbnails + model files)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Mount catalog and admin API routes
app.use('/api/catalog', catalogRoutes);
app.use('/api/admin', adminRoutes);
```

### 5c — After the server starts (near the bottom), add a DB connectivity check:

```js
// Verify DB connection on startup
db.query('SELECT 1').then(() => {
  console.log('✅ PostgreSQL connected');
}).catch(err => {
  console.error('❌ PostgreSQL connection failed:', err.message);
  console.error('   Check DATABASE_URL in .env and that PostgreSQL is running');
});
```

---

## 6. Create the Uploads Directory Structure

Run once manually or let the server create it on first start:

```
ifc-render-app/
└── uploads/
    └── catalog/
        ├── thumbnails/    ← category + item thumbnail images
        └── models/        ← uploaded .ifc and .glb model files
```

The `admin-routes.js` creates these directories automatically via `fs.mkdirSync(..., { recursive: true })` on first upload.

---

## 7. API Endpoint Reference

### Public (Frontend)

| Method | URL | Description |
|---|---|---|
| GET | `/api/catalog/tree` | Full category tree with nested items |
| GET | `/api/catalog/search?q=sofa` | Search items by name |
| GET | `/api/catalog/items/:id` | Single item detail |

### Admin (CMS)

| Method | URL | Body / Files | Description |
|---|---|---|---|
| GET | `/api/admin/categories` | — | All categories flat list |
| POST | `/api/admin/categories` | form-data: name, slug, description, parent_id, thumbnail | Create category |
| PUT | `/api/admin/categories/:id` | form-data: any fields + optional thumbnail | Update category |
| DELETE | `/api/admin/categories/:id` | — | Delete category (cascades) |
| GET | `/api/admin/items?category_id=5` | — | Items, optionally filtered |
| POST | `/api/admin/items` | form-data: all fields + thumbnail + model (.ifc or .glb) | Create item |
| PUT | `/api/admin/items/:id` | form-data: any fields + optional files | Update item |
| DELETE | `/api/admin/items/:id` | — | Delete item |

---

## 8. Testing the API (curl examples)

```cmd
# Get full catalog tree
curl http://localhost:3000/api/catalog/tree

# Search
curl "http://localhost:3000/api/catalog/search?q=sofa"

# Create a category
curl -X POST http://localhost:3000/api/admin/categories ^
  -F "name=Dining Table" ^
  -F "slug=dining-table" ^
  -F "parent_id=1"

# Upload an item with IFC model
curl -X POST http://localhost:3000/api/admin/items ^
  -F "category_id=2" ^
  -F "name=Traditional Sofa" ^
  -F "slug=sofa-traditional" ^
  -F "color_rgb=[0.6,0.3,0.1]" ^
  -F "model=@C:\path\to\sofa.ifc" ^
  -F "thumbnail=@C:\path\to\sofa_thumb.jpg"

# Upload an item with GLB model
curl -X POST http://localhost:3000/api/admin/items ^
  -F "category_id=4" ^
  -F "name=Luxury Bed" ^
  -F "slug=bed-luxury" ^
  -F "color_rgb=[0.9,0.85,0.75]" ^
  -F "file_type=glb" ^
  -F "model=@C:\path\to\bed.glb" ^
  -F "thumbnail=@C:\path\to\bed_thumb.jpg"
```

---

## Next Step

Once backend is running and `/api/catalog/tree` returns data, proceed to:
**`CATALOG_PHASE1_FRONTEND.md`** — LeftPanel hierarchical tree + Admin Panel UI.
