# Phase 1 — Changelog: Deploy Checklist (Porting to Another Release)

Use this document when applying Phase 1 changes to a fresh/different release of the project.
Follow the steps in order — each step has a verification check.

---

## Prerequisites

- Node.js 18+ installed
- Python 3.10+ installed (already required by existing project)
- PostgreSQL 16 installed and running (see `CATALOG_PHASE1_POSTGRES_SETUP.md`)
- Database `hci_catalog` created with user `hci_user` (see same doc)

---

## BACKEND STEPS

### Step B1 — Copy new backend files

Copy these 3 files into `ifc-render-app/`:

| Source (from this release) | Destination (new release) |
|---|---|
| `ifc-render-app/db.js` | `ifc-render-app/db.js` |
| `ifc-render-app/catalog-routes.js` | `ifc-render-app/catalog-routes.js` |
| `ifc-render-app/admin-routes.js` | `ifc-render-app/admin-routes.js` |

Copy the migrations folder:

| Source | Destination |
|---|---|
| `ifc-render-app/migrations/` (entire folder) | `ifc-render-app/migrations/` |

✅ **Verify:** All 4 files/folders exist in the new release's `ifc-render-app/`

---

### Step B2 — Install `pg` package

```cmd
cd <new-release>\ifc-render-app
npm install pg
```

✅ **Verify:** `"pg"` appears in `ifc-render-app/package.json` dependencies

---

### Step B3 — Update `.env`

Open `ifc-render-app/.env` and add:

```
DATABASE_URL=postgresql://hci_user:hci_pass_2024@localhost:5432/hci_catalog
```

Also update `.env.example`:

```
DATABASE_URL=postgresql://<db_user>:<db_password>@localhost:5432/hci_catalog
```

✅ **Verify:** `DATABASE_URL` is present in `.env`

---

### Step B4 — Patch `server.js`

Open `ifc-render-app/server.js` and make 3 additions:

**Addition 1** — At the very top, after `require('dotenv').config();`:
```js
const db = require('./db');
const catalogRoutes = require('./catalog-routes');
const adminRoutes = require('./admin-routes');
```

**Addition 2** — After the line `app.use('/assets', express.static(assetsDir));`:
```js
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
app.use('/api/catalog', catalogRoutes);
app.use('/api/admin', adminRoutes);
```

**Addition 3** — After `app.listen(PORT, () => { ... });`:
```js
db.query('SELECT 1').then(() => {
  console.log('✅ PostgreSQL connected');
}).catch(err => {
  console.error('❌ PostgreSQL connection failed:', err.message);
});
```

✅ **Verify:** No existing lines were removed. Only additions were made.

---

### Step B5 — Run the database migration

```cmd
cd <new-release>\ifc-render-app
psql -U hci_user -d hci_catalog -h localhost -f migrations/001_catalog.sql
```

Enter password `hci_pass_2024` when prompted.

✅ **Verify:** Output shows `CREATE TABLE`, `CREATE INDEX`, `INSERT` lines with no errors.

---

### Step B6 — Start the backend and verify

```cmd
cd <new-release>\ifc-render-app
node server.js
```

Check console output for:
```
🚀 HC Interior Backend running on port 3000
✅ PostgreSQL connected
```

Then test the catalog API:
```cmd
curl http://localhost:3000/api/catalog/tree
```

✅ **Verify:** Returns a JSON array with category objects. Should include `Furniture` and `Structural` root categories with nested children and items.

---

## FRONTEND STEPS

### Step F1 — Copy new frontend files

| Source | Destination |
|---|---|
| `bim-viewer-app/src/hooks/useCatalog.js` | same path in new release |
| `bim-viewer-app/src/components/CatalogTree.jsx` | same path in new release |
| `bim-viewer-app/src/pages/AdminPanel.jsx` | same path in new release (create `pages/` folder first) |
| `bim-viewer-app/src/components/admin/AdminCategoryTree.jsx` | same path (create `admin/` folder first) |
| `bim-viewer-app/src/components/admin/AdminItemsPanel.jsx` | same path |

Create folders first:
```cmd
mkdir <new-release>\bim-viewer-app\src\pages
mkdir <new-release>\bim-viewer-app\src\components\admin
```

✅ **Verify:** All 5 new files exist in correct locations

---

### Step F2 — Install `react-router-dom`

```cmd
cd <new-release>\bim-viewer-app
npm install react-router-dom
```

✅ **Verify:** `"react-router-dom"` appears in `bim-viewer-app/package.json` dependencies

---

### Step F3 — Patch `App.jsx`

Replace the entire contents of `bim-viewer-app/src/App.jsx` with the version from
`CATALOG_PHASE1_FRONTEND_HOOKS.md` (Section 3 — "Full updated App.jsx").

Key things to double-check after replacing:
- All original state variables are present (`isUploadOpen`, `isContactOpen`, `modelFile`, `isDeleteModalOpen`)
- `confirmDelete` logic is identical to original
- The delete modal JSX is identical to original
- New additions: `BrowserRouter`, `Routes`, `Route`, `AdminPanel` imports + routing wrapper

✅ **Verify:** App compiles without errors. Opening `http://localhost:5173` shows the viewer as before.

---

### Step F4 — Patch `LeftPanel.jsx`

Make these 3 targeted changes (do NOT replace the whole file):

**Change 1** — Add import at top:
```jsx
import { CatalogTree } from './CatalogTree';
```

**Change 2** — Add 3 new props to the function signature:
```jsx
// Add these alongside existing props:
catalogTree, catalogLoading, catalogError,
```

**Change 3** — Replace the catalog tab div:

Find this block (the entire div with `leftTab === 'assets'`):
```jsx
<div className={`flex-1 overflow-y-auto p-4 ${leftTab === 'assets' ? 'block' : 'hidden'}`}>
  {/* ...entire flat grid content... */}
</div>
```

Replace with:
```jsx
<div className={`flex-1 overflow-hidden flex flex-col ${leftTab === 'assets' ? 'flex' : 'hidden'}`}>
  <CatalogTree
    tree={catalogTree || []}
    loading={catalogLoading}
    error={catalogError}
    placementMode={placementMode}
    setPlacementMode={setPlacementMode}
    resetSelection={resetSelection}
  />
</div>
```

✅ **Verify:** Explorer tab and Layouts tab still render correctly. Catalog tab shows the tree.

---

### Step F5 — Patch `BIMViewer.jsx`

Make these 3 targeted additions (do NOT replace the whole file):

**Addition 1** — Add import near top with other hook imports:
```jsx
import { useCatalog } from './hooks/useCatalog';
```

**Addition 2** — Add inside the component body, near other hook calls:
```jsx
const { tree: catalogTree, loading: catalogLoading, error: catalogError } = useCatalog();
```

**Addition 3** — Find the `<LeftPanel` JSX and add 3 props:
```jsx
catalogTree={catalogTree}
catalogLoading={catalogLoading}
catalogError={catalogError}
```

✅ **Verify:** No existing props on LeftPanel were removed. Only 3 new ones added.

---

### Step F6 — Confirm `VITE_API_URL`

Check if `bim-viewer-app/.env` exists. If not, create it:

```
VITE_API_URL=http://localhost:3000
```

✅ **Verify:** File exists with correct URL

---

### Step F7 — Start frontend and verify

```cmd
cd <new-release>\bim-viewer-app
npm run dev
```

Run through this checklist:

| Check | Expected |
|---|---|
| `http://localhost:5173` loads | Viewer opens normally |
| Upload an IFC file | Works as before |
| Left panel → Catalog tab | Shows hierarchical tree with Furniture / Structural categories |
| Expand Furniture → Sofa | Shows sofa items with thumbnails (or fallback icon) |
| Drag an item to viewer | Drag starts, payload has `source: 'catalog'` |
| Search "sofa" in catalog | Filters items across all categories |
| `http://localhost:5173/admin` | Admin panel loads |
| Admin → select Furniture category | Items grid shows seeded items |
| Admin → Add Item → upload .ifc | Item appears in grid |
| Admin → Add Item → upload .glb | Item appears with GLB badge |
| Admin → Edit category | Form pre-fills, saves correctly |
| Admin → Delete item | Item removed from grid |

---

## Rollback Plan

If anything goes wrong and you need to revert:

**Backend rollback:**
1. Remove the 3 `require` lines added to `server.js`
2. Remove the `uploads` static + route mount block from `server.js`
3. Remove the DB check from `server.js`
4. The database and migration are harmless to leave — they don't affect existing routes

**Frontend rollback:**
1. Revert `App.jsx` to original (remove BrowserRouter wrapper, remove AdminPanel import)
2. Revert `LeftPanel.jsx` — remove CatalogTree import, remove 3 new props, restore original catalog tab div
3. Revert `BIMViewer.jsx` — remove useCatalog import, remove hook call, remove 3 props from LeftPanel
4. The new files (CatalogTree, AdminPanel, etc.) can be left in place — they won't be imported

The existing `/api/assets` endpoint and flat catalog behavior are completely preserved
throughout — rollback restores the original UI with zero data loss.

---

## Summary of All Changes

| # | File | Type | Risk |
|---|---|---|---|
| 1 | `ifc-render-app/migrations/001_catalog.sql` | NEW | None |
| 2 | `ifc-render-app/db.js` | NEW | None |
| 3 | `ifc-render-app/catalog-routes.js` | NEW | None |
| 4 | `ifc-render-app/admin-routes.js` | NEW | None |
| 5 | `ifc-render-app/server.js` | MODIFIED (additions only) | Low |
| 6 | `ifc-render-app/package.json` | MODIFIED (add `pg`) | Low |
| 7 | `ifc-render-app/.env` | MODIFIED (add `DATABASE_URL`) | Low |
| 8 | `bim-viewer-app/src/hooks/useCatalog.js` | NEW | None |
| 9 | `bim-viewer-app/src/components/CatalogTree.jsx` | NEW | None |
| 10 | `bim-viewer-app/src/pages/AdminPanel.jsx` | NEW | None |
| 11 | `bim-viewer-app/src/components/admin/AdminCategoryTree.jsx` | NEW | None |
| 12 | `bim-viewer-app/src/components/admin/AdminItemsPanel.jsx` | NEW | None |
| 13 | `bim-viewer-app/src/App.jsx` | MODIFIED (routing wrapper) | Low |
| 14 | `bim-viewer-app/src/components/LeftPanel.jsx` | MODIFIED (catalog tab only) | Low |
| 15 | `bim-viewer-app/src/BIMViewer.jsx` | MODIFIED (additions only) | Low |
| 16 | `bim-viewer-app/package.json` | MODIFIED (add `react-router-dom`) | Low |
