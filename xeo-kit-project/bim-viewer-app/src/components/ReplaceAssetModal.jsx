import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Check, FileBox, Loader2, RefreshCw, Search, X } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function resolveAssetUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return `${API_BASE_URL.replace(/\/$/, '')}/${url.replace(/^\/+/, '')}`;
}

function flattenCatalog(nodes, parents = []) {
  const result = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const path = [...parents, String(node.name || '').trim()].filter(Boolean);
    for (const item of Array.isArray(node.items) ? node.items : []) {
      const fileType = String(item.file_type || item.fileType || '').toLowerCase();
      const modelUrl = item.model_url || item.url || item.src;
      if (!modelUrl) continue;
      result.push({
        ...item,
        _fileType: fileType || (String(modelUrl).toLowerCase().includes('.glb') ? 'glb' : 'ifc'),
        _categoryPath: path.join(' / ') || String(item.category || 'Catalogue'),
        _modelUrl: modelUrl,
      });
    }
    result.push(...flattenCatalog(node.children || [], path));
  }
  return result;
}

function isDoorAsset(item) {
  const text = `${item.name || ''} ${item.category || ''} ${item._categoryPath || ''} ${item.type || ''}`.toLowerCase();
  return /\bdoors?\b|sliding door|door frame|door leaf|door mat|doormat|doorstop/.test(text);
}

function normalizeModelPath(value) {
  return String(value || '')
    .split('?')[0]
    .replace(API_BASE_URL.replace(/\/$/, ''), '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function sameAsset(item, currentItem) {
  const itemId = String(item.id ?? '');
  const currentCatalogId = String(currentItem?.id ?? '').replace(/^cat_/, '');
  if (itemId && currentCatalogId && itemId === currentCatalogId) return true;
  const currentSrc = normalizeModelPath(currentItem?.src);
  const candidateSrc = normalizeModelPath(item._modelUrl);
  return Boolean(currentSrc && candidateSrc && currentSrc === candidateSrc);
}

function ModelThumbnail({ item }) {
  const [failed, setFailed] = useState(false);
  const thumbnail = resolveAssetUrl(item.thumbnail_url || item.thumbnailUrl);
  if (thumbnail && !failed) {
    return <img src={thumbnail} alt="" onError={() => setFailed(true)} className="h-full w-full object-cover" />;
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
      {item._fileType === 'glb' ? <FileBox className="h-8 w-8" /> : <Box className="h-8 w-8" />}
    </div>
  );
}

export function ReplaceAssetModal({
  open,
  currentItem,
  catalogTree = [],
  onClose,
  onReplace,
}) {
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [preserveFinish, setPreserveFinish] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const onCloseRef = useRef(onClose);
  const submittingRef = useRef(submitting);
  onCloseRef.current = onClose;
  submittingRef.current = submitting;

  const flatItems = useMemo(() => flattenCatalog(catalogTree), [catalogTree]);
  const currentCatalogMatch = useMemo(() => {
    const sourceKey = normalizeModelPath(currentItem?.src);
    const currentId = String(currentItem?.id ?? '').replace(/^cat_/, '');
    return flatItems.find((item) => (
      (currentId && String(item.id) === currentId) ||
      (sourceKey && normalizeModelPath(item._modelUrl) === sourceKey)
    )) || null;
  }, [flatItems, currentItem?.src, currentItem?.id]);
  const eligibleItems = useMemo(() => flatItems.filter((item) => {
    if (isDoorAsset(item)) return false;
    if (sameAsset(item, currentItem)) return false;
    return true;
  }), [flatItems, currentItem]);
  const categories = useMemo(() => [...new Set(eligibleItems.map((item) => item._categoryPath).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [eligibleItems]);
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return eligibleItems.filter((item) => {
      if (categoryFilter !== 'all' && item._categoryPath !== categoryFilter) return false;
      const text = `${item.name || ''} ${item.category || ''} ${item.description || ''} ${item._categoryPath || ''}`.toLowerCase();
      return !normalized || text.includes(normalized);
    });
  }, [eligibleItems, categoryFilter, query]);
  const selectedItem = filteredItems.find((item) => String(item.id) === selectedId) || null;

  useEffect(() => {
    if (!open) return undefined;
    setQuery(currentItem?.isNativeIfcElement ? String(currentItem?.name || '').replace(/[^a-z0-9 ]/gi, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 2).join(' ') : '');
    setCategoryFilter(currentCatalogMatch?._categoryPath || 'all');
    setSelectedId('');
    setPreserveFinish(true);
    setError('');
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !submittingRef.current) onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, currentItem?.instanceId, currentCatalogMatch?._categoryPath]);

  if (!open) return null;

  const handleReplace = async () => {
    if (!selectedItem || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onReplace?.(selectedItem, preserveFinish);
      onCloseRef.current?.();
    } catch (replaceError) {
      setError(replaceError?.message || 'Replacement failed. The original item has been kept.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[260] flex items-center justify-center bg-slate-950/65 p-3 backdrop-blur-sm sm:p-6"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose?.(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="replace-asset-title"
        className="flex max-h-[min(88vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-950"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800 sm:px-6">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#d96b25]">Design edit · Replace item</p>
            <h2 id="replace-asset-title" className="mt-1 text-lg font-bold text-slate-900 dark:text-white">Replace {currentItem?.name || 'selected item'}</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{currentItem?.isNativeIfcElement ? 'Choose a catalogue asset to replace this IFC furniture element. The original IFC source is preserved and hidden through a tracked edit.' : 'Choose a catalogue alternative. The rest of your design stays in place.'}</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} className="rounded-xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800" aria-label="Close replace item dialog">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid shrink-0 grid-cols-1 gap-3 border-b border-slate-200 bg-slate-50/80 p-4 dark:border-slate-800 dark:bg-slate-900/60 sm:grid-cols-[minmax(0,1fr)_250px] sm:px-6">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} autoFocus placeholder="Search sofas, chairs, tables…" className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-2 focus:ring-orange-100 dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:focus:border-orange-500/50 dark:focus:ring-orange-500/10" />
          </label>
          <label className="block">
            <span className="sr-only">Filter by category</span>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none focus:border-orange-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
              <option value="all">All categories ({eligibleItems.length})</option>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {error && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">{error}</div>}
          {filteredItems.length ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {filteredItems.map((item) => {
                const id = String(item.id);
                const selected = selectedId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => { setSelectedId(id); setError(''); }}
                    className={`group overflow-hidden rounded-xl border text-left transition ${selected ? 'border-orange-400 bg-orange-50/70 ring-2 ring-orange-200 dark:border-orange-400 dark:bg-orange-500/10 dark:ring-orange-500/20' : 'border-slate-200 bg-white hover:border-orange-200 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-orange-500/40'}`}
                    aria-pressed={selected}
                  >
                    <div className="relative aspect-[4/3] overflow-hidden bg-slate-100 dark:bg-slate-800">
                      <ModelThumbnail item={item} />
                      <span className="absolute left-2 top-2 rounded-md bg-slate-950/75 px-1.5 py-1 text-[8px] font-bold uppercase tracking-wider text-white">{item._fileType || 'asset'}</span>
                      {selected && <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-orange-500 text-white shadow"><Check className="h-3.5 w-3.5" /></span>}
                    </div>
                    <div className="p-2.5">
                      <p className="truncate text-xs font-bold text-slate-900 dark:text-white" title={item.name}>{item.name || 'Untitled asset'}</p>
                      <p className="mt-1 truncate text-[10px] text-slate-500 dark:text-slate-400" title={item._categoryPath}>{item._categoryPath}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 text-center dark:border-slate-700">
              <Search className="h-7 w-7 text-slate-300 dark:text-slate-600" />
              <p className="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">No replacement items found</p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">Try another search or choose a different category.</p>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 flex-col gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/80 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={preserveFinish} onChange={(event) => setPreserveFinish(event.target.checked)} className="mt-0.5 accent-orange-500" />
            <span><span className="font-semibold">Keep current finish where possible</span><span className="mt-0.5 block text-[10px] text-slate-400">Applies the selected color/fabric/texture to the new item when supported.</span></span>
          </label>
          <div className="flex items-center justify-end gap-2">
            <span className="mr-2 hidden max-w-[230px] truncate text-[10px] text-slate-400 sm:inline">{selectedItem ? `Selected: ${selectedItem.name}` : 'Select an item to continue'}</span>
            <button type="button" onClick={onClose} disabled={submitting} className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600 transition hover:bg-white disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
            <button type="button" onClick={handleReplace} disabled={!selectedItem || submitting} className="inline-flex items-center gap-2 rounded-xl bg-[#ff914d] px-4 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-[#ff7a28] disabled:cursor-not-allowed disabled:opacity-50">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {submitting ? 'Replacing…' : 'Replace item'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
