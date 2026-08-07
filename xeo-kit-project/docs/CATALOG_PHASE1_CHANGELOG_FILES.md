# Phase 1 — Changelog: All Files Created & Modified

This document is the **porting reference**. It lists every single file that is
new or changed, what was done, and what to copy/apply when deploying to another release.

---

## NEW FILES — Backend (`ifc-render-app/`)

### `ifc-render-app/migrations/001_catalog.sql`
- **What it is:** One-time SQL migration. Creates `categories` and `catalog_items` tables.
  Seeds all existing `/assets` files as catalog items so old and new UI both work.
- **Run once:** `psql -U hci_user -d hci_catalog -h localhost -f migrations/001_catalog.sql`
- **Safe to re-run:** Yes — all inserts use `ON CONFLICT (slug) DO NOTHING`

### `ifc-render-app/db.js`
- **What it is:** PostgreSQL connection pool using the `pg` package.
- **Depends on:** `DATABASE_URL` in `.env`
- **Copy as-is** to another release — no project-specific logic

### `ifc-render-app/catalog-routes.js`
- **What it is:** Public read-only Express router mounted at `/api/catalog`
- **Endpoints:** `GET /tree`, `GET /search`, `GET /items/:id`
- **Copy as-is** to another release

### `ifc-render-app/admin-routes.js`
- **What it is:** Admin CRUD Express router mounted at `/api/admin`
- **Endpoints:** Full CRUD for categories and items, file upload (thumbnail + model)
- **File size limit:** 400 MB (set in multer config)
- **Accepted model formats:** `.ifc` and `.glb`
- **Copy as-is** to another release

---

## MODIFIED FILES — Backend (`ifc-render-app/`)

### `ifc-render-app/server.js`
**3 additions only — nothing removed:**

| Location in file | What to add |
|---|---|
| Top of file, after `require('dotenv').config()` | `const db = require('./db');` `const catalogRoutes = require('./catalog-routes');` `const adminRoutes = require('./admin-routes');` |
| After `app.use('/assets', express.static(assetsDir))` | `const uploadsDir = path.join(__dirname, 'uploads');` `if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });` `app.use('/uploads', express.static(uploadsDir));` `app.use('/api/catalog', catalogRoutes);` `app.use('/api/admin', adminRoutes);` |
| After `app.listen(PORT, ...)` | DB connectivity check — `db.query('SELECT 1').then(...)` |

### `ifc-render-app/package.json`
**1 new dependency:**
```json
"pg": "^8.13.0"
```
Install with: `npm install pg`

### `ifc-render-app/.env`
**1 new line:**
```
DATABASE_URL=postgresql://hci_user:hci_pass_2024@localhost:5432/hci_catalog
```

### `ifc-render-app/.env.example`
**1 new line:**
```
DATABASE_URL=postgresql://<db_user>:<db_password>@localhost:5432/hci_catalog
```

---

## NEW FILES — Frontend (`bim-viewer-app/src/`)

### `bim-viewer-app/src/hooks/useCatalog.js`
- **What it is:** React hook that fetches `/api/catalog/tree` on mount
- **Returns:** `{ tree, loading, error, refresh }`
- **Copy as-is** to another release

### `bim-viewer-app/src/components/CatalogTree.jsx`
- **What it is:** Hierarchical collapsible category tree for the left panel Catalog tab
- **Sub-components inside:** `ColorDot`, `ItemThumb`, `CatalogItemCard`, `CategoryNode`
- **Drag payload shape it produces:**
  ```json
  {
    "id": "cat_42",
    "name": "Traditional Sofa",
    "url": "/uploads/catalog/models/1234_abc.ifc",
    "type": "furniture",
    "file_type": "ifc",
    "color_rgb": [0.6, 0.3, 0.1],
    "source": "catalog"
  }
  ```
- **Copy as-is** to another release

