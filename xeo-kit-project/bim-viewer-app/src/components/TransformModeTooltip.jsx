import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { positionPopoverInViewport } from './positionPopoverInViewport.mjs';
import { Move, RotateCw, Scaling, Lock, Unlock, MoreHorizontal, Trash2, Palette, CircleHelp, CopyPlus, Square, Diamond, Box, Search, X, Check, Eye, Crosshair, RefreshCw } from 'lucide-react';

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
  selectionCount = 1,
  selectedElements = [],
  isMultiSelection = false,
  multiSelectMode = false,
  onMaterialSelect,
  canApplyToAllWalls = false,
  onApplyToAllWalls,
  onApplyMaterialToAllWalls,
  wallSurfaceScope = 'both',
  onWallSurfaceScopeChange,
  isNative,
  onIsolate,
  onToggleMultiSelect,
  onOpenAppearance,
  onReplaceAsset,
  canReplaceAsset = false,
  onOpen360Walkthrough,
  onFocusSelection,

  isDarkMode = true,
  resizeSubmode = 'face',
  onResizeSubmodeChange,
}) => {
  const [showMore, setShowMore] = useState(false);
  const [materialMode, setMaterialMode] = useState('color');
  const [showHelp, setShowHelp] = useState(false);
  const [materialSearch, setMaterialSearch] = useState('');
  const [lastPickedMaterial, setLastPickedMaterial] = useState(null);
  const [placement] = useState({ above: false });
  const [helpPlacement, setHelpPlacement] = useState({ left: 0, top: 0, side: 'below' });
  const [morePlacement, setMorePlacement] = useState({ left: 0, top: 0, side: 'above', maxHeight: 360 });
  const selectionKey = selectedElements.map((item) => item?.id).filter(Boolean).join('|');
  const moreRef = useRef(null);
  const moreButtonRef = useRef(null);
  const toolbarRef = useRef(null);
  const helpRef = useRef(null);
  const helpButtonRef = useRef(null);


  const getViewportRect = () => {
    const viewport = window.visualViewport;
    const left = Number.isFinite(viewport?.offsetLeft) ? viewport.offsetLeft : 0;
    const top = Number.isFinite(viewport?.offsetTop) ? viewport.offsetTop : 0;
    const width = Number.isFinite(viewport?.width) ? viewport.width : window.innerWidth;
    const height = Number.isFinite(viewport?.height) ? viewport.height : window.innerHeight;
    return { left, top, width, height };
  };

  const positionAnchoredPopover = (anchorRef, popoverRef, setState, preferredSide = 'above', requestedMaxHeight = 560) => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const popover = popoverRef.current?.getBoundingClientRect();
    if (!anchor || !popover) return;
    const intrinsicContentHeight = popoverRef.current?.scrollHeight;
    const position = positionPopoverInViewport({
      anchor,
      popover: { ...popover, contentHeight: intrinsicContentHeight },
      viewport: getViewportRect(),
      preferredSide,
      requestedMaxHeight,
    });
    if (position) setState(position);
  };

  const positionMorePopover = () => positionAnchoredPopover(moreButtonRef, moreRef, setMorePlacement, 'above', 560);
  const positionHelpPopover = () => positionAnchoredPopover(helpButtonRef, helpRef, setHelpPlacement, placement.above ? 'above' : 'below', 460);

  useLayoutEffect(() => {
    if (!showMore) return undefined;
    const frame = requestAnimationFrame(positionMorePopover);
    return () => cancelAnimationFrame(frame);
  }, [showMore, placement, materialMode, materialSearch]);

  useLayoutEffect(() => {
    if (!showHelp) return undefined;
    const frame = requestAnimationFrame(positionHelpPopover);
    return () => cancelAnimationFrame(frame);
  }, [showHelp, placement]);

  useEffect(() => {
    if (!showHelp && !showMore) return undefined;
    let frame = 0;
    const handler = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (showMore) positionMorePopover();
        if (showHelp) positionHelpPopover();
      });
    };
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    window.visualViewport?.addEventListener('resize', handler);
    window.visualViewport?.addEventListener('scroll', handler);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
      window.visualViewport?.removeEventListener('resize', handler);
      window.visualViewport?.removeEventListener('scroll', handler);
    };
  }, [showHelp, showMore, placement]);

  useEffect(() => {
    setMaterialSearch('');
    setLastPickedMaterial(null);
    setShowMore(false);
  }, [assetName, selectionCount, isMultiSelection, selectionKey]);

  useEffect(() => {
    if (selectedMaterial) setLastPickedMaterial(selectedMaterial);
  }, [selectedMaterial]);

  useEffect(() => {
    if (!showMore) return undefined;
    const handleOutsidePointer = (event) => {
      if (!toolbarRef.current?.contains(event.target) && !moreRef.current?.contains(event.target)) setShowMore(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setShowMore(false);
    };
    document.addEventListener('pointerdown', handleOutsidePointer);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showMore]);

  const filteredTooltipMaterials = materialLibrary.filter((material) => {
    if (material.kind !== materialMode) return false;
    const query = materialSearch.trim().toLowerCase();
    if (!query) return true;
    return [material.name, material.category, material.brand, material.collection, material.shadeCode,
      material.shade_code, material.color, material.slug].filter(Boolean).join(' ').toLowerCase().includes(query);
  });

  const colorDefinitionFromHex = (hex) => {
    const safeHex = /^#[0-9a-f]{6}$/i.test(String(hex || '')) ? String(hex).toUpperCase() : '#FFFFFF';
    const rgb = [1, 3, 5].map((offset) => Number.parseInt(safeHex.slice(offset, offset + 2), 16) / 255);
    return { id: `custom-${safeHex}`, kind: 'color', name: `Custom ${safeHex}`, color: safeHex, rgb, roughness: 0.8, metallic: 0 };
  };

  const materialIsSelected = (material) => {
    if (!selectedMaterial || selectedMaterial.kind !== material.kind) return false;
    if (material.kind === 'color') return String(selectedMaterial.color || '').toUpperCase() === String(material.color || '').toUpperCase();
    return [material.id, material.materialAssetId, material.slug].filter(Boolean).some((id) => (
      id === selectedMaterial.id || id === selectedMaterial.materialAssetId || id === selectedMaterial.slug
      || id === selectedMaterial.texture?.id
    ));
  };

  const currentBulkMaterial = (() => {
    if (lastPickedMaterial?.kind === materialMode) return lastPickedMaterial;
    if (selectedMaterial?.kind === materialMode) return selectedMaterial;
    // Never offer bulk apply with an accidental default white. A finish must
    // be explicitly selected or customized first.
    return null;
  })();

  const handleMaterialPick = (material) => {
    setLastPickedMaterial(material);
    onMaterialSelect?.(material, wallSurfaceScope);
  };

  const handleCustomColorPick = (hex) => {
    const material = colorDefinitionFromHex(hex);
    setLastPickedMaterial(material);
    onColorChange?.(hex, wallSurfaceScope);
  };

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
      className="fixed bottom-[108px] left-1/2 z-[120] max-w-[calc(100vw-24px)] -translate-x-1/2 pointer-events-none"
      aria-label="Transform toolbar"
    >
      <div className={`relative ${placement.above ? 'origin-bottom-left' : 'origin-top-left'}`}>
        <div
          className="flex max-w-[calc(100vw-24px)] items-center gap-1.5 overflow-x-auto overscroll-x-contain rounded-2xl border border-slate-700/80 bg-[#0b1322]/96 px-2 py-2 shadow-[0_18px_50px_rgba(0,0,0,0.45)] backdrop-blur-2xl pointer-events-auto"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-2.5 min-w-0 max-w-[330px]">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold text-white truncate" title={assetName}>
                {isMultiSelection ? `${selectionCount} elements selected` : (assetName || 'Selected element')}
              </div>
              <div className="text-[8px] uppercase tracking-[0.17em] text-slate-500 mt-0.5">
                {isMultiSelection ? 'Multi-selection' : (isNative ? 'Native element' : 'Editable transform')}
              </div>
              {selectedElements.length > 1 && (
                <div className="mt-1.5 flex items-center gap-1.5 overflow-hidden">
                  {selectedElements.slice(0, 3).map((item) => (
                    <span key={item.id} className="max-w-[105px] truncate rounded-md border border-slate-700/80 bg-slate-800/80 px-1.5 py-0.5 text-[8px] text-slate-300" title={item.name}>
                      {item.name || item.type || 'Element'}
                    </span>
                  ))}
                  {selectedElements.length > 3 && (
                    <span className="shrink-0 text-[8px] text-slate-500">+{selectedElements.length - 3} more</span>
                  )}
                </div>
              )}
            </div>
            <span className={`shrink-0 text-[8px] px-1.5 py-0.5 rounded-md font-bold uppercase tracking-wider ${isNative ? 'bg-slate-700 text-slate-100 border border-slate-600' : 'bg-[#ff914d]/12 text-[#ffb07a] border border-[#ff914d]/25'}`}>
              {isMultiSelection ? `${selectionCount} selected` : (isNative ? 'Native' : 'Editable')}
            </span>
          </div>

          <div className="w-px h-7 bg-slate-700/70" />

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleModeClick('move'); }}
            disabled={isNative || isMultiSelection}
            className={`relative flex items-center justify-center hci-transform-action hci-transform-action--move w-10 h-10 rounded-xl border border-transparent ${isNative || isMultiSelection ? 'opacity-30 cursor-not-allowed text-slate-500' : buttonClass(mode === 'move', 'move')}`}
            title={isNative ? 'Unlock Element first' : 'Move · W'}
          >
            <Move className="w-5 h-5" />
            <span className="absolute -bottom-0.5 text-[7px] font-bold text-slate-500">W</span>
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleModeClick('rotate'); }}
            disabled={isNative || isMultiSelection}
            className={`relative flex items-center justify-center hci-transform-action hci-transform-action--rotate w-10 h-10 rounded-xl border border-transparent ${isNative || isMultiSelection ? 'opacity-30 cursor-not-allowed text-slate-500' : buttonClass(mode === 'rotate', 'rotate')}`}
            title={isNative ? 'Unlock Element first' : 'Rotate · E'}
          >
            <RotateCw className="w-5 h-5" />
            <span className="absolute -bottom-0.5 text-[7px] font-bold text-slate-500">E</span>
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleModeClick('stretch'); }}
            disabled={isNative || isMultiSelection}
            className={`relative flex items-center justify-center hci-transform-action hci-transform-action--resize w-10 h-10 rounded-xl border border-transparent ${isNative || isMultiSelection ? 'opacity-30 cursor-not-allowed text-slate-500' : buttonClass(mode === 'stretch', 'resize')}`}
            title={isNative ? 'Unlock Element first' : 'Resize · R'}
          >
            <Scaling className="w-5 h-5" />
            <span className="absolute -bottom-0.5 text-[7px] font-bold text-slate-500">R</span>
          </button>

          <div className="w-px h-7 bg-slate-700/70 mx-0.5" />

          {onFocusSelection && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onFocusSelection(); }}
              className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-2.5 text-emerald-200 transition hover:border-emerald-300/50 hover:bg-emerald-500/18 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff914d]"
              title="Focus item — centre the selected object in the 3D view"
              aria-label="Focus selected item"
            >
              <Crosshair className="h-4 w-4" />
              <span className="whitespace-nowrap text-[9px] font-bold">Focus item</span>
            </button>
          )}

          {!isMultiSelection && <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (isNative && onIsolate) onIsolate(); }}
            disabled={!isNative || !onIsolate}
            className={`flex items-center justify-center hci-transform-action hci-transform-action--lock w-10 h-10 rounded-xl border border-transparent ${!isNative ? 'opacity-30 cursor-not-allowed text-slate-500' : 'text-amber-300 bg-amber-500/8 hover:border-amber-400/25 hover:bg-amber-500/14 hover:text-amber-200'}`}
            title={isNative ? 'Unlock element for editing · U' : 'Editing already enabled'}
          >
            {isNative ? <Lock className="w-[17px] h-[17px]" /> : <Unlock className="w-[17px] h-[17px]" />}
          </button>}

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMultiSelect?.();
            }}
            className={`flex h-10 items-center gap-1.5 rounded-xl border px-2.5 transition-colors ${multiSelectMode ? 'border-cyan-300/25 bg-cyan-400/12 text-cyan-200 ring-1 ring-cyan-300/20' : 'border-slate-700/80 bg-slate-900/30 text-slate-300 hover:border-cyan-300/20 hover:bg-cyan-400/8 hover:text-cyan-200'}`}
            title={multiSelectMode ? 'Multi-select ON · click again or press Esc to finish' : 'Enable multi-select'}
            aria-label={multiSelectMode ? 'Exit multi-select mode' : 'Enable multi-select'}
          >
            <CopyPlus className="w-[17px] h-[17px]" strokeWidth={2.25} />
            <span className="text-[8px] font-bold uppercase tracking-wider">Multi-select</span>
            <span className={`rounded-md px-1.5 py-0.5 text-[7px] font-extrabold tracking-wider ${multiSelectMode ? 'bg-cyan-300/15 text-cyan-200' : 'bg-slate-800 text-slate-500'}`}>
              {multiSelectMode ? 'ON' : 'OFF'}
            </span>
          </button>

          {(onOpenAppearance || onReplaceAsset || onFocusSelection || onOpen360Walkthrough) && <div className="w-px h-7 bg-slate-700/70 mx-0.5" />}

          {onReplaceAsset && canReplaceAsset && !isMultiSelection && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowMore(false); onReplaceAsset(); }}
              className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-sky-400/25 bg-sky-500/10 px-2.5 text-sky-200 transition hover:border-sky-300/45 hover:bg-sky-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff914d]"
              title="Replace this furniture item with another catalogue model"
              aria-label="Replace selected item"
            >
              <RefreshCw className="h-4 w-4" />
              <span className="hidden 2xl:inline text-[9px] font-bold">Replace</span>
            </button>
          )}

          {onOpenAppearance && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowMore(false); onOpenAppearance(); }}
              className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-[#ff914d]/25 bg-[#ff914d]/10 px-2.5 text-[#ffb07a] transition hover:border-[#ff914d]/50 hover:bg-[#ff914d]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff914d]"
              title="Open color, fabric and texture options for the selected element"
              aria-label="Customize appearance"
            >
              <Palette className="h-4 w-4" />
              <span className="hidden 2xl:inline text-[9px] font-bold">Finish</span>
            </button>
          )}

          {onOpen360Walkthrough && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowMore(false); onOpen360Walkthrough(); }}
              className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-emerald-400/20 bg-emerald-500/8 px-2.5 text-emerald-200 transition hover:border-emerald-300/40 hover:bg-emerald-500/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff914d]"
              title="Open the 360° walkthrough render setup"
              aria-label="Open 360 degree walkthrough"
            >
              <Eye className="h-4 w-4" />
              <span className="hidden 2xl:inline text-[9px] font-bold">360 Tour</span>
            </button>
          )}

          <button
            ref={moreButtonRef}
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowMore((v) => !v); setShowHelp(false); }}
            className={`flex items-center justify-center hci-transform-action w-10 h-10 rounded-xl border border-transparent ${showMore ? 'bg-white/8 text-white ring-1 ring-slate-600/70' : 'text-slate-400 hover:text-white hover:bg-white/6 hover:border-slate-700'}`}
            title="More options"
            aria-expanded={showMore}
            aria-controls="transform-more-panel"
          >
            <MoreHorizontal className="w-4 h-4" />
            <span className="text-[9px] font-bold">More</span>
          </button>

          <button
            ref={helpButtonRef}
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
                { id: 'face', label: 'Side', hint: '1 dimension', desc: 'Change width, height, or depth', Icon: Square },
                { id: 'edge', label: 'Edge', hint: '2 dimensions', desc: 'Resize two dimensions together', Icon: Diamond },
                { id: 'corner', label: 'Corner', hint: '3 dimensions', desc: 'Resize all three dimensions', Icon: Box },
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

        {showHelp && typeof document !== 'undefined' && createPortal(
          <div
            ref={helpRef}
            id="transform-help-panel"
            className={`fixed z-[160] w-[286px] p-3 rounded-2xl backdrop-blur-2xl border shadow-[0_18px_50px_rgba(0,0,0,0.5)] pointer-events-auto ${isDarkMode ? 'bg-[#07111d]/98 border-slate-700 text-slate-200' : 'bg-white/98 border-slate-200 text-slate-700'}`}
            style={{ left: helpPlacement.left, top: helpPlacement.top, maxHeight: `${helpPlacement.maxHeight || 460}px`, overflowY: 'auto' }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className={`text-[9px] font-bold uppercase tracking-[0.15em] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Transform controls</div>
              <span className="text-[8px] font-semibold px-1.5 py-0.5 rounded-md border border-[#ff914d]/25 bg-[#ff914d]/10 text-[#ffb07a]">HCI</span>
            </div>
            <div className="space-y-2.5">
              <HelpRow tone="move" icon={<Move className="w-4 h-4" />} title="Move" text="Drag the four-way move control to reposition the asset on the floor plane." isDarkMode={isDarkMode} />
              <HelpRow tone="rotate" icon={<RotateCw className="w-4 h-4" />} title="Rotate" text="Drag the circular arrow on the left or right side of the object. The highlighted arrow shows the active rotation direction." isDarkMode={isDarkMode} />
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-2.5">
                <HelpRow tone="resize" icon={<Scaling className="w-4 h-4" />} title="Resize" text="Choose Resize, then drag a Side arrow for one dimension. Use Edge or Corner grips when you need to change multiple dimensions together." isDarkMode={isDarkMode} />
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
          </div>,
          document.body,
        )}

        {showMore && typeof document !== 'undefined' && createPortal(
          <div
            id="transform-more-panel"
            ref={moreRef}
            className="fixed z-[160] flex flex-col overflow-hidden rounded-2xl border border-slate-700 bg-[#0b1322]/[0.98] shadow-[0_18px_50px_rgba(0,0,0,0.5)] backdrop-blur-2xl pointer-events-auto"
            style={{ position: 'fixed', left: morePlacement.left, top: morePlacement.top, width: morePlacement.width || 'min(360px, calc(100vw - 24px))', maxHeight: `${morePlacement.maxHeight || 560}px`, overflowY: 'auto', overscrollBehavior: 'contain' }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {(onColorChange || onMaterialSelect) && (
              <>
                <div className="shrink-0 border-b border-slate-800/90 p-3 pb-2.5">
                  <div className="mb-2.5 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-200">Surface finish</div>
                      <div className="mt-1 text-[9px] leading-4 text-slate-500">
                        {isMultiSelection ? `Selecting a finish applies it to ${selectionCount} selected elements.` : 'Choose a color, fabric or texture.'}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="h-7 w-7 rounded-lg border border-slate-600 bg-cover bg-center shadow-inner" style={{ backgroundColor: selectedMaterial?.color || currentColor, backgroundImage: selectedMaterial?.textureSrc || selectedMaterial?.texture?.src ? `url(${selectedMaterial?.textureSrc || selectedMaterial?.texture?.src})` : 'none' }} />
                      <button type="button" onClick={(e) => { e.stopPropagation(); setShowMore(false); }} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white" aria-label="Close surface finish palette" title="Close palette">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {canApplyToAllWalls && (
                    <div className="mb-2.5 flex items-center justify-between gap-2 rounded-lg border border-indigo-400/20 bg-indigo-500/8 px-2.5 py-2">
                      <div className="min-w-0">
                        <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-indigo-200">Wall side</div>
                        <div className="mt-0.5 text-[8px] text-slate-500">For wall finishes</div>
                      </div>
                      <select value={wallSurfaceScope} onChange={(e) => { e.stopPropagation(); onWallSurfaceScopeChange?.(e.target.value); }} className="max-w-[145px] rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-[9px] font-bold text-slate-200 outline-none">
                        <option value="interior">Interior</option>
                        <option value="exterior">Exterior</option>
                        <option value="both">Both sides</option>
                      </select>
                    </div>
                  )}

                  <div className="mb-2 flex rounded-lg border border-slate-700 bg-slate-900/80 p-1">
                    {['color', 'fabric', 'texture'].map((tab) => (
                      <button key={tab} type="button" onClick={(e) => { e.stopPropagation(); setMaterialMode(tab); setMaterialSearch(''); }} className={`flex-1 rounded-md py-1.5 text-[9px] font-bold capitalize transition-colors ${materialMode === tab ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-200'}`}>
                        {tab === 'color' ? 'Color' : tab === 'fabric' ? 'Fabric' : 'Texture'}
                      </button>
                    ))}
                  </div>

                  <label className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/80 px-2.5 py-2 focus-within:border-slate-500">
                    <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    <input value={materialSearch} onChange={(e) => setMaterialSearch(e.target.value)} placeholder={`Search ${materialMode === 'color' ? 'colors' : materialMode === 'fabric' ? 'fabrics' : 'textures'}…`} aria-label={`Search ${materialMode} materials`} className="min-w-0 flex-1 bg-transparent text-[10px] text-slate-100 outline-none placeholder:text-slate-600" />
                    {materialSearch && <button type="button" onClick={() => setMaterialSearch('')} aria-label="Clear material search" className="text-slate-500 hover:text-white"><X className="h-3 w-3" /></button>}
                  </label>
                  <div className="mt-1.5 text-[8px] text-slate-500">{filteredTooltipMaterials.length} {materialMode === 'color' ? 'colors' : materialMode === 'fabric' ? 'fabrics' : 'textures'}</div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pt-2" style={{ maxHeight: 'min(300px, 34vh)' }}>
                  {materialMode === 'color' ? (
                    <div className="grid grid-cols-4 gap-1.5">
                      {filteredTooltipMaterials.map((material) => (
                        <button key={material.id} type="button" title={`${material.name} · ${material.color || '#FFFFFF'}`} aria-label={`Apply ${material.name || material.color}`} onClick={(e) => { e.stopPropagation(); handleMaterialPick(material); }} className={`flex min-w-0 flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors ${materialIsSelected(material) ? 'border-[#ff914d] bg-orange-500/10 ring-1 ring-[#ff914d]/30' : 'border-slate-700 bg-slate-900/45 hover:border-slate-500'}`}>
                          <span className="h-7 w-full rounded-md border border-white/10" style={{ backgroundColor: material.color || '#FFFFFF' }} />
                          <span className="w-full truncate text-[8px] font-medium text-slate-300">{material.name || material.color}</span>
                          <span className="font-mono text-[7px] text-slate-500">{String(material.color || '#FFFFFF').toUpperCase()}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-1.5">
                      {filteredTooltipMaterials.map((material) => (
                        <button key={material.id} type="button" title={material.name} aria-label={`Apply ${material.name}`} onClick={(e) => { e.stopPropagation(); handleMaterialPick(material); }} className={`flex min-w-0 items-center gap-2 rounded-lg border p-1.5 text-left transition-colors ${materialIsSelected(material) ? 'border-[#ff914d] bg-orange-500/10 ring-1 ring-[#ff914d]/25' : 'border-slate-700 bg-slate-900/45 hover:border-slate-500'}`}>
                          <span className="h-9 w-9 shrink-0 rounded-md border border-white/10 bg-cover bg-center" style={{ backgroundColor: material.color || '#FFFFFF', backgroundImage: (material.textureSrc || material.texture?.src) ? `url(${material.textureSrc || material.texture.src})` : 'none' }} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[9px] font-semibold text-slate-200">{material.name}</span>
                            <span className="mt-0.5 block truncate text-[8px] text-slate-500">{material.category || material.brand || 'Surface finish'}</span>
                          </span>
                          {materialIsSelected(material) && <Check className="h-3 w-3 shrink-0 text-[#ff914d]" />}
                        </button>
                      ))}
                    </div>
                  )}
                  {!filteredTooltipMaterials.length && (
                    <div className="rounded-lg border border-dashed border-slate-700 px-3 py-6 text-center">
                      <div className="text-[10px] font-semibold text-slate-300">{materialLibrary.some((material) => material.kind === materialMode) ? 'No matching finishes' : `No ${materialMode === 'color' ? 'colors' : materialMode === 'fabric' ? 'fabrics' : 'textures'} available`}</div>
                      <div className="mt-1 text-[9px] text-slate-500">{materialSearch ? 'Try another search term.' : 'Add materials from Admin → Surface Materials.'}</div>
                    </div>
                  )}
                </div>

                <div className="shrink-0 space-y-2 border-t border-slate-800 bg-[#0b1322]/98 p-3">
                  {onColorChange && (
                    <div className="flex items-center gap-2">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/70 px-2.5 py-2 text-[9px] font-semibold text-slate-200 transition hover:border-slate-500">
                        <span className="h-5 w-5 shrink-0 rounded-md border border-white/10" style={{ backgroundColor: currentColor || '#FFFFFF' }} />
                        <span className="min-w-0 flex-1">Custom color <span className="ml-1 font-mono text-slate-500">{String(currentColor || '#FFFFFF').toUpperCase()}</span></span>
                        <input type="color" aria-label="Choose custom material color" value={currentColor || '#FFFFFF'} className="sr-only" onChange={(e) => handleCustomColorPick(e.target.value)} />
                      </label>
                    </div>
                  )}

                  {isMultiSelection && currentBulkMaterial && onMaterialSelect && (
                    <button type="button" onClick={(e) => { e.stopPropagation(); onMaterialSelect(currentBulkMaterial, wallSurfaceScope); }} className="flex w-full items-center justify-between gap-2 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-3 py-2 text-left text-emerald-100 transition hover:bg-emerald-500/15">
                      <span><span className="block text-[9px] font-bold">Apply to all {selectionCount} selected</span><span className="mt-0.5 block text-[8px] text-emerald-200/60">Current: {currentBulkMaterial.name || currentBulkMaterial.color || 'selected finish'}</span></span>
                      <span className="text-[8px] font-bold uppercase tracking-wider">Apply</span>
                    </button>
                  )}

                  {canApplyToAllWalls && onApplyMaterialToAllWalls && currentBulkMaterial && (
                    <button type="button" onClick={(e) => { e.stopPropagation(); onApplyMaterialToAllWalls(currentBulkMaterial, wallSurfaceScope); }} className="flex w-full items-center justify-between gap-2 rounded-lg border border-indigo-400/25 bg-indigo-500/10 px-3 py-2 text-left text-indigo-100 transition hover:bg-indigo-500/15">
                      <span><span className="block text-[9px] font-bold">Apply to all walls</span><span className="mt-0.5 block text-[8px] text-indigo-200/60">Uses the current finish and wall side</span></span>
                      <span className="text-[8px] font-bold uppercase tracking-wider">Apply</span>
                    </button>
                  )}

                  {onDelete && (
                    <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); setShowMore(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[10px] font-semibold text-rose-400 transition hover:bg-rose-500/10 hover:text-rose-300">
                      <Trash2 className="h-3.5 w-3.5" />
                      {isMultiSelection ? `Delete ${selectionCount} elements` : 'Delete element'}
                    </button>
                  )}
                </div>
              </>
            )}
            {!onColorChange && !onMaterialSelect && onDelete && (
              <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); setShowMore(false); }} className="flex w-full items-center gap-2 p-3 text-left text-xs font-semibold text-rose-400 hover:bg-rose-500/10">
                <Trash2 className="h-4 w-4" /> Delete element
              </button>
            )}
          </div>,
          document.body,
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
