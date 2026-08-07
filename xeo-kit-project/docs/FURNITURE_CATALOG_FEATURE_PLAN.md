# Furniture Catalog & BIM Drag-and-Drop Feature Plan

## What I Understood

You want two interconnected features:

**Feature 1 — Hierarchical Catalog with CMS**
A tree-structured catalog on the left panel (like: Furniture → Sofa → Traditional → [image + IFC file]).
Each leaf item has two assets: a **thumbnail image** (shown in the UI) and an **IFC file** (used for drag-and-drop into the BIM viewer). A CMS admin panel lets you add/edit/delete categories, sub-categories, and items with their attributes.

**Feature 2 — Drag IFC Furniture into Open BIM Model**
When a user drags a catalog item from the left panel and drops it onto the BIM viewer canvas (which already has a building IFC open), the furniture IFC is merged/placed into the scene at the drop position, preserving the color/material defined in the catalog.

---

## Feasibility Assessment

| Area | Feasibility | Notes |
|---|---|---|
| Hierarchical categories in Postgres | ✅ High | Standard adjacency-list or nested-set pattern |
| CMS admin panel (React) | ✅ High | Simple CRUD UI, already have React + Express |
| Image upload & serving | ✅ High | Multer already used in server.js |
| IFC file upload & serving | ✅ High | Same pattern as existing `/assets` folder |
| Drag-and-drop from catalog to viewer | ✅ High | Already implemented for flat asset list in LeftPanel.jsx |
| Placing furniture IFC into open BIM IFC | ✅ Medium | ifcopenshell already used; need merge logic |
| Color preservation from catalog to viewer | ✅ Medium | Color stored in DB, passed in drag payload, applied via xeokit |
| Infinite sub-category depth | ✅ High | Self-referencing table handles any depth |

---

## Current Project State (What Already Exists)