### `bim-viewer-app/src/pages/AdminPanel.jsx`
- **What it is:** Root admin page component at route `/admin`
- **Renders:** `AdminCategoryTree` (left sidebar) + `AdminItemsPanel` (main area)
- **Copy as-is** to another release

### `bim-viewer-app/src/components/admin/AdminCategoryTree.jsx`
- **What it is:** Category tree with add/edit/delete forms for the admin sidebar
- **Sub-components inside:** `CategoryForm`, `CategoryRow`
- **Copy as-is** to another release

### `bim-viewer-app/src/components/admin/AdminItemsPanel.jsx`
- **What it is:** Items grid with add/edit/delete + file upload form
- **Sub-components inside:** `ItemForm`, `ItemCard`
- **Handles both `.ifc` and `.glb` uploads**
- **Copy as-is** to another release

---

## MODIFIED FILES — Frontend (`bim-viewer-app/src/`)

### `bim-viewer-app/src/App.jsx`
**What changed:**
- Existing `App` function body moved into new `ViewerApp` function (zero logic change)
- New `App` wraps in `BrowserRouter` + `Routes`
- Added route: `<Route path="/admin" element={<AdminPanel />} />`
- Added imports: `BrowserRouter`, `Routes`, `Route`, `AdminPanel`

**What did NOT change:**
- All state variables, handlers, modals — identical to original

### `bim-viewer-app/src/components/LeftPanel.jsx`
**What changed:**
- Added import: `import { CatalogTree } from './CatalogTree';`
- Added 3 new props: `catalogTree`, `catalogLoading`, `catalogError`
- Replaced the flat asset grid div (the `leftTab === 'assets'` section) with `<CatalogTree />`
- Old `availableAssets` prop kept for backward compatibility (still passed, just unused in catalog tab)

**What did NOT change:**
- Explorer tab — identical
- Layouts/Templates tab — identical
- Header, tab bar — identical

### `bim-viewer-app/src/BIMViewer.jsx`
**What changed:**
- Added import: `import { useCatalog } from './hooks/useCatalog';`
- Added inside component body: `const { tree: catalogTree, loading: catalogLoading, error: catalogError } = useCatalog();`
- Added 3 props to `<LeftPanel />`: `catalogTree`, `catalogLoading`, `catalogError`

**What did NOT change:**
- `handleDrop` — no changes needed. Existing URL-extension-based IFC/GLB detection
  in `spawnAsset`/`useBIMEngine` already handles both file types correctly.
  The new drag payload's `file_type` field is available for future use.
- All other logic — identical

### `bim-viewer-app/package.json`
**1 new dependency:**
```json
"react-router-dom": "^6.x"
```
Install with: `npm install react-router-dom`

---

## NEW FOLDERS TO CREATE

```
ifc-render-app/
└── uploads/
    └── catalog/
        ├── thumbnails/
        └── models/

bim-viewer-app/src/
├── pages/
└── components/
    └── admin/
```

These are created automatically by the server and by the mkdir commands in the docs,
but listing here for completeness.

---

## FILES THAT ARE COMPLETELY UNCHANGED

Everything not listed above is untouched:

**Backend:** `worker.js`, `queue.js`, `aps-pipeline.js`, `asset_resolver.js`,
`asset_registry.json`, `ifc_element_editor.py`, `scene_merger.py`, all compiler files,
all renderer_v2 files, all job folders.

**Frontend:** `useBIMEngine.js`, `useCloudRender.js`, `useProjectSync.js`,
`BottomDock.jsx`, `ContactForm.jsx`, `Footer.jsx`, `MeasurementPanel.jsx`,
`Navbar.jsx`, `RenderStudioModal.jsx`, `RightPanel.jsx`, `UploadModal.jsx`,
`main.jsx`, `index.css`, `App.css`, `vite.config.js`, `tailwind.config.js`,
`postcss.config.js`, `index.html`.

---

## Next Step

Proceed to: **`CATALOG_PHASE1_CHANGELOG_DEPLOY.md`** — step-by-step deploy checklist
for applying all these changes to a fresh release.
