import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MousePointer2,
  Ruler,
  Slice,
  Orbit,
  Camera,
  Crosshair,
  Box,
  Grid2X2,
  DoorOpen,
  ScanSearch,
  Bookmark,
  Save,
  Trash2,
  X,
  RotateCcw,
  Undo2,
  Redo2,
  Footprints,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Layers3,
  Check,
  Loader2,
} from 'lucide-react';

const PRESETS = [
  { label: 'Top', value: 'top', hint: 'Plan view', Icon: Grid2X2 },
  { label: 'Front', value: 'front', hint: 'Front elevation', Icon: ArrowUp },
  { label: 'Back', value: 'back', hint: 'Rear elevation', Icon: ArrowDown },
  { label: 'Right', value: 'right', hint: 'Right elevation', Icon: ArrowRight },
  { label: 'Left', value: 'left', hint: 'Left elevation', Icon: ArrowLeft },
  { label: '3D angle', value: 'iso', hint: 'Isometric view', Icon: Box },
];

const POPUP_WIDTH = 360;
const POPUP_MAX_HEIGHT = 560;
const VIEWPORT_GUTTER = 12;

function getPopupPosition(anchor) {
  if (!anchor || typeof window === 'undefined') {
    return { top: VIEWPORT_GUTTER, left: VIEWPORT_GUTTER, width: POPUP_WIDTH };
  }

  const rect = anchor.getBoundingClientRect();
  const width = Math.min(POPUP_WIDTH, Math.max(280, window.innerWidth - VIEWPORT_GUTTER * 2));
  const maxHeight = Math.max(260, Math.min(POPUP_MAX_HEIGHT, window.innerHeight - VIEWPORT_GUTTER * 2));
  const left = Math.min(
    Math.max(VIEWPORT_GUTTER, rect.left + rect.width / 2 - width / 2),
    Math.max(VIEWPORT_GUTTER, window.innerWidth - width - VIEWPORT_GUTTER),
  );
  const belowTop = rect.bottom + 10;
  const top = belowTop + maxHeight <= window.innerHeight - VIEWPORT_GUTTER
    ? belowTop
    : Math.max(VIEWPORT_GUTTER, rect.top - maxHeight - 10);

  return { top, left, width };
}

