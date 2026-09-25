const express = require('express');
const router = express.Router();
const db = require('./db');

// GET /api/catalog/tree
router.get('/tree', async (req, res) => {
  try {
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

    res.json(roots);
  } catch (err) {
    console.error('[Catalog] Tree error:', err.message);
    res.status(500).json({ error: 'Failed to load catalog tree' });
  }
});

// GET /api/catalog/search?q=sofa
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
