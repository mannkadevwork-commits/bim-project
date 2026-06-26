import { useState } from 'react';
import { PanelLeftClose, Loader2, Database } from 'lucide-react';

export const LeftPanel = ({ isOpen, onClose, treeRef, availableAssets, placementMode, setPlacementMode, resetSelection }) => {
  const [leftTab, setLeftTab] = useState('explorer');

  return (
    <div className={`flex flex-col h-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 transition-all duration-300 z-20 ${isOpen ? 'w-80' : 'w-0 overflow-hidden border-none'}`}>
        <div className="flex justify-between items-center px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
            <h2 className="font-bold text-slate-800 dark:text-white text-sm uppercase tracking-wider">Workspace</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400"><PanelLeftClose className="w-4 h-4"/></button>
        </div>
        
        <div className="flex border-b border-slate-200 dark:border-slate-800 shrink-0">
            <button onClick={() => setLeftTab('explorer')} className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${leftTab === 'explorer' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500 bg-indigo-50/50 dark:bg-indigo-900/20' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>Explorer</button>
            <button onClick={() => setLeftTab('assets')} className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${leftTab === 'assets' ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500 bg-indigo-50/50 dark:bg-indigo-900/20' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>BIM Assets</button>
        </div>
        
        <div className={`flex-1 overflow-y-auto ${leftTab === 'explorer' ? 'block' : 'hidden'}`}>
            <div ref={treeRef} className="p-4 text-sm text-slate-700 dark:text-slate-300" />
        </div>
        
        <div className={`flex-1 overflow-y-auto p-4 ${leftTab === 'assets' ? 'block' : 'hidden'}`}>
            {availableAssets.length === 0 ? (
                <div className="flex justify-center items-center h-full text-slate-400 text-sm"><Loader2 className="animate-spin w-4 h-4 mr-2"/> Loading...</div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {availableAssets.map(asset => (
                        <button 
                            key={asset.id} 
                            draggable={true}
                            onDragStart={(e) => {
                                // Package the asset data into the drag event
                                e.dataTransfer.setData('application/json', JSON.stringify(asset));
                            }}
                            onClick={() => { setPlacementMode(asset); resetSelection(); }} 
                            className={`flex flex-col items-center justify-center p-4 border rounded-xl transition-all group cursor-grab active:cursor-grabbing ${placementMode?.id === asset.id ? 'bg-indigo-50 border-indigo-500 dark:bg-indigo-900/30 dark:border-indigo-400 shadow-sm' : 'bg-slate-50 hover:bg-white dark:bg-slate-800/50 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-700'}`}
                        >
                            <div className="mb-2 text-slate-500 group-hover:text-indigo-500 transition-colors"><Database className="w-5 h-5"/></div>
                            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 text-center">{asset.name}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    </div>
  );
};