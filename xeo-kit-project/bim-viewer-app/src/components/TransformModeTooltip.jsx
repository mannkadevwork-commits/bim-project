import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Move, RotateCw, Scaling, Lock, Unlock, MoreHorizontal, Trash2, Palette, CircleHelp, Square, Diamond, Box } from 'lucide-react';

const QUICK_COLORS = ['#FFFFFF', '#000000', '#E74C3C', '#3498DB', '#F5DEB3', '#7F8C8D'];

export const TransformModeTooltip = ({
  mode,
  onModeChange,
  assetName,
  onDelete,
  onColorChange,
  currentColor = '#FFFFFF',
  materialLibrary = [],
  selectedMaterial = null,
  onMaterialSelect,
  canApplyToAllWalls = false,
  onApplyToAllWalls,
  onApplyMaterialToAllWalls,
  isNative,
  onIsolate,
  isDarkMode = true,
  resizeSubmode = 'face',
  onResizeSubmodeChange,
  anchorX = 0,
  anchorY = 0,
}) => {
  const [showMore, setShowMore] = useState(false);
  const [materialMode, setMaterialMode] = useState('color');
  const [showHelp, setShowHelp] = useState(false);
  const [placement, setPlacement] = useState({ left: 0, top: 0, above: true });
  const [helpPlacement, setHelpPlacement] = useState({ left: 0, top: 0, side: 'below' });
  const [morePlacement, setMorePlacement] = useState({ left: 0, top: 0, side: 'below' });
  const moreRef = useRef(null);
  const toolbarRef = useRef(null);
  const helpRef = useRef(null);

  useEffect(() => {
    const updatePlacement = () => {
      const rect = toolbarRef.current?.getBoundingClientRect();
      if (!rect) return;

      const gap = 52;
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
    };

    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [anchorX, anchorY, showMore, showHelp, isNative, assetName]);

  useLayoutEffect(() => {
    const positionPopover = (node, setState, preferredSide = 'below') => {
      const toolbar = toolbarRef.current?.getBoundingClientRect();
      const popover = node?.getBoundingClientRect();
      if (!toolbar || !popover) return;

      const margin = 10;
      const gap = 10;
      const aboveSpace = toolbar.top - margin;
      const belowSpace = window.innerHeight - toolbar.bottom - margin;

      let side;
      if (preferredSide === 'above' && aboveSpace >= popover.height + gap) side = 'above';
      else if (preferredSide === 'below' && belowSpace >= popover.height + gap) side = 'below';
      else if (belowSpace >= popover.height + gap) side = 'below';
      else side = 'above';

      let top = side === 'above'
        ? toolbar.top - popover.height - gap
        : toolbar.bottom + gap;

      top = Math.max(margin, Math.min(top, window.innerHeight - popover.height - margin));

      let left = toolbar.right - popover.width;
      left = Math.max(margin, Math.min(left, window.innerWidth - popover.width - margin));

      setState({ left, top, side });
    };

    if (showHelp) {
      const frame = requestAnimationFrame(() => positionPopover(helpRef.current, setHelpPlacement, placement.above ? 'above' : 'below'));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [showHelp, placement]);

  useLayoutEffect(() => {
    if (!showMore) return undefined;
    const frame = requestAnimationFrame(() => {
      positionMorePopover();
    });
    return () => cancelAnimationFrame(frame);
  }, [showMore, placement]);

  const positionMorePopover = () => {
    const toolbar = toolbarRef.current?.getBoundingClientRect();
    const popover = moreRef.current?.getBoundingClientRect();
    if (!toolbar || !popover) return;

    const margin = 10;
    const gap = 10;
    const aboveSpace = toolbar.top - margin;
    const belowSpace = window.innerHeight - toolbar.bottom - margin;
    const side = belowSpace >= popover.height + gap || aboveSpace < popover.height + gap ? 'below' : 'above';
    let top = side === 'below' ? toolbar.bottom + gap : toolbar.top - popover.height - gap;
    top = Math.max(margin, Math.min(top, window.innerHeight - popover.height - margin));
    let left = toolbar.right - popover.width;
    left = Math.max(margin, Math.min(left, window.innerWidth - popover.width - margin));
    setMorePlacement({ left, top, side });
  };

  useEffect(() => {
    const handler = () => {
      if (showHelp) {
        const frame = requestAnimationFrame(() => {
          const toolbar = toolbarRef.current?.getBoundingClientRect();
          const popover = helpRef.current?.getBoundingClientRect();
          if (!toolbar || !popover) return;
          const margin = 10;
          const gap = 10;
          const aboveSpace = toolbar.top - margin;
          const belowSpace = window.innerHeight - toolbar.bottom - margin;
          const side = aboveSpace >= popover.height + gap && placement.above ? 'above' : (belowSpace >= popover.height + gap ? 'below' : 'above');
          let top = side === 'above' ? toolbar.top - popover.height - gap : toolbar.bottom + gap;
          top = Math.max(margin, Math.min(top, window.innerHeight - popover.height - margin));
          let left = toolbar.right - popover.width;
          left = Math.max(margin, Math.min(left, window.innerWidth - popover.width - margin));
          setHelpPlacement({ left, top, side });
        });
        return () => cancelAnimationFrame(frame);
      }
      if (showMore) {
        positionMorePopover();
      }
      return undefined;
    };

    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [showHelp, showMore, placement]);

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
            className={`relative flex items-center justify-center hci-transform-action hci-transform-action--move w-10 h-10 rounded-xl border border-transparent ${isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : buttonClass(mode === 'move', 'move')}`}
            title={isNative ? 'Unlock Element first' : 'Move · W'}
          >
            <Move className="w-5 h-5" />
            <span className="absolute -bottom-0.5 text-[7px] font-bold text-slate-500">W</span>
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleModeClick('rotate'); }}
            disabled={isNative}
            className={`relative flex items-center justify-center hci-transform-action hci-transform-action--rotate w-10 h-10 rounded-xl border border-transparent ${isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : buttonClass(mode === 'rotate', 'rotate')}`}
            title={isNative ? 'Unlock Element first' : 'Rotate · E'}
          >
            <RotateCw className="w-5 h-5" />
            <span className="absolute -bottom-0.5 text-[7px] font-bold text-slate-500">E</span>
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleModeClick('stretch'); }}
            disabled={isNative}
            className={`relative flex items-center justify-center hci-transform-action hci-transform-action--resize w-10 h-10 rounded-xl border border-transparent ${isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : buttonClass(mode === 'stretch', 'resize')}`}
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
            className={`flex items-center justify-center hci-transform-action hci-transform-action--lock w-10 h-10 rounded-xl border border-transparent ${!isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : 'text-amber-300 bg-amber-500/8 hover:border-amber-400/25 hover:bg-amber-500/14 hover:text-amber-200'}`}
            title={isNative ? 'Unlock element for editing · U' : 'Editing already enabled'}
          >
            {isNative ? <Lock className="w-[17px] h-[17px]" /> : <Unlock className="w-[17px] h-[17px]" />}
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowMore((v) => !v); }}
            className={`flex items-center justify-center hci-transform-action w-10 h-10 rounded-xl border border-transparent ${showMore ? 'bg-white/8 text-white ring-1 ring-slate-600/70' : 'text-slate-400 hover:text-white hover:bg-white/6 hover:border-slate-700'}`}
            title="More options"
            aria-expanded={showMore}
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowHelp((v) => !v); setShowMore(false); }}
            className={`flex items-center justify-center hci-transform-action hci-transform-action--help w-9 h-9 rounded-xl border border-transparent ${showHelp ? 'bg-cyan-400/12 text-cyan-300 ring-1 ring-cyan-300/35' : 'text-cyan-300/75 hover:text-cyan-200 hover:bg-cyan-400/10 hover:border-cyan-300/20'}`}
            title="Transform help"
            aria-label="Transform help"
            aria-expanded={showHelp}
            aria-controls="transform-help-panel"
          >
            <CircleHelp className="w-[17px] h-[17px]" strokeWidth={2.35} />
          </button>
        </div>

        {mode === 'stretch' && !isNative && onResizeSubmodeChange && (
          <div
            className={`absolute right-0 w-[192px] rounded-2xl border border-amber-500/20 bg-[#0b1322]/98 backdrop-blur-2xl p-2 shadow-[0_18px_45px_rgba(0,0,0,0.42)] pointer-events-auto ${placement.above ? 'top-full mt-3' : 'bottom-full mb-3'}`}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-1.5 pb-1.5 mb-1.5 border-b border-slate-700/60">
              <div>
                <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-300">Resize by</div>
                <div className="text-[7px] text-slate-600 mt-0.5">Choose which grips to show</div>
              </div>
              <Scaling className="w-3.5 h-3.5 text-amber-300" />
            </div>

            <div className="space-y-1">
              {[
                { id: 'face', label: 'Face', hint: '1 axis', desc: 'Stretch one dimension', Icon: Square },
                { id: 'edge', label: 'Edge', hint: '2 axes', desc: 'Resize across two dimensions', Icon: Diamond },
                { id: 'corner', label: 'Corner', hint: '3 axes', desc: 'Resize in three dimensions', Icon: Box },
              ].map(({ id, label, hint, desc, Icon }) => {
                const active = resizeSubmode === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onResizeSubmodeChange(id); }}
                    className={`w-full flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition ${active ? 'border-amber-400/55 bg-amber-500/12 shadow-[0_0_0_1px_rgba(251,146,60,0.06)]' : 'border-slate-700/65 bg-slate-900/20 text-slate-500 hover:border-slate-500 hover:bg-white/[0.03] hover:text-slate-200'}`}
                    title={`${label}: ${hint}`}
                  >
                    <span className={`w-8 h-8 shrink-0 rounded-lg border flex items-center justify-center ${active ? 'border-amber-400/45 bg-amber-500/10 text-amber-300' : 'border-slate-700/70 bg-slate-950/20 text-slate-500'}`}>
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`flex items-center gap-1.5 text-[9px] font-semibold ${active ? 'text-amber-200' : 'text-slate-200'}`}>
                        {label}
                        <span className={`text-[7px] font-bold uppercase tracking-[0.12em] ${active ? 'text-amber-300/80' : 'text-slate-600'}`}>{hint}</span>
                      </span>
                      <span className="block text-[7px] mt-0.5 text-slate-500">{desc}</span>
                    </span>
                    <span className={`text-[11px] ${active ? 'text-amber-300' : 'text-slate-700'}`}>›</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {showHelp && (
          <div
            ref={helpRef}
            id="transform-help-panel"
            className={`fixed z-[160] w-[286px] p-3 rounded-2xl backdrop-blur-2xl border shadow-[0_18px_50px_rgba(0,0,0,0.5)] pointer-events-auto ${isDarkMode ? 'bg-[#07111d]/98 border-slate-700 text-slate-200' : 'bg-white/98 border-slate-200 text-slate-700'}`}
            style={{ left: helpPlacement.left, top: helpPlacement.top }}
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
            ref={moreRef}
            className="fixed z-[160] w-56 p-3 rounded-2xl bg-[#0b1322]/98 border border-slate-700 shadow-[0_18px_50px_rgba(0,0,0,0.5)] backdrop-blur-2xl pointer-events-auto"
            style={{ left: morePlacement.left, top: morePlacement.top }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {(onColorChange || onMaterialSelect) && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div><div className="text-[9px] font-bold text-slate-300 uppercase tracking-[0.15em]">Surface finish</div><div className="text-[8px] text-slate-600 mt-0.5">Color, fabric and texture are separate tools</div></div>
                  <span className="w-6 h-6 rounded-lg border border-slate-600 shadow-inner bg-cover bg-center" style={{ backgroundColor: selectedMaterial?.color || currentColor, backgroundImage: selectedMaterial?.texture?.src ? `url(${selectedMaterial.texture.src})` : 'none' }} />
                </div>
                <div className="flex p-1 rounded-lg bg-slate-900/80 border border-slate-700 mb-2">
                  {['color','fabric','texture'].map(tab => <button key={tab} type="button" onClick={(e)=>{e.stopPropagation();setMaterialMode(tab)}} className={`flex-1 py-1.5 rounded-md text-[8px] font-bold capitalize ${materialMode===tab ? 'bg-slate-700 text-white' : 'text-slate-500'}`}>{tab}</button>)}
                </div>
                {materialMode === 'color' ? (
                  <div className="grid grid-cols-5 gap-1.5">
                    {materialLibrary.filter(m => m.kind === 'color').map(material => <button key={material.id} type="button" title={material.name} onClick={(e)=>{e.stopPropagation();onMaterialSelect?.(material)}} style={{backgroundColor:material.color}} className={`aspect-square rounded-md border ${selectedMaterial?.kind==='color' && selectedMaterial?.color?.toUpperCase()===material.color.toUpperCase() ? 'border-[#ff914d] ring-1 ring-[#ff914d]/40' : 'border-slate-700'}`} />)}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5">
                    {materialLibrary.filter(m => m.kind === materialMode).map(material => <button key={material.id} type="button" onClick={(e)=>{e.stopPropagation();onMaterialSelect?.(material)}} className={`flex items-center gap-2 p-1.5 rounded-lg border text-left ${selectedMaterial?.kind===material.kind && selectedMaterial?.texture?.id===material.id ? 'border-[#ff914d] bg-orange-500/10' : 'border-slate-700 bg-slate-900/50'}`}>
                      <span className="w-7 h-7 rounded-md border border-white/10 bg-cover bg-center" style={{backgroundColor:material.color,backgroundImage:material.textureSrc?`url(${material.textureSrc})`:'none'}} />
                      <span className="text-[8px] text-slate-200 truncate">{material.name}</span>
                    </button>)}
                  </div>
                )}
                <div className="flex gap-2 mt-2">
                  <label className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-900/70 text-[9px] font-semibold text-slate-300 hover:border-slate-500 cursor-pointer"><Palette className="w-3 h-3"/> Custom color<input type="color" aria-label="Choose custom color" value={currentColor || '#FFFFFF'} className="sr-only" onChange={(e)=>onColorChange?.(e.target.value)} /></label>
                </div>
                {canApplyToAllWalls && onApplyMaterialToAllWalls && selectedMaterial && (
                  <button type="button" onClick={(e)=>{e.stopPropagation();onApplyMaterialToAllWalls(selectedMaterial)}} className="w-full mt-2.5 flex items-center justify-between px-2.5 py-2 rounded-lg border border-indigo-400/20 bg-indigo-500/8 text-indigo-200 hover:bg-indigo-500/15 hover:border-indigo-300/35 transition-colors"><span className="text-left"><span className="block text-[9px] font-bold">Apply finish to all walls</span><span className="block text-[7px] text-indigo-300/65 mt-0.5">Use the selected finish across every wall</span></span><span className="text-[8px] font-bold uppercase tracking-wider">Apply</span></button>
                )}
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

        {!showHelp && !showMore && (
          <div
            className={`absolute w-3 h-3 rotate-45 bg-[#0b1322] border-slate-700/80 ${placement.above ? 'left-5 -bottom-1.5 border-r border-b' : 'left-5 -top-1.5 border-l border-t'}`}
            aria-hidden="true"
          />
        )}
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
