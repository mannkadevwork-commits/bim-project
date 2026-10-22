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
  Undo2,
  Redo2,
  Footprints,
} from 'lucide-react';

const PRESETS = [
  ['Top', 'top'],
  ['Front', 'front'],
  ['Back', 'back'],
  ['Right', 'right'],
  ['Left', 'left'],
  ['3D angle', 'iso'],
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
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  isDarkMode = true,
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

  const shell = isDarkMode
    ? 'border-slate-700/80 bg-[#0b1322]/94 text-slate-100 shadow-[0_14px_38px_rgba(0,0,0,0.30)]'
    : 'border-slate-200/90 bg-white/94 text-slate-800 shadow-[0_12px_32px_rgba(15,23,42,0.16)]';
  const idleButton = isDarkMode
    ? 'text-slate-300 hover:bg-white/[0.08] hover:text-white'
    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950';
  const divider = isDarkMode ? 'bg-slate-700/80' : 'bg-slate-200';
  const popup = isDarkMode
    ? 'border-slate-700/90 bg-[#0b1322]/98 text-slate-100 shadow-black/30'
    : 'border-slate-200 bg-white/98 text-slate-800 shadow-slate-900/15';
  const popupMuted = isDarkMode ? 'text-slate-400' : 'text-slate-500';
  const item = (active = false) => `inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-2.5 transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff914d] ${active ? 'bg-[#ff914d] text-white shadow-md shadow-[#ff914d]/25' : idleButton}`;
  const modeItem = (active = false) => `inline-flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3 text-[11px] font-semibold transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff914d] ${active ? 'bg-[#ff914d] text-white shadow-md shadow-[#ff914d]/20' : idleButton}`;
  const miniItem = (active = false) => `flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-[10px] font-semibold transition-all ${active ? (isDarkMode ? 'bg-[#ff914d]/15 text-[#ff914d]' : 'bg-orange-50 text-[#c85b1f]') : idleButton}`;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
      <div className={`flex max-w-[calc(100vw-1.5rem)] flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain rounded-2xl border px-2 py-2 backdrop-blur-2xl pointer-events-auto ${shell}`}>
        <button type="button" className={item(transformMode === 'select')} onClick={onSelect} title="Select an object to inspect or edit it" aria-label="Select an object">
          <MousePointer2 className="h-4.5 w-4.5" />
          <span className="hidden 2xl:inline text-[11px] font-semibold">Select</span>
        </button>

        <button
          className={item(navMode === 'firstPerson')}
          onClick={() => onNavMode?.(navMode === 'firstPerson' ? 'orbit' : 'firstPerson')}
          title={navMode === 'firstPerson' ? 'Switch to orbit controls to inspect the model from outside' : 'Walk through the rooms at eye level'}
          aria-label={navMode === 'firstPerson' ? 'Switch to orbit controls' : 'Walk through the model'}
        >
          {navMode === 'firstPerson' ? <Footprints className="h-4.5 w-4.5" /> : <Orbit className="h-4.5 w-4.5" />}
          <span className="hidden 2xl:inline text-[11px] font-semibold">{navMode === 'firstPerson' ? 'Orbit' : 'Walk'}</span>
        </button>

        <div ref={cameraRef} className="relative flex items-center">
          <button
            className={item(cameraOpen)}
            onClick={() => setCameraOpen((value) => !value)}
            title="Choose a view, focus the selection or save a viewpoint"
            aria-label="Camera and viewpoints"
            aria-expanded={cameraOpen}
          >
            <Camera className="h-4.5 w-4.5" />
          </button>

          {cameraOpen && (
            <div className={`absolute left-1/2 top-[52px] flex max-w-[calc(100vw-2rem)] -translate-x-[27%] flex-wrap items-center gap-1.5 rounded-2xl border p-2.5 shadow-2xl backdrop-blur-2xl ${popup}`}>
              <div className="flex items-center gap-1 pr-1">
                {PRESETS.map(([label, value]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { onCameraPreset?.(value); closeCamera(); }}
                    className={`h-10 min-w-[52px] rounded-xl px-2.5 text-[11px] font-semibold transition ${idleButton}`}
                    title={`${label} view`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className={`h-8 w-px ${divider}`} />

              <button type="button" onClick={() => { onFocus?.(); closeCamera(); }} className={miniItem(false)} title="Bring the selected item into view">
                <Crosshair className="h-3.5 w-3.5 text-[#ff914d]" />
                Focus item
              </button>
              <button type="button" onClick={() => { onFit?.(); closeCamera(); }} className={miniItem(false)} title="Show the whole building">
                <ScanSearch className="h-3.5 w-3.5 text-[#ff914d]" />
                Whole model
              </button>
              <button type="button" onClick={() => { onResetCamera?.(); closeCamera(); }} className={miniItem(false)} title="Return to the starting view">
                <RotateCcw className="h-3.5 w-3.5" />
                Reset view
              </button>

              <div className={`h-8 w-px ${divider}`} />

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
                <div className={`absolute right-0 top-12 w-[290px] rounded-2xl border p-2 shadow-2xl backdrop-blur-2xl ${popup}`}>
                  <div className="flex items-center justify-between px-1 pb-2">
                    <span className={`text-[10px] font-bold uppercase tracking-[0.18em] ${popupMuted}`}>Saved views</span>
                    <button type="button" onClick={() => setShowSavedViews(false)} className={`rounded-md p-1 transition ${isDarkMode ? 'text-slate-400 hover:bg-white/10 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`} aria-label="Close saved views">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <input
                      value={viewName}
                      onChange={(event) => setViewName(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') handleSaveView(); }}
                      placeholder="Name this viewpoint…"
                      className={`min-w-0 flex-1 rounded-lg border px-2.5 py-2 text-[11px] outline-none focus:border-[#ff914d]/70 ${isDarkMode ? 'border-slate-700 bg-slate-900/70 text-white placeholder:text-slate-600' : 'border-slate-200 bg-slate-50 text-slate-900 placeholder:text-slate-400'}`}
                    />
                    <button type="button" onClick={handleSaveView} className="rounded-lg bg-[#ff914d] p-2 text-white shadow-md shadow-[#ff914d]/20 hover:bg-[#ff7a28]" title="Save this viewpoint for later">
                      <Save className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {savedViews.length > 0 ? (
                    <div className="mt-2 max-h-[180px] space-y-1 overflow-y-auto pr-0.5">
                      {savedViews.map((view) => (
                        <div key={view.id} className={`group flex items-center gap-1 rounded-lg border border-transparent ${isDarkMode ? 'hover:border-slate-700 hover:bg-white/[0.035]' : 'hover:border-slate-200 hover:bg-slate-50'}`}>
                          <button type="button" onClick={() => { onRestoreView?.(view.id); closeCamera(); }} className={`min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[11px] font-semibold ${isDarkMode ? 'text-slate-300 hover:text-white' : 'text-slate-700 hover:text-slate-950'}`} title={`Restore ${view.name}`}>
                            {view.name}
                          </button>
                          <button type="button" onClick={() => onDeleteView?.(view.id)} className={`mr-1 rounded-md p-1.5 opacity-0 transition group-hover:opacity-100 ${isDarkMode ? 'text-slate-500 hover:bg-rose-500/10 hover:text-rose-400' : 'text-slate-500 hover:bg-rose-50 hover:text-rose-600'}`} title={`Delete ${view.name}`} aria-label={`Delete ${view.name}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={`px-2 py-4 text-center text-[10px] leading-5 ${popupMuted}`}>Save a viewpoint to return to this angle at any time.</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>


        <div className={`mx-0.5 h-8 w-px ${divider}`} />

        <button
          type="button"
          className={`${item(false)} ${canUndo ? '' : 'cursor-not-allowed opacity-30 hover:bg-transparent hover:text-slate-400'}`}
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo the last change (Ctrl+Z)"
          aria-label="Undo"
          aria-keyshortcuts="Control+Z Meta+Z"
        >
          <Undo2 className="h-4.5 w-4.5" />
          <span className="hidden 2xl:inline text-[11px] font-semibold">Undo</span>
        </button>
        <button
          type="button"
          className={`${item(false)} ${canRedo ? '' : 'cursor-not-allowed opacity-30 hover:bg-transparent hover:text-slate-400'}`}
          onClick={onRedo}
          disabled={!canRedo}
          title="Restore the change you just undid (Ctrl+Y or Ctrl+Shift+Z)"
          aria-label="Redo"
          aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Y Meta+Shift+Z"
        >
          <Redo2 className="h-4.5 w-4.5" />
          <span className="hidden 2xl:inline text-[11px] font-semibold">Redo</span>
        </button>

        <button
          type="button"
          className={modeItem(projection === 'perspective')}
          onClick={() => { onProjection?.('perspective'); closeCamera(); }}
          title="Natural 3D perspective view"
          aria-label="Perspective view"
        >
          <Box className="h-4 w-4" />
          <span className="hidden 2xl:inline">Perspective</span><span className="2xl:hidden">3D</span>
        </button>

        <button
          type="button"
          className={modeItem(projection === 'ortho')}
          onClick={() => { onProjection?.('ortho'); closeCamera(); }}
          title="Flat technical view with parallel lines; useful for alignment and measurements"
          aria-label="Flat technical view"
        >
          <Grid2X2 className="h-4 w-4" />
          <span className="hidden 2xl:inline">Flat view</span><span className="2xl:hidden">Flat</span>
        </button>

        <div className={`mx-0.5 h-8 w-px ${divider}`} />

        <button type="button" className={item(isMeasuring)} onClick={onMeasure} title="Measure distances in the model" aria-label="Measure distances">
          <Ruler className="h-4.5 w-4.5" />
        </button>
        <button type="button" className={item(isClipping)} onClick={onClip} title="Create a cutaway view to see inside the building" aria-label="Cutaway view">
          <Slice className="h-4.5 w-4.5" />
        </button>

      </div>

    </div>
  );
};
