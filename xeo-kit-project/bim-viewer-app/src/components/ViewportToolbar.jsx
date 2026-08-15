import React, { useState } from 'react';
import {
  MousePointer2,
  Ruler,
  Slice,
  Maximize2,
  Minimize2,
  ScanSearch,
  Orbit,
  Camera,
  Crosshair,
  Box,
  Grid2X2,
} from 'lucide-react';

const PRESETS = [
  ['Top', 'top'],
  ['Front', 'front'],
  ['Back', 'back'],
  ['Right', 'right'],
  ['Left', 'left'],
  ['Isometric', 'iso'],
];

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
  onFocus,
  onCameraPreset,
  onProjection,
  projection = 'perspective',
  navMode,
  onNavMode,
}) => {
  const [cameraOpen, setCameraOpen] = useState(false);

  const item = (active = false) => `flex items-center justify-center w-9 h-9 rounded-xl transition-all ${active ? 'bg-[#ff914d] text-white shadow-lg shadow-[#ff914d]/25' : 'text-slate-400 hover:text-white hover:bg-white/8'}`;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
      <div className="flex items-center gap-1 px-2 py-2 rounded-2xl bg-[#0b1322]/94 border border-slate-700/80 shadow-[0_16px_45px_rgba(0,0,0,0.35)] backdrop-blur-2xl pointer-events-auto">
        <button className={item(!isMeasuring && !isClipping)} onClick={onSelect} title="Select · V">
          <MousePointer2 className="w-4.5 h-4.5" />
        </button>

        <button className={item(navMode === 'orbit')} onClick={() => onNavMode('orbit')} title="Orbit camera">
          <Orbit className="w-4.5 h-4.5" />
        </button>

        <div className="relative">
          <button
            className={item(cameraOpen)}
            onClick={() => setCameraOpen((v) => !v)}
            title="Camera views and framing"
            aria-label="Camera views and framing"
          >
            <Camera className="w-4.5 h-4.5" />
          </button>

          {cameraOpen && (
            <div className="absolute top-11 left-1/2 -translate-x-1/2 w-[220px] rounded-2xl border border-slate-700/90 bg-[#0b1322]/97 p-2 shadow-2xl backdrop-blur-2xl">
              <div className="px-2 pb-2 pt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Camera</div>
              <div className="grid grid-cols-3 gap-1">
                {PRESETS.map(([label, value]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { onCameraPreset?.(value); setCameraOpen(false); }}
                    className="rounded-xl px-2 py-2 text-[11px] font-semibold text-slate-300 transition hover:bg-white/[0.07] hover:text-white"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="my-2 h-px bg-slate-800" />
              <button type="button" onClick={() => onFocus?.()} className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 text-xs font-semibold text-slate-200 hover:bg-white/[0.07]">
                <Crosshair className="h-3.5 w-3.5 text-[#ff914d]" />
                Focus selected
              </button>
              <button type="button" onClick={() => onFit?.()} className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 text-xs font-semibold text-slate-200 hover:bg-white/[0.07]">
                <ScanSearch className="h-3.5 w-3.5 text-[#ff914d]" />
                Frame model
              </button>
              <div className="my-2 h-px bg-slate-800" />
              <div className="grid grid-cols-2 gap-1">
                <button type="button" onClick={() => onProjection?.('perspective')} className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-[11px] font-semibold ${projection === 'perspective' ? 'bg-[#ff914d]/15 text-[#ff914d]' : 'text-slate-400 hover:bg-white/[0.07] hover:text-white'}`}>
                  <Box className="h-3.5 w-3.5" /> Perspective
                </button>
                <button type="button" onClick={() => onProjection?.('ortho')} className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-[11px] font-semibold ${projection === 'ortho' ? 'bg-[#ff914d]/15 text-[#ff914d]' : 'text-slate-400 hover:bg-white/[0.07] hover:text-white'}`}>
                  <Grid2X2 className="h-3.5 w-3.5" /> Orthographic
                </button>
              </div>
            </div>
          )}
        </div>

        <button className={item(isMeasuring)} onClick={onMeasure} title="Measure">
          <Ruler className="w-4.5 h-4.5" />
        </button>
        <button className={item(isClipping)} onClick={onClip} title="Section / Clip">
          <Slice className="w-4.5 h-4.5" />
        </button>

        <div className="w-px h-6 bg-slate-700/80 mx-1" />

        {/* <button className={item(false)} onClick={onMaxView} title={isMaxView ? 'Show panels' : 'Maximize workspace'}>
          {isMaxView ? <Minimize2 className="w-4.5 h-4.5" /> : <Maximize2 className="w-4.5 h-4.5" />}
        </button>
        <button className={item(isFullscreen)} onClick={onFullscreen} title="Browser fullscreen">
          {isFullscreen ? <Minimize2 className="w-4.5 h-4.5" /> : <Maximize2 className="w-4.5 h-4.5" />}
        </button> */}
      </div>
    </div>
  );
};
