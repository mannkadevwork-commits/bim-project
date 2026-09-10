import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Camera, ChevronDown, ChevronUp, CircleHelp, Fullscreen, Gauge,
  Minus, Map, Move3d, MousePointer2, Play, Plus, RotateCcw, RotateCw,
  Settings2, Target, View, X,
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

const LOCK_TOAST_CSS = `@keyframes walkLockFade { from { opacity: 0; transform: translateY(-6px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }`;

export default function WalkthroughPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const viewportRef = useRef(null);
  const [railOpen, setRailOpen] = useState(true);
  const [touring, setTouring] = useState(false);
  const [heightOffset, setHeightOffset] = useState(0.35);
  const [sensitivity, setSensitivity] = useState(0.0048);
  const [viewMode, setViewMode] = useState('overview');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [lockToast, setLockToast] = useState(false);
  const lockToastTimer = useRef(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [fov, setFov] = useState(120);
  const [walkMode, setWalkMode] = useState('guided');

  const walkthrough = useWalkthroughEngine({ containerRef: viewportRef, jobId });
  const navigationPlan = walkthrough.navigationPlan || null;
  const navigationHotspots = navigationPlan?.hotspots || [];
  const effectiveWalkMode = walkthrough.walkMode || walkMode;

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
    if (walkthrough.stuck) return 'Navigation paused · choose a nearby floor marker or reposition safely';
    if (walkthrough.message) return walkthrough.message;
    if (viewMode === 'overview') return 'Preview · orbit and zoom · click Start Walkthrough';
    if (effectiveWalkMode === 'guided') return 'Guided · click a floor destination to move · camera slowly pans automatically';
    return walkthrough.lookLocked
      ? 'Explore · view locked · double-click to unlock'
      : 'Explore · move with W/A/S/D · move mouse to look';
  }, [walkthrough.status, walkthrough.message, viewMode, effectiveWalkMode, walkthrough.lookLocked]);

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

  const switchWalkMode = (mode) => {
    setWalkMode(mode);
    walkthrough.setWalkMode(mode);
    if (mode === 'guided') {
      walkthrough.setLookLocked(true);
    } else {
      walkthrough.setLookLocked(false);
    }
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
    if (!navigationHotspots.length) return;
    setTouring(true);
    setViewMode('walk');
    setWalkMode('guided');
    walkthrough.setWalkMode('guided');
    walkthrough.setViewMode('walk');
    for (const hotspot of navigationHotspots) {
      if (!touring) break;
      // eslint-disable-next-line no-await-in-loop
      const ok = await walkthrough.navigateToHotspot(hotspot);
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

      {viewMode === 'walk' && (
        <div className="absolute left-4 top-20 z-30 w-[320px] overflow-hidden rounded-3xl border border-white/10 bg-slate-950/62 shadow-[0_24px_80px_rgba(0,0,0,.35)] backdrop-blur-2xl">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3.5 text-left"
            onClick={() => setRailOpen((v) => !v)}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05]">
                <Map className="h-4 w-4 text-[#ff914d]" />
              </div>
              <div>
                <div className="text-sm font-semibold text-white">Floor map</div>
                <div className="mt-0.5 text-[11px] text-slate-400">{navigationHotspots.length} validated destinations</div>
              </div>
            </div>
            {railOpen ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
          </button>

          {railOpen && (
            <div className="border-t border-white/10 p-3">
              {!navigationPlan ? (
                <div className="flex h-[220px] items-center justify-center rounded-2xl border border-dashed border-white/10 text-xs text-slate-500">
                  Building floor map…
                </div>
              ) : (
                <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-white/10 bg-slate-900/65 shadow-inner">
                  <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(255,145,77,.07),transparent_58%)]" />
                  <svg
                    className="absolute inset-0 h-full w-full"
                    viewBox={`${navigationPlan.bounds.minX} ${navigationPlan.bounds.minZ} ${Math.max(0.001, navigationPlan.bounds.maxX - navigationPlan.bounds.minX)} ${Math.max(0.001, navigationPlan.bounds.maxZ - navigationPlan.bounds.minZ)}`}
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label="Floor navigation map"
                  >
                    <g opacity="0.46">
                      {navigationPlan.triangles.map((tri, index) => (
                        <polygon
                          key={`floor-${index}`}
                          points={`${tri[0]},${tri[1]} ${tri[2]},${tri[3]} ${tri[4]},${tri[5]}`}
                          fill="rgba(255,255,255,0.055)"
                        />
                      ))}
                    </g>
                    <g>
                      {navigationHotspots.map((hotspot, index) => {
                        const active = walkthrough.activeHotspotId === hotspot.id;
                        const size = Math.max(0.055, Math.min(0.16, Math.min(navigationPlan.bounds.maxX - navigationPlan.bounds.minX, navigationPlan.bounds.maxZ - navigationPlan.bounds.minZ) * 0.012));
                        return (
                          <g
                            key={hotspot.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`Go to ${hotspot.label}`}
                            onClick={() => walkthrough.navigateToHotspot(hotspot)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); walkthrough.navigateToHotspot(hotspot); } }}
                            className="cursor-pointer outline-none"
                          >
                            <circle cx={hotspot.x} cy={hotspot.z} r={active ? size * 2.05 : size * 1.65} fill="rgba(255,145,77,0.10)" />
                            <circle cx={hotspot.x} cy={hotspot.z} r={active ? size * 1.05 : size * 0.92} fill={active ? 'rgba(255,145,77,0.95)' : 'rgba(255,145,77,0.72)'} stroke="rgba(255,214,186,0.95)" strokeWidth={size * 0.18} />
                            <text x={hotspot.x} y={hotspot.z + size * 0.35} textAnchor="middle" fontSize={Math.max(0.08, size * 0.9)} fill="white" fontWeight="700" pointerEvents="none">{index + 1}</text>
                            <title>{hotspot.label || `Navigation ${index + 1}`}</title>
                          </g>
                        );
                      })}
                    </g>
                  </svg>
                  <div className="pointer-events-none absolute bottom-2 left-2 rounded-lg border border-white/10 bg-slate-950/55 px-2 py-1 text-[10px] text-slate-400 backdrop-blur-md">
                    Click a point to move
                  </div>
                </div>
              )}

              <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
                <span>Orange = walkable destination</span>
                <span>{effectiveWalkMode === 'guided' ? 'Guided' : 'Explore'}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {viewMode === 'walk' && walkthrough.stuck && walkthrough.recoveryAvailable && (
        <div className="absolute bottom-24 left-5 z-40 w-[290px] rounded-2xl border border-[#ff914d]/25 bg-slate-950/88 p-3 shadow-2xl backdrop-blur-xl">
          <div className="text-xs font-semibold text-white">Need a safe position?</div>
          <div className="mt-1 text-[11px] leading-4 text-slate-400">The current location has limited navigation clearance. Reposition to the nearest safe floor marker.</div>
          <button type="button" onClick={() => walkthrough.recoverToSafeSpot()} className="mt-3 w-full rounded-xl bg-[#ff914d] px-3 py-2 text-xs font-bold text-slate-950 transition hover:bg-[#ff7a28]">Move to safe position</button>
        </div>
      )}

      {viewMode === 'walk' && effectiveWalkMode === 'explore' && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="h-2.5 w-2.5 rounded-full border border-white/75 bg-white/10 shadow-[0_0_16px_rgba(255,255,255,.4)]" />
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
              <input className="w-full accent-[#ff914d]" type="range" min="30" max="120" step="1" value={fov} onChange={(e) => applyFov(e.target.value)} />
              <div className="mt-1 flex justify-between text-[10px] text-slate-500"><span>Narrow</span><span>Presentation</span><span>Wide</span></div>
            </label>
            <label className={`block ${''}`}>
              <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300"><span>Mouse sensitivity</span><span className="font-mono text-slate-500">{sensitivity.toFixed(4)}</span></div>
              <input disabled={effectiveWalkMode === 'guided'} className="w-full accent-[#ff914d]" type="range" min="0.0015" max="0.009" step="0.0001" value={sensitivity} onChange={(e) => applySensitivity(e.target.value)} />
              <div className="mt-1 flex justify-between text-[10px] text-slate-500"><span>Precise</span><span>Fast</span></div>
            </label>
            <label className="block">
              <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300"><span>Camera height</span><span className="font-mono text-slate-500">{heightOffset.toFixed(2)}m</span></div>
              <input className="w-full accent-[#ff914d]" type="range" min="-0.15" max="0.35" step="0.01" value={heightOffset} onChange={(e) => applyHeight(e.target.value)} />
              <div className="mt-1 flex justify-between text-[10px] text-slate-500"><span>Lower</span><span>Neutral</span><span>Higher</span></div>
            </label>
            <button type="button" onClick={() => { applyHeight(0.35); applyFov(120); }} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.06]"><RotateCcw className="h-3.5 w-3.5" /> Reset camera height &amp; FOV</button>
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
            <div><b className="text-slate-200">Guided:</b> click a circular floor destination to travel with a slow cinematic camera pan.</div>
            <div><b className="text-slate-200">Explore:</b> W/A/S/D moves · mouse looks freely · Shift runs. Mouse movement is smoothed.</div>
            <div><b className="text-slate-200">Overview:</b> W/A/S/D pan · Q/E zoom · mouse orbit · wheel zoom · +/- keys zoom.</div>
            <div><b className="text-slate-200">Floor map:</b> glass map shows every validated navigation destination; click a point to travel there.</div>
            <div><b className="text-slate-200">Views:</b> Top/Front/Side/Perspective/Isometric presets + Fit model.</div>
            <div><b className="text-slate-200">View lock:</b> available in Explore mode via double-click. Guided mode uses a slow cinematic pan and fixed presentation pitch by design.</div>
          </div>
        </div>
      )}

      <div className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-white/10 bg-slate-950/82 p-2 shadow-2xl backdrop-blur-2xl">
        <IconButton
          title={viewMode === 'walk' ? 'Exit first-person view' : 'Back to renderer'}
          onClick={() => {
            if (viewMode === 'walk') {
              walkthrough.stopTravel();
              setWalkMode('guided');
              walkthrough.setWalkMode('guided');
              walkthrough.setLookLocked(true);
              walkthrough.setViewPreset('perspective');
              setViewMode('overview');
              setSettingsOpen(false);
              setViewsOpen(false);
              setMoreOpen(false);
              return;
            }
            navigate(-1);
          }}
        >
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <div className="mx-1 h-7 w-px bg-white/10" />
        {viewMode === 'overview' ? (
          <button type="button" onClick={() => { setWalkMode('guided'); walkthrough.setWalkMode('guided'); switchViewMode('walk'); }} className="flex h-9 items-center gap-2 rounded-xl bg-[#ff914d] px-3 text-xs font-bold text-slate-950 transition hover:bg-[#ff7a28]">
            <Play className="h-4 w-4" /> Start Walkthrough
          </button>
        ) : (
          <div className="flex items-center rounded-xl border border-white/10 bg-white/[0.03] p-0.5" aria-label="Walkthrough interaction mode">
            <button type="button" onClick={() => switchWalkMode('guided')} title="Guided mode: click destinations, slow cinematic camera pan" className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold transition ${effectiveWalkMode === 'guided' ? 'bg-[#ff914d] text-slate-950 shadow-sm' : 'text-slate-300 hover:bg-white/[0.06]'}`}>
              <MousePointer2 className="h-3.5 w-3.5" /> Guided
            </button>
            <button type="button" onClick={() => switchWalkMode('explore')} title="Explore mode: W/A/S/D movement and free mouse look" className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold transition ${effectiveWalkMode === 'explore' ? 'bg-[#ff914d] text-slate-950 shadow-sm' : 'text-slate-300 hover:bg-white/[0.06]'}`}>
              <Move3d className="h-3.5 w-3.5" /> Explore
            </button>
          </div>
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