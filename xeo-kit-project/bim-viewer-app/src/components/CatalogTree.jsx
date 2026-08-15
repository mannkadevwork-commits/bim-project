import { useState, useMemo } from 'react';
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

function CatalogItemCard({ item, placementMode, setPlacementMode, resetSelection }) {
  const placementId = `cat_${item.id}`;
  const isActive = placementMode?.id === placementId;
  const modelUrl = assetUrl(item.model_url || item.url);

  const catalogId = String(item.id ?? '').trim();
  const itemType = String(item.type || '').trim().toLowerCase();
  const itemCategory = String(item.category || '').trim().toLowerCase();
  const itemName = String(item.name || '').trim().toLowerCase();
  const inferredDoor =
    itemType === 'door' ||
    /^door[_-]/i.test(catalogId) ||
    (itemCategory === 'structural' && itemName.includes('door')) ||
    itemName.includes('sliding door') ||
    itemName.includes('flush door') ||
    itemName.includes('swing door') ||
    itemName.includes('fire-rated door') ||
    itemName.includes('revolving door');

  const buildPlacementAsset = () => ({
    ...item,
    id: placementId,
    catalogId: item.id,
    url: modelUrl,
    type: inferredDoor ? 'door' : (itemType || 'furniture'),
    file_type: item.file_type || item.fileType || 'ifc',
    source: 'catalog',
  });

  const handleDragStart = (e) => {
    e.dataTransfer.setData('application/json', JSON.stringify(buildPlacementAsset()));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={() => { setPlacementMode(buildPlacementAsset()); resetSelection(); }}
      className={`flex flex-col rounded-xl border transition-all cursor-grab active:cursor-grabbing overflow-hidden
        ${isActive
          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 shadow-sm'
          : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 hover:border-indigo-300 dark:hover:border-indigo-700 hover:bg-white dark:hover:bg-slate-800'
        }`}
    >
      <div className="w-full h-20 bg-slate-100 dark:bg-slate-700/50 overflow-hidden">
        <ItemThumb url={assetUrl(item.thumbnail_url)} name={item.name} fileType={item.file_type} />
      </div>
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

function CategoryNode({ node, depth, placementMode, setPlacementMode, resetSelection, searchQuery }) {
  const [isOpen, setIsOpen] = useState(depth === 0);

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
        onClick={() => hasContent && setIsOpen(o => !o)}
        className={`w-full flex items-center gap-2 py-2 text-left transition-colors
          ${hasContent ? 'hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer' : 'cursor-default'}
          ${depth === 0 ? 'border-b border-slate-100 dark:border-slate-800' : ''}`}
        style={{ paddingLeft: `${12 + indentPx}px`, paddingRight: '12px' }}
      >
        <span className="w-3 h-3 shrink-0 text-slate-400">
          {hasContent
            ? (isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)
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

      {(isOpen || searchQuery) && (
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
            <button onClick={() => setSearchQuery('')} className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer">✕</button>
          )}
        </div>
      </div>
      <p className="text-[10px] text-slate-400 dark:text-slate-500 px-3 py-1.5 shrink-0">
        Drag an item onto the 3D view to place it.
      </p>
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
