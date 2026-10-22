import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Camera, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleHelp, Gauge,
  Maximize2, Minimize2, Minus, Map, Move3d, MousePointer2, Play, Plus,
  RotateCcw, RotateCw, Settings2, Target, View, X,
} from 'lucide-react';
import { useWalkthroughEngine } from '../hooks/useWalkthroughEngine';
import { DEFAULT_PRESENTATION_SETTINGS, loadPresentationSettings, mergePresentationSettings, normalizePresentationSettings, savePresentationSettings } from '../hooks/walkthrough/presentationSettings.js';

function IconButton({ title, onClick, children, active = false, disabled = false }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-xl border text-white transition ${active ? 'border-[#ff914d]/50 bg-[#ff914d]/18 text-[#ffd1b3] shadow-[0_0_22px_rgba(255,145,77,.14)]' : 'border-white/[0.07] bg-white/[0.06] hover:border-white/15 hover:bg-white/[0.11] hover:text-white'} disabled:cursor-not-allowed disabled:opacity-40`}
    >{children}</button>
  );
}

const LOCK_TOAST_CSS = `@keyframes walkLockFade { from { opacity: 0; transform: translateY(-6px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }`;
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export default function WalkthroughPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const viewportRef = useRef(null);
  const [railOpen, setRailOpen] = useState(false);
  const [touring, setTouring] = useState(false);
  const [heightOffset, setHeightOffset] = useState(DEFAULT_PRESENTATION_SETTINGS.camera.heightOffsetMeters);
  const [sensitivity, setSensitivity] = useState(DEFAULT_PRESENTATION_SETTINGS.camera.lookSensitivity);
  const [presentationSettings, setPresentationSettings] = useState(DEFAULT_PRESENTATION_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const lastPresentationLightingRef = useRef(DEFAULT_PRESENTATION_SETTINGS.appearance.lightingPreset);
  const [viewMode, setViewMode] = useState('overview');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [lockToast, setLockToast] = useState(false);
  const lockToastTimer = useRef(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [walkMode, setWalkMode] = useState('guided');
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const [displayName, setDisplayName] = useState('');


  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSettingsReady(false);
    loadPresentationSettings(jobId, API_BASE_URL).then(({ settings, manifest, source }) => {
      if (cancelled) return;
      const normalized = normalizePresentationSettings(settings);
      setPresentationSettings(normalized);
      setHeightOffset(normalized.camera.heightOffsetMeters);
      setSensitivity(normalized.camera.lookSensitivity);
      setSettingsReady(true);
      console.info(`[HCI Presentation] Settings loaded from ${source}${manifest?.schemaVersion ? ` (manifest v${manifest.schemaVersion})` : ''}.`);
    }).catch((error) => {
      console.warn('[HCI Presentation] Could not load presentation settings; defaults will be used.', error);
      if (!cancelled) setSettingsReady(true);
    });
    return () => { cancelled = true; };
  }, [jobId]);

  useEffect(() => {
    let cancelled = false;

    const resolveDisplayName = async () => {
      if (!jobId) {
        setDisplayName('HCI Walkthrough');
        return;
      }

      // Saved layouts use their immutable renderJobId in the walkthrough URL.
      // Prefer the human-readable hierarchy stored on the saved-layout record.
      try {
        const layoutsResponse = await fetch(`${API_BASE_URL}/api/saved-layouts`, { cache: 'no-store' });
        if (layoutsResponse.ok) {
          const payload = await layoutsResponse.json().catch(() => ({}));
          const savedLayout = Array.isArray(payload?.layouts)
            ? payload.layouts.find((layout) => layout?.id === jobId || layout?.renderJobId === jobId)
            : null;

          if (savedLayout) {
            const hierarchy = [
              savedLayout.categoryName,
              savedLayout.subCategory,
              savedLayout.name,
            ]
              .map((value) => String(value || '').trim())
              .filter(Boolean)
              .join(' → ');

            if (!cancelled && hierarchy) {
              setDisplayName(hierarchy);
              return;
            }
          }
        }
      } catch (error) {
        console.warn('[WalkthroughPage] Saved-layout metadata lookup failed:', error);
      }

      // Normal renders/projects don't have saved-layout metadata, so use the
      // original IFC filename from the project manifest instead of exposing the
      // internal job id.
      try {
        const projectResponse = await fetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(jobId)}/validate`, { cache: 'no-store' });
        if (projectResponse.ok) {
          const payload = await projectResponse.json().catch(() => ({}));
          const fileName = String(payload?.fileName || '').trim();
          if (!cancelled && fileName) {
            setDisplayName(fileName);
            return;
          }
        }
      } catch (error) {
        console.warn('[WalkthroughPage] Project filename lookup failed:', error);
      }

      if (!cancelled) setDisplayName('HCI Walkthrough');
    };

    resolveDisplayName();
    return () => { cancelled = true; };
  }, [jobId]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen?.();
      else await document.documentElement.requestFullscreen?.();
    } catch {
      // Fullscreen can be blocked by browser policy; leave the walkthrough unchanged.
    }
  };

  const walkthrough = useWalkthroughEngine({ containerRef: viewportRef, jobId });
  const navigationPlan = walkthrough.navigationPlan || null;
  const navigationHotspots = navigationPlan?.hotspots || [];
  const effectiveWalkMode = walkthrough.walkMode || walkMode;

  useEffect(() => {
    if (!settingsReady) return;
    walkthrough.applyPresentationSettings(presentationSettings);
  }, [settingsReady, presentationSettings, walkthrough.applyPresentationSettings]);

  useEffect(() => {
    if (!settingsReady || !jobId) return;
    savePresentationSettings(jobId, presentationSettings);
  }, [jobId, settingsReady, presentationSettings]);

  useEffect(() => {
    const mode = walkthrough.lightingMode;
    if (!settingsReady || !['day', 'evening', 'night'].includes(mode)) return;
    if (mode === presentationSettings.appearance.lightingPreset) {
      lastPresentationLightingRef.current = mode;
      return;
    }
    // Ignore stale runtime state while a saved manifest preference is first being applied.
    // Only persist a runtime-driven mode change when the runtime itself has moved from
    // the last known presentation selection (for example, the L keyboard shortcut).
    if (mode !== lastPresentationLightingRef.current) {
      lastPresentationLightingRef.current = mode;
      setPresentationSettings((previous) => mergePresentationSettings(previous, { appearance: { lightingPreset: mode } }));
    }
  }, [walkthrough.lightingMode, settingsReady, presentationSettings.appearance.lightingPreset]);

  useEffect(() => {
    if (walkthrough.immersivePresentationActive) {
      setRailOpen(false);
      setSettingsOpen(false);
      setViewsOpen(false);
      setMoreOpen(false);
    }
  }, [walkthrough.immersivePresentationActive]);

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
    if (walkthrough.immersive360Active) {
      if (walkthrough.smart720Active) return `Smart 720 · ${walkthrough.smart720CurrentLabel || 'room presentation'} · full-room presentation`;
      return `${walkthrough.immersivePresentationLabel || '360° presentation'} · drag horizontally to look around${walkthrough.immersive360AutoRotate ? ' · auto-rotate on' : ' · auto-rotate off'}`;
    }
    if (effectiveWalkMode === 'guided') {
      if (walkthrough.smart720Active) return `Smart 720 · ${walkthrough.smart720CurrentLabel || 'next room'}`;
      if (walkthrough.smart720OfferAvailable && walkthrough.immersive360OfferAvailable) return 'Guided · choose a room-to-room Smart 720 tour or explore 360° here';
      if (walkthrough.smart720OfferAvailable) return 'Guided · presentation ready · start a Smart 720 tour';
      return walkthrough.immersive360OfferAvailable ? 'Guided · presentation ready · explore 360° from the current point' : 'Guided · click a floor destination to move · drag horizontally to look';
    }
    return walkthrough.lookLocked
      ? 'Explore · view locked · double-click to unlock'
      : 'Explore · move with W/A/S/D · move mouse to look';
  }, [walkthrough.status, walkthrough.message, viewMode, effectiveWalkMode, walkthrough.lookLocked, walkthrough.immersive360Active, walkthrough.immersive360OfferAvailable, walkthrough.smart720Active, walkthrough.smart720OfferAvailable, walkthrough.smart720CurrentLabel]);

  const updatePresentationSettings = (patch) => {
    setPresentationSettings((previous) => mergePresentationSettings(previous, patch));
  };

  const setLightingPreset = (mode) => {
    if (!['day', 'evening', 'night'].includes(mode)) return;
    updatePresentationSettings({ appearance: { lightingPreset: mode } });
    walkthrough.setLightingMode(mode);
  };

  const setQualityMode = (mode) => updatePresentationSettings({ quality: { mode } });

  const applySensitivity = (value) => {
    const next = Number(value);
    setSensitivity(next);
    updatePresentationSettings({ camera: { lookSensitivity: next } });
    walkthrough.setSensitivity(next);
  };

  const applyHeight = (value) => {
    const next = Number(value);
    setHeightOffset(next);
    updatePresentationSettings({ camera: { heightOffsetMeters: next } });
    walkthrough.setHeightOffset(next);
  };

  const resetPresentationSettings = () => {
    const defaults = normalizePresentationSettings(DEFAULT_PRESENTATION_SETTINGS);
    setPresentationSettings(defaults);
    setHeightOffset(defaults.camera.heightOffsetMeters);
    setSensitivity(defaults.camera.lookSensitivity);
    walkthrough.applyPresentationSettings(defaults);
  };

  const openImmersive360 = () => {
    if (viewMode !== 'walk' || effectiveWalkMode !== 'guided' || !walkthrough.immersive360OfferAvailable) return;
    walkthrough.enterImmersivePresentation({ autoRotate: true });
  };

  const startSmart720 = () => {
    if (viewMode !== 'walk' || effectiveWalkMode !== 'guided' || !walkthrough.smart720OfferAvailable) return;
    walkthrough.startSmart720Tour();
  };

  const reset360View = () => walkthrough.resetImmersivePresentationView();
  const toggle360AutoRotate = () => walkthrough.setImmersive360AutoRotate(!walkthrough.immersive360AutoRotate);

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

      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between p-4 md:p-5">
        <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/78 px-3.5 py-2.5 shadow-[0_18px_60px_rgba(0,0,0,.24)] backdrop-blur-2xl">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-[#ff914d]/30 bg-[#ff914d]/14">
            <Move3d className="h-4 w-4 text-[#ffad73]" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight text-white">HCI Presentation</div>
            <div
              className="max-w-[min(72vw,620px)] truncate text-[10px] uppercase tracking-[0.16em] text-slate-300"
              title={displayName || undefined}
            >
              {viewMode === 'walk' ? (walkthrough.immersivePresentationActive ? '360° Home Presentation' : 'Interactive Walkthrough') : '3D Preview'} · {displayName || 'Loading…'}
            </div>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/20 p-1 backdrop-blur-md">
          <div className="hidden items-center gap-2 rounded-full border border-white/12 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-200 shadow-xl backdrop-blur-xl sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ff914d] shadow-[0_0_10px_rgba(255,145,77,.8)]" />
            {viewMode === 'walk'
              ? (walkthrough.smart720Active ? 'Smart 720 tour' : (walkthrough.immersive360Active ? '360° presentation' : (effectiveWalkMode === 'guided' ? 'Guided presentation' : 'Explore mode')))
              : 'Overview'}
          </div>
          <IconButton
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            onClick={toggleFullscreen}
            active={isFullscreen}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </IconButton>
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

      {viewMode === 'walk' && presentationSettings.interface.showFloorMap && walkthrough.immersivePresentationActive && !railOpen && (
        <button
          type="button"
          onClick={() => setRailOpen(true)}
          className="absolute left-4 top-20 z-30 flex items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/62 px-3.5 py-2.5 text-left shadow-[0_18px_60px_rgba(0,0,0,.25)] backdrop-blur-2xl transition hover:bg-slate-950/78"
          title="Open rooms and floor map"
        >
          <Map className="h-4 w-4 text-[#ff914d]" />
          <span>
            <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Rooms</span>
            <span className="block max-w-[170px] truncate text-xs font-semibold text-white">{walkthrough.immersivePresentationLabel || 'Choose a room'}</span>
          </span>
          <ChevronDown className="ml-1 h-4 w-4 text-slate-400" />
        </button>
      )}

      {viewMode === 'walk' && presentationSettings.interface.showFloorMap && (
        <div className="absolute left-4 top-20 z-30 w-[300px] overflow-hidden rounded-[24px] border border-white/10 bg-slate-950/54 shadow-[0_28px_90px_rgba(0,0,0,.32)] backdrop-blur-2xl sm:w-[310px]">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3 text-left"
            onClick={() => setRailOpen((v) => !v)}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05]">
                <Map className="h-4 w-4 text-[#ff914d]" />
              </div>
              <div>
                <div className="text-[13px] font-semibold tracking-tight text-white">Floor map</div>
                <div className="mt-0.5 text-[10px] text-slate-300">{navigationHotspots.length} curated destinations</div>
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
                <div className="relative aspect-[4/3] overflow-hidden rounded-[18px] border border-white/12 bg-slate-900/76 shadow-inner">
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
                  <div className="pointer-events-none absolute bottom-2 left-2 rounded-full border border-white/10 bg-slate-950/52 px-2.5 py-1 text-[10px] font-medium text-slate-200 backdrop-blur-md">
                    Click a point to move
                  </div>
                </div>
              )}

              <div className="mt-3 flex items-center justify-between text-[10px] font-medium text-slate-300">
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

      <div className="pointer-events-auto absolute bottom-5 right-5 z-30 flex items-center gap-1 rounded-2xl border border-white/10 bg-slate-950/78 p-1.5 text-white shadow-xl backdrop-blur-2xl">
        <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Light</span>
        {[
          ['day', 'Day'], ['evening', 'Evening'], ['night', 'Night'],
        ].map(([mode, label]) => (
          <button key={mode} type="button" onClick={() => setLightingPreset(mode)} aria-pressed={presentationSettings.appearance.lightingPreset === mode} className={`h-8 rounded-xl px-2.5 text-[11px] font-semibold transition ${presentationSettings.appearance.lightingPreset === mode ? 'bg-[#ff914d]/20 text-[#ffd1b3]' : 'text-slate-300 hover:bg-white/[0.08]'}`}>{label}</button>
        ))}
        <span className="mx-1 h-5 w-px bg-white/10" />
        <button type="button" title="Presentation settings" aria-label="Presentation settings" onClick={() => setSettingsOpen((open) => !open)} className={`flex h-8 w-8 items-center justify-center rounded-xl transition ${settingsOpen ? 'bg-[#ff914d]/20 text-[#ffd1b3]' : 'text-slate-300 hover:bg-white/[0.08]'}`}><Settings2 className="h-4 w-4" /></button>
      </div>

      {settingsOpen && (
        <div className="absolute bottom-24 right-5 z-40 max-h-[72vh] w-[min(92vw,420px)] overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/94 p-4 text-white shadow-2xl backdrop-blur-2xl">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Presentation settings</div>
              <div className="mt-1 text-[11px] leading-4 text-slate-400">One visual profile shared by Overview, Guided, Explore and 360.</div>
            </div>
            <IconButton title="Close presentation settings" onClick={() => setSettingsOpen(false)}><X className="h-4 w-4" /></IconButton>
          </div>

          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Lighting & atmosphere</div>
            <div className="grid grid-cols-3 gap-2">
              {[
                ['day', '☀', 'Daylight'], ['evening', '◐', 'Evening'], ['night', '☾', 'Night'],
              ].map(([mode, icon, label]) => (
                <button key={mode} type="button" onClick={() => setLightingPreset(mode)} aria-pressed={presentationSettings.appearance.lightingPreset === mode} className={`flex h-10 items-center justify-center gap-1.5 rounded-xl border text-xs font-semibold transition ${presentationSettings.appearance.lightingPreset === mode ? 'border-[#ff914d]/50 bg-[#ff914d]/16 text-[#ffd1b3]' : 'border-white/10 bg-white/[0.035] text-slate-300 hover:bg-white/[0.08]'}`}>
                  <span aria-hidden="true">{icon}</span>{label}
                </button>
              ))}
            </div>
            <label className="block pt-1">
              <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300"><span>Exposure</span><span className="font-mono text-slate-400">{presentationSettings.appearance.exposureMultiplier.toFixed(2)}×</span></div>
              <input aria-label="Exposure multiplier" className="w-full accent-[#ff914d]" type="range" min="0.75" max="1.25" step="0.05" value={presentationSettings.appearance.exposureMultiplier} onChange={(e) => updatePresentationSettings({ appearance: { exposureMultiplier: Number(e.target.value) } })} />
            </label>
            <label className="block">
              <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300"><span>Environment fill</span><span className="font-mono text-slate-400">{presentationSettings.appearance.environmentMultiplier.toFixed(2)}×</span></div>
              <input aria-label="Environment fill multiplier" className="w-full accent-[#ff914d]" type="range" min="0.5" max="1.5" step="0.05" value={presentationSettings.appearance.environmentMultiplier} onChange={(e) => updatePresentationSettings({ appearance: { environmentMultiplier: Number(e.target.value) } })} />
            </label>
            <label className="block text-xs text-slate-300">
              <span className="mb-1.5 block">Color rendering</span>
              <select value={presentationSettings.appearance.toneMapping} onChange={(e) => updatePresentationSettings({ appearance: { toneMapping: e.target.value } })} className="w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-[#ff914d]/50">
                <option value="agx">AgX · Balanced architectural color</option>
                <option value="aces">ACES · Filmic highlights</option>
                <option value="neutral">Neutral · Minimal tone curve</option>
              </select>
            </label>
          </section>

          <div className="my-4 h-px bg-white/10" />
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Rendering quality</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                ['auto', 'Automatic', 'Based on device capability'],
                ['performance', 'Performance', 'Lower resolution, shadows off'],
                ['balanced', 'Balanced', 'Recommended default'],
                ['high', 'High detail', 'Higher resolution, shadows on'],
              ].map(([mode, label, description]) => (
                <button key={mode} type="button" onClick={() => setQualityMode(mode)} aria-pressed={presentationSettings.quality.mode === mode} className={`rounded-xl border px-3 py-2 text-left transition ${presentationSettings.quality.mode === mode ? 'border-[#ff914d]/50 bg-[#ff914d]/12' : 'border-white/10 bg-white/[0.035] hover:bg-white/[0.07]'}`}>
                  <span className="block text-xs font-semibold text-white">{label}</span>
                  <span className="mt-1 block text-[10px] leading-4 text-slate-400">{description}</span>
                </button>
              ))}
            </div>
          </section>

          <div className="my-4 h-px bg-white/10" />
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
            <span>
              <span className="block text-xs font-semibold text-white">Show floor map</span>
              <span className="mt-0.5 block text-[10px] text-slate-400">Keep room destinations available while walking.</span>
            </span>
            <input type="checkbox" checked={presentationSettings.interface.showFloorMap} onChange={(e) => updatePresentationSettings({ interface: { showFloorMap: e.target.checked } })} className="h-4 w-4 accent-[#ff914d]" />
          </label>
          <div className="my-4 h-px bg-white/10" />
          <section className="space-y-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Camera</div>
            {[
              ['Guided field of view', 'guidedFov', 50, 88, 1],
              ['Explore field of view', 'exploreFov', 55, 95, 1],
              ['360 field of view', 'immersiveFov', 50, 88, 1],
            ].map(([label, key, min, max, step]) => (
              <label key={key} className="block">
                <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300"><span>{label}</span><span className="font-mono text-slate-400">{presentationSettings.camera[key]}°</span></div>
                <input aria-label={label} className="w-full accent-[#ff914d]" type="range" min={min} max={max} step={step} value={presentationSettings.camera[key]} onChange={(e) => updatePresentationSettings({ camera: { [key]: Number(e.target.value) } })} />
              </label>
            ))}
            <label className="block">
              <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300"><span>Camera height offset</span><span className="font-mono text-slate-400">{heightOffset.toFixed(2)} m</span></div>
              <input aria-label="Camera height offset" className="w-full accent-[#ff914d]" type="range" min="-0.15" max="0.35" step="0.01" value={heightOffset} onChange={(e) => applyHeight(e.target.value)} />
            </label>
            <label className="block">
              <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300"><span>Mouse sensitivity</span><span className="font-mono text-slate-400">{sensitivity.toFixed(4)}</span></div>
              <input disabled={effectiveWalkMode === 'guided'} aria-label="Mouse sensitivity" className="w-full accent-[#ff914d] disabled:opacity-40" type="range" min="0.0015" max="0.009" step="0.0001" value={sensitivity} onChange={(e) => applySensitivity(e.target.value)} />
            </label>
          </section>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/10 pt-3">
            <span className="text-[10px] leading-4 text-slate-500">Saved in this browser for this render.</span>
            <button type="button" onClick={resetPresentationSettings} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] font-semibold text-slate-200 hover:bg-white/[0.09]"><RotateCcw className="h-3.5 w-3.5" /> Reset</button>
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
        </div>
      )}

      {helpOpen && (
        <div className="absolute bottom-24 right-5 z-40 w-[300px] rounded-2xl border border-white/10 bg-slate-950/92 p-4 text-sm text-slate-300 shadow-2xl backdrop-blur-2xl">
          <div className="mb-3 flex items-center justify-between"><span className="font-semibold text-white">Walkthrough help</span><IconButton title="Close help" onClick={() => setHelpOpen(false)}><X className="h-4 w-4" /></IconButton></div>
          <div className="space-y-2 text-xs leading-5 text-slate-400">
            <div><b className="text-slate-200">Guided:</b> click a circular floor destination to travel with a slow cinematic camera pan.</div>
            <div><b className="text-slate-200">360°:</b> appears as a contextual presentation action after a Guided destination settles. Explore the full room; slow auto-rotation pauses while you interact and resumes after idle.</div>
            <div><b className="text-slate-200">Smart 720:</b> presents the curated customer-facing rooms one by one, using real NavMesh travel between them and a full 360° presentation at each stop.</div>
            <div><b className="text-slate-200">Explore:</b> W/A/S/D moves · mouse looks freely · Shift runs. Mouse movement is smoothed.</div>
            <div><b className="text-slate-200">Overview:</b> W/A/S/D pan · Q/E zoom · mouse orbit · wheel zoom · +/- keys zoom.</div>
            <div><b className="text-slate-200">Floor map:</b> glass map shows every validated navigation destination; click a point to travel there.</div>
            <div><b className="text-slate-200">Views:</b> Top/Front/Side/Perspective/Isometric presets + Fit model.</div>
            <div><b className="text-slate-200">View lock:</b> available in Explore mode via double-click. Guided mode uses a slow cinematic pan and fixed presentation pitch by design.</div>
          </div>
        </div>
      )}

      {viewMode === 'walk' && effectiveWalkMode === 'guided' && !walkthrough.immersive360Active && (walkthrough.smart720OfferAvailable || walkthrough.immersive360OfferAvailable) && (
        <div className="absolute bottom-20 left-1/2 z-30 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/90 p-2 shadow-[0_18px_50px_rgba(0,0,0,.34)] backdrop-blur-2xl">
            {walkthrough.smart720OfferAvailable && (
              <button
                type="button"
                onClick={startSmart720}
                className="group flex items-center gap-2 rounded-xl bg-[#ff914d] px-4 py-2.5 text-xs font-bold text-slate-950 shadow-[0_10px_28px_rgba(255,145,77,.18)] transition hover:bg-[#ff7a28]"
                title="Start a room-to-room whole-home presentation tour"
              >
                <Play className="h-4 w-4" />
                <span>Smart 720 Tour</span>
              </button>
            )}
            {walkthrough.immersive360OfferAvailable && (
              <button
                type="button"
                onClick={openImmersive360}
                className="group flex items-center gap-2 rounded-xl border border-[#ff914d]/28 bg-white/[0.05] px-3.5 py-2.5 text-xs font-semibold text-white transition hover:border-[#ff914d]/48 hover:bg-white/[0.09]"
                title="Explore a full 360° view from the current destination"
              >
                <RotateCw className="h-4 w-4 text-[#ff914d] transition group-hover:rotate-45" />
                <span>Explore 360°</span>
              </button>
            )}
          </div>
        </div>
      )}

      {walkthrough.immersivePresentationActive && (
        <div className="absolute bottom-[92px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-white/10 bg-slate-950/72 p-1.5 shadow-[0_22px_65px_rgba(0,0,0,.32)] backdrop-blur-2xl">
          <button type="button" onClick={() => setRailOpen((v) => !v)} className="flex h-9 items-center gap-2 rounded-xl px-3 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.08]">
            <Map className="h-4 w-4 text-[#ff914d]" /> Rooms
          </button>
          <button type="button" onClick={reset360View} className="flex h-9 items-center gap-2 rounded-xl px-3 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.08]">
            <RotateCcw className="h-4 w-4" /> Recenter
          </button>
          <button type="button" onClick={toggle360AutoRotate} className={`flex h-9 items-center gap-2 rounded-xl px-3 text-xs font-semibold transition ${walkthrough.immersive360AutoRotate ? 'bg-[#ff914d]/16 text-[#ffd1b3]' : 'text-slate-200 hover:bg-white/[0.08]'}`}>
            <RotateCw className="h-4 w-4" /> {walkthrough.immersive360AutoRotate ? 'Auto' : 'Manual'}
          </button>
          <button type="button" onClick={() => walkthrough.exitImmersivePresentation()} className="flex h-9 items-center gap-2 rounded-xl px-3 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.08]">
            <X className="h-4 w-4" /> Exit 360
          </button>
        </div>
      )}

      <div className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-[22px] border border-white/12 bg-slate-950/84 p-1.5 shadow-[0_24px_70px_rgba(0,0,0,.36)] backdrop-blur-2xl">
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
          <>
          {!walkthrough.immersivePresentationActive && (
          <div className="flex items-center rounded-xl border border-white/10 bg-white/[0.03] p-0.5" aria-label="Walkthrough interaction mode">
            <button type="button" onClick={() => switchWalkMode('guided')} title="Guided mode: click destinations, slow cinematic camera pan" className={`flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-[11px] font-semibold transition ${effectiveWalkMode === 'guided' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-200 hover:bg-white/[0.08]'}`}>
              <MousePointer2 className="h-3.5 w-3.5" /> Guided
            </button>
            <button type="button" onClick={() => switchWalkMode('explore')} title="Explore mode: W/A/S/D movement and free mouse look" className={`flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-[11px] font-semibold transition ${effectiveWalkMode === 'explore' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-200 hover:bg-white/[0.08]'}`}>
              <Move3d className="h-3.5 w-3.5" /> Explore
            </button>
          </div>
          )}
          {!walkthrough.immersivePresentationActive && <IconButton title="Camera views" active={viewsOpen} onClick={() => { setViewsOpen((v) => !v); setMoreOpen(false); setSettingsOpen(false); }}><Camera className="h-4 w-4" /></IconButton>}
        {!walkthrough.immersivePresentationActive && <IconButton title="Walk settings" active={settingsOpen} onClick={() => { setSettingsOpen((v) => !v); setViewsOpen(false); setMoreOpen(false); }}><Settings2 className="h-4 w-4" /></IconButton>}
        {!walkthrough.immersivePresentationActive && <IconButton title="More controls" active={moreOpen} onClick={() => { setMoreOpen((v) => !v); setViewsOpen(false); setSettingsOpen(false); }}><ChevronUp className="h-4 w-4" /></IconButton>}
        <IconButton title={helpOpen ? 'Close help' : 'Help'} active={helpOpen} onClick={() => setHelpOpen((v) => !v)}><CircleHelp className="h-4 w-4" /></IconButton>
        <div className="mx-1 h-7 w-px bg-white/10" />
        </>
        )}
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

      <div className="pointer-events-none absolute left-1/2 top-16 z-20 -translate-x-1/2">
        <div className={`rounded-full border px-4 py-2 text-xs font-medium shadow-xl backdrop-blur-xl ${walkthrough.immersivePresentationActive ? 'border-white/10 bg-slate-950/72 text-white' : 'border-white/10 bg-slate-950/82 text-slate-100'}`}>
          {walkthrough.immersivePresentationActive
            ? `${walkthrough.immersivePresentationLabel || 'Room'} · ${walkthrough.smart720Active ? 'guided 360 tour' : '360° view'}`
            : statusText}
        </div>
      </div>

      {walkthrough.immersivePresentationActive && !settingsOpen && (
        <div className="absolute bottom-28 right-6 z-30 w-[270px] rounded-2xl border border-white/10 bg-slate-950/82 p-3 text-white shadow-2xl backdrop-blur-2xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-200/80">{walkthrough.smart720Active ? 'Smart 720 Tour' : '360° Presentation'}</div>
              <div className="mt-1 truncate text-sm font-semibold text-white">{walkthrough.smart720CurrentLabel || walkthrough.immersivePresentationLabel || 'Architectural view'}</div>
              <div className="mt-1 text-[11px] leading-4 text-slate-300">{walkthrough.smart720Active ? `Room presentation ${walkthrough.smart720StopIndex || 1} of ${walkthrough.smart720TotalStops || 1}. The next room follows automatically.` : 'Stationary architectural view. Drag to explore the room.'}</div>
            </div>
          </div>
          {!walkthrough.smart720Active && walkthrough.immersiveSceneTotal > 1 && (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-2 py-1.5">
              <button type="button" onClick={() => walkthrough.switchImmersiveScene(-1)} disabled={!walkthrough.immersiveSceneCanPrev || walkthrough.immersiveSceneSwitching} className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-slate-200 transition hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-35" title="Previous presentation scene"><ChevronLeft className="h-4 w-4" /></button>
              <div className="min-w-0 flex-1 text-center">
                <div className="truncate text-[10px] font-semibold text-white">{walkthrough.immersiveSceneLabel || walkthrough.immersivePresentationLabel || 'Presentation scene'}</div>
                <div className="mt-0.5 text-[9px] uppercase tracking-[0.16em] text-slate-400">Scene {Math.max(1, walkthrough.immersiveSceneIndex)} of {walkthrough.immersiveSceneTotal}</div>
              </div>
              <button type="button" onClick={() => walkthrough.switchImmersiveScene(1)} disabled={!walkthrough.immersiveSceneCanNext || walkthrough.immersiveSceneSwitching} className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-slate-200 transition hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-35" title="Next presentation scene"><ChevronRight className="h-4 w-4" /></button>
            </div>
          )}
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button type="button" onClick={reset360View} className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.06] text-[10px] font-semibold text-slate-200 hover:bg-white/[0.11]"><RotateCcw className="h-3.5 w-3.5" /> Recenter</button>
            {!walkthrough.smart720Active && (
              <button type="button" onClick={toggle360AutoRotate} className={`flex h-8 items-center justify-center gap-1.5 rounded-lg border text-[10px] font-semibold ${walkthrough.immersive360AutoRotate ? 'border-[#ff914d]/40 bg-[#ff914d]/12 text-[#ffd1b3]' : 'border-white/10 bg-white/[0.06] text-slate-200 hover:bg-white/[0.11]'}`}><RotateCw className="h-3.5 w-3.5" /> {walkthrough.immersive360AutoRotate ? 'Auto on' : 'Auto off'}</button>
            )}
            <button type="button" onClick={() => walkthrough.exitImmersivePresentation()} className="flex h-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-[10px] font-semibold text-slate-200 hover:bg-white/[0.11]">{walkthrough.smart720Active ? 'Stop tour' : 'Exit'}</button>
          </div>
        </div>
      )}
      </div>
    </>
  );
}