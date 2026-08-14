import React, { useEffect, useRef, useState } from 'react';
import { Move, RotateCw, Scaling, Unlock, MoreHorizontal, Trash2, Palette, CircleHelp, ArrowUp, RotateCcw } from 'lucide-react';

const QUICK_COLORS = ['#FFFFFF', '#000000', '#E74C3C', '#3498DB', '#F5DEB3', '#7F8C8D'];

export const TransformModeTooltip = ({
  mode,
  onModeChange,
  assetName,
  onDelete,
  onColorChange,
  isNative,
  onIsolate,
  isDarkMode = true,
  anchorX = 0,
  anchorY = 0,
}) => {
  const [showMore, setShowMore] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [placement, setPlacement] = useState({ left: 0, top: 0, above: true });
  const [helpPlacement, setHelpPlacement] = useState('below');
  const toolbarRef = useRef(null);
  const helpRef = useRef(null);

  useEffect(() => {
    const updatePlacement = () => {
      const rect = toolbarRef.current?.getBoundingClientRect();
      if (!rect) return;

      const gap = 32;
      const margin = 12;
      const width = rect.width;
      const height = rect.height;

      let left = anchorX + 18;
      let above = true;
      let top = anchorY - height - gap;

      if (left + width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - width - margin);
      if (left < margin) left = margin;

      if (top < margin) {
        above = false;
        top = anchorY + gap;
      }

      if (!above && top + height > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - height - margin);
      }

      setPlacement({ left, top, above });

      if (showHelp) {
        requestAnimationFrame(() => {
          const helpRect = helpRef.current?.getBoundingClientRect();
          if (!helpRect) return;
          const spaceAbove = rect.top - helpRect.height - 12;
          const spaceBelow = window.innerHeight - rect.bottom - helpRect.height - 12;
          setHelpPlacement(spaceAbove >= margin || spaceAbove >= spaceBelow ? 'above' : 'below');
        });
      }
    };

    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    return () => window.removeEventListener('resize', updatePlacement);
  }, [anchorX, anchorY, showMore, showHelp, isNative, assetName]);

  const handleModeClick = (newMode) => {
    if (isNative) return;
    onModeChange(newMode);
    setShowMore(false);
  };

  const buttonClass = (active, tone) => {
    const tones = {
      move: active ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/45' : 'text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/8',
      rotate: active ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/45' : 'text-slate-400 hover:text-sky-300 hover:bg-sky-500/8',
      resize: active ? 'bg-[#ff914d]/15 text-[#ffb07a] ring-1 ring-[#ff914d]/55' : 'text-slate-400 hover:text-[#ffb07a] hover:bg-[#ff914d]/8',
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
            <span className={`shrink-0 text-[8px] px-1.5 py-0.5 rounded-md font-bold uppercase tracking-wider ${isNative ? 'bg-slate-700 text-slate-100 border border-slate-600' : 'bg-[#ff914d]/12 text-[#ffb07a] border border-[#ff914d]/25'}`}>
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

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowHelp((v) => !v); setShowMore(false); }}
            className={`flex items-center justify-center w-8 h-8 rounded-xl ${showHelp ? 'bg-[#ff914d]/15 text-[#ffb07a] ring-1 ring-[#ff914d]/45' : 'text-slate-500 hover:text-white hover:bg-white/6'}`}
            title="Transform help"
            aria-label="Transform help"
            aria-expanded={showHelp}
            aria-controls="transform-help-panel"
          >
            <CircleHelp className="w-4 h-4" />
          </button>
        </div>

        {showHelp && (
          <div
            className={`absolute right-0 w-[286px] p-3 rounded-2xl backdrop-blur-2xl border shadow-[0_18px_50px_rgba(0,0,0,0.5)] pointer-events-auto ${placement.above ? 'bottom-full mb-2' : 'top-full mt-2'} ${isDarkMode ? 'bg-[#07111d]/98 border-slate-700 text-slate-200' : 'bg-white/98 border-slate-200 text-slate-700'}`}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className={`text-[9px] font-bold uppercase tracking-[0.15em] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Transform controls</div>
              <span className="text-[8px] font-semibold px-1.5 py-0.5 rounded-md border border-[#ff914d]/25 bg-[#ff914d]/10 text-[#ffb07a]">HCI</span>
            </div>
            <div className="space-y-2.5">
              <HelpRow tone="move" icon={<Move className="w-4 h-4" />} title="Move" text="Drag the colored arrows. Small translucent planes move on two axes." isDarkMode={isDarkMode} />
              <HelpRow tone="rotate" icon={<RotateCw className="w-4 h-4" />} title="Rotate" text="Drag the circular arrow on the left or right side of the object. The highlighted arrow shows the active rotation direction." isDarkMode={isDarkMode} />
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-2.5">
                <HelpRow tone="resize" icon={<Scaling className="w-4 h-4" />} title="Resize" text="Choose Resize, then drag a face grip for one dimension. Click a face to reveal its nearby edge and corner grips for broader resizing." isDarkMode={isDarkMode} />
                <div className="grid grid-cols-3 gap-1.5 mt-2.5">
                  <div className="rounded-lg border border-red-400/20 bg-red-500/5 px-2 py-1.5 text-center">
                    <div className="mx-auto mb-1 w-3 h-3 rounded-sm border-2 border-red-300" />
                    <div className="text-[8px] font-semibold text-slate-200">FACE</div>
                    <div className="text-[7px] text-slate-500">1 axis</div>
                  </div>
                  <div className="rounded-lg border border-violet-400/20 bg-violet-500/5 px-2 py-1.5 text-center">
                    <div className="mx-auto mb-1 w-3 h-3 rotate-45 border-2 border-violet-300" />
                    <div className="text-[8px] font-semibold text-slate-200">EDGE</div>
                    <div className="text-[7px] text-slate-500">2 axes</div>
                  </div>
                  <div className="rounded-lg border border-fuchsia-400/20 bg-fuchsia-500/5 px-2 py-1.5 text-center">
                    <div className="mx-auto mb-1 w-3 h-3 rounded-full border-2 border-fuchsia-300" />
                    <div className="text-[8px] font-semibold text-slate-200">CORNER</div>
                    <div className="text-[7px] text-slate-500">3 axes</div>
                  </div>
                </div>
              </div>
              <HelpRow tone="unlock" icon={<Unlock className="w-4 h-4" />} title="Unlock" text="Convert a native IFC element into an editable isolated object." isDarkMode={isDarkMode} />
            </div>
          </div>
        )}

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

function HelpRow({ tone, icon, title, text, isDarkMode }) {
  const toneClass = { move: 'text-emerald-400 bg-emerald-500/10 border-emerald-400/20', rotate: 'text-sky-400 bg-sky-500/10 border-sky-400/20', resize: 'text-amber-400 bg-amber-500/10 border-amber-400/20', unlock: 'text-slate-400 bg-slate-500/10 border-slate-500/20' }[tone];
  return (
    <div className="flex gap-2.5 items-start">
      <div className={`w-8 h-8 shrink-0 rounded-lg border flex items-center justify-center ${toneClass}`}>{icon}</div>
      <div className="min-w-0">
        <div className={`text-[11px] font-semibold ${isDarkMode ? 'text-white' : 'text-slate-800'}`}>{title}</div>
        <div className={`text-[10px] leading-[1.35] mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{text}</div>
      </div>
    </div>
  );
}
