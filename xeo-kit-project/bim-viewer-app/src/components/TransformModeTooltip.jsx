import React from 'react';
import { Move, Rotate3D, Maximize2, Trash2, Palette, Unlock } from 'lucide-react';

const MODES = [
  { id: 'move', label: 'Move', Icon: Move },
  { id: 'rotate', label: 'Rotate', Icon: Rotate3D },
  { id: 'stretch', label: 'Stretch', Icon: Maximize2 },
];

const QUICK_COLORS = ['#FFFFFF', '#000000', '#E74C3C', '#3498DB', '#F5DEB3', '#7F8C8D'];

export const TransformModeTooltip = ({ 
  mode, onModeChange, assetName, x, y, onDelete, onColorChange, isNative, onIsolate 
}) => (
  <div 
    className="fixed z-[70] flex flex-col gap-2 p-2.5 rounded-2xl bg-slate-950/95 text-white border border-slate-700/70 shadow-2xl backdrop-blur-xl transition-all duration-200"
    style={{
      left: x ? `${x + 20}px` : '50%',
      top: y ? `${y - 40}px` : '20px',
      transform: x ? 'none' : 'translateX(-50%)'
    }}
  >
    {/* Header */}
    <div className="flex items-center gap-2 px-1">
      <div className="text-xs font-semibold text-slate-300 max-w-40 truncate" title={assetName}>
        {assetName}
      </div>
      {isNative && (
        <span className="text-[9px] bg-indigo-500/30 text-indigo-300 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
          Native
        </span>
      )}
    </div>
    
    <div className="w-full h-px bg-slate-700/50" />
    
    {/* Transform Modes */}
    <div className="flex items-center gap-1.5">
      {MODES.map(({ id, label, Icon }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (onModeChange) onModeChange(id);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors ${
              active ? 'bg-cyan-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        );
      })}
    </div>

    {/* Material Paint Row */}
    {onColorChange && (
      <div className="flex items-center gap-2.5 px-2 py-1">
        <Palette className="w-3.5 h-3.5 text-slate-400" />
        <div className="flex gap-2">
          {QUICK_COLORS.map(hex => (
            <button
              key={hex}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onColorChange(hex);
              }}
              className="w-5 h-5 rounded-full border border-slate-600 hover:scale-110 transition-transform shadow-sm"
              style={{ backgroundColor: hex }}
              title={`Apply ${hex}`}
            />
          ))}
          <input 
            type="color" 
            className="w-5 h-5 rounded cursor-pointer border-none bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch]:rounded-full" 
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onColorChange(e.target.value)}
            title="Custom Color"
          />
        </div>
      </div>
    )}

    <div className="w-full h-px bg-slate-700/50" />

    {/* Actions */}
    <div className="flex items-center justify-between gap-2">
      {isNative && onIsolate ? (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onIsolate();
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-indigo-400 hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors"
          title="Make this element fully independent for advanced editing"
        >
          <Unlock className="w-3.5 h-3.5" />
          Unlock Element
        </button>
      ) : <div className="flex-1" />}

      {onDelete && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-rose-400 hover:bg-rose-500/20 hover:text-rose-300 transition-colors ml-auto"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </button>
      )}
    </div>
  </div>
);