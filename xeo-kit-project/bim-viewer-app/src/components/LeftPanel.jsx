import { useState } from 'react';
import { PanelLeftClose, Loader2, Database, Layout, Hexagon } from 'lucide-react';
import { CatalogTree } from './CatalogTree';

export const LeftPanel = ({ 
  isOpen, onClose, treeRef, availableAssets,
  catalogTree, catalogLoading, catalogError,
  placementMode, setPlacementMode, resetSelection,
  homeTemplates, onApplyTemplate, fileName
}) => {
  const [leftTab, setLeftTab] = useState('explorer');
  const [activeCategory, setActiveCategory] = useState('All');

  return (
    <div className={`flex flex-col h-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 transition-all duration-300 z-20 ${isOpen ? 'w-80' : 'w-0 overflow-hidden border-none'}`}>
      
      {/* ── NEW: Global Logo & Filename Header ── */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50 dark:bg-slate-900/50">
        <div className="flex items-center gap-3">
          <Hexagon className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
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
          className={`flex-1 py-3 text-[11px] font-bold uppercase tracking-wider transition-colors cursor-pointer ${leftTab === 'explorer' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500 bg-indigo-50/50 dark:bg-indigo-900/20' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
        >
          Explorer
        </button>
        <button
          onClick={() => setLeftTab('assets')}
          className={`flex-1 py-3 text-[11px] font-bold uppercase tracking-wider transition-colors cursor-pointer ${leftTab === 'assets' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500 bg-indigo-50/50 dark:bg-indigo-900/20' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
        >
          Catalog
        </button>
        <button
          onClick={() => setLeftTab('templates')}
          className={`flex-1 py-3 text-[11px] font-bold uppercase tracking-wider transition-colors cursor-pointer ${leftTab === 'templates' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500 bg-indigo-50/50 dark:bg-indigo-900/20' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
        >
          Layouts
        </button>
      </div>

      {/* IFC Structure Tree */}
      <div className={`flex-1 overflow-y-auto ${leftTab === 'explorer' ? 'block' : 'hidden'}`}>
        <div ref={treeRef} className="p-4 text-sm text-slate-700 dark:text-slate-300" />
      </div>

      {/* Catalog Tab — Hierarchical Tree */}
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

      {/* Predefined Home Templates */}
      <div className={`flex-1 overflow-y-auto p-4 ${leftTab === 'templates' ? 'block' : 'hidden'}`}>
        <p className="text-xs text-slate-400 dark:text-slate-500 mb-4 text-center leading-relaxed">
          Upload a blank structure, then apply a predefined library layout below to auto-populate furniture.
        </p>
        <div className="space-y-4">
          {homeTemplates?.map(template => (
            <div key={template.id} className="p-4 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 rounded-xl hover:border-indigo-300 transition-colors">
              <div className="flex items-center gap-2 mb-2">
                <Layout className="w-5 h-5 text-indigo-500" />
                <h3 className="font-bold text-sm text-slate-800 dark:text-white">{template.name}</h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">{template.description}</p>
              
              <div className="text-[10px] text-slate-400 mb-4 font-mono">
                Contains {template.items.length} assets
              </div>

              <button
                onClick={() => onApplyTemplate(template.id)}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition-colors shadow-sm cursor-pointer"
              >
                Apply Layout to Structure
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};