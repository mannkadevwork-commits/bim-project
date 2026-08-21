import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Camera, ChevronDown, ChevronUp, CircleHelp, Expand, Eye, EyeOff,
  Fullscreen, Gauge, Minus, Move3d, Play, Plus, RotateCcw,
  RotateCw, Settings2, Square, StopCircle, Target, View, X,
} from 'lucide-react';
import { useWalkthroughEngine } from '../hooks/useWalkthroughEngine';

function IconButton({ title, onClick, children, active = false, disabled = false }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-xl border text-slate-200 transition ${active ? 'border-[#ff914d]/40 bg-[#ff914d]/15 text-[#ffb27a]' : 'border-transparent bg-white/[0.03] hover:border-white/10 hover:bg-white/[0.08] hover:text-white'} disabled:cursor-not-allowed disabled:opacity-40`}
    >{children}</button>
  );
}

const DEFAULT_HEIGHT_OFFSET = 0.35;
const MIN_HEIGHT_OFFSET = -0.45;
const MAX_HEIGHT_OFFSET = 1.0;
const DEFAULT_FOV = 110;

const LOCK_TOAST_CSS = `@keyframes walkLockFade { from { opacity: 0; transform: translateY(-6px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }`;

export default function WalkthroughPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const viewportRef = useRef(null);
  const [railOpen, setRailOpen] = useState(true);
  const [touring, setTouring] = useState(false);
  const [heightOffset, setHeightOffset] = useState(DEFAULT_HEIGHT_OFFSET);
  const [sensitivity, setSensitivity] = useState(0.0048);
  const [viewMode, setViewMode] = useState('overview');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [lockToast, setLockToast] = useState(false);
  const lockToastTimer = useRef(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [fov, setFov] = useState(DEFAULT_FOV);

  const walkthrough = useWalkthroughEngine({ containerRef: viewportRef, jobId });
  const areas = walkthrough.areas || [];

  useEffect(() => {
    if (Number.isFinite(walkthrough.heightOffsetMeters)) {
      setHeightOffset(Number(walkthrough.heightOffsetMeters.toFixed(2)));
    }
    if (Number.isFinite(walkthrough.cameraFov)) setFov(walkthrough.cameraFov);
  }, [walkthrough.heightOffsetMeters, walkthrough.cameraFov]);

  useEffect(() => {
    if (walkthrough.lookLocked === undefined) return;
    if (walkthrough.lookLocked) {
      setLockToast(true);
      clearTimeout(lockToastTimer.current);
      lockToastTimer.current = setTimeout(() => setLockToast(false), 2200);
    } else if (lockToast) {
      setLockToast(true);
      clearTimeout(lockToastTimer.current);
      lockToastTimer.current = setTimeout(() => setLockToast(false), 1400);
    }
    return () => clearTimeout(lockToastTimer.current);
  }, [walkthrough.lookLocked]);

  const statusText = useMemo(() => {
    if (walkthrough.status === 'loading') return 'Loading walkthrough…';
    if (walkthrough.status === 'error') return walkthrough.message || 'Walkthrough unavailable';
    if (walkthrough.message) return walkthrough.message;
    return viewMode === 'walk'
      ? (walkthrough.lookLocked ? 'View locked · double-click to unlock · W/A/S/D walk' : 'Free look · W/A/S/D walk · double-click to lock')
      : 'Overview · orbit / wheel zoom · W/A/S/D pan · Q/E zoom · click Start Walkthrough';
  }, [walkthrough.status, walkthrough.message, viewMode]);

  const applyFov = (value) => {
    const next = Number(value);
    setFov(next);
    walkthrough.setFov(next);
  };

  const applySensitivity = (value) => {
    const next = Number(value);
    setSensitivity(next);
    walkthrough.setSensitivity(next);
  };

  const applyHeight = (value) => {
    const next = Number(value);
    setHeightOffset(next);
    walkthrough.setHeightOffset(next);
  };

  const switchViewMode = (mode) => {
    setViewMode(mode);
    walkthrough.setViewMode(mode);
    setViewsOpen(false);
  };

  const handlePreset = (preset) => {
    walkthrough.setViewPreset(preset);
    setViewMode('overview');
    setViewsOpen(false);
  };

  const handleTour = async () => {
    if (touring) {
      walkthrough.stopTravel();
      setTouring(false);
      return;
    }
    if (!areas.length) return;
    setTouring(true);
    setViewMode('walk');
    walkthrough.setViewMode('walk');
    for (const area of areas) {
      if (!touring) break;
      // eslint-disable-next-line no-await-in-loop
      const ok = await walkthrough.travelTo(area);
      if (!ok) continue;
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    setTouring(false);
  };

  return (
    <>
      <style>{LOCK_TOAST_CSS}</style>
      <div className="relative h-screen w-screen overflow-hidden bg-slate-950 text-white">
      <div ref={viewportRef} className="absolute inset-0" />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center p-4">
        <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/72 px-4 py-2.5 shadow-2xl backdrop-blur-xl">
          <Move3d className="h-4 w-4 text-[#ff914d]" />
          <span className="text-sm font-semibold">{viewMode === 'walk' ? 'HCI Walkthrough' : 'HCI 3D Preview'}</span>
          <span className="text-xs text-slate-400">{jobId}</span>
        </div>
      </div>

      {/* {viewMode === 'overview' && walkthrough.status === 'ready' && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-40 flex -translate-y-1/2 justify-center">
          <div className="pointer-events-auto rounded-3xl border border-white/10 bg-slate-950/84 p-5 text-center shadow-[0_20px_80px_rgba(0,0,0,.45)] backdrop-blur-2xl">
            <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Interactive walkthrough</div>
            <div className="mt-1 text-lg font-semibold text-white">Explore the room in first-person</div>
            <div className="mt-1 text-xs text-slate-400">Start from the perspective preview, then walk freely with mouse + WASD.</div>
            <button
              type="button"
              onClick={() => switchViewMode('walk')}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#ff914d] px-5 py-3 text-sm font-bold text-slate-950 shadow-lg shadow-orange-500/20 transition hover:bg-[#ff7a28]"
            >
              <Play className="h-4 w-4" /> Start Walkthrough
            </button>
          </div>
        </div>
      )} */}

      <div className="absolute left-4 top-20 z-30 w-[270px] rounded-2xl border border-white/10 bg-slate-950/72 shadow-2xl backdrop-blur-xl">
        <button className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => setRailOpen((v) => !v)}>
          <div>
            <div className="text-sm font-semibold">Rooms</div>
            <div className="mt-0.5 text-[11px] text-slate-400">Quick room switch</div>
          </div>
          {railOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {railOpen && (
          <div className="max-h-[56vh] overflow-y-auto border-t border-white/10 p-2">
            {areas.map((area) => {
              const active = walkthrough.activeArea === area.label;
              return (
                <button
                  key={area.id || area.label}
                  type="button"
                  onClick={() => walkthrough.switchRoom(area)}
                  className={`mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${active ? 'bg-[#ff914d]/15 text-[#ffb27a]' : 'text-slate-200 hover:bg-white/5'}`}
                >
                  <span className={`h-2 w-2 rounded-full ${active ? 'bg-[#ff914d] shadow-[0_0_10px_rgba(255,145,77,.7)]' : 'border border-slate-500'}`} />
                  <span className="text-sm font-medium">{area.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {viewMode === 'walk' && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="h-2.5 w-2.5 rounded-full border border-white/80 bg-white/10 shadow-[0_0_16px_rgba(255,255,255,.45)]" />
        </div>
      )}

      {viewMode === 'overview' && (
        <div className="absolute right-8 top-1/2 z-30 flex -translate-y-1/2 flex-col rounded-2xl border border-white/10 bg-slate-950/72 p-1.5 shadow-2xl backdrop-blur-xl">
          <IconButton title="Zoom in" onClick={() => walkthrough.zoom(1)}><Plus className="h-4 w-4" /></IconButton>
          <IconButton title="Zoom out" onClick={() => walkthrough.zoom(-1)}><Minus className="h-4 w-4" /></IconButton>
          <div className="my-1 h-px bg-white/10" />
          <IconButton title="Fit model" onClick={() => walkthrough.fitView()}><Target className="h-4 w-4" /></IconButton>
        </div>
      )}

      {settingsOpen && (
        <div className="absolute bottom-24 left-1/2 z-40 w-[340px] -translate-x-1/2 rounded-2xl border border-white/10 bg-slate-950/92 p-4 shadow-2xl backdrop-blur-2xl">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Walk Controls</div>
              <div className="text-[11px] text-slate-400">Fine-tune how the camera feels.</div>
            </div>
            <IconButton title="Close controls" onClick={() => setSettingsOpen(false)}><X className="h-4 w-4" /></IconButton>
          </div>
          <div className="space-y-4">
            <label className="block">
              <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300"><span>Field of view (FOV)</span><span className="font-mono text-slate-500">{fov}°</span></div>
              <input className="w-full accent-[#ff914d]" type="range" min="30" max="110" step="1" value={fov} onChange={(e) => applyFov(e.target.value)} />
              <div className="mt-1 flex justify-between text-[10px] text-slate-500"><span>Narrow</span><span>Natural 60–80°</span><span>Wide</span></div>
            </label>
            <label className="block">
              <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300"><span>Mouse sensitivity</span><span className="font-mono text-slate-500">{sensitivity.toFixed(4)}</span></div>
              <input className="w-full accent-[#ff914d]" type="range" min="0.0015" max="0.009" step="0.0001" value={sensitivity} onChange={(e) => applySensitivity(e.target.value)} />
              <div className="mt-1 flex justify-between text-[10px] text-slate-500"><span>Precise</span><span>Fast</span></div>
            </label>
            <label className="block">
              <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300"><span>Camera height</span><span className="font-mono text-slate-500">{Number.isFinite(walkthrough.cameraHeightMeters) ? walkthrough.cameraHeightMeters.toFixed(2) : '1.95'}m</span></div>
              <input className="w-full accent-[#ff914d]" type="range" min={MIN_HEIGHT_OFFSET} max={MAX_HEIGHT_OFFSET} step="0.01" value={heightOffset} onChange={(e) => applyHeight(e.target.value)} />
              <div className="mt-1 flex justify-between text-[10px] text-slate-500"><span>1.15m</span><span>1.60m</span><span>2.60m+</span></div>
            </label>
            <div className="rounded-xl border border-[#ff914d]/15 bg-[#ff914d]/[0.05] px-3 py-2.5 text-[10px] leading-4 text-slate-400">
              <div className="mb-0.5 font-semibold text-[#ffb27a]">Camera reference</div>
              <div>Recommended interior range: <span className="text-slate-200">1.1–1.3m</span> height · <span className="text-slate-200">60–80°</span> FOV.</div>
              <div className="mt-0.5 text-slate-500">HCI walk default remains <span className="text-slate-300">{Number.isFinite(walkthrough.cameraHeightMeters) ? walkthrough.cameraHeightMeters.toFixed(2) : '1.95'}m · {fov}°</span> for the manager-approved view.</div>
            </div>
            <button type="button" onClick={() => { applyHeight(DEFAULT_HEIGHT_OFFSET); applyFov(DEFAULT_FOV); }} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.06]"><RotateCcw className="h-3.5 w-3.5" /> Reset camera height &amp; FOV</button>
          </div>
        </div>
      )}

      {viewsOpen && (
        <div className="absolute bottom-24 left-1/2 z-40 min-w-[210px] -translate-x-1/2 rounded-2xl border border-white/10 bg-slate-950/92 p-2 shadow-2xl backdrop-blur-2xl">
          <div className="px-3 pb-2 pt-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">Camera view</div>
          {[
            ['Top', 'top'], ['Front', 'front'], ['Side', 'side'], ['Perspective', 'perspective'], ['Isometric', 'isometric'],
          ].map(([label, key]) => (
            <button key={key} type="button" onClick={() => handlePreset(key)} className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm text-slate-200 hover:bg-white/[0.06]">
              <span>{label}</span><View className="h-4 w-4 text-slate-500" />
            </button>
          ))}
          <div className="my-1 h-px bg-white/10" />
          <button type="button" onClick={() => { const next = !autoRotate; setAutoRotate(next); walkthrough.setAutoRotate(next); switchViewMode('overview'); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-slate-200 hover:bg-white/[0.06]"><RotateCw className="h-4 w-4" /> Toggle auto rotate</button>
        </div>
      )}

      {moreOpen && (
        <div className="absolute bottom-24 left-1/2 z-40 min-w-[220px] -translate-x-1/2 rounded-2xl border border-white/10 bg-slate-950/92 p-2 shadow-2xl backdrop-blur-2xl">
          <button type="button" onClick={() => { walkthrough.fitView(); setMoreOpen(false); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-slate-200 hover:bg-white/[0.06]"><Target className="h-4 w-4" /> Fit model</button>
          <button type="button" onClick={() => { setSettingsOpen(true); setMoreOpen(false); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-slate-200 hover:bg-white/[0.06]"><Gauge className="h-4 w-4" /> Walk sensitivity & height</button>
          <button type="button" onClick={() => { const next = !autoRotate; setAutoRotate(next); walkthrough.setAutoRotate(next); setMoreOpen(false); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-slate-200 hover:bg-white/[0.06]"><RotateCw className="h-4 w-4" /> Auto rotate</button>
          <button type="button" onClick={() => { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); setMoreOpen(false); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-slate-200 hover:bg-white/[0.06]"><Fullscreen className="h-4 w-4" /> Fullscreen</button>
        </div>
      )}

      {helpOpen && (
        <div className="absolute bottom-24 right-5 z-40 w-[300px] rounded-2xl border border-white/10 bg-slate-950/92 p-4 text-sm text-slate-300 shadow-2xl backdrop-blur-2xl">
          <div className="mb-3 flex items-center justify-between"><span className="font-semibold text-white">Walkthrough help</span><IconButton title="Close help" onClick={() => setHelpOpen(false)}><X className="h-4 w-4" /></IconButton></div>
          <div className="space-y-2 text-xs leading-5 text-slate-400">
            <div><b className="text-slate-200">Walk:</b> mouse looks freely · W/A/S/D moves · Shift runs · Q/E adjust height.</div>
            <div><b className="text-slate-200">Overview:</b> W/A/S/D pan · Q/E zoom · mouse orbit · wheel zoom · +/- keys zoom.</div>
            <div><b className="text-slate-200">Rooms:</b> left rail switches instantly between semantic room destinations.</div>
            <div><b className="text-slate-200">Views:</b> Top/Front/Side/Perspective/Isometric presets + Fit model.</div>
            <div><b className="text-slate-200">Look lock:</b> double-click the 3D scene to lock your current view. Double-click again to unlock.</div>
          </div>
        </div>
      )}

      <div className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-white/10 bg-slate-950/82 p-2 shadow-2xl backdrop-blur-2xl">
        <IconButton title="Exit walkthrough" onClick={() => navigate('/')}><ArrowLeft className="h-4 w-4" /></IconButton>
        <div className="mx-1 h-7 w-px bg-white/10" />
        {viewMode === 'overview' ? (
          <button type="button" onClick={() => switchViewMode('walk')} className="flex h-9 items-center gap-2 rounded-xl bg-[#ff914d] px-3 text-xs font-bold text-slate-950 transition hover:bg-[#ff7a28]">
            <Play className="h-4 w-4" /> Start Walkthrough
          </button>
        ) : (
          <IconButton title="Walk mode" active onClick={() => switchViewMode('walk')}><Move3d className="h-4 w-4" /></IconButton>
        )}
        <IconButton title="Camera views" active={viewsOpen} onClick={() => { setViewsOpen((v) => !v); setMoreOpen(false); setSettingsOpen(false); }}><Camera className="h-4 w-4" /></IconButton>
        <IconButton title="Walk settings" active={settingsOpen} onClick={() => { setSettingsOpen((v) => !v); setViewsOpen(false); setMoreOpen(false); }}><Settings2 className="h-4 w-4" /></IconButton>
        <IconButton title="More controls" active={moreOpen} onClick={() => { setMoreOpen((v) => !v); setViewsOpen(false); setSettingsOpen(false); }}><ChevronUp className="h-4 w-4" /></IconButton>
        <IconButton title={helpOpen ? 'Close help' : 'Help'} active={helpOpen} onClick={() => setHelpOpen((v) => !v)}><CircleHelp className="h-4 w-4" /></IconButton>
        <div className="mx-1 h-7 w-px bg-white/10" />
        {/* <button type="button" onClick={handleTour} disabled={!areas.length} className={`flex h-9 items-center gap-2 rounded-xl px-3 text-xs font-semibold transition ${touring ? 'bg-white text-slate-950' : 'bg-[#ff914d] text-slate-950 hover:bg-[#ff7a28]'}`}>
          {touring ? <><StopCircle className="h-4 w-4" /> Stop</> : <><Play className="h-4 w-4" /> Tour</>}
        </button> */}
      </div>

      {lockToast && (
        <div className="pointer-events-none absolute left-1/2 top-24 z-50 -translate-x-1/2" style={{ animation: 'walkLockFade 180ms ease-out' }}>
          <div className="rounded-full border border-white/10 bg-slate-950/82 px-4 py-2 text-xs font-medium text-white shadow-2xl backdrop-blur-xl">
            {walkthrough.lookLocked ? 'View locked · double-click to unlock' : 'View unlocked · free look restored'}
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute left-1/2 top-16 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-slate-950/70 px-4 py-2 text-xs text-slate-300 shadow-xl backdrop-blur-xl">
        {statusText}
      </div>
      </div>
    </>
  );
}