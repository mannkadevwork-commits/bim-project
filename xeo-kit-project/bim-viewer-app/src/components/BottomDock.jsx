import { Plus, Camera, Expand, Shrink, Minimize, Maximize, Trash2 } from 'lucide-react';

export const BottomDock = ({ onAdd, onDelete, onRenderClick, toggleMaxView, isMaxView, isFullscreen, toggleBrowserFullscreen }) => {
  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 p-2 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl">
        <button onClick={onAdd} className="p-2.5 rounded-xl text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 dark:text-slate-400 dark:hover:bg-slate-800 transition-colors" title="Upload New File">
            <Plus className="w-5 h-5" />
        </button>

        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1"></div>
        
        <button onClick={onRenderClick} className="p-2.5 rounded-xl text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors" title="Cloud Render Studio">
            <Camera className="w-5 h-5" />
        </button>

        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1"></div>

        <button onClick={toggleMaxView} className={`p-2.5 rounded-xl transition-colors ${isMaxView ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`} title={isMaxView ? "Show Side Panels" : "Max View (Hide Panels)"}>
            {isMaxView ? <Shrink className="w-5 h-5" /> : <Expand className="w-5 h-5" />}
        </button>
        
        <button onClick={toggleBrowserFullscreen} className="p-2.5 rounded-xl text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 transition-colors" title="Browser Fullscreen">
            {isFullscreen ? <Minimize className="w-5 h-5"/> : <Maximize className="w-5 h-5"/>}
        </button>

        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1"></div>

        <button onClick={onDelete} className="p-2.5 rounded-xl text-slate-600 hover:text-rose-500 hover:bg-rose-50 dark:text-slate-400 dark:hover:bg-rose-500/10 transition-colors" title="Delete Model">
            <Trash2 className="w-5 h-5" />
        </button>
    </div>
  );
};