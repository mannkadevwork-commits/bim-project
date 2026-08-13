import React, { useState } from 'react';
import { Move, Rotate3D, Maximize2, Unlock, MoreHorizontal, Trash2, Palette } from 'lucide-react';

export const ViewportHUD = ({
  engineState,
  engineActions,
  activeAsset,
  selectedObject,
  onColorChange,
  onDelete,
  onIsolate,
  placementPos,
}) => {
  const [showMore, setShowMore] = useState(false);

  // 1. Placement Mode (Show XYZ while dropping furniture)
  if (engineState.placementMode && placementPos) {
    return (
      <div className="fixed top-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center gap-4 px-5 py-2.5 bg-slate-900/90 backdrop-blur-xl border border-slate-700/50 shadow-2xl rounded-full text-slate-100 font-mono text-sm animate-in slide-in-from-top-4 fade-in">
        <span className="flex items-center gap-2 font-bold text-indigo-400 uppercase tracking-widest text-[11px]">
          <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" /> Placing
        </span>
        <div className="flex gap-3">
          <span><span className="text-rose-400">X:</span> {placementPos[0].toFixed(3)}</span>
          <span><span className="text-emerald-400">Y:</span> {placementPos[1].toFixed(3)}</span>
          <span><span className="text-blue-400">Z:</span> {placementPos[2].toFixed(3)}</span>
        </div>
      </div>
    );
  }

  // 2. Active Transformation (Show data while user is actively dragging a gizmo handle)
  if (engineState.isStretching && engineState.activeStretchData) {
    const d = engineState.activeStretchData;
    return (
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center gap-4 px-6 py-3 bg-slate-900/90 backdrop-blur-xl border border-slate-700/50 shadow-2xl rounded-full text-slate-100 font-mono text-sm animate-in slide-in-from-bottom-4 fade-in">
        <span className="flex items-center gap-2 font-bold text-cyan-400 uppercase tracking-widest text-[11px]">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" /> {d.label}
        </span>
        {d.label === 'MOVE' && (
          <div className="flex gap-4">
            <span><span className="text-rose-400">X:</span> {d.x?.toFixed(3)}</span>
            <span><span className="text-emerald-400">Y:</span> {d.y?.toFixed(3)}</span>
            <span><span className="text-blue-400">Z:</span> {d.z?.toFixed(3)}</span>
          </div>
        )}
        {d.label === 'ROTATE' && (
          <div className="flex gap-4">
            <span><span className="text-cyan-400">Angle:</span> {d.deg?.toFixed(1)}°</span>
          </div>
        )}
        {d.label === 'SCALE' && (
          <div className="flex gap-4">
            <span><span className="text-rose-400">W:</span> {d.w?.toFixed(2)}</span>
            <span><span className="text-emerald-400">H:</span> {d.h?.toFixed(2)}</span>
            <span><span className="text-blue-400">D:</span> {d.d?.toFixed(2)}</span>
          </div>
        )}
      </div>
    );
  }

  // 3. Contextual Toolbar (Show near the object when selected)
  const isNative = !!selectedObject && !activeAsset;
  const isSelected = !!selectedObject || !!activeAsset;

  if (isSelected && engineState.selectionScreenPos) {
    // Keep the toolbar inside the visible screen bounds (leaving room for side panels)
    const SAFE_X_MAX = window.innerWidth - 380; // Right panel width margin
    const SAFE_Y_MAX = window.innerHeight - 150; // Bottom dock margin
    const x = Math.min(Math.max(20, engineState.selectionScreenPos.x + 30), SAFE_X_MAX);
    const y = Math.min(Math.max(80, engineState.selectionScreenPos.y - 60), SAFE_Y_MAX);

    return (
      <div
        className="fixed z-40 flex flex-col gap-2 p-2 rounded-2xl bg-slate-900/90 backdrop-blur-xl border border-slate-700/50 shadow-2xl pointer-events-auto transition-transform duration-75"
        style={{ left: x, top: y }}
      >
        <div className="flex items-center justify-between gap-3 px-2 pt-1 pb-1">
          <span className="text-xs font-bold text-white truncate max-w-[140px]" title={selectedObject?.name || activeAsset?.name}>
            {selectedObject?.name || activeAsset?.name || 'Asset'}
          </span>
          {isNative && (
            <span className="bg-indigo-500/30 text-indigo-300 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
              Native
            </span>
          )}
        </div>
        
        <div className="w-full h-px bg-slate-700/50" />

        <div className="flex items-center gap-1.5">
          <ToolbarButton active={engineState.transformMode === 'move'} icon={<Move />} onClick={() => engineActions.setTransformMode('move')} title="Move" />
          <ToolbarButton active={engineState.transformMode === 'rotate'} icon={<Rotate3D />} onClick={() => engineActions.setTransformMode('rotate')} title="Rotate" />
          <ToolbarButton active={engineState.transformMode === 'stretch'} icon={<Maximize2 />} onClick={() => engineActions.setTransformMode('stretch')} title="Scale" />
          
          <div className="w-px h-5 bg-slate-700/50 mx-1" />
          
          {isNative && onIsolate && (
            <ToolbarButton icon={<Unlock />} onClick={onIsolate} title="Unlock Element" />
          )}

          <div className="relative">
            <ToolbarButton active={showMore} icon={<MoreHorizontal />} onClick={() => setShowMore(!showMore)} title="More Options" />
            {showMore && (
              <div className="absolute top-full mt-3 right-0 flex gap-1 p-1.5 bg-slate-900 border border-slate-700 rounded-xl shadow-xl animate-in slide-in-from-top-2">
                <button
                  className="p-2 rounded-lg text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                  onClick={() => {
                    const el = document.getElementById('context-color-picker');
                    if (el) el.click();
                  }}
                  title="Color / Material"
                >
                  <Palette className="w-4 h-4" />
                  <input
                    id="context-color-picker"
                    type="color"
                    className="absolute opacity-0 pointer-events-none w-0 h-0"
                    onChange={(e) => {
                      if (onColorChange) onColorChange(e.target.value);
                      setShowMore(false);
                    }}
                  />
                </button>
                <button
                  className="p-2 rounded-lg text-rose-400 hover:bg-rose-500/20 hover:text-rose-300 transition-colors"
                  onClick={() => {
                    if (onDelete) onDelete();
                    setShowMore(false);
                  }}
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
};

const ToolbarButton = ({ active, icon, onClick, title }) => (
  <button
    onPointerDown={(e) => e.stopPropagation()}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    className={`p-2 rounded-xl transition-colors ${
      active ? 'bg-cyan-500 text-slate-900 shadow-md' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
    }`}
    title={title}
  >
    {React.cloneElement(icon, { className: 'w-4 h-4' })}
  </button>
);