export const ViewportToolbar = ({
  isMeasuring,
  isClipping,
  onOpenRooms,
  roomsOpen = false,
  roomCount = 0,
  roomsLoading = false,
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
  const [popupPosition, setPopupPosition] = useState({ top: 12, left: 12, width: POPUP_WIDTH });
  const cameraRef = useRef(null);
  const cameraButtonRef = useRef(null);
  const cameraPopupRef = useRef(null);

  const closeCamera = useCallback(() => {
    setCameraOpen(false);
    setShowSavedViews(false);
    setViewName('');
  }, []);

  const toggleCamera = () => {
    if (cameraOpen) {
      closeCamera();
      return;
    }
    setPopupPosition(getPopupPosition(cameraButtonRef.current));
    setCameraOpen(true);
  };

  useEffect(() => {
    if (!cameraOpen) return undefined;

    const handlePointerDown = (event) => {
      const target = event.target;
      if (cameraRef.current?.contains(target) || cameraPopupRef.current?.contains(target)) return;
      closeCamera();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeCamera();
    };
    const updatePosition = () => {
      setPopupPosition(getPopupPosition(cameraButtonRef.current));
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    // Capture scrolls from nested scrollable panels too; the portal remains anchored to the button.
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [cameraOpen, closeCamera]);

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
    ? 'border-slate-700/90 bg-[#0b1322]/[0.98] text-slate-100 shadow-black/40'
    : 'border-slate-200 bg-white/[0.98] text-slate-800 shadow-slate-900/15';
  const popupMuted = isDarkMode ? 'text-slate-400' : 'text-slate-500';
  const item = (active = false) => `inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-2.5 transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff914d] ${active ? 'bg-[#ff914d] text-white shadow-md shadow-[#ff914d]/25' : idleButton}`;
  const modeItem = (active = false) => `inline-flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3 text-[11px] font-semibold transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff914d] ${active ? 'bg-[#ff914d] text-white shadow-md shadow-[#ff914d]/20' : idleButton}`;
  const miniItem = (active = false) => `flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-[10px] font-semibold transition-all ${active ? (isDarkMode ? 'bg-[#ff914d]/15 text-[#ff914d]' : 'bg-orange-50 text-[#c85b1f]') : idleButton}`;

  const cameraPopup = cameraOpen && typeof document !== 'undefined' ? createPortal(
    <div
      ref={cameraPopupRef}
      role="dialog"
      aria-label="Camera and viewpoints"
      className={`fixed z-[9999] flex flex-col overflow-hidden rounded-2xl border backdrop-blur-2xl shadow-2xl ${popup}`}
      style={{
        top: popupPosition.top,
        left: popupPosition.left,
        width: popupPosition.width,
        maxHeight: 'calc(100vh - 24px)',
      }}
    >
      <div className={`flex shrink-0 items-center justify-between border-b px-4 py-3 ${isDarkMode ? 'border-slate-700/80' : 'border-slate-200'}`}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#ff914d]/15 text-[#ff914d]">
            <Camera className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold">Camera &amp; views</div>
            <div className={`mt-0.5 text-[10px] ${popupMuted}`}>Choose a viewpoint or frame the model</div>
          </div>
        </div>
        <button
          type="button"
          onClick={closeCamera}
          className={`ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${idleButton}`}
          aria-label="Close camera menu"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto overscroll-contain p-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className={`text-[10px] font-bold uppercase tracking-[0.16em] ${popupMuted}`}>Viewpoint</span>
          <span className={`text-[10px] ${popupMuted}`}>6 presets</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map(({ label, value, hint, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => { onCameraPreset?.(value); closeCamera(); }}
              className={`group flex min-h-[78px] min-w-0 flex-col items-start justify-between rounded-xl border p-2.5 text-left transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff914d] ${isDarkMode ? 'border-slate-700/90 bg-slate-900/60 hover:border-[#ff914d]/70 hover:bg-[#ff914d]/[0.08]' : 'border-slate-200 bg-slate-50 hover:border-orange-300 hover:bg-orange-50'}`}
              title={`${label} view`}
            >
              <span className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${isDarkMode ? 'bg-slate-800 text-slate-300 group-hover:bg-[#ff914d]/15 group-hover:text-[#ff914d]' : 'bg-white text-slate-600 shadow-sm group-hover:bg-orange-100 group-hover:text-orange-700'}`}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="mt-2 min-w-0">
                <span className="block text-[11px] font-bold leading-4">{label}</span>
                <span className={`mt-0.5 block truncate text-[9px] leading-3 ${popupMuted}`}>{hint}</span>
              </span>
            </button>
          ))}
        </div>

        <div className={`my-3 h-px ${divider}`} />
        <div className={`mb-2 px-1 text-[10px] font-bold uppercase tracking-[0.16em] ${popupMuted}`}>Quick actions</div>
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={() => { onFocus?.(); closeCamera(); }} className={`flex min-h-[70px] flex-col items-start justify-center gap-2 rounded-xl border p-2.5 text-left transition ${isDarkMode ? 'border-slate-700/80 bg-slate-900/40 hover:bg-white/[0.06]' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`} title="Bring the selected item into view">
            <Crosshair className="h-4 w-4 text-[#ff914d]" />
            <span className="text-[10px] font-semibold">Focus item</span>
          </button>
          <button type="button" onClick={() => { onFit?.(); closeCamera(); }} className={`flex min-h-[70px] flex-col items-start justify-center gap-2 rounded-xl border p-2.5 text-left transition ${isDarkMode ? 'border-slate-700/80 bg-slate-900/40 hover:bg-white/[0.06]' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`} title="Show the whole building">
            <ScanSearch className="h-4 w-4 text-[#ff914d]" />
            <span className="text-[10px] font-semibold">Whole model</span>
          </button>
          <button type="button" onClick={() => { onResetCamera?.(); closeCamera(); }} className={`flex min-h-[70px] flex-col items-start justify-center gap-2 rounded-xl border p-2.5 text-left transition ${isDarkMode ? 'border-slate-700/80 bg-slate-900/40 hover:bg-white/[0.06]' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`} title="Return to the starting view">
            <RotateCcw className="h-4 w-4 text-[#ff914d]" />
            <span className="text-[10px] font-semibold">Reset view</span>
          </button>
        </div>

        <div className={`my-3 h-px ${divider}`} />
        <div className="flex items-center justify-between px-1">
          <div>
            <div className="text-[11px] font-bold">Projection</div>
            <div className={`mt-0.5 text-[10px] ${popupMuted}`}>Perspective for natural depth, flat for technical plans</div>
          </div>
          <Layers3 className={`h-4 w-4 ${popupMuted}`} />
        </div>
        <div className={`mt-2 grid grid-cols-2 gap-1 rounded-xl p-1 ${isDarkMode ? 'bg-slate-950/70' : 'bg-slate-100'}`}>
          <button
            type="button"
            onClick={() => { onProjection?.('perspective'); closeCamera(); }}
            className={`flex h-9 items-center justify-center gap-2 rounded-lg px-2 text-[11px] font-semibold transition ${projection === 'perspective' ? 'bg-[#ff914d] text-white shadow-md shadow-[#ff914d]/20' : idleButton}`}
          >
            <Box className="h-4 w-4" /> Perspective
            {projection === 'perspective' && <Check className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => { onProjection?.('ortho'); closeCamera(); }}
            className={`flex h-9 items-center justify-center gap-2 rounded-lg px-2 text-[11px] font-semibold transition ${projection === 'ortho' ? 'bg-[#ff914d] text-white shadow-md shadow-[#ff914d]/20' : idleButton}`}
          >
            <Grid2X2 className="h-4 w-4" /> Flat view
            {projection === 'ortho' && <Check className="h-3.5 w-3.5" />}
          </button>
        </div>

        <div className={`my-3 h-px ${divider}`} />
        <button
          type="button"
          onClick={() => setShowSavedViews((value) => !value)}
          aria-expanded={showSavedViews}
          className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left transition ${isDarkMode ? 'border-slate-700/80 hover:bg-white/[0.05]' : 'border-slate-200 hover:bg-slate-50'}`}
        >
          <span className="flex items-center gap-2.5">
            <Bookmark className="h-4 w-4 text-[#ff914d]" />
            <span>
              <span className="block text-[11px] font-bold">Saved views</span>
              <span className={`mt-0.5 block text-[10px] ${popupMuted}`}>{savedViews.length ? `${savedViews.length} saved viewpoint${savedViews.length === 1 ? '' : 's'}` : 'Save a camera angle to return to it later'}</span>
            </span>
          </span>
          <span className={`text-xs ${popupMuted}`}>{showSavedViews ? '−' : '+'}</span>
        </button>

        {showSavedViews && (
          <div className={`mt-2 rounded-xl border p-2.5 ${isDarkMode ? 'border-slate-700/80 bg-slate-950/40' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex items-center gap-1.5">
              <input
                value={viewName}
                onChange={(event) => setViewName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') handleSaveView(); }}
                placeholder="Name this viewpoint…"
                aria-label="Name this viewpoint"
                className={`min-w-0 flex-1 rounded-lg border px-2.5 py-2 text-[11px] outline-none focus:border-[#ff914d]/70 ${isDarkMode ? 'border-slate-700 bg-slate-900/70 text-white placeholder:text-slate-600' : 'border-slate-200 bg-white text-slate-900 placeholder:text-slate-400'}`}
              />
              <button type="button" onClick={handleSaveView} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#ff914d] text-white shadow-md shadow-[#ff914d]/20 transition hover:bg-[#ff7a28]" title="Save this viewpoint" aria-label="Save viewpoint">
                <Save className="h-4 w-4" />
              </button>
            </div>

            {savedViews.length > 0 ? (
              <div className="mt-2 max-h-[160px] space-y-1 overflow-y-auto pr-0.5">
                {savedViews.map((view) => (
                  <div key={view.id} className={`group flex min-w-0 items-center gap-1 rounded-lg border border-transparent ${isDarkMode ? 'hover:border-slate-700 hover:bg-white/[0.035]' : 'hover:border-slate-200 hover:bg-white'}`}>
                    <button type="button" onClick={() => { onRestoreView?.(view.id); closeCamera(); }} className={`min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[11px] font-semibold ${isDarkMode ? 'text-slate-300 hover:text-white' : 'text-slate-700 hover:text-slate-950'}`} title={`Restore ${view.name}`}>
                      {view.name}
                    </button>
                    <button type="button" onClick={() => onDeleteView?.(view.id)} className={`mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-70 transition group-hover:opacity-100 ${isDarkMode ? 'text-slate-500 hover:bg-rose-500/10 hover:text-rose-400' : 'text-slate-500 hover:bg-rose-50 hover:text-rose-600'}`} title={`Delete ${view.name}`} aria-label={`Delete ${view.name}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className={`px-2 py-4 text-center text-[10px] leading-5 ${popupMuted}`}>Save your current camera to create your first viewpoint.</div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
        <div className={`flex max-w-[calc(100vw-1.5rem)] flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain rounded-2xl border px-2 py-2 backdrop-blur-2xl pointer-events-auto ${shell}`}>
          <button type="button" className={item(transformMode === 'select')} onClick={onSelect} title="Select an object to inspect or edit it" aria-label="Select an object">
            <MousePointer2 className="h-4.5 w-4.5" />
            <span className="hidden xl:inline text-[11px] font-semibold">Select</span>
          </button>

          <button type="button" className={item(roomsOpen)} onClick={onOpenRooms} title="Browse and select rooms" aria-label="Open room browser">
            {roomsLoading ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : <DoorOpen className="h-4.5 w-4.5" />}
            <span className="hidden xl:inline text-[11px] font-semibold">Rooms &amp; zones{roomCount ? ` (${roomCount})` : ''}</span>
          </button>

          <button type="button" className={item(navMode === 'planView')} onClick={() => onNavMode?.(navMode === 'planView' ? 'orbit' : 'planView')} title="Lock the camera to a top-down floor plan" aria-label="Toggle plan view">
            <Grid2X2 className="h-4.5 w-4.5" />
            <span className="hidden xl:inline text-[11px] font-semibold">Floor plan</span>
          </button>

          <button
            className={item(navMode === 'firstPerson')}
            onClick={() => onNavMode?.(navMode === 'firstPerson' ? 'orbit' : (navMode === 'planView' ? 'orbit' : 'firstPerson'))}
            title={navMode === 'firstPerson' ? 'Switch to orbit controls to inspect the model from outside' : 'Walk through the rooms at eye level'}
            aria-label={navMode === 'firstPerson' ? 'Switch to orbit controls' : 'Walk through the model'}
          >
            {navMode === 'firstPerson' ? <Orbit className="h-4.5 w-4.5" /> : navMode === 'planView' ? <Orbit className="h-4.5 w-4.5" /> : <Footprints className="h-4.5 w-4.5" />}
            <span className="hidden xl:inline text-[11px] font-semibold">{navMode === 'firstPerson' || navMode === 'planView' ? '3D view' : 'Walk'}</span>
          </button>

          <div ref={cameraRef} className="relative flex items-center">
            <button
              ref={cameraButtonRef}
              type="button"
              className={item(cameraOpen)}
              onClick={toggleCamera}
              title="Choose a view, focus the selection or save a viewpoint"
              aria-label="Camera and viewpoints"
              aria-haspopup="dialog"
              aria-expanded={cameraOpen}
            >
              <Camera className="h-4.5 w-4.5" />
              <span className="hidden xl:inline text-[11px] font-semibold">Views</span>
            </button>
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
            <span className="hidden xl:inline text-[11px] font-semibold">Undo</span>
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
            <span className="hidden xl:inline text-[11px] font-semibold">Redo</span>
          </button>

          <button
            type="button"
            className={modeItem(projection === 'perspective')}
            onClick={() => { onProjection?.('perspective'); closeCamera(); }}
            title="Natural 3D perspective view"
            aria-label="Perspective view"
          >
            <Box className="h-4 w-4" />
            <span className="hidden xl:inline">Perspective</span><span className="xl:hidden">3D</span>
          </button>

          <button
            type="button"
            className={modeItem(projection === 'ortho')}
            onClick={() => { onProjection?.('ortho'); closeCamera(); }}
            title="Flat technical view with parallel lines; useful for alignment and measurements"
            aria-label="Flat technical view"
          >
            <Grid2X2 className="h-4 w-4" />
            <span className="hidden xl:inline">Flat view</span><span className="xl:hidden">Flat</span>
          </button>

          <div className={`mx-0.5 h-8 w-px ${divider}`} />

          <button type="button" className={item(isMeasuring)} onClick={onMeasure} title="Measure distances in the model" aria-label="Measure distances">
            <Ruler className="h-4.5 w-4.5" />
            <span className="hidden xl:inline text-[11px] font-semibold">Measure</span>
          </button>
          <button type="button" className={item(isClipping)} onClick={onClip} title="Create a cutaway view to see inside the building" aria-label="Cutaway view">
            <Slice className="h-4.5 w-4.5" />
            <span className="hidden xl:inline text-[11px] font-semibold">Cutaway</span>
          </button>
        </div>
      </div>
      {cameraPopup}
    </>
  );
};
