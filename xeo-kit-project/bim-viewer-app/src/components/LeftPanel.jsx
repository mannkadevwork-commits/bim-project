import { useMemo, useState } from 'react';
import { PanelLeftClose, Loader2, Layout, Orbit, ExternalLink, Box, Pencil, Trash2, X, AlertTriangle ,FolderOpen} from 'lucide-react';
import { LayoutMetadataForm } from './LayoutMetadataForm';
import { CatalogTree } from './CatalogTree'; //[cite: 1]

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const resolveBackendUrl = (value) => {
  if (!value) return '';
  try { return new URL(value, API_BASE_URL).toString(); }
  catch { return value; }
};



export const LeftPanel = ({ 
  isOpen, onClose, treeRef, availableAssets,
  catalogTree, catalogLoading, catalogError,
  placementMode, setPlacementMode, resetSelection,
  homeTemplates, onApplyTemplate, availableLayouts, layoutsLoading, layoutsError, onSelectLayout, fileName,
  savedLayouts = [], savedLayoutsLoading = false, savedLayoutsError = null, onOpenSavedLayout,
  onEditSavedLayout, onDeleteSavedLayout, fileNameForLayoutMetadata,
}) => {
  const [leftTab, setLeftTab] = useState('explorer');
  const [layoutPath, setLayoutPath] = useState({ level: 'root', type: null, category: null, subCategory: null });
  const [editingLayout, setEditingLayout] = useState(null);
  const [deletingLayout, setDeletingLayout] = useState(null);
  const [layoutMutationBusy, setLayoutMutationBusy] = useState(false);
  const [layoutMutationError, setLayoutMutationError] = useState(null);

  const resetLayoutNavigation = () => setLayoutPath({ level: 'root', type: null, category: null, subCategory: null });

  const projectGroups = useMemo(() => {
    const map = new Map();
    (savedLayouts || [])
      .filter((layout) => layout?.categoryType === 'project' && String(layout.categoryName || '').trim())
      .forEach((layout) => {
        const name = String(layout.categoryName).trim();
        if (!map.has(name)) map.set(name, []);
        map.get(name).push(layout);
      });
    return Array.from(map.entries())
      .map(([name, layouts]) => ({ name, layouts, subCategories: Array.from(new Set(layouts.map((l) => String(l.subCategory || '').trim()).filter(Boolean))) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [savedLayouts]);

  const floorplanGroups = useMemo(() => {
    const map = new Map();
    (savedLayouts || [])
      .filter((layout) => layout?.categoryType === 'floorplan' && String(layout.categoryName || '').trim())
      .forEach((layout) => {
        const name = String(layout.categoryName).trim();
        if (!map.has(name)) map.set(name, []);
        map.get(name).push(layout);
      });
    return Array.from(map.entries())
      .map(([name, layouts]) => ({ name, layouts, subCategories: Array.from(new Set(layouts.map((l) => String(l.subCategory || '').trim()).filter(Boolean))) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [savedLayouts]);

  const selectedLayouts = useMemo(() => {
    if (layoutPath.level !== 'layouts') return [];
    return (savedLayouts || []).filter((layout) =>
      layout?.categoryType === layoutPath.type &&
      String(layout.categoryName || '').trim() === layoutPath.category &&
      String(layout.subCategory || '').trim() === layoutPath.subCategory
    );
  }, [savedLayouts, layoutPath]);

  const selectedCategory = useMemo(() => {
    const groups = layoutPath.type === 'project' ? projectGroups : floorplanGroups;
    return groups.find((group) => group.name === layoutPath.category) || null;
  }, [layoutPath, projectGroups, floorplanGroups]);

  const selectedSubCategories = selectedCategory?.subCategories || [];

  const breadcrumb = () => {
    if (layoutPath.level === 'root') return 'Layouts';
    if (layoutPath.level === 'categories') return layoutPath.type === 'project' ? 'Projects' : 'Floor Plans';
    if (layoutPath.level === 'subcategories') return layoutPath.category;
    return `${layoutPath.category} / ${layoutPath.subCategory}`;
  };

  const openCategory = (type) => setLayoutPath({ level: 'categories', type, category: null, subCategory: null });
  const openSubcategories = (category) => setLayoutPath({ level: 'subcategories', type: layoutPath.type, category, subCategory: null });
  const openLayouts = (subCategory) => setLayoutPath({ level: 'layouts', type: layoutPath.type, category: layoutPath.category, subCategory });
  const goBack = () => {
    if (layoutPath.level === 'layouts') return setLayoutPath({ ...layoutPath, level: 'subcategories', subCategory: null });
    if (layoutPath.level === 'subcategories') return setLayoutPath({ level: 'categories', type: layoutPath.type, category: null, subCategory: null });
    return resetLayoutNavigation();
  };

  const renderLayoutCard = (layout) => (
    <div key={layout.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-800/70 dark:hover:border-indigo-700">
      <button type="button" onClick={() => onOpenSavedLayout?.(layout)} className="block w-full text-left" title={`Load ${layout.name}`}>
        <div className="relative aspect-[16/9] overflow-hidden bg-slate-950">
          {layout.thumbnailUrl ? (
            <img src={resolveBackendUrl(layout.thumbnailUrl)} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-indigo-300"><Box className="h-8 w-8" /></div>
          )}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-3 pb-3 pt-9">
            <p className="truncate text-sm font-bold text-white">{layout.name}</p>
          </div>
        </div>
      </button>
      <div className="px-3 py-2.5">
        <p className="truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-indigo-500 dark:text-indigo-300">{layoutPath.subCategory}</p>
        <div className="mt-2 grid grid-cols-[1fr_auto_auto] gap-2">
          <button type="button" onClick={() => onOpenSavedLayout?.(layout)} className="rounded-lg bg-[#ff914d] px-3 py-2 text-[11px] font-bold text-white transition hover:bg-[#ff7a28]">Use Layout</button>
          <a href={layout.walkthroughUrl ? resolveBackendUrl(layout.walkthroughUrl) : '#'} target="_blank" rel="noreferrer" className="rounded-lg border border-indigo-200 px-3 py-2 text-[11px] font-bold text-indigo-600 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-900/30" title="Preview in 360°"><Orbit className="h-3.5 w-3.5" /></a>
          <button type="button" onClick={() => { setLayoutMutationError(null); setEditingLayout(layout); }} className="rounded-lg border border-slate-200 px-2.5 py-2 text-slate-500 hover:border-indigo-300 hover:text-indigo-500 dark:border-slate-700" aria-label={`Edit ${layout.name}`}><Pencil className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => { setLayoutMutationError(null); setDeletingLayout(layout); }} className="rounded-lg border border-rose-200 px-2.5 py-2 text-rose-500 hover:bg-rose-50 dark:border-rose-900/60 dark:hover:bg-rose-900/20" aria-label={`Delete ${layout.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={`flex h-full flex-col border-r border-slate-200 bg-white transition-all duration-300 dark:border-slate-800 dark:bg-slate-900 ${isOpen ? 'w-80' : 'w-0 overflow-hidden border-none'}`}>
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-4 dark:border-slate-800 dark:bg-slate-900/50">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/hci-logo.svg" alt="High Creation Interiors" className="hci-logo-badge hci-logo-badge--compact" />
          <div className="h-4 w-px bg-slate-300 dark:bg-slate-700" />
          <span className="truncate text-xs font-bold tracking-wide text-slate-700 dark:text-slate-300">{fileName || 'Untitled Project'}</span>
        </div>
        <button onClick={onClose} className="rounded p-1.5 text-slate-400 transition-colors hover:text-indigo-600 dark:hover:text-indigo-400" title="Close Panel"><PanelLeftClose className="h-4 w-4" /></button>
      </div>

      <div className="flex shrink-0 border-b border-slate-200 dark:border-slate-800">
        {[
          ['explorer', 'Explorer'],
          ['assets', 'Catalog'],
          ['templates', 'Layouts'],
        ].map(([id, label]) => (
          <button key={id} onClick={() => { setLeftTab(id); if (id !== 'templates') resetLayoutNavigation(); }} className={`flex-1 py-3 text-[11px] font-bold uppercase tracking-wider transition-colors ${leftTab === id ? 'border-b-2 border-[#ff914d] bg-indigo-50/50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>{label}</button>
        ))}
      </div>

      <div className={`flex-1 overflow-y-auto ${leftTab === 'explorer' ? 'block' : 'hidden'}`}>
        <div ref={treeRef} className="p-4 text-sm text-slate-700 dark:text-slate-300" />
      </div>

      <div className={`flex-1 overflow-hidden ${leftTab === 'assets' ? 'flex' : 'hidden'}`}>
        <CatalogTree tree={catalogTree || []} loading={catalogLoading} error={catalogError} placementMode={placementMode} setPlacementMode={setPlacementMode} resetSelection={resetSelection} />
      </div>

      <div className={`flex-1 overflow-y-auto ${leftTab === 'templates' ? 'block' : 'hidden'}`}>
        <div className="border-b border-slate-200 px-4 py-4 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Layout Library</p>
              <h3 className="mt-1 text-lg font-bold text-slate-900 dark:text-white">{breadcrumb()}</h3>
            </div>
            {layoutPath.level !== 'root' && <button type="button" onClick={goBack} className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-bold text-slate-500 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-300"><span className="mr-1">←</span> Back</button>}
          </div>
          {layoutPath.level === 'root' && <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">Choose a project first. Layouts appear only after you drill into their category.</p>}
        </div>

        {savedLayoutsLoading ? (
          <div className="flex h-52 flex-col items-center justify-center text-slate-400"><Loader2 className="mb-2 h-6 w-6 animate-spin text-indigo-500" /><span className="text-xs">Loading layout library…</span></div>
        ) : savedLayoutsError ? (
          <div className="m-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[11px] text-rose-600 dark:border-rose-900/50 dark:bg-rose-900/10 dark:text-rose-400">{savedLayoutsError}</div>
        ) : layoutPath.level === 'root' ? (
          <div className="space-y-3 p-4">
            <button type="button" onClick={() => openCategory('project')} className="group flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-800/60">
              <div className="flex min-w-0 items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300"><FolderOpen className="h-5 w-5" /></div><div><p className="font-bold text-sm text-slate-900 dark:text-white">Projects</p><p className="mt-0.5 text-[11px] text-slate-400">{projectGroups.length} project{projectGroups.length === 1 ? '' : 's'} · browse by sub-category</p></div></div><span className="text-xl text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500">›</span>
            </button>
            {/* <button type="button" onClick={() => openCategory('floorplan')} className="group flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-800/60">
              <div className="flex min-w-0 items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-50 text-orange-500 dark:bg-orange-950/30 dark:text-orange-300"><Layout className="h-5 w-5" /></div><div><p className="font-bold text-sm text-slate-900 dark:text-white">Floor Plans</p><p className="mt-0.5 text-[11px] text-slate-400">{floorplanGroups.length} floor plan categor{floorplanGroups.length === 1 ? 'y' : 'ies'}</p></div></div><span className="text-xl text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500">›</span>
            </button> */}
            <div className="pt-3">
              <div className="mb-3 flex items-center justify-between"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Starter Layouts</p><span className="text-[10px] text-slate-400">{availableLayouts?.length || 0} available</span></div>
              {layoutsLoading ? <div className="rounded-xl border border-slate-200 p-4 text-center text-xs text-slate-400 dark:border-slate-700">Loading starters…</div> : layoutsError ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-600 dark:border-rose-900/50 dark:bg-rose-900/10">{layoutsError}</div> : availableLayouts?.length ? <div className="space-y-2">{availableLayouts.map(layout => <button key={layout.id} type="button" onClick={() => onSelectLayout?.(layout)} disabled={layout.available === false} className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-left transition hover:border-indigo-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800/50"><span><span className="block text-xs font-bold text-slate-800 dark:text-white">{layout.name}</span><span className="mt-0.5 block text-[10px] text-slate-400">{layout.description}</span></span><span className="text-lg text-slate-300">›</span></button>)}</div> : <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400 dark:border-slate-700">No starter layouts available.</div>}
            </div>
          </div>
        ) : layoutPath.level === 'categories' ? (
          <div className="space-y-2 p-4">
            {(layoutPath.type === 'project' ? projectGroups : floorplanGroups).length ? (layoutPath.type === 'project' ? projectGroups : floorplanGroups).map(group => (
              <button key={group.name} type="button" onClick={() => openSubcategories(group.name)} className="group flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-indigo-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-800/60">
                <div><p className="text-sm font-bold text-slate-900 dark:text-white">{group.name}</p><p className="mt-1 text-[10px] text-slate-400">{group.subCategories.length} sub-categor{group.subCategories.length === 1 ? 'y' : 'ies'} · {group.layouts.length} layout{group.layouts.length === 1 ? '' : 's'}</p></div><span className="text-xl text-slate-300 group-hover:text-indigo-500">›</span>
              </button>
            )) : <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400 dark:border-slate-700">No {layoutPath.type === 'project' ? 'projects' : 'floor plans'} have saved layouts yet.</div>}
          </div>
        ) : layoutPath.level === 'subcategories' ? (
          <div className="space-y-2 p-4">
            {selectedSubCategories.length ? selectedSubCategories.map(sub => {
              const count = (savedLayouts || []).filter((layout) => layout.categoryType === layoutPath.type && String(layout.categoryName || '').trim() === layoutPath.category && String(layout.subCategory || '').trim() === sub).length;
              return <button key={sub} type="button" onClick={() => openLayouts(sub)} className="group flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-indigo-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-800/60"><div><p className="text-sm font-bold text-slate-900 dark:text-white">{sub}</p><p className="mt-1 text-[10px] text-slate-400">{count} layout{count === 1 ? '' : 's'}</p></div><span className="text-xl text-slate-300 group-hover:text-indigo-500">›</span></button>;
            }) : <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400 dark:border-slate-700">No sub-categories exist under this project yet.</div>}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 p-4">{selectedLayouts.length ? selectedLayouts.map(renderLayoutCard) : <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400 dark:border-slate-700">No layouts found here.</div>}</div>
        )}
      </div>

        {editingLayout && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-md">
            <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
              <div className="shrink-0 border-b border-slate-200 p-5 dark:border-slate-800"><div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-indigo-500">Edit Saved Layout</p>
                  <h3 className="mt-1 text-lg font-bold text-slate-900 dark:text-white">Update “{editingLayout.name}”</h3>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Only the catalog details change. The frozen 360 snapshot and Xeokit restore data stay untouched.</p>
                </div>
                <button type="button" onClick={() => setEditingLayout(null)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5"><X className="h-5 w-5" /></button>
              </div></div>
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {layoutMutationError && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-400">{layoutMutationError}</div>}
              <LayoutMetadataForm
                mode="edit"
                fileName={fileNameForLayoutMetadata || fileName}
                existingLayouts={savedLayouts}
                initialValue={editingLayout}
                submitting={layoutMutationBusy}
                onCancel={() => setEditingLayout(null)}
                onSubmit={async (metadata) => {
                  if (!onEditSavedLayout) return;
                  setLayoutMutationBusy(true);
                  setLayoutMutationError(null);
                  try {
                    await onEditSavedLayout(editingLayout.id, metadata);
                    setEditingLayout(null);
                  } catch (error) {
                    setLayoutMutationError(error?.message || 'Failed to update layout.');
                  } finally {
                    setLayoutMutationBusy(false);
                  }
                }}
              />
              </div>
            </div>
          </div>
        )}

        {deletingLayout && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-md">
            <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-rose-100 text-rose-500 dark:bg-rose-950/40"><AlertTriangle className="h-5 w-5" /></div>
              <h3 className="mt-4 text-lg font-bold text-slate-900 dark:text-white">Delete “{deletingLayout.name}”?</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">This removes the saved layout from the Layouts menu and deletes its frozen render snapshot. Your current project is not changed.</p>
              {layoutMutationError && <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-400">{layoutMutationError}</div>}
              <div className="mt-6 flex justify-end gap-2">
                <button type="button" onClick={() => setDeletingLayout(null)} className="rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/5">Cancel</button>
                <button
                  type="button"
                  disabled={layoutMutationBusy}
                  onClick={async () => {
                    if (!onDeleteSavedLayout) return;
                    setLayoutMutationBusy(true);
                    setLayoutMutationError(null);
                    try {
                      await onDeleteSavedLayout(deletingLayout.id);
                      setDeletingLayout(null);
                    } catch (error) {
                      setLayoutMutationError(error?.message || 'Failed to delete layout.');
                    } finally {
                      setLayoutMutationBusy(false);
                    }
                  }}
                  className="rounded-xl bg-rose-500 px-4 py-2.5 text-xs font-bold text-white hover:bg-rose-600 disabled:opacity-50"
                >
                  {layoutMutationBusy ? 'Deleting…' : 'Delete Layout'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
  );
};