- `LeftPanel.jsx` — has a flat "Catalog" tab with category filter pills (All / Structural / Furniture)
- `server.js` — `/api/assets` returns a hardcoded flat array; assets served from `/assets` folder
- `BIMViewer.jsx` — `handleDrop` already processes drag-and-drop, calls `spawnAsset` or `insertDoor`
- `useProjectSync.js` — manages `availableAssets`, `spawnAsset`, furniture state
- `ifc_element_editor.py` — ifcopenshell-based element editing already in place
- No database exists yet — everything is file-based

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  React Frontend (bim-viewer-app)                            │
│  ├── LeftPanel.jsx  ← hierarchical tree catalog             │
│  ├── CMS Admin Page ← new route /admin                      │
│  └── BIMViewer.jsx  ← drag-drop unchanged in principle      │
├─────────────────────────────────────────────────────────────┤
│  Node/Express Backend (server.js)                           │
│  ├── /api/catalog/*  ← new CRUD endpoints                   │
│  ├── /api/admin/*    ← CMS endpoints (upload, manage)       │
│  └── /uploads/*      ← served static (images + IFC files)  │
├─────────────────────────────────────────────────────────────┤
│  PostgreSQL Database                                        │
│  ├── categories table (self-referencing tree)               │
│  └── catalog_items table (leaf nodes with assets)          │
├─────────────────────────────────────────────────────────────┤
│  Python (ifc_element_editor.py / new merge script)         │
│  └── merge_furniture.py ← places furniture IFC into BIM    │
└─────────────────────────────────────────────────────────────┘
```

---

## Database Schema (PostgreSQL)

### Table: `categories`
```sql
CREATE TABLE categories (
  id          SERIAL PRIMARY KEY,
  parent_id   INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  image_url   VARCHAR(500),   -- thumbnail shown in left menu
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Root categories: parent_id IS NULL
-- Example tree:
--   Furniture (parent_id=NULL)
--     └── Sofa (parent_id=1)
--           ├── Traditional (parent_id=2)
--           └── Modern (parent_id=2)
```

### Table: `catalog_items`
```sql
CREATE TABLE catalog_items (
  id            SERIAL PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(255) NOT NULL UNIQUE,
  description   TEXT,
  color         VARCHAR(7),          -- hex color e.g. #8B4513
  color_rgb     JSONB,               -- [r, g, b] 0-1 range for xeokit
  thumbnail_url VARCHAR(500),        -- image shown in left panel card
  ifc_url       VARCHAR(500),        -- IFC file for drag-and-drop
  attributes    JSONB,               -- flexible: { "material": "oak", "width": "1.8m" }
  sort_order    INTEGER DEFAULT 0,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### Key Design Decisions
- `categories` is self-referencing (adjacency list) — supports unlimited depth
- `catalog_items` always belong to a leaf or any category — flexible
- `attributes` is JSONB — no schema migration needed when adding new item properties
- `color_rgb` stored separately so frontend doesn't need to convert hex on every render
- Both image and IFC file URLs are stored as paths — files live in `/uploads/catalog/`

---

## Backend Changes (server.js + new files)

### New Dependencies to Add
```json
"pg": "^8.x",           // PostgreSQL client
"pg-pool": included in pg,
"sharp": "^0.33.x"      // image resizing for thumbnails (optional but recommended)
```

### New File: `db.js`
- PostgreSQL connection pool
- Single place to manage DB config from `.env`

### New File: `catalog-routes.js`
Mounted at `/api/catalog`:

| Method | Route | Description |
|---|---|---|
| GET | `/api/catalog/tree` | Full category tree (recursive) |
| GET | `/api/catalog/categories/:id/children` | Direct children of a category |
| GET | `/api/catalog/categories/:id/items` | Items in a category |
| GET | `/api/catalog/items/:id` | Single item detail |

### New File: `admin-routes.js`
Mounted at `/api/admin` (add auth middleware later):

| Method | Route | Description |
|---|---|---|
| POST | `/api/admin/categories` | Create category |
| PUT | `/api/admin/categories/:id` | Update category |
| DELETE | `/api/admin/categories/:id` | Delete category (cascades) |
| POST | `/api/admin/categories/:id/image` | Upload category image |
| POST | `/api/admin/items` | Create catalog item |
| PUT | `/api/admin/items/:id` | Update item |
| DELETE | `/api/admin/items/:id` | Delete item |
| POST | `/api/admin/items/:id/thumbnail` | Upload thumbnail image |
| POST | `/api/admin/items/:id/ifc` | Upload IFC file |

### Changes to `server.js`
- Add `require('./catalog-routes')` and `require('./admin-routes')`
- Add `/uploads` static serving: `app.use('/uploads', express.static(uploadsDir))`
- Keep existing `/api/assets` for backward compatibility (or migrate it)
- Add `pg` pool initialization

### New Python Script: `merge_furniture.py`
This is the core of Feature 2. It:
1. Opens the base building IFC (already open in viewer)
2. Opens the furniture IFC from catalog
3. Places the furniture at the drop coordinates (x, y, z)
4. Applies the catalog color to the furniture's material
5. Writes a new merged IFC file
6. Returns the file URL to the frontend

New Express route: `POST /api/projects/:jobId/place-furniture`
```
Body: { itemId, position: [x,y,z], rotation: degrees, color: [r,g,b] }
```

---

## Frontend Changes

### 1. `LeftPanel.jsx` — Replace flat catalog with hierarchical tree

Current state: flat grid with category filter pills.

New behavior:
- Fetch `/api/catalog/tree` on mount
- Render collapsible tree: root categories → sub-categories → items
- Each category row shows its thumbnail image + name + expand arrow
- Each item card shows thumbnail image, name, color swatch
- Items are draggable (same `onDragStart` pattern, but payload now includes `color_rgb` and `ifc_url`)
- Search/filter bar at top of catalog tab

### 2. `BIMViewer.jsx` — Update `handleDrop` for catalog items

Current: calls `spawnAsset` which loads IFC directly into xeokit scene client-side.

New flow for catalog items:
1. Drop detected → get `position` from `engineActions.getDropPosition(canvasPos)`
2. POST to `/api/projects/:jobId/place-furniture` with `{ itemId, position, rotation, color_rgb }`
3. Backend runs `merge_furniture.py` → returns new IFC file URL
4. Call `engineActions.loadIFCAssetIntoScene(newModelId, fileUrl)` — same as existing door/wall pattern
5. Apply color via xeokit's `scene.objects[id].colorize = color_rgb`

### 3. New Page: `AdminPanel.jsx` (route `/admin`)

Sections:
- Category tree view (left sidebar) with add/edit/delete buttons
- Item list for selected category (main area)
- Item form: name, description, color picker, attributes (key-value pairs), image upload, IFC upload
- Category form: name, description, parent selector, image upload
- Drag-to-reorder for sort_order (optional enhancement)

### 4. `useProjectSync.js` — Minor update
- Replace hardcoded `availableAssets` fetch from `/api/assets` with `/api/catalog/tree`
- Or keep both and let LeftPanel decide which to use based on a prop

---

## File Storage Structure

```
ifc-render-app/
└── uploads/
    └── catalog/
        ├── categories/
        │   ├── furniture/
        │   │   └── thumbnail.jpg
        │   └── sofa/
        │       └── thumbnail.jpg
        └── items/
            ├── {item-slug}/
            │   ├── thumbnail.jpg   ← shown in left panel
            │   └── model.ifc       ← dragged into BIM viewer
```

---

## Feature 2 Deep Dive: IFC Merge / Placement

### How it works technically

When a user drags a sofa from the catalog and drops it on a bedroom in the BIM viewer:

1. Frontend sends: `{ itemId: 42, position: [3.5, 0, 2.1], rotation: 90, color_rgb: [0.54, 0.27, 0.07] }`
2. `merge_furniture.py` runs:
   - Opens `jobs/{jobId}/input.ifc` (the building)
   - Opens `uploads/catalog/items/sofa-traditional/model.ifc` (the furniture)
   - Reads the furniture's root `IfcProduct` and its geometry
   - Creates a new `IfcLocalPlacement` at the drop coordinates
   - Copies the furniture entity into the building IFC with the new placement
   - Applies color: creates `IfcStyledItem` → `IfcSurfaceStyle` → `IfcSurfaceStyleRendering` with the RGB values
   - Writes output to `jobs/{jobId}/element_edits/furniture_{itemId}_{timestamp}.ifc`
3. Frontend loads this new IFC as an additional model layer in xeokit (same as how doors work today)
4. The furniture appears in the room at the correct position with the catalog color

### Color Preservation
- Catalog stores `color_rgb` as `[r, g, b]` (0–1 range, xeokit native format)
- Python applies it as IFC material during merge
- xeokit renders it correctly since it reads IFC materials natively
- User can still override color via the existing RightPanel color picker after placement

### Coordinate System
- xeokit world coordinates match IFC coordinates (meters)
- Drop position from `getDropPosition()` is already in world space
- No coordinate conversion needed — pass directly to Python

---

## Additional Features I'd Recommend Adding

### 1. Item Preview on Hover
When hovering a catalog item, show a larger preview popup with the thumbnail, dimensions, and attributes. Low effort, high UX value.

### 2. Favorites / Recently Used
Store recently dragged items in localStorage. Show a "Recent" section at the top of the catalog. Zero backend work.

### 3. Search Across All Items
A search bar in the catalog tab that filters items by name across all categories. Single `/api/catalog/search?q=sofa` endpoint.

### 4. Quantity Tracking
After placing items, show a count badge on each catalog item ("3 placed"). Derived from `projectState.furniture` which already exists.

### 5. Category Image as Background
Show the category thumbnail as a subtle background in the expanded category row — makes the left panel visually rich.

### 6. Admin Auth (Basic)
A simple `ADMIN_PASSWORD` env var check on all `/api/admin/*` routes. Not production-grade but prevents accidental edits.

### 7. IFC Preview in Admin
When uploading an IFC file in the CMS, auto-generate a thumbnail by running a headless xeokit render or a simple Python script that extracts a top-down view. Medium effort, high value for content managers.

---

## Implementation Phases

### Phase 1 — Database + Backend API (No UI changes)
1. Set up PostgreSQL, create `categories` and `catalog_items` tables
2. Write `db.js` connection pool
3. Write `catalog-routes.js` (read-only endpoints)
4. Write `admin-routes.js` (CRUD + file upload)
5. Wire into `server.js`
6. Seed with sample data (Furniture → Sofa → Traditional → 2-3 items)
7. Test all endpoints with Postman/curl

### Phase 2 — Left Panel Hierarchical Catalog
1. Update `LeftPanel.jsx` to fetch and render category tree
2. Collapsible tree with thumbnails
3. Item cards with thumbnail + color swatch
4. Drag payload updated to include `color_rgb` and `ifc_url`
5. Keep existing flat catalog as fallback

### Phase 3 — IFC Merge / Placement
1. Write `merge_furniture.py`
2. Add `/api/projects/:jobId/place-furniture` route
3. Update `handleDrop` in `BIMViewer.jsx` to call new endpoint for catalog items
4. Test with a simple sofa IFC on a sample building

### Phase 4 — CMS Admin Panel
1. New React route `/admin`
2. Category tree management UI
3. Item CRUD with image + IFC upload
4. Color picker + attributes editor

### Phase 5 — Polish & Enhancements
1. Search, favorites, quantity badges
2. Admin auth
3. IFC preview thumbnails

---

## Files to Create (New)

| File | Purpose |
|---|---|
| `ifc-render-app/db.js` | PostgreSQL pool |
| `ifc-render-app/catalog-routes.js` | Public catalog API |
| `ifc-render-app/admin-routes.js` | CMS API |
| `ifc-render-app/merge_furniture.py` | IFC placement logic |
| `ifc-render-app/migrations/001_catalog.sql` | DB schema |
| `bim-viewer-app/src/pages/AdminPanel.jsx` | CMS UI |
| `bim-viewer-app/src/components/CatalogTree.jsx` | Hierarchical catalog component |
| `bim-viewer-app/src/components/CategoryNode.jsx` | Single tree node |
| `bim-viewer-app/src/hooks/useCatalog.js` | Catalog data fetching hook |

## Files to Modify (Existing)

| File | Change |
|---|---|
| `ifc-render-app/server.js` | Mount new routes, add `/uploads` static, add pg init |
| `ifc-render-app/package.json` | Add `pg`, optionally `sharp` |
| `bim-viewer-app/src/components/LeftPanel.jsx` | Replace flat catalog with `<CatalogTree>` |
| `bim-viewer-app/src/BIMViewer.jsx` | Update `handleDrop` for catalog items with color |
| `bim-viewer-app/src/hooks/useProjectSync.js` | Update asset fetching |
| `bim-viewer-app/src/App.jsx` | Add `/admin` route |
| `bim-viewer-app/package.json` | Add `react-router-dom` if not present |
| `.env` / `.env.example` | Add `DATABASE_URL` |

---

## Open Questions to Confirm Before Starting

1. **Postgres hosting** — local dev only, or do you need a cloud DB (RDS, Supabase, Neon)?
2. **Admin auth** — simple password env var is fine for now, or do you need user accounts?
3. **IFC file size** — furniture IFC files can be 1–50MB. Should we set a max upload size limit?
4. **Existing assets** — the current flat assets (sofa.ifc, chair.ifc etc. in `/assets`) — should these be migrated into the new catalog DB, or kept as-is?
5. **Merge strategy** — should placing furniture modify `input.ifc` in-place (permanent), or always create a new overlay file (reversible, current door pattern)? Recommend reversible.
6. **Multi-user** — is this single-user local tool or multi-user? Affects whether we need per-user catalog or shared catalog.
