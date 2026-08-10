import React from 'react';
import { Move, Rotate3D, Maximize2 } from 'lucide-react';

const MODES = [
  { id: 'move', label: 'Move', Icon: Move },
  { id: 'rotate', label: 'Rotate', Icon: Rotate3D },
  { id: 'stretch', label: 'Stretch', Icon: Maximize2 },
];

export const TransformModeTooltip = ({ mode, onModeChange, assetName }) => (
  <div className="absolute top-5 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-1.5 px-2 py-2 rounded-2xl bg-slate-950/95 text-white border border-slate-700/70 shadow-2xl backdrop-blur-xl">
    <div className="px-2 text-xs font-semibold text-slate-300 max-w-36 truncate" title={assetName}>
      {assetName}
    </div>
    <div className="w-px h-6 bg-slate-700" />
    {MODES.map(({ id, label, Icon }) => {
      const active = mode === id;
      return (
        <button
          key={id}
          type="button"
          onClick={() => onModeChange(id)}
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
);
