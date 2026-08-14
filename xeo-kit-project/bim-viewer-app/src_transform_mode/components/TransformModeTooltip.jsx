import React, { useEffect, useRef, useState } from 'react';
import { Move, RotateCw, Scaling, Unlock, MoreHorizontal, Trash2, Palette } from 'lucide-react';

const QUICK_COLORS = ['#FFFFFF', '#000000', '#E74C3C', '#3498DB', '#F5DEB3', '#7F8C8D'];

export const TransformModeTooltip = ({
  mode,
  onModeChange,
  assetName,
  onDelete,
  onColorChange,
  isNative,
  onIsolate,
  anchorX = 0,
  anchorY = 0,
}) => {
  const [showMore, setShowMore] = useState(false);
  const [placement, setPlacement] = useState({ left: 0, top: 0, above: true });
  const toolbarRef = useRef(null);

  useEffect(() => {
    const updatePlacement = () => {
      const rect = toolbarRef.current?.getBoundingClientRect();
      if (!rect) return;

      const gap = 16;
      const margin = 12;
      const width = rect.width;
      const height = rect.height;

      let left = anchorX + 18;
      let above = true;
      let top = anchorY - gap;

      if (left + width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - width - margin);
      }
      if (left < margin) left = margin;

      if (top - height < margin) {
        above = false;
        top = anchorY + gap;
      }

      if (!above && top + height > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - height - margin);
      }

      setPlacement({ left, top, above });
    };

    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    return () => window.removeEventListener('resize', updatePlacement);
  }, [anchorX, anchorY, showMore, isNative, assetName]);

  const handleModeClick = (newMode) => {
    if (isNative) return;
    onModeChange(newMode);
    setShowMore(false);
  };

  const buttonClass = (active, tone) => {
    const tones = {
      move: active ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40' : 'text-slate-400 hover:text-white hover:bg-white/6',
      rotate: active ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/40' : 'text-slate-400 hover:text-white hover:bg-white/6',
      resize: active ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-300/50' : 'text-slate-400 hover:text-white hover:bg-white/6',
    };
    return tones[tone];
  };

  return (
    <div
      ref={toolbarRef}
      className="fixed z-[120] pointer-events-none"
      style={{ left: placement.left, top: placement.top }}
      aria-label="Transform toolbar"
    >
      <div className={`relative ${placement.above ? 'origin-bottom-left' : 'origin-top-left'}`}>
        <div
          className="flex items-center gap-1.5 px-2 py-2 rounded-2xl bg-[#0b1322]/96 border border-slate-700/80 shadow-[0_18px_50px_rgba(0,0,0,0.45)] backdrop-blur-2xl pointer-events-auto"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-2.5 min-w-0 max-w-[205px]">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold text-white truncate" title={assetName}>
                {assetName || 'Selected element'}
              </div>
              <div className="text-[8px] uppercase tracking-[0.17em] text-slate-500 mt-0.5">
                {isNative ? 'Native element' : 'Editable transform'}
              </div>
            </div>
            <span className={`shrink-0 text-[8px] px-1.5 py-0.5 rounded-md font-bold uppercase tracking-wider ${isNative ? 'bg-indigo-600 text-white' : 'bg-emerald-500/15 text-emerald-300 border border-emerald-400/20'}`}>
              {isNative ? 'Native' : 'Editable'}
            </span>
          </div>

          <div className="w-px h-7 bg-slate-700/70" />

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleModeClick('move'); }}
            disabled={isNative}
            className={`relative flex items-center justify-center w-10 h-10 rounded-xl ${isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : buttonClass(mode === 'move', 'move')}`}
            title={isNative ? 'Unlock Element first' : 'Move · W'}
          >
            <Move className="w-5 h-5" />
            <span className="absolute -bottom-0.5 text-[7px] font-bold text-slate-500">W</span>
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleModeClick('rotate'); }}
            disabled={isNative}
            className={`relative flex items-center justify-center w-10 h-10 rounded-xl ${isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : buttonClass(mode === 'rotate', 'rotate')}`}
            title={isNative ? 'Unlock Element first' : 'Rotate · E'}
          >
            <RotateCw className="w-5 h-5" />
            <span className="absolute -bottom-0.5 text-[7px] font-bold text-slate-500">E</span>
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleModeClick('stretch'); }}
            disabled={isNative}
            className={`relative flex items-center justify-center w-10 h-10 rounded-xl ${isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : buttonClass(mode === 'stretch', 'resize')}`}
            title={isNative ? 'Unlock Element first' : 'Resize · R'}
          >
            <Scaling className="w-5 h-5" />
            <span className="absolute -bottom-0.5 text-[7px] font-bold text-slate-500">R</span>
          </button>

          <div className="w-px h-7 bg-slate-700/70 mx-0.5" />

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (isNative && onIsolate) onIsolate(); }}
            disabled={!isNative || !onIsolate}
            className={`flex items-center justify-center w-10 h-10 rounded-xl ${!isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : 'text-slate-300 hover:text-white hover:bg-white/6'}`}
            title="Unlock Element · U"
          >
            <Unlock className="w-4.5 h-4.5" />
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowMore((v) => !v); }}
            className={`flex items-center justify-center w-10 h-10 rounded-xl ${showMore ? 'bg-white/8 text-white' : 'text-slate-400 hover:text-white hover:bg-white/6'}`}
            title="More options"
            aria-expanded={showMore}
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>
        </div>

        {showMore && (
          <div
            className={`absolute right-0 w-56 p-3 rounded-2xl bg-[#0b1322]/98 border border-slate-700 shadow-[0_18px_50px_rgba(0,0,0,0.5)] backdrop-blur-2xl pointer-events-auto ${placement.above ? 'bottom-full mb-2' : 'top-full mt-2'}`}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {onColorChange && (
              <div>
                <div className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.15em] mb-2">Quick Paint</div>
                <div className="flex items-center gap-2">
                  {QUICK_COLORS.map(hex => (
                    <button
                      key={hex}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onColorChange(hex); setShowMore(false); }}
                      className="w-5 h-5 rounded-full border border-slate-600 hover:scale-110 transition-transform"
                      style={{ backgroundColor: hex }}
                      title={hex}
                    />
                  ))}
                  <label className="relative w-5 h-5 rounded-full border border-slate-600 hover:scale-110 transition-transform overflow-hidden cursor-pointer" title="Custom color">
                    <Palette className="w-3 h-3 text-slate-400 absolute inset-0 m-auto pointer-events-none" />
                    <input
                      type="color"
                      className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                      onChange={(e) => { onColorChange(e.target.value); setShowMore(false); }}
                    />
                  </label>
                </div>
              </div>
            )}
            {onColorChange && onDelete && <div className="w-full h-px bg-slate-800 my-3" />}
            {onDelete && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(); setShowMore(false); }}
                className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs font-semibold text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete Element
              </button>
            )}
          </div>
        )}

        <div
          className={`absolute w-3 h-3 rotate-45 bg-[#0b1322] border-slate-700/80 ${placement.above ? 'left-5 -bottom-1.5 border-r border-b' : 'left-5 -top-1.5 border-l border-t'}`}
          aria-hidden="true"
        />
      </div>
    </div>
  );
};
