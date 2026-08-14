import { Move, Settings2, Trash2, Box } from 'lucide-react';

export const AssetContextMenu = ({ 
  selectedObject, 
  activeAsset, 
  setIsRightPanelOpen, 
  setRightTab, 
  deleteSelectedAsset 
}) => {
  if (!selectedObject && !activeAsset) return null;

  return (
    <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 p-1.5 bg-slate-900/95 backdrop-blur-xl border border-slate-700/50 shadow-2xl rounded-2xl animate-in slide-in-from-bottom-4 fade-in zoom-in-95 duration-200">
      
      <div className="px-3 py-1.5 flex items-center gap-2 border-r border-slate-700/50">
        <Box className="w-4 h-4 text-indigo-400" />
        <span className="text-xs font-bold text-white max-w-[120px] truncate">
          {activeAsset ? activeAsset.name : selectedObject.name}
        </span>
      </div>

      {activeAsset && (
        <div className="px-2 py-1 flex items-center gap-2 border-r border-slate-700/50 text-xs font-medium text-slate-300">
          <Move className="w-3.5 h-3.5 text-cyan-400" />
          Drag center pad to move
        </div>
      )}

      <button 
        onClick={() => {
          setIsRightPanelOpen(true);
          setRightTab('properties');
        }}
        className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
      >
        <Settings2 className="w-4 h-4" /> Properties
      </button>

      {activeAsset && (
        <button 
          onClick={deleteSelectedAsset}
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-rose-400 hover:text-white hover:bg-rose-500/20 transition-colors"
        >
          <Trash2 className="w-4 h-4" /> Delete
        </button>
      )}

    </div>
  );
};