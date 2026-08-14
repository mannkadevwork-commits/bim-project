import { useState } from 'react';
import { PanelLeftClose, Loader2, Database, Layout } from 'lucide-react';
import { CatalogTree } from './CatalogTree'; //[cite: 1]


export const LeftPanel = ({ 
  isOpen, onClose, treeRef, availableAssets,
  catalogTree, catalogLoading, catalogError, //[cite: 1]
  placementMode, setPlacementMode, resetSelection,
  homeTemplates, onApplyTemplate, availableLayouts, layoutsLoading, layoutsError, onSelectLayout, fileName 
}) => {
  const [leftTab, setLeftTab] = useState('explorer');
  const [activeCategory, setActiveCategory] = useState('All');

  return (
    <div className={`flex flex-col h-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 transition-all duration-300 z-20 ${isOpen ? 'w-80' : 'w-0 overflow-hidden border-none'}`}>
      
      {/* ── NEW: Global Logo & Filename Header ── */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50 dark:bg-slate-900/50">
        <div className="flex items-center gap-3">
          <img src="/hci-logo.svg" alt="High Creation Interiors" className="hci-logo-badge hci-logo-badge--compact" />
          <div className="w-px h-4 bg-slate-300 dark:bg-slate-700"></div>
          <span className="text-xs font-bold text-slate-700 dark:text-slate-300 tracking-wide truncate max-w-[150px]">
            {fileName || 'Untitled Project'}
          </span>
        </div>
        <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 rounded transition-colors cursor-pointer" title="Close Panel">
          <PanelLeftClose className="w-4 h-4"/>
        </button>
      </div>

      <div className="flex border-b border-slate-200 dark:border-slate-800 shrink-0">
        <button
          onClick={() => setLeftTab('explorer')}
          className={`flex-1 py-3 text-[11px] font-bold uppercase tracking-wider transition-colors cursor-pointer ${leftTab === 'explorer' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-[#ff914d] bg-indigo-50/50 dark:bg-indigo-900/20' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
        >
          Explorer
        </button>
        <button
          onClick={() => setLeftTab('assets')}
          className={`flex-1 py-3 text-[11px] font-bold uppercase tracking-wider transition-colors cursor-pointer ${leftTab === 'assets' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-[#ff914d] bg-indigo-50/50 dark:bg-indigo-900/20' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
        >
          Catalog
        </button>
        <button
          onClick={() => setLeftTab('templates')}
          className={`flex-1 py-3 text-[11px] font-bold uppercase tracking-wider transition-colors cursor-pointer ${leftTab === 'templates' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-[#ff914d] bg-indigo-50/50 dark:bg-indigo-900/20' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
        >
          Layouts
        </button>
      </div>

      {/* IFC Structure Tree */}
      <div className={`flex-1 overflow-y-auto ${leftTab === 'explorer' ? 'block' : 'hidden'}`}>
        <div ref={treeRef} className="p-4 text-sm text-slate-700 dark:text-slate-300" />
      </div>

      {/* Single Asset Catalog */}
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

      {/* Predefined IFC Layouts */}
      <div className={`flex-1 overflow-y-auto p-4 ${leftTab === 'templates' ? 'block' : 'hidden'}`}>
        <div className="mb-4 text-center">
          <p className="text-xs text-slate-400 dark:text-slate-500 leading-relaxed">
            Choose a predefined IFC layout to replace the current project with a fresh workspace.
          </p>
        </div>

        {layoutsLoading ? (
          <div className="h-40 flex flex-col items-center justify-center text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin mb-2" />
            <span className="text-xs">Loading layouts...</span>
          </div>
        ) : layoutsError ? (
          <div className="p-4 rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-900/10 text-xs text-rose-600 dark:text-rose-400">
            {layoutsError}
          </div>
        ) : availableLayouts?.length ? (
          <div className="space-y-4">
            {availableLayouts.map(layout => (
              <div
                key={layout.id}
                className="p-4 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 rounded-xl hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Layout className="w-5 h-5 text-indigo-500" />
                  <h3 className="font-bold text-sm text-slate-800 dark:text-white">{layout.name}</h3>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">{layout.description}</p>
                <div className="text-[10px] text-slate-400 mb-4 font-mono truncate" title={layout.fileName}>
                  {layout.fileName}
                </div>
                <button
                  onClick={() => onSelectLayout?.(layout)}
                  disabled={layout.available === false}
                  className="w-full py-2 bg-[#ff914d] hover:bg-[#ff7a28] disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold transition-colors shadow-sm cursor-pointer"
                >
                  {layout.available === false ? 'Unavailable' : 'Use This Layout'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4 text-center text-xs text-slate-400">No predefined layouts available.</div>
        )}
      </div>
    </div>
  );
};