import React from 'react';
import { 
  Move, 
  RotateCw, 
  Scaling, 
  Unlock, 
  Trash2, 
  Palette, 
  ArrowRightLeft, 
  Square, 
  Box 
} from 'lucide-react';

const QUICK_COLORS = ['#FFFFFF', '#000000', '#E74C3C', '#3498DB', '#F5DEB3', '#7F8C8D'];

export const TransformModeTooltip = ({
  mode,
  onModeChange,
  assetName,
  onDelete,
  onColorChange,
  isNative,
  onIsolate,
}) => {
  // Determine base mode for highlighting
  const baseMode = mode?.startsWith('stretch') ? 'stretch' : mode;

  // Cycle through scale modes on repeated clicks
  const handleScaleClick = () => {
    if (baseMode === 'stretch') {
      const nextMode = mode === 'stretch-1d' ? 'stretch-2d' : mode === 'stretch-2d' ? 'stretch-3d' : 'stretch-1d';
      onModeChange(nextMode);
    } else {
      onModeChange('stretch-1d');
    }
  };

  const getStretchIcon = () => {
    if (mode === 'stretch-2d') return <Square className="w-4 h-4" />;
    if (mode === 'stretch-3d') return <Box className="w-4 h-4" />;
    return <ArrowRightLeft className="w-4 h-4" />;
  };

  return (
    <div 
      className="fixed top-6 left-1/2 -translate-x-1/2 z-[70] flex items-center h-14 rounded-2xl bg-slate-950/95 border border-slate-700/80 shadow-2xl backdrop-blur-xl animate-in slide-in-from-top-4 fade-in duration-300"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Asset Name Section */}
      <div className="flex flex-col justify-center px-5 h-full border-r border-slate-800">
        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">
          {isNative ? 'Native Element' : 'Placed Asset'}
        </span>
        <span className="text-xs font-semibold text-slate-200 max-w-[160px] truncate" title={assetName}>
          {assetName || 'Selected Element'}
        </span>
      </div>

      {/* Primary Transform Tools */}
      <div className="flex items-center gap-2 px-3 h-full border-r border-slate-800">
        <ToolButton
          active={baseMode === 'move'}
          onClick={() => onModeChange('move')}
          icon={<Move className="w-4 h-4" />}
          label="Move"
          shortcut="W"
          activeStyles="bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
        />
        <ToolButton
          active={baseMode === 'rotate'}
          onClick={() => onModeChange('rotate')}
          icon={<RotateCw className="w-4 h-4" />}
          label="Rotate"
          shortcut="E"
          activeStyles="bg-blue-500/20 text-blue-400 border-blue-500/40"
        />
        
        {/* Scale Button (Cycles 1D -> 2D -> 3D) */}
        <div className="relative">
          <ToolButton
            active={baseMode === 'stretch'}
            onClick={handleScaleClick}
            icon={baseMode === 'stretch' ? getStretchIcon() : <Scaling className="w-4 h-4" />}
            label="Scale (Click to cycle axis)"
            shortcut="R"
            activeStyles="bg-amber-500/20 text-amber-400 border-amber-500/40"
          />
          {baseMode === 'stretch' && (
            <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center w-4 h-4 bg-amber-500 text-slate-900 rounded-full text-[8px] font-bold shadow-md pointer-events-none">
              {mode === 'stretch-3d' ? '3D' : mode === 'stretch-2d' ? '2D' : '1D'}
            </span>
          )}
        </div>
      </div>

      {/* Quick Material Paint */}
      {onColorChange && (
        <div className="flex items-center gap-2.5 px-4 h-full border-r border-slate-800">
          {QUICK_COLORS.map((hex) => (
            <button
              key={hex}
              onClick={() => onColorChange(hex)}
              className="w-5 h-5 rounded-full border border-slate-500 shadow-sm transition-transform hover:scale-110"
              style={{ backgroundColor: hex }}
              title={`Apply ${hex}`}
            />
          ))}
          <div className="relative flex items-center justify-center w-5 h-5 rounded-full border border-slate-500 bg-slate-800 overflow-hidden cursor-pointer hover:scale-110 transition-transform" title="Custom Color">
            <Palette className="w-3 h-3 text-slate-400 pointer-events-none" />
            <input
              type="color"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              onChange={(e) => onColorChange(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Utility Actions */}
      <div className="flex items-center gap-2 px-3 h-full">
        {isNative && onIsolate && (
          <button
            onClick={onIsolate}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold text-indigo-400 hover:bg-indigo-500/20 transition-colors"
            title="Unlock Element for advanced editing"
          >
            <Unlock className="w-3.5 h-3.5" /> Unlock
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold text-rose-400 hover:bg-rose-500/20 transition-colors"
            title="Delete Element"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        )}
      </div>
    </div>
  );
};

// Sub-component for clean rendering
const ToolButton = ({ active, onClick, icon, activeStyles, label, shortcut }) => (
  <button
    onClick={onClick}
    className={`relative flex items-center justify-center w-10 h-10 rounded-xl border transition-all ${
      active ? activeStyles : 'border-transparent text-slate-400 hover:bg-slate-800 hover:text-slate-200'
    }`}
    title={label}
  >
    {icon}
    {active && shortcut && (
      <span className="absolute -bottom-0.5 text-[8px] font-bold opacity-80">
        {shortcut}
      </span>
    )}
  </button>
);