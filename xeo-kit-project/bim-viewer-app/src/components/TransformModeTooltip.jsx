import React, { useEffect, useRef, useState } from 'react';
import {
  Move,
  RotateCw,
  Scaling,
  Unlock,
  MoreHorizontal,
  Trash2,
  Palette,
  ArrowRightLeft,
  Square,
  Box,
  Lock,
} from 'lucide-react';

const QUICK_COLORS = ['#FFFFFF', '#000000', '#E74C3C', '#3498DB', '#F5DEB3', '#7F8C8D'];

/**
 * Stable contextual transform toolbar.
 *
 * Intentional UX contract:
 * - It is NOT anchored to the last mouse click.
 * - It sits in a stable, dock-relative position so it never chases the cursor.
 * - The outer layer does not intercept canvas input; only the actual controls do.
 * - Submenus open upward to stay clear of the bottom dock and viewport edges.
 */
export const TransformModeTooltip = ({
  mode,
  onModeChange,
  assetName,
  onDelete,
  onColorChange,
  isNative,
  onIsolate,
}) => {
  const [openMenu, setOpenMenu] = useState(null);
  const [scaleMode, setScaleMode] = useState(
    mode?.startsWith('stretch-') ? mode : 'stretch-1d'
  );
  const toolbarRef = useRef(null);

  const isScaleActive = mode?.startsWith('stretch');
  const isMoveActive = mode === 'move';
  const isRotateActive = mode === 'rotate';

  useEffect(() => {
    if (mode?.startsWith('stretch-')) {
      setScaleMode(mode);
    }
  }, [mode]);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  const stopCanvasEvent = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const selectMode = (nextMode) => {
    onModeChange(nextMode);
    setOpenMenu(null);
  };

  const handleStretchTrigger = () => {
    if (isNative) return;

    // Stretch is an explicit mode picker, not a cycling button.
    setOpenMenu((current) => (current === 'stretch' ? null : 'stretch'));
  };

  const handleStretchChoice = (nextMode) => {
    setScaleMode(nextMode);
    onModeChange(nextMode);
    setOpenMenu(null);
  };

  const handleMore = () => {
    setOpenMenu((current) => (current === 'more' ? null : 'more'));
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[92px] z-[70] flex justify-center px-4"
      aria-label="Selected element transform toolbar"
    >
      <div ref={toolbarRef} className="relative pointer-events-auto">
        {/* Upward menus — they never sit underneath the bottom dock. */}
        {openMenu === 'stretch' && !isNative && (
          <div
            className="absolute bottom-[calc(100%+10px)] left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-2xl border border-slate-700/80 bg-slate-950/95 p-2 shadow-2xl shadow-black/30 backdrop-blur-xl animate-in slide-in-from-bottom-2 fade-in duration-150"
            onPointerDown={stopCanvasEvent}
            onClick={stopCanvasEvent}
          >
            <StretchOption
              active={scaleMode === 'stretch-1d'}
              icon={<ArrowRightLeft className="h-4 w-4" />}
              label="1 Axis"
              hint="Single-axis stretch"
              onClick={() => handleStretchChoice('stretch-1d')}
            />
            <StretchOption
              active={scaleMode === 'stretch-2d'}
              icon={<Square className="h-4 w-4" />}
              label="2 Axis"
              hint="Planar stretch"
              onClick={() => handleStretchChoice('stretch-2d')}
            />
            <StretchOption
              active={scaleMode === 'stretch-3d'}
              icon={<Box className="h-4 w-4" />}
              label="3 Axis"
              hint="Uniform 3-axis stretch"
              onClick={() => handleStretchChoice('stretch-3d')}
            />
          </div>
        )}

        {openMenu === 'more' && (
          <div
            className="absolute bottom-[calc(100%+10px)] right-0 w-56 rounded-2xl border border-slate-700/80 bg-slate-950/95 p-3 shadow-2xl shadow-black/30 backdrop-blur-xl animate-in slide-in-from-bottom-2 fade-in duration-150"
            onPointerDown={stopCanvasEvent}
            onClick={stopCanvasEvent}
          >
            {onColorChange && (
              <div>
                <div className="mb-2 text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  Quick Paint
                </div>
                <div className="flex items-center gap-2">
                  {QUICK_COLORS.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      title={`Paint ${hex}`}
                      onPointerDown={stopCanvasEvent}
                      onClick={(event) => {
                        stopCanvasEvent(event);
                        onColorChange(hex);
                        setOpenMenu(null);
                      }}
                      className="h-6 w-6 rounded-full border border-slate-600 shadow-sm transition-transform hover:scale-110"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                  <label
                    className="relative flex h-6 w-6 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-slate-600 bg-slate-900"
                    title="Custom color"
                    onPointerDown={stopCanvasEvent}
                  >
                    <Palette className="pointer-events-none h-3.5 w-3.5 text-slate-400" />
                    <input
                      type="color"
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      onChange={(event) => {
                        onColorChange(event.target.value);
                        setOpenMenu(null);
                      }}
                    />
                  </label>
                </div>
              </div>
            )}

            {onDelete && (
              <>
                {onColorChange && <div className="my-3 h-px bg-slate-800" />}
                <button
                  type="button"
                  onPointerDown={stopCanvasEvent}
                  onClick={(event) => {
                    stopCanvasEvent(event);
                    onDelete();
                    setOpenMenu(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-semibold text-rose-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete element
                </button>
              </>
            )}
          </div>
        )}

        {/* Main contextual toolbar */}
        <div className="relative overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-950/95 shadow-[0_14px_40px_rgba(0,0,0,0.36)] backdrop-blur-2xl">
          <div className="flex items-center gap-1 px-2 py-2">
            {/* Selection identity */}
            <div className="min-w-0 max-w-[210px] px-2.5 py-1.5">
              <div className="truncate text-[11px] font-semibold tracking-wide text-slate-100">
                {assetName || 'Selected element'}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="text-[8px] uppercase tracking-[0.16em] text-slate-500">
                  {isNative ? 'Native Element' : 'Transform'}
                </span>
                {isNative ? (
                  <span className="rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-indigo-300">
                    Native
                  </span>
                ) : (
                  <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-emerald-300">
                    Editable
                  </span>
                )}
              </div>
            </div>

            <div className="mx-1 h-8 w-px bg-slate-800" />

            <ToolbarButton
              icon={<Move className="h-[18px] w-[18px]" />}
              label="Move"
              shortcut="W"
              active={isMoveActive}
              disabled={isNative}
              tone="emerald"
              onClick={() => selectMode('move')}
              title={isNative ? 'Unlock Element first' : 'Move (W)'}
            />

            <ToolbarButton
              icon={<RotateCw className="h-[18px] w-[18px]" />}
              label="Rotate"
              shortcut="E"
              active={isRotateActive}
              disabled={isNative}
              tone="blue"
              onClick={() => selectMode('rotate')}
              title={isNative ? 'Unlock Element first' : 'Rotate (E)'}
            />

            <ToolbarButton
              icon={<Scaling className="h-[18px] w-[18px]" />}
              label="Stretch"
              shortcut="R"
              active={isScaleActive || openMenu === 'stretch'}
              disabled={isNative}
              tone="amber"
              onClick={handleStretchTrigger}
              title={isNative ? 'Unlock Element first' : 'Stretch (R)'}
            />

            <div className="mx-1 h-8 w-px bg-slate-800" />

            <ToolbarButton
              icon={<Unlock className="h-4 w-4" />}
              label="Unlock"
              shortcut="U"
              active={false}
              disabled={!isNative || !onIsolate}
              tone="neutral"
              onClick={onIsolate}
              title={isNative ? 'Unlock element (U)' : 'Already unlocked'}
            />

            <button
              type="button"
              onPointerDown={stopCanvasEvent}
              onClick={(event) => {
                stopCanvasEvent(event);
                handleMore();
              }}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-slate-400 transition-all hover:border-slate-600 hover:bg-slate-800/80 hover:text-white ${openMenu === 'more' ? 'border-slate-600 bg-slate-800 text-white' : 'border-transparent'}`}
              title="More options"
              aria-label="More options"
              aria-expanded={openMenu === 'more'}
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
          </div>

          {/* Tiny visual connector toward the viewport content, not the cursor. */}
          <div className="absolute -bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-slate-700/80 bg-slate-950" />
        </div>
      </div>
    </div>
  );
};

function ToolbarButton({ icon, label, shortcut, active, disabled, tone, onClick, title }) {
  const toneClasses = {
    emerald: active
      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
      : 'border-transparent text-slate-400 hover:border-emerald-500/20 hover:bg-slate-800 hover:text-emerald-300',
    blue: active
      ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
      : 'border-transparent text-slate-400 hover:border-blue-500/20 hover:bg-slate-800 hover:text-blue-300',
    amber: active
      ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
      : 'border-transparent text-slate-400 hover:border-amber-500/20 hover:bg-slate-800 hover:text-amber-300',
    neutral: active
      ? 'border-slate-600 bg-slate-800 text-white'
      : 'border-transparent text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-white',
  };

  return (
    <button
      type="button"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) onClick?.();
      }}
      disabled={disabled}
      className={`group relative flex h-11 min-w-11 shrink-0 flex-col items-center justify-center rounded-xl border px-2 transition-all ${toneClasses[tone]} ${disabled ? 'cursor-not-allowed opacity-35' : 'cursor-pointer'}`}
      title={title}
      aria-label={title}
    >
      {icon}
      <span className="pointer-events-none absolute -bottom-0.5 text-[7px] font-bold uppercase tracking-wider opacity-0 transition-opacity group-hover:opacity-70">
        {shortcut}
      </span>
      <span className="pointer-events-none sr-only">{label}</span>
    </button>
  );
}

function StretchOption({ active, icon, label, hint, onClick }) {
  return (
    <button
      type="button"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={`flex min-w-[112px] flex-col items-start rounded-xl border px-3 py-2 transition-all ${active ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-transparent text-slate-400 hover:border-slate-700 hover:bg-slate-800/80 hover:text-slate-200'}`}
    >
      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider">
        {icon}
        {label}
      </span>
      <span className="mt-1 text-[8px] text-slate-500">{hint}</span>
    </button>
  );
}
