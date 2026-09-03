import React, { useEffect, useRef, useState } from 'react';
import {
  MousePointer2,
  Ruler,
  Slice,
  Orbit,
  Camera,
  Crosshair,
  Box,
  Grid2X2,
  ScanSearch,
  Bookmark,
  Save,
  Trash2,
  X,
  RotateCcw,
  Footprints,
} from 'lucide-react';

const PRESETS = [
  ['Top', 'top'],
  ['Front', 'front'],
  ['Back', 'back'],
  ['Right', 'right'],
  ['Left', 'left'],
  ['Iso', 'iso'],
];

export const ViewportToolbar = ({
  isMeasuring,
  isClipping,
  onSelect,
  onMeasure,
  onClip,
  onFit,
  onFocus,
  onCameraPreset,
  onProjection,
  projection = 'perspective',
  navMode,
  onNavMode,
  transformMode,
  savedViews = [],
  onSaveView,
  onRestoreView,
  onDeleteView,
  onResetCamera,
  onSaveLayout,
}) => {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [showSavedViews, setShowSavedViews] = useState(false);
  const [viewName, setViewName] = useState('');
  const cameraRef = useRef(null);

  useEffect(() => {
    if (!cameraOpen) return undefined;
    const handlePointerDown = (event) => {
      if (!cameraRef.current?.contains(event.target)) {
        setCameraOpen(false);
        setShowSavedViews(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [cameraOpen]);

  const closeCamera = () => {
    setCameraOpen(false);
    setShowSavedViews(false);
    setViewName('');
  };

  const handleSaveView = () => {
    const trimmed = viewName.trim();
    const fallback = `View ${savedViews.length + 1}`;
    onSaveView?.(trimmed || fallback);
    setViewName('');
    setShowSavedViews(true);
  };

  const item = (active = false) => `flex items-center justify-center w-11 h-11 rounded-xl transition-all duration-200 ${active ? 'bg-[#ff914d] text-white shadow-lg shadow-[#ff914d]/25' : 'text-slate-400 hover:text-white hover:bg-white/8'}`;
  const modeItem = (active = false) => `flex h-10 min-w-[76px] items-center justify-center gap-2 rounded-xl px-3 text-[11px] font-bold transition-all ${active ? 'bg-[#ff914d] text-white shadow-md shadow-[#ff914d]/20' : 'text-slate-400 hover:bg-white/[0.07] hover:text-white'}`;
  const miniItem = (active = false) => `flex h-9 items-center justify-center gap-1.5 rounded-xl px-3 text-[10px] font-semibold transition-all ${active ? 'bg-[#ff914d]/15 text-[#ff914d]' : 'text-slate-400 hover:bg-white/[0.07] hover:text-white'}`;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
      <div className="flex items-center gap-1.5 rounded-2xl border border-slate-700/80 bg-[#0b1322]/96 px-3 py-2.5 shadow-[0_16px_45px_rgba(0,0,0,0.35)] backdrop-blur-2xl pointer-events-auto">
        <button className={item(transformMode === 'select')} onClick={onSelect} title="Select / Inspect · click an element in the scene" aria-label="Select / Inspect">
          <MousePointer2 className="h-4.5 w-4.5" />
        </button>

        <button
          className={item(navMode === 'firstPerson')}
          onClick={() => onNavMode?.(navMode === 'firstPerson' ? 'orbit' : 'firstPerson')}
          title={navMode === 'firstPerson' ? 'Walk mode · click to return to Orbit' : 'Orbit mode · click to enter Walk'}
          aria-label={navMode === 'firstPerson' ? 'Walk mode' : 'Orbit mode'}
        >
          {navMode === 'firstPerson' ? <Footprints className="h-4.5 w-4.5" /> : <Orbit className="h-4.5 w-4.5" />}
        </button>

        <div ref={cameraRef} className="relative flex items-center">
          <button
            className={item(cameraOpen)}
            onClick={() => setCameraOpen((value) => !value)}
            title="Camera"
            aria-label="Camera"
            aria-expanded={cameraOpen}
          >
            <Camera className="h-4.5 w-4.5" />
          </button>

          {cameraOpen && (
            <div className="absolute left-1/2 top-[56px] flex min-w-[640px] -translate-x-[27%] items-center gap-1.5 rounded-2xl border border-slate-700/90 bg-[#0b1322]/98 p-2.5 shadow-2xl backdrop-blur-2xl">
              <div className="flex items-center gap-1 pr-1">
                {PRESETS.map(([label, value]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { onCameraPreset?.(value); closeCamera(); }}
                    className="h-10 min-w-[52px] rounded-xl px-2.5 text-[11px] font-semibold text-slate-300 transition hover:bg-white/[0.07] hover:text-white"
                    title={`${label} view`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="h-8 w-px bg-slate-700/80" />

              <button type="button" onClick={() => { onFocus?.(); closeCamera(); }} className={miniItem(false)} title="Focus selected">
                <Crosshair className="h-3.5 w-3.5 text-[#ff914d]" />
                Focus
              </button>
              <button type="button" onClick={() => { onFit?.(); closeCamera(); }} className={miniItem(false)} title="Frame model">
                <ScanSearch className="h-3.5 w-3.5 text-[#ff914d]" />
                Fit
              </button>
              <button type="button" onClick={() => { onResetCamera?.(); closeCamera(); }} className={miniItem(false)} title="Reset camera">
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </button>

              <div className="h-8 w-px bg-slate-700/80" />

              <button
                type="button"
                onClick={() => setShowSavedViews((value) => !value)}
                className={miniItem(showSavedViews)}
                title="Saved camera views"
              >
                <Bookmark className="h-3.5 w-3.5" />
                Views
              </button>

              {showSavedViews && (
                <div className="absolute right-0 top-12 w-[290px] rounded-2xl border border-slate-700/90 bg-[#0b1322]/98 p-2 shadow-2xl backdrop-blur-2xl">
                  <div className="flex items-center justify-between px-1 pb-2">
                    <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Saved views</span>
                    <button type="button" onClick={() => setShowSavedViews(false)} className="rounded-md p-1 text-slate-500 hover:bg-white/5 hover:text-white" aria-label="Close saved views">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <input
                      value={viewName}
                      onChange={(event) => setViewName(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') handleSaveView(); }}
                      placeholder="Name this view..."
                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900/70 px-2.5 py-2 text-[11px] text-white outline-none placeholder:text-slate-600 focus:border-[#ff914d]/70"
                    />
                    <button type="button" onClick={handleSaveView} className="rounded-lg bg-[#ff914d] p-2 text-white shadow-md shadow-[#ff914d]/20 hover:bg-[#ff7a28]" title="Save current camera">
                      <Save className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {savedViews.length > 0 ? (
                    <div className="mt-2 max-h-[180px] space-y-1 overflow-y-auto pr-0.5">
                      {savedViews.map((view) => (
                        <div key={view.id} className="group flex items-center gap-1 rounded-lg border border-transparent hover:border-slate-700 hover:bg-white/[0.035]">
                          <button type="button" onClick={() => { onRestoreView?.(view.id); closeCamera(); }} className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[11px] font-semibold text-slate-300 hover:text-white" title={`Restore ${view.name}`}>
                            {view.name}
                          </button>
                          <button type="button" onClick={() => onDeleteView?.(view.id)} className="mr-1 rounded-md p-1.5 text-slate-600 opacity-0 transition group-hover:opacity-100 hover:bg-rose-500/10 hover:text-rose-400" title={`Delete ${view.name}`} aria-label={`Delete ${view.name}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-2 py-4 text-center text-[10px] leading-5 text-slate-600">Save a camera angle to bring it back instantly.</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mx-0.5 h-8 w-px bg-slate-700/80" />

        <button
          type="button"
          onClick={onSaveLayout}
          className="flex h-10 items-center justify-center gap-2 rounded-xl bg-[#ff914d] px-3 text-[11px] font-bold text-white shadow-md shadow-[#ff914d]/20 transition hover:bg-[#ff7a28]"
          title="Save current design as a reusable layout"
          aria-label="Save current design as a reusable layout"
        >
          <Save className="h-4 w-4" />
          <span>Save Layout</span>
        </button>

        <div className="mx-0.5 h-8 w-px bg-slate-700/80" />

        <button
          type="button"
          className={modeItem(projection === 'perspective')}
          onClick={() => { onProjection?.('perspective'); closeCamera(); }}
          title="Perspective projection"
          aria-label="Perspective projection"
        >
          <Box className="h-4 w-4" />
          <span>Persp</span>
        </button>

        <button
          type="button"
          className={modeItem(projection === 'ortho')}
          onClick={() => { onProjection?.('ortho'); closeCamera(); }}
          title="Orthographic projection"
          aria-label="Orthographic projection"
        >
          <Grid2X2 className="h-4 w-4" />
          <span>Ortho</span>
        </button>

        <div className="mx-0.5 h-8 w-px bg-slate-700/80" />

        <button className={item(isMeasuring)} onClick={onMeasure} title="Measure" aria-label="Measure">
          <Ruler className="h-4.5 w-4.5" />
        </button>
        <button className={item(isClipping)} onClick={onClip} title="Section / Clip" aria-label="Section / Clip">
          <Slice className="h-4.5 w-4.5" />
        </button>

      </div>

    </div>
  );
};
