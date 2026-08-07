# Phase 1 — Frontend: LeftPanel Hierarchical Catalog Tree

This document covers replacing the flat asset grid in `LeftPanel.jsx` with a
hierarchical collapsible category tree powered by `/api/catalog/tree`.

Prerequisite: Backend is running and `/api/catalog/tree` returns data.
See `CATALOG_PHASE1_BACKEND.md`.

---

## What Changes in the Catalog Tab

**Before (current state):**
- Flat grid of asset cards
- 3 hardcoded filter pills: All / Structural / Furniture
- No thumbnails — just a Database icon
- Data comes from `/api/assets` (hardcoded array in server.js)

**After:**
- Collapsible category tree: root → sub-category → items
- Each category row shows its thumbnail + name + expand/collapse arrow
- Each item card shows thumbnail image (or fallback icon), name, color swatch dot
- Items are draggable — payload includes `file_type` so BIMViewer knows if it's IFC or GLB
- Search bar at top filters across all items
- Old `/api/assets` flat list still works as fallback (existing behavior preserved)

---

## New File: `bim-viewer-app/src/components/CatalogTree.jsx`

This is the main hierarchical tree component rendered inside the Catalog tab.

```jsx
import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, Search, Box, FileBox } from 'lucide-react';

// Single color swatch dot shown on item cards
function ColorDot({ rgb }) {
  if (!rgb || !Array.isArray(rgb)) return null;
  const [r, g, b] = rgb;
  return (
    <span
      className="w-3 h-3 rounded-full border border-slate-300 dark:border-slate-600 shrink-0"
      style={{ backgroundColor: `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})` }}
    />
  );
}

// Thumbnail image with fallback icon
function ItemThumb({ url, name, fileType }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt={name}
        onError={() => setFailed(true)}
        className="w-full h-full object-cover"
      />
    );
  }
  return (
    <div className="w-full h-full flex items-center justify-center text-slate-400">
      {fileType === 'glb' ? <FileBox className="w-5 h-5" /> : <Box className="w-5 h-5" />}
    </div>
  );
}

// A single draggable item card
function CatalogItemCard({ item, placementMode, setPlacementMode, resetSelection }) {
  const isActive = placementMode?.id === `cat_${item.id}`;

  const handleDragStart = (e) => {
    const payload = JSON.stringify({
      id: `cat_${item.id}`,
      name: item.name,
      url: item.model_url,
      type: item.file_type === 'glb' ? 'furniture' : 'furniture',
      file_type: item.file_type,         // 'ifc' or 'glb'
      color_rgb: item.color_rgb,
      source: 'catalog',                 // distinguishes from legacy /api/assets items
    });
    e.dataTransfer.setData('application/json', payload);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={() => { setPlacementMode({ id: `cat_${item.id}`, ...item }); resetSelection(); }}
      className={`flex flex-col rounded-xl border transition-all cursor-grab active:cursor-grabbing overflow-hidden
        ${isActive
          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 shadow-sm'
          : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 hover:border-indigo-300 dark:hover:border-indigo-700 hover:bg-white dark:hover:bg-slate-800'
        }`}
    >
      {/* Thumbnail area */}
      <div className="w-full h-20 bg-slate-100 dark:bg-slate-700/50 overflow-hidden">
        <ItemThumb url={item.thumbnail_url} name={item.name} fileType={item.file_type} />
      </div>

      {/* Name + color swatch */}
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <ColorDot rgb={item.color_rgb} />
        <span className="text-[10px] font-semibold text-slate-700 dark:text-slate-300 truncate leading-tight">
          {item.name}
        </span>
        {item.file_type === 'glb' && (
          <span className="ml-auto text-[8px] font-bold text-indigo-500 uppercase shrink-0">GLB</span>
        )}
      </div>
    </div>
  );
}

// A single category node — collapsible, shows children + items
function CategoryNode({ node, depth, placementMode, setPlacementMode, resetSelection, searchQuery }) {
  const [isOpen, setIsOpen] = useState(depth === 0); // root categories open by default

  const hasChildren = node.children?.length > 0;
  const hasItems = node.items?.length > 0;
  const hasContent = hasChildren || hasItems;

  // When searching, auto-expand nodes that have matching items anywhere in subtree
  const matchesSearch = useMemo(() => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const itemMatch = (items) => items?.some(i => i.name.toLowerCase().includes(q));
    const childMatch = (children) => children?.some(c =>
      itemMatch(c.items) || childMatch(c.children)
    );
    return itemMatch(node.items) || childMatch(node.children);
  }, [searchQuery, node]);

  if (searchQuery && !matchesSearch) return null;

  const filteredItems = searchQuery
    ? node.items?.filter(i => i.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : node.items;

  const indentPx = depth * 12;

  return (
    <div>
      {/* Category header row */}
      <button
        onClick={() => hasContent && setIsOpen(o => !o)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors
          ${hasContent ? 'hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer' : 'cursor-default'}
          ${depth === 0 ? 'border-b border-slate-100 dark:border-slate-800' : ''}`}
        style={{ paddingLeft: `${12 + indentPx}px` }}
      >
        {/* Expand arrow */}
        <span className="w-3 h-3 shrink-0 text-slate-400">
          {hasContent
            ? (isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)
            : <span className="w-3 h-3 block" />
          }
        </span>

        {/* Category thumbnail */}
        {node.image_url ? (
          <img src={node.image_url} alt={node.name}
            className="w-5 h-5 rounded object-cover shrink-0" />
        ) : (
          <span className={`w-2 h-2 rounded-full shrink-0 ${depth === 0 ? 'bg-indigo-400' : 'bg-slate-300 dark:bg-slate-600'}`} />
        )}

        <span className={`truncate ${depth === 0
          ? 'text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wide'
          : 'text-xs font-semibold text-slate-600 dark:text-slate-400'}`}>
          {node.name}
        </span>

        {/* Item count badge */}
        {hasItems && (
          <span className="ml-auto text-[9px] text-slate-400 shrink-0">{node.items.length}</span>
        )}
      </button>

      {/* Expanded content */}
      {(isOpen || searchQuery) && (
        <div>
          {/* Child categories */}
          {node.children?.map(child => (
            <CategoryNode
              key={child.id}
              node={child}
              depth={depth + 1}
              placementMode={placementMode}
              setPlacementMode={setPlacementMode}
              resetSelection={resetSelection}
              searchQuery={searchQuery}
            />
          ))}

          {/* Items grid */}
          {filteredItems?.length > 0 && (
            <div className="grid grid-cols-2 gap-2 px-3 py-2"
              style={{ paddingLeft: `${12 + indentPx + 12}px` }}>
              {filteredItems.map(item => (
                <CatalogItemCard
                  key={item.id}
                  item={item}
                  placementMode={placementMode}
                  setPlacementMode={setPlacementMode}
                  resetSelection={resetSelection}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Root component — receives the tree from useCatalog hook
export function CatalogTree({ tree, loading, error, placementMode, setPlacementMode, resetSelection }) {
  const [searchQuery, setSearchQuery] = useState('');

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-slate-400 text-sm gap-2">
        <span className="animate-spin w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full" />
        Loading catalog...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center text-rose-500 text-xs">
        Failed to load catalog.<br />
        <span className="text-slate-400">{error}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 rounded-lg px-2 py-1.5">
          <Search className="w-3 h-3 text-slate-400 shrink-0" />
          <input
            type="text"
            placeholder="Search catalog..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-xs text-slate-700 dark:text-slate-300 placeholder-slate-400 outline-none"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')}
              className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer">✕</button>
          )}
        </div>
      </div>

      {/* Hint text */}
      <p className="text-[10px] text-slate-400 dark:text-slate-500 px-3 py-1.5 shrink-0">
        Drag an item onto the 3D view to place it.
      </p>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto">
        {tree.map(rootNode => (
          <CategoryNode
            key={rootNode.id}
            node={rootNode}
            depth={0}
            placementMode={placementMode}
            setPlacementMode={setPlacementMode}
            resetSelection={resetSelection}
            searchQuery={searchQuery}
          />
        ))}
      </div>
    </div>
  );
}
```

---

## Changes to `bim-viewer-app/src/components/LeftPanel.jsx`

Only the **Catalog tab section** changes. Everything else (Explorer tab, Layouts tab,
header, tab bar) stays exactly as-is.

### What to change

1. Add import for `CatalogTree` at the top
2. Replace the entire contents of the `{leftTab === 'assets'}` div with `<CatalogTree />`
3. Pass `tree`, `loading`, `error` props down from BIMViewer via LeftPanel props

### Diff — imports section (top of file)

```jsx
// ADD this import alongside existing imports
import { CatalogTree } from './CatalogTree';
```

### Diff — LeftPanel props signature

```jsx
// BEFORE
export const LeftPanel = ({ 
  isOpen, onClose, treeRef, availableAssets, 
  placementMode, setPlacementMode, resetSelection,
  homeTemplates, onApplyTemplate, fileName
}) => {

// AFTER
export const LeftPanel = ({ 
  isOpen, onClose, treeRef, availableAssets,
  catalogTree, catalogLoading, catalogError,
  placementMode, setPlacementMode, resetSelection,
  homeTemplates, onApplyTemplate, fileName
}) => {
```

### Diff — Catalog tab content (replace the entire assets div)

```jsx
// BEFORE — the entire block starting with:
// <div className={`flex-1 overflow-y-auto p-4 ${leftTab === 'assets' ? 'block' : 'hidden'}`}>
//   ...flat grid with category pills...
// </div>

// AFTER
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

---

## Changes to `bim-viewer-app/src/BIMViewer.jsx`

BIMViewer fetches the catalog tree via `useCatalog` hook and passes it to LeftPanel.

### Add import at top of BIMViewer.jsx

```jsx
import { useCatalog } from './hooks/useCatalog';
```

### Inside the BIMViewer component body, add:

```jsx
const { tree: catalogTree, loading: catalogLoading, error: catalogError } = useCatalog();
```

### Pass new props to LeftPanel in BIMViewer's JSX:

```jsx
// Find the <LeftPanel ... /> usage and add these 3 props:
<LeftPanel
  // ... all existing props stay unchanged ...
  catalogTree={catalogTree}
  catalogLoading={catalogLoading}
  catalogError={catalogError}
/>
```

### Update handleDrop to handle catalog items

The drag payload from catalog items includes `source: 'catalog'` and `file_type`.
The existing `handleDrop` / `spawnAsset` already handles both `.ifc` and `.glb` by
checking the URL extension. Since catalog items set `url` to the model path and
`file_type` explicitly, no logic change is needed — the existing URL-based detection
in `spawnAsset` / `useBIMEngine` already works for both types.

If you want to be explicit, find the drag payload read in handleDrop and ensure
`file_type` is forwarded:

```jsx
// In handleDrop, when reading the drag data:
const data = JSON.parse(e.dataTransfer.getData('application/json'));
// data.file_type is now available ('ifc' or 'glb')
// data.color_rgb is now available ([r,g,b] 0-1 range)
// Existing spawnAsset(data.url, ...) call works unchanged
```

---

## Backward Compatibility

- The old `/api/assets` endpoint in `server.js` is **not removed**
- `availableAssets` prop is still passed to LeftPanel (unused in catalog tab now but kept)
- The Layouts tab is completely untouched
- The Explorer tab is completely untouched
- Existing drag-and-drop behavior for legacy assets still works

---

## Next Step

Proceed to: **`CATALOG_PHASE1_FRONTEND_ADMINPANEL.md`** — Admin CMS page.
