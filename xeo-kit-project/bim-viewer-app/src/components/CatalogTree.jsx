import { useState, useMemo, useRef } from 'react';
import { ChevronRight, ChevronDown, Search, Box, FileBox } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const assetUrl = (url) => (url && url.startsWith('/') ? `${API}${url}` : url);

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

function FileTypeBadge({ fileType }) {
  const isGlb = fileType === 'glb';
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-1">
      <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${
        isGlb ? 'bg-indigo-100 dark:bg-indigo-900/40' : 'bg-amber-100 dark:bg-amber-900/40'
      }`}>
        {isGlb
          ? <FileBox className="w-4 h-4 text-indigo-500" />
          : <Box className="w-4 h-4 text-amber-500" />}
      </div>
      <span className={`text-[9px] font-bold tracking-widest uppercase ${
        isGlb ? 'text-indigo-500' : 'text-amber-500'
      }`}>
        {isGlb ? 'GLB' : 'IFC'}
      </span>
    </div>
  );
}

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
  return <FileTypeBadge fileType={fileType} />;
}

function containsSearchMatch(node, query) {
  if (!node || !query) return true;
  const normalized = query.toLowerCase();
  if ((node.items || []).some((item) => String(item.name || '').toLowerCase().includes(normalized))) return true;
  return (node.children || []).some((child) => containsSearchMatch(child, query));
}

function CatalogItemCard({ item, placementMode, setPlacementMode, resetSelection }) {
  const placementId = `cat_${item.id}`;
  const isActive = placementMode?.id === placementId;
  const modelUrl = assetUrl(item.model_url || item.url);

  const dragStartedRef = useRef(false);

  const catalogId = String(item.id ?? '').trim();
  const itemType = String(item.type || '').trim().toLowerCase();
  const itemCategory = String(item.category || '').trim().toLowerCase();
  const itemName = String(item.name || '').trim().toLowerCase();
  const modelExtension = String(modelUrl || '').split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  const normalizedFileType = String(item.file_type || item.fileType || modelExtension || 'ifc').trim().toLowerCase();
  const doorText = `${catalogId} ${itemName} ${itemCategory}`;
  const isDoorAccessory = /\b(door\s*mat|doormat|doorstop|door\s*stop|doorbell)\b/i.test(doorText);
  // Do not require a curated naming convention. Real catalog assets frequently
  // use labels such as "Wooden Door 1" / "Wooden Door 2" and those must enter
  // the same host-wall/opening flow as the built-in IFC door presets.
  const hasDoorIdentity = /\bdoor\b/i.test(doorText) || /(?:^|[_-])door(?:[_-]|$)/i.test(catalogId);
  const isDoorCategory = /\bdoors?\b/i.test(itemCategory);
  const inferredDoor = !isDoorAccessory && (
    itemType === 'door' ||
    /^door[_-]/i.test(catalogId) ||
    isDoorCategory ||
    (normalizedFileType === 'glb' && hasDoorIdentity) ||
    (itemCategory === 'structural' && hasDoorIdentity) ||
    itemName.includes('sliding door') ||
    itemName.includes('flush door') ||
    itemName.includes('swing door') ||
    itemName.includes('fire-rated door') ||
    itemName.includes('revolving door')
  );

  const buildPlacementAsset = () => ({
    ...item,
    id: placementId,
    catalogId: item.id,
    url: modelUrl,
    type: inferredDoor ? 'door' : (itemType || 'furniture'),
    file_type: normalizedFileType,
    source: 'catalog',
  });

  const handleDragStart = (e) => {
    dragStartedRef.current = true;
    e.dataTransfer.setData('application/json', JSON.stringify(buildPlacementAsset()));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleDragEnd = () => {
    // Keep the flag alive long enough to cover Chromium's synthetic click
    // that can follow a completed drag. A zero-delay reset is too early on
    // some browser event sequences.
    setTimeout(() => {
      dragStartedRef.current = false;
    }, 250);
  };

  const handleClick = () => {
    if (dragStartedRef.current) return;
    setPlacementMode(buildPlacementAsset());
    resetSelection();
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleClick(); } }}
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      title={`Select or drag ${item.name} into the model`}
      aria-label={`Add ${item.name} to the model`}
      className={`flex flex-col rounded-xl border transition-all cursor-grab active:cursor-grabbing overflow-hidden
        ${isActive
          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 shadow-sm'
          : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 hover:border-indigo-300 dark:hover:border-indigo-700 hover:bg-white dark:hover:bg-slate-800'
        }`}
    >
      <div className="w-full h-24 bg-slate-100 dark:bg-slate-700/50 overflow-hidden">
        <ItemThumb url={assetUrl(item.thumbnail_url)} name={item.name} fileType={item.file_type} />
      </div>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <ColorDot rgb={item.color_rgb} />
        <span className="text-[11px] font-semibold text-slate-800 dark:text-slate-200 truncate leading-tight">
          {item.name}
        </span>
        {item.file_type === 'glb' && (
          <span className="ml-auto text-[8px] font-bold text-indigo-500 uppercase shrink-0">GLB</span>
        )}
      </div>
    </div>
  );
}

function CategoryNode({ node, depth, placementMode, setPlacementMode, resetSelection, searchQuery, isOpenControlled, onToggleRoot }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = depth === 0 ? isOpenControlled : isOpen;
  const handleToggle = depth === 0 ? onToggleRoot : () => setIsOpen(o => !o);

  const hasChildren = node.children?.length > 0;
  const hasItems = node.items?.length > 0;
  const hasContent = hasChildren || hasItems;

  const matchesSearch = useMemo(() => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const itemMatch = (items) => items?.some(i => i.name.toLowerCase().includes(q));
    const childMatch = (children) => children?.some(c => itemMatch(c.items) || childMatch(c.children));
    return itemMatch(node.items) || childMatch(node.children);
  }, [searchQuery, node]);

  if (searchQuery && !matchesSearch) return null;

  const filteredItems = searchQuery
    ? node.items?.filter(i => i.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : node.items;

  const indentPx = depth * 12;

  return (
    <div>
      <button
        onClick={() => hasContent && handleToggle()}
        className={`w-full flex items-center gap-2 py-2 text-left transition-colors
          ${hasContent ? 'hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer' : 'cursor-default'}
          ${depth === 0 ? 'border-b border-slate-100 dark:border-slate-800' : ''}`}
        style={{ paddingLeft: `${12 + indentPx}px`, paddingRight: '12px' }}
      >
        <span className="w-3 h-3 shrink-0 text-slate-400">
          {hasContent
            ? (open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)
            : <span className="w-3 h-3 block" />}
        </span>
        {node.image_url ? (
          <img src={assetUrl(node.image_url)} alt={node.name} className="w-5 h-5 rounded object-cover shrink-0" />
        ) : (
          <span className={`w-2 h-2 rounded-full shrink-0 ${depth === 0 ? 'bg-indigo-400' : 'bg-slate-300 dark:bg-slate-600'}`} />
        )}
        <span className={`truncate ${depth === 0
          ? 'text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wide'
          : 'text-xs font-semibold text-slate-600 dark:text-slate-400'}`}>
          {node.name}
        </span>
        {hasItems && (
          <span className="ml-auto text-[9px] text-slate-400 shrink-0">{node.items.length}</span>
        )}
      </button>

      {(open || searchQuery) && (
        <div>
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
          {filteredItems?.length > 0 && (
            <div
              className="grid grid-cols-2 gap-2 py-2 pr-3"
              style={{ paddingLeft: `${12 + indentPx + 12}px` }}
            >
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

export function CatalogTree({ tree, loading, error, placementMode, setPlacementMode, resetSelection }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [openRootId, setOpenRootId] = useState(null);

  if (loading) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-500 dark:text-slate-400">
        <span className="animate-spin w-5 h-5 border-2 border-[#ff914d]/40 border-t-[#ff914d] rounded-full" />
        <span className="font-semibold text-slate-700 dark:text-slate-200">Getting your items ready…</span>
        <span className="text-xs">Furniture and building elements will appear here.</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-center text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-900/10 dark:text-rose-300">
        <p className="font-semibold">We couldn’t load the item library.</p>
        <p className="mt-1 text-xs text-rose-600/80 dark:text-rose-300/70">Check that the editor is connected, then reload this panel.</p>
        <details className="mt-3 text-left"><summary className="cursor-pointer text-[10px] font-semibold">Technical details</summary><pre className="mt-2 whitespace-pre-wrap break-words text-[10px]">{error}</pre></details>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 rounded-lg px-2 py-1.5">
          <Search className="w-3 h-3 text-slate-400 shrink-0" />
          <input
            type="text"
            aria-label="Search furniture, doors and building items"
            placeholder="Search furniture, doors or items…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-xs text-slate-700 dark:text-slate-300 placeholder-slate-400 outline-none"
          />
          {searchQuery && (
            <button type="button" onClick={() => setSearchQuery('')} className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-white" aria-label="Clear search" title="Clear search">✕</button>
          )}
        </div>
      </div>
      <div className="mx-3 my-2 rounded-lg bg-orange-50/80 px-2.5 py-2 dark:bg-orange-500/10">
        <p className="text-[10px] leading-4 text-slate-600 dark:text-slate-300"><span className="font-semibold text-slate-800 dark:text-white">Add to your design:</span> click an item, then click in the model—or drag it into place.</p>
      </div>
      <div className="flex-1 overflow-y-auto pb-3">
        {!tree.length ? (
          <div className="mx-3 mt-4 rounded-xl border border-dashed border-slate-300 p-5 text-center dark:border-slate-700">
            <Box className="mx-auto h-7 w-7 text-slate-400" />
            <p className="mt-2 text-xs font-semibold text-slate-700 dark:text-slate-200">No items available yet</p>
            <p className="mt-1 text-[10px] leading-4 text-slate-500 dark:text-slate-400">No items are available in this library yet. Ask your catalog administrator to add them.</p>
          </div>
        ) : searchQuery.trim() && !tree.some((rootNode) => containsSearchMatch(rootNode, searchQuery.trim())) ? (
          <div className="mx-3 mt-4 rounded-xl border border-dashed border-slate-300 p-5 text-center dark:border-slate-700">
            <Search className="mx-auto h-6 w-6 text-slate-400" />
            <p className="mt-2 text-xs font-semibold text-slate-700 dark:text-slate-200">No matching items</p>
            <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">Try a shorter name or a different search.</p>
            <button type="button" onClick={() => setSearchQuery('')} className="mt-3 rounded-lg bg-[#ff914d]/10 px-3 py-1.5 text-[10px] font-semibold text-[#c96320] hover:bg-[#ff914d]/20 dark:text-orange-300">Clear search</button>
          </div>
        ) : tree.map(rootNode => (
          <CategoryNode
            key={rootNode.id}
            node={rootNode}
            depth={0}
            placementMode={placementMode}
            setPlacementMode={setPlacementMode}
            resetSelection={resetSelection}
            searchQuery={searchQuery}
            isOpenControlled={openRootId === rootNode.id}
            onToggleRoot={() => setOpenRootId(id => id === rootNode.id ? null : rootNode.id)}
          />
        ))}
      </div>
    </div>
  );
}
