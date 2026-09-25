const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const router = express.Router();
const db = require('./db');

// Explicit opt-in: production stays DB-only unless this local/demo flag is enabled.
const LOCAL_CATALOG_FALLBACK_ENABLED = String(process.env.ENABLE_LOCAL_CATALOG_FALLBACK || '').toLowerCase() === 'true';

// Local/demo catalog source:
//   backend/assets/<CATEGORY>/<SUBCATEGORY>/<MODEL>.glb
// The same folder structure can be copied from the HCI Google Drive folder.
const ASSETS_DIR = path.join(__dirname, 'assets');
const CATALOG_DIR = fs.existsSync(path.join(ASSETS_DIR, 'catalog'))
  ? path.join(ASSETS_DIR, 'catalog')
  : ASSETS_DIR;
const MODEL_EXTENSIONS = new Set(['.glb', '.gltf', '.ifc', '.obj', '.fbx']);
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const IGNORE_DIRS = new Set(['node_modules', '.git', 'thumbnails', 'thumbnail', '__pycache__']);

function stableId(relativePath) {
  return `cat_${crypto.createHash('sha1').update(relativePath.toLowerCase()).digest('hex').slice(0, 14)}`;
}

function encodeAssetUrl(relativePath) {
  return `/assets/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function titleFromFile(fileName) {
  return path.basename(fileName, path.extname(fileName))
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function inferType(fileName, categoryPath) {
  const value = `${fileName} ${categoryPath}`.toLowerCase();
  if (/\bdoor\b/.test(value)) return 'door';
  if (/\b(window|wall|slab|column|beam|structure)\b/.test(value)) return 'structural';
  return 'furniture';
}

function findSidecarThumbnail(fullModelPath, relativeModelPath) {
  const modelDir = path.dirname(fullModelPath);
  const stem = path.basename(fullModelPath, path.extname(fullModelPath));
  const candidates = [
    ...IMAGE_EXTENSIONS.map(ext => path.join(modelDir, `${stem}${ext}`)),
    ...IMAGE_EXTENSIONS.map(ext => path.join(modelDir, `${stem}_thumb${ext}`)),
    ...IMAGE_EXTENSIONS.map(ext => path.join(modelDir, `${stem}_thumbnail${ext}`)),
    ...IMAGE_EXTENSIONS.map(ext => path.join(modelDir, `thumbnail${ext}`)),
    ...IMAGE_EXTENSIONS.map(ext => path.join(modelDir, 'thumbnails', `${stem}${ext}`)),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const rel = path.relative(ASSETS_DIR, candidate);
      return encodeAssetUrl(rel);
    }
  }
  return null;
}

function walkModels(dir, relativeDir = '') {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      results.push(...walkModels(fullPath, relativePath));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!MODEL_EXTENSIONS.has(ext)) continue;

    const categoryParts = relativeDir
      .split(path.sep)
      .filter(Boolean);
    const category = categoryParts[0] || 'Uncategorized';
    const subCategory = categoryParts.slice(1).join(' / ') || category;
    const categoryPath = categoryParts.join(' / ');
    const encodedUrl = encodeAssetUrl(relativePath);
    const thumbnailUrl = findSidecarThumbnail(fullPath, relativePath);
    const type = inferType(entry.name, categoryPath);

    results.push({
      id: stableId(relativePath),
      catalogId: stableId(relativePath),
      name: titleFromFile(entry.name),
      original_name: entry.name,
      type,
      category,
      sub_category: subCategory,
      subCategory,
      category_path: categoryPath,
      categoryPath,
      url: encodedUrl,
      src: encodedUrl,
      file_url: encodedUrl,
      model_url: encodedUrl,
      file_type: ext.slice(1),
      fileType: ext.slice(1),
      thumbnail_url: thumbnailUrl,
      thumbnailUrl,
      source: 'filesystem',
      relative_path: relativePath.split(path.sep).join('/'),
    });
  }

  return results;
}

function buildFilesystemCatalog() {
  return walkModels(CATALOG_DIR, CATALOG_DIR === ASSETS_DIR ? '' : 'catalog').sort((a, b) => {
    const categoryCompare = a.categoryPath.localeCompare(b.categoryPath);
    if (categoryCompare !== 0) return categoryCompare;
    return a.name.localeCompare(b.name);
  });
}

function buildTree(items) {
  const roots = [];
  const nodeMap = new Map();

  const ensureNode = (pathParts) => {
    let parent = null;
    let currentPath = '';

    for (const part of pathParts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let node = nodeMap.get(currentPath);
      if (!node) {
        node = {
          id: stableId(`dir:${currentPath}`),
          name: part,
          children: [],
          items: [],
          path: currentPath,
          source: 'filesystem',
        };
        nodeMap.set(currentPath, node);
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
      parent = node;
    }
    return parent;
  };

  for (const item of items) {
    const parts = item.categoryPath.split(' / ').filter(Boolean);
    const node = ensureNode(parts.length ? parts : ['Uncategorized']);
    node.items.push(item);
  }

  return roots;
}

function searchFilesystemCatalog(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return buildFilesystemCatalog();
  return buildFilesystemCatalog().filter(item =>
    [item.name, item.original_name, item.category, item.subCategory, item.categoryPath]
      .some(value => String(value || '').toLowerCase().includes(q))
  );
}

async function loadDbCatalogTree() {
  const { rows: categories } = await db.query(
    'SELECT * FROM categories ORDER BY sort_order, name'
  );
  const { rows: items } = await db.query(
    'SELECT * FROM catalog_items ORDER BY sort_order, name'
  );

  const map = {};
  categories.forEach(c => { map[c.id] = { ...c, children: [], items: [] }; });
  items.forEach(item => {
    if (map[item.category_id]) map[item.category_id].items.push(item);
  });

  const roots = [];
  categories.forEach(c => {
    if (c.parent_id && map[c.parent_id]) {
      map[c.parent_id].children.push(map[c.id]);
    } else if (!c.parent_id) {
      roots.push(map[c.id]);
    }
  });
  return roots;
}

// GET /api/catalog/tree
router.get('/tree', async (req, res) => {
  try {
    // Production/default path: exactly the original DB-backed behavior.
    const roots = await loadDbCatalogTree();
    res.json(roots);
  } catch (err) {
    if (!LOCAL_CATALOG_FALLBACK_ENABLED) {
      console.error('[Catalog] Tree error:', err.message);
      return res.status(500).json({ error: 'Failed to load catalog tree' });
    }

    const fallback = buildTree(buildFilesystemCatalog());
    console.warn(`[Catalog] Local filesystem fallback enabled; DB unavailable, serving ${fallback.length} catalog root node(s).`);
    return res.json(fallback);
  }
});

// GET /api/catalog/search?q=sofa
router.get('/search', async (req, res) => {
  const q = `%${(req.query.q || '').toLowerCase()}%`;
  try {
    // Production/default path: keep the original DB query unchanged.
    const { rows } = await db.query(
      `SELECT ci.*, c.name AS category_name
       FROM catalog_items ci
       JOIN categories c ON c.id = ci.category_id
       WHERE LOWER(ci.name) LIKE $1
       ORDER BY ci.name
       LIMIT 50`,
      [q]
    );
    return res.json(rows);
  } catch (err) {
    if (!LOCAL_CATALOG_FALLBACK_ENABLED) {
      console.error('[Catalog] Search error:', err.message);
      return res.status(500).json({ error: 'Search failed' });
    }

    return res.json(searchFilesystemCatalog(req.query.q));
  }
});

// GET /api/catalog/items/:id
router.get('/items/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM catalog_items WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    return res.json(rows[0]);
  } catch (err) {
    if (!LOCAL_CATALOG_FALLBACK_ENABLED) {
      console.error('[Catalog] Item error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch item' });
    }
  }

  const item = buildFilesystemCatalog().find(entry => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  return res.json(item);
});

// Useful for local/demo diagnostics. This endpoint is additive and does not
// change the production DB-backed catalog behavior when the flag is disabled.
router.get('/source', async (_req, res) => {
  let dbAvailable = false;
  try {
    await db.query('SELECT 1');
    dbAvailable = true;
  } catch (_) {}

  const filesystemItems = LOCAL_CATALOG_FALLBACK_ENABLED ? buildFilesystemCatalog() : [];
  res.json({
    source: dbAvailable ? 'database' : (LOCAL_CATALOG_FALLBACK_ENABLED ? 'filesystem' : 'database-unavailable'),
    fallback_enabled: LOCAL_CATALOG_FALLBACK_ENABLED,
    filesystem_item_count: filesystemItems.length,
    assets_root: CATALOG_DIR === ASSETS_DIR ? 'assets' : 'assets/catalog',
  });
});

router.buildFilesystemCatalog = buildFilesystemCatalog;
router.buildTree = buildTree;

module.exports = router;
