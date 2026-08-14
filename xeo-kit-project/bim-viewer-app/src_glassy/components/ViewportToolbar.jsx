import React from 'react';
import {
  MousePointer2,
  Ruler,
  Slice,
  Maximize2,
  Minimize2,
  ScanSearch,
  Orbit,
} from 'lucide-react';

export const ViewportToolbar = ({
  isMeasuring,
  isClipping,
  isMaxView,
  isFullscreen,
  onSelect,
  onMeasure,
  onClip,
  onMaxView,
  onFullscreen,
  onFit,
  navMode,
  onNavMode,
}) => {
  const item = (active = false) => `flex items-center justify-center w-9 h-9 rounded-xl transition-all ${active ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-400 hover:text-white hover:bg-white/8'}`;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
      <div className="flex items-center gap-1 px-2 py-2 rounded-2xl bg-[#0b1322]/92 border border-slate-700/80 shadow-[0_16px_45px_rgba(0,0,0,0.35)] backdrop-blur-2xl pointer-events-auto">
        <button className={item(!isMeasuring && !isClipping)} onClick={onSelect} title="Select · V">
          <MousePointer2 className="w-4.5 h-4.5" />
        </button>
        <button className={item(navMode === 'orbit')} onClick={() => onNavMode('orbit')} title="Orbit View">
          <Orbit className="w-4.5 h-4.5" />
        </button>
        <button className={item(isMeasuring)} onClick={onMeasure} title="Measure">
          <Ruler className="w-4.5 h-4.5" />
        </button>
        <button className={item(isClipping)} onClick={onClip} title="Section / Clip">
          <Slice className="w-4.5 h-4.5" />
        </button>
        <button className={item(false)} onClick={onFit} title="Fit View">
          <ScanSearch className="w-4.5 h-4.5" />
        </button>
        <div className="w-px h-6 bg-slate-700/80 mx-1" />
        <button className={item(isMaxView)} onClick={onMaxView} title={isMaxView ? 'Show Panels' : 'Max View'}>
          {isMaxView ? <Minimize2 className="w-4.5 h-4.5" /> : <Maximize2 className="w-4.5 h-4.5" />}
        </button>
        <button className={item(isFullscreen)} onClick={onFullscreen} title="Browser Fullscreen">
          <Maximize2 className="w-4.5 h-4.5" />
        </button>
      </div>
    </div>
  );
};
