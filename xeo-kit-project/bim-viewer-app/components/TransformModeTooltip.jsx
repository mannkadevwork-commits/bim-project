import React, { useState } from 'react';
import { Move, RotateCw, Scaling, Unlock, MoreHorizontal, Trash2, Palette, ArrowRightLeft, Square, Box } from 'lucide-react';

const QUICK_COLORS = ['#FFFFFF', '#000000', '#E74C3C', '#3498DB', '#F5DEB3', '#7F8C8D'];

export const TransformModeTooltip = ({ 
  mode, onModeChange, assetName, x, y, onDelete, onColorChange, isNative, onIsolate 
}) => {
  const [showMore, setShowMore] = useState(false);
  
  // Track sub-mode for scaling to isolate meshes
  const [scaleMode, setScaleMode] = useState('stretch-1d'); 
  const isScaleActive = mode?.startsWith('stretch');

  const handleScaleClick = () => {
    if (isScaleActive) {
      // Toggle through the scale modes if clicking scale again
      const nextMode = scaleMode === 'stretch-1d' ? 'stretch-2d' : scaleMode === 'stretch-2d' ? 'stretch-3d' : 'stretch-1d';
      setScaleMode(nextMode);
      onModeChange(nextMode);
    } else {
      onModeChange(scaleMode);
    }
    setShowMore(false);
  };

  const handleModeClick = (newMode) => {
    onModeChange(newMode);
    setShowMore(false);
  };

  return (
    <div 
      className="fixed z-[70] flex flex-col items-center transition-all duration-200"
      style={{ 
        left: x ? `${x}px` : '50%', 
        top: y ? `${y - 85}px` : '20px', // Shifted up to accommodate the tooltip arrow
        transform: x ? 'translateX(-50%)' : 'translateX(-50%)' 
      }}
    >
      {/* Main Tooltip Bubble */}
      <div className="flex flex-col p-1.5 rounded-2xl bg-slate-900/95 border border-slate-700 shadow-2xl backdrop-blur-xl">
        
        {/* Header Row */}
        <div className="flex items-center justify-between gap-4 px-2.5 pt-1.5 pb-2">
          <div className="text-[11px] font-semibold text-slate-200 max-w-[160px] truncate" title={assetName}>
            {assetName || 'Selected Element'}
          </div>
          {isNative && (
            <span className="bg-indigo-600/90 text-white text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
              Native
            </span>
          )}
        </div>
        
        {/* Tool Row */}
        <div className="flex items-center gap-1">
          {/* MOVE */}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); if (!isNative) handleModeClick('move'); }}
            disabled={isNative}
            className={`relative flex items-center justify-center w-10 h-10 rounded-xl transition-all ${
              isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : mode === 'move' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50' : 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent'
            }`}
            title={isNative ? 'Unlock Element first' : 'Move (W)'}
          >
            <Move className="w-5 h-5" />
            {mode === 'move' && <span className="absolute -bottom-1 text-[8px] font-bold text-emerald-500">W</span>}
          </button>

          {/* ROTATE */}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); if (!isNative) handleModeClick('rotate'); }}
            disabled={isNative}
            className={`relative flex items-center justify-center w-10 h-10 rounded-xl transition-all ${
              isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : mode === 'rotate' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/50' : 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent'
            }`}
            title={isNative ? 'Unlock Element first' : 'Rotate (E)'}
          >
            <RotateCw className="w-5 h-5" />
            {mode === 'rotate' && <span className="absolute -bottom-1 text-[8px] font-bold text-blue-500">E</span>}
          </button>

          {/* SCALE / STRETCH */}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); if (!isNative) handleScaleClick(); }}
            disabled={isNative}
            className={`relative flex items-center justify-center w-10 h-10 rounded-xl transition-all ${
              isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : isScaleActive ? 'bg-amber-500/20 text-amber-400 border border-amber-500/50' : 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent'
            }`}
            title={isNative ? 'Unlock Element first' : 'Scale/Stretch (R)'}
          >
            <Scaling className="w-5 h-5" />
            {isScaleActive && <span className="absolute -bottom-1 text-[8px] font-bold text-amber-500">R</span>}
          </button>

          <div className="w-px h-6 bg-slate-700/80 mx-1" />

          {/* UNLOCK NATIVE */}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); if(onIsolate) onIsolate(); }}
            disabled={!isNative || !onIsolate}
            className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all ${
              !isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent'
            }`}
            title="Unlock Element (U)"
          >
            <Unlock className="w-4 h-4" />
          </button>

          {/* MORE OPTIONS */}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setShowMore(!showMore); }}
            className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all ${
              showMore ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent'
            }`}
            title="More Options"
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Tooltip Down Arrow */}
      <div className="w-3 h-3 bg-slate-900 border-b border-r border-slate-700 transform rotate-45 -mt-1.5 shadow-sm" />

      {/* SUB-MENU: Scale Modes (1D, 2D, 3D) */}
      {isScaleActive && !isNative && (
        <div className="absolute top-full mt-3 flex items-center gap-1 p-1 bg-slate-900 border border-slate-700 rounded-xl shadow-xl animate-in slide-in-from-top-2">
          <button 
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setScaleMode('stretch-1d'); onModeChange('stretch-1d'); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors ${scaleMode === 'stretch-1d' ? 'bg-amber-500/20 text-amber-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
          >
            <ArrowRightLeft className="w-3 h-3" /> 1-Axis
          </button>
          <button 
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setScaleMode('stretch-2d'); onModeChange('stretch-2d'); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors ${scaleMode === 'stretch-2d' ? 'bg-amber-500/20 text-amber-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
          >
            <Square className="w-3 h-3" /> 2-Axis
          </button>
          <button 
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setScaleMode('stretch-3d'); onModeChange('stretch-3d'); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors ${scaleMode === 'stretch-3d' ? 'bg-amber-500/20 text-amber-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
          >
            <Box className="w-3 h-3" /> 3-Axis
          </button>
        </div>
      )}

      {/* SUB-MENU: More Options */}
      {showMore && !isScaleActive && (
        <div className="absolute top-full mt-3 flex flex-col gap-2 p-3 bg-slate-900 border border-slate-700 rounded-xl shadow-xl animate-in slide-in-from-top-2 w-48">
          {/* Quick Colors */}
          {onColorChange && (
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Quick Paint</span>
              <div className="flex gap-2">
                {QUICK_COLORS.map(hex => (
                  <button
                    key={hex}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onColorChange(hex); setShowMore(false); }}
                    className="w-5 h-5 rounded-full border border-slate-600 hover:scale-110 transition-transform shadow-sm"
                    style={{ backgroundColor: hex }}
                  />
                ))}
                <div className="relative w-5 h-5 rounded-full border border-slate-600 hover:scale-110 transition-transform overflow-hidden cursor-pointer" title="Custom Color">
                  <Palette className="w-3 h-3 text-slate-400 absolute inset-0 m-auto pointer-events-none" />
                  <input 
                    type="color" 
                    className="w-8 h-8 -ml-2 -mt-2 cursor-pointer opacity-0"
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => { onColorChange(e.target.value); setShowMore(false); }}
                  />
                </div>
              </div>
            </div>
          )}
          
          <div className="w-full h-px bg-slate-800" />
          
          {/* Delete Action */}
          {onDelete && (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDelete(); setShowMore(false); }}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-semibold text-rose-400 hover:bg-rose-500/20 hover:text-rose-300 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete Element
            </button>
          )}
        </div>
      )}
    </div>
  );
};