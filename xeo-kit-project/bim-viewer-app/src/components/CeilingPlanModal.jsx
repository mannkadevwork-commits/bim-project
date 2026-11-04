import { useMemo, useRef, useState } from 'react';
import { X, Lightbulb, Trash2, Grid3X3, CircleDot, MoveUpRight, Info, RotateCcw } from 'lucide-react';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));

function pointInRing(point, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i]?.x), zi = Number(ring[i]?.z);
    const xj = Number(ring[j]?.x), zj = Number(ring[j]?.z);
    const intersects = ((zi > point.z) !== (zj > point.z)) &&
      (point.x < ((xj - xi) * (point.z - zi)) / ((zj - zi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function circleToPolygon(opening, segments = 32) {
  const x = finite(opening?.x, NaN);
  const z = finite(opening?.z, NaN);
  const radius = finite(opening?.radius, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0) return [];
  return Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return { x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius };
  });
}

function openingRing(opening) {
  if (Array.isArray(opening)) return opening;
  if (Array.isArray(opening?.polygon)) return opening.polygon;
  if (opening?.type === 'circle' || Number.isFinite(Number(opening?.radius))) return circleToPolygon(opening);
  return [];
}

function pathForRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return '';
  return `${ring.map((point, index) => `${index ? 'L' : 'M'} ${Number(point.x).toFixed(4)} ${(-Number(point.z)).toFixed(4)}`).join(' ')} Z`;
}

function distanceToSegment(point, start, end) {
  const dx = Number(end.x) - Number(start.x);
  const dz = Number(end.z) - Number(start.z);
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - Number(start.x), point.z - Number(start.z));
  const projection = clamp(
    ((point.x - Number(start.x)) * dx + (point.z - Number(start.z)) * dz) / lengthSquared,
    0,
    1,
  );
  const closestX = Number(start.x) + projection * dx;
  const closestZ = Number(start.z) + projection * dz;
  return Math.hypot(point.x - closestX, point.z - closestZ);
}

function distanceToRing(point, ring) {
  if (!Array.isArray(ring) || ring.length < 2) return Infinity;
  let minimum = Infinity;
  for (let index = 0; index < ring.length; index += 1) {
    minimum = Math.min(minimum, distanceToSegment(point, ring[index], ring[(index + 1) % ring.length]));
  }
  return minimum;
}

function isCircleInsideRoom(center, radius, outer, holes) {
  if (!pointInRing(center, outer) || distanceToRing(center, outer) < radius - 0.001) return false;
  for (const hole of holes) {
    if (pointInRing(center, hole) || distanceToRing(center, hole) < radius + 0.001) return false;
  }
  return true;
}

function fixtureGlyph(asset, selected = false) {
  const id = String(asset?.id || '').toLowerCase();
  const name = String(asset?.name || '').toLowerCase();
  const accent = selected ? '#f97316' : '#38bdf8';
  if (id.includes('linear') || name.includes('tubelight')) {
    return <g><rect x="-0.26" y="-0.035" width="0.52" height="0.07" rx="0.025" fill={accent}/><path d="M-0.22 0 H0.22" stroke="#0f172a" strokeWidth="0.012"/></g>;
  }
  if (id.includes('pendant') || name.includes('pendant')) {
    return <g><circle r="0.12" fill={accent} stroke="#0f172a" strokeWidth="0.018"/><circle r="0.045" fill="#fff7ed"/></g>;
  }
  if (id.includes('square') || name.includes('square')) {
    return <g><rect x="-0.12" y="-0.12" width="0.24" height="0.24" rx="0.025" fill={accent} stroke="#0f172a" strokeWidth="0.018"/><circle r="0.045" fill="#fff7ed"/></g>;
  }
  return <g><circle r="0.115" fill={accent} stroke="#0f172a" strokeWidth="0.018"/><circle r="0.042" fill="#fff7ed"/></g>;
}

export const CeilingPlanModal = ({
  open,
  room,
  ceiling,
  lightingAssets = [],
  furniture = [],
  onClose,
  onPlaceFixture,
  onRemoveFixture,
}) => {
  const svgRef = useRef(null);
  const [selectedAssetId, setSelectedAssetId] = useState('hci_recessed_downlight');
  const [gridStep, setGridStep] = useState(0.1);
  const [cutoutDiameter, setCutoutDiameter] = useState(0.09);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState('');
  const [selectedFixtureId, setSelectedFixtureId] = useState(null);

  const outer = Array.isArray(ceiling?.boundary?.outer) ? ceiling.boundary.outer : (room?.boundary?.outer || []);
  const boundaryHoles = Array.isArray(ceiling?.boundary?.holes) ? ceiling.boundary.holes : (room?.boundary?.holes || []);
  const openings = Array.isArray(ceiling?.openings) ? ceiling.openings.filter((item) => item?.enabled !== false) : [];
  const openingRings = useMemo(() => [
    ...boundaryHoles,
    ...openings.map(openingRing).filter((ring) => ring.length >= 3),
  ], [boundaryHoles, openings]);

  const bounds = useMemo(() => {
    const points = outer.filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.z)));
    if (points.length < 3) return null;
    const xs = points.map((point) => Number(point.x));
    const zs = points.map((point) => Number(point.z));
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const pad = Math.max(0.35, Math.max(maxX - minX, maxZ - minZ) * 0.08);
    return {
      minX: minX - pad,
      maxX: maxX + pad,
      minZ: minZ - pad,
      maxZ: maxZ + pad,
      width: Math.max(0.5, maxX - minX + pad * 2),
      height: Math.max(0.5, maxZ - minZ + pad * 2),
    };
  }, [outer]);

  const selectedAsset = lightingAssets.find((asset) => asset.id === selectedAssetId) || lightingAssets[0] || null;
  const fixturesInRoom = useMemo(() => (Array.isArray(furniture) ? furniture : []).filter((item) => {
    if (!item || item.isLightFixture !== true && item.assetCategory !== 'lighting') return false;
    if (item.ceilingRoomId && String(item.ceilingRoomId) === String(room?.id)) return true;
    const position = item.position;
    return Array.isArray(position) && position.length === 3 && pointInRing({ x: Number(position[0]), z: Number(position[2]) }, outer);
  }), [furniture, room?.id, outer]);

  const finishedBottomY = finite(ceiling?.elevation?.finishedBottomY, finite(room?.recommendedCeilingY, finite(room?.floorY, 0) + 2.7));
  const combinedPath = useMemo(() => [pathForRing(outer), ...openingRings.map(pathForRing)].filter(Boolean).join(' '), [outer, openingRings]);

  if (!open) return null;

  const snap = (value) => gridStep > 0 ? Math.round(value / gridStep) * gridStep : value;

  const resolveSvgPoint = (event) => {
    const svg = svgRef.current;
    if (!svg || !bounds) return null;
    try {
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const point = svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const local = point.matrixTransform(ctm.inverse());
        return { x: snap(local.x), z: snap(-local.y) };
      }
    } catch (_) {
      // Fall through to the rectangle mapping for browsers without SVGPoint support.
    }
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: snap(bounds.minX + ((event.clientX - rect.left) / rect.width) * bounds.width),
      z: snap(bounds.maxZ - ((event.clientY - rect.top) / rect.height) * bounds.height),
    };
  };

  const handlePlanClick = async (event) => {
    if (placing || !selectedAsset) return;
    if (event.target?.closest?.('[data-fixture-marker="true"]')) return;
    const point = resolveSvgPoint(event);
    if (!point) return;
    if (!pointInRing(point, outer)) {
      setError('Choose a point inside the selected room boundary.');
      return;
    }
    if (openingRings.some((ring) => pointInRing(point, ring))) {
      setError('That point is inside an existing opening. Choose another position.');
      return;
    }

    const mountType = selectedAsset.ceilingMountType === 'recessed' || selectedAsset.id === 'hci_recessed_downlight'
      ? 'recessed'
      : 'surface';
    const radius = clamp(cutoutDiameter / 2, 0.025, 0.35);
    if (mountType === 'recessed' && !isCircleInsideRoom(point, radius, outer, openingRings)) {
      setError('The recessed-light cut-out must fit completely inside the ceiling. Move it farther from the room edge or an existing opening.');
      return;
    }

    const openingId = mountType === 'recessed'
      ? `opening_${room?.id || 'room'}_${Date.now()}_${Math.round(point.x * 1000)}_${Math.round(point.z * 1000)}`
      : null;
    const opening = openingId ? {
      id: openingId,
      type: 'circle',
      x: point.x,
      z: point.z,
      radius,
      segments: 32,
      enabled: true,
      fixtureType: selectedAsset.id,
    } : null;

    setError('');
    setPlacing(true);
    try {
      const placedModel = await onPlaceFixture?.({
        asset: {
          ...selectedAsset,
          // Ceiling fixtures are decorative/installed assets by default.
          // Do not create a live PointLight when placing them; room editing
          // can explicitly enable an individual fixture later.
          lightEnabled: false,
          ceilingRoomId: room?.id,
          ceilingMountType: mountType,
          ...(openingId ? { ceilingOpeningId: openingId } : {}),
        },
        position: [point.x, finishedBottomY, point.z],
        roomId: room?.id,
        mountType,
        opening,
      });
      if (placedModel?.id) setSelectedFixtureId(placedModel.id);
    } catch (caught) {
      setError(caught?.message || 'Could not place this ceiling fixture.');
    } finally {
      setPlacing(false);
    }
  };

  const removeSelectedFixture = async () => {
    const fixture = fixturesInRoom.find((item) => item.instanceId === selectedFixtureId);
    if (!fixture) return;
    try {
      await onRemoveFixture?.(fixture);
      setSelectedFixtureId(null);
      setError('');
    } catch (caught) {
      setError(caught?.message || 'Could not remove this fixture.');
    }
  };

  const gridOriginX = bounds?.minX || 0;
  const gridOriginY = -(bounds?.maxZ || 0);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/75 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="hci-ceiling-plan-title">
      <section className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 text-slate-100 shadow-2xl">
        <header className="flex items-center justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-bold"><Grid3X3 className="h-4 w-4 text-orange-400"/> <span id="hci-ceiling-plan-title">Ceiling Plan · {room?.label || 'Selected room'}</span></div>
            <p className="mt-1 text-[11px] text-slate-400">Top-down room workspace · underside Y {finishedBottomY.toFixed(3)} m · click the plan to place a fixture</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-800" aria-label="Close ceiling plan"><X className="h-4 w-4"/></button>
        </header>

        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[270px_minmax(0,1fr)_260px]">
          <aside className="min-h-0 space-y-3 overflow-y-auto border-b border-slate-800 p-4 lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400"><Lightbulb className="h-3.5 w-3.5"/> Fixture catalogue</div>
            <div className="grid grid-cols-2 gap-2">
              {lightingAssets.map((asset) => {
                const active = asset.id === selectedAssetId;
                return (
                  <button key={asset.id} type="button" onClick={() => { setSelectedAssetId(asset.id); setError(''); }} aria-pressed={active} className={`min-h-[72px] rounded-xl border p-2 text-left transition ${active ? 'border-orange-400 bg-orange-500/10 ring-1 ring-orange-500/20' : 'border-slate-800 bg-slate-900 hover:border-slate-600'}`}>
                    <span className={`mb-1 flex h-7 w-7 items-center justify-center rounded-lg ${active ? 'bg-orange-500/20 text-orange-300' : 'bg-slate-800 text-slate-400'}`}><Lightbulb className="h-4 w-4"/></span>
                    <span className="block text-[10px] font-semibold leading-tight">{asset.name}</span>
                    <span className="mt-1 block text-[8px] text-slate-500">{asset.ceilingMountType === 'recessed' ? 'Cut-out required' : 'Surface mounted'}</span>
                  </button>
                );
              })}
            </div>

            <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
              <label className="block text-[10px] font-semibold text-slate-300">Grid snap</label>
              <select value={gridStep} onChange={(event) => setGridStep(Number(event.target.value))} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-white">
                <option value="0">Off</option><option value="0.05">5 cm</option><option value="0.1">10 cm</option><option value="0.2">20 cm</option>
              </select>
              {selectedAsset?.ceilingMountType === 'recessed' && (
                <label className="block text-[10px] font-semibold text-slate-300">Recessed cut-out diameter (m)
                  <input type="number" min="0.05" max="0.7" step="0.01" value={cutoutDiameter} onChange={(event) => setCutoutDiameter(clamp(event.target.value, 0.05, 0.7))} className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-white"/>
                </label>
              )}
              <div className="flex items-start gap-2 text-[9px] leading-relaxed text-slate-500"><Info className="mt-0.5 h-3 w-3 shrink-0"/>Surface fixtures sit on the ceiling underside. Recessed downlights automatically create a matching circular opening.</div>
            </div>
          </aside>

          <main className="flex min-h-[340px] flex-col bg-[#0b1220] p-3 lg:min-h-0">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[10px] text-slate-400">
              <span>Room footprint · {finite(room?.areaM2, 0).toFixed(2)} m²</span>
              <span className="inline-flex items-center gap-1"><MoveUpRight className="h-3 w-3"/> Top view · X/Z coordinates</span>
            </div>
            {bounds ? (
              <svg ref={svgRef} viewBox={`${bounds.minX} ${-bounds.maxZ} ${bounds.width} ${bounds.height}`} preserveAspectRatio="xMidYMid meet" onClick={handlePlanClick} className={`min-h-0 w-full flex-1 rounded-xl border border-slate-800 bg-slate-950 ${placing ? 'cursor-wait' : 'cursor-crosshair'}`} role="img" aria-label={`Ceiling plan for ${room?.label || 'selected room'}`}>
                <defs>
                  {gridStep > 0 && <pattern id="hci-ceiling-grid" x={gridOriginX} y={gridOriginY} width={gridStep} height={gridStep} patternUnits="userSpaceOnUse"><path d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`} fill="none" stroke="#334155" strokeWidth="0.006" opacity="0.65"/></pattern>}
                </defs>
                <rect x={bounds.minX} y={-bounds.maxZ} width={bounds.width} height={bounds.height} fill="#0b1220"/>
                {gridStep > 0 && <rect x={bounds.minX} y={-bounds.maxZ} width={bounds.width} height={bounds.height} fill="url(#hci-ceiling-grid)"/>}
                <path d={combinedPath} fill="#1e293b" fillRule="evenodd" stroke="#cbd5e1" strokeWidth="0.035" strokeLinejoin="round"/>
                <path d={pathForRing(outer)} fill="none" stroke="#fb923c" strokeWidth="0.045" strokeLinejoin="round"/>
                {openingRings.map((ring, index) => <path key={`opening-${index}`} d={pathForRing(ring)} fill="#020617" fillOpacity="0.9" stroke="#fbbf24" strokeWidth="0.025" strokeDasharray="0.08 0.05"/>)}
                {fixturesInRoom.map((fixture) => {
                  const fixtureAsset = lightingAssets.find((asset) => asset.id === fixture.id || asset.name === fixture.name) || fixture;
                  const selected = fixture.instanceId === selectedFixtureId;
                  return (
                    <g key={fixture.instanceId} data-fixture-marker="true" transform={`translate(${finite(fixture.position?.[0])} ${-finite(fixture.position?.[2])})`} onClick={(event) => { event.stopPropagation(); setSelectedFixtureId(fixture.instanceId); }} className="cursor-pointer">
                      <circle r="0.18" fill={selected ? '#f97316' : '#38bdf8'} fillOpacity="0.18" stroke={selected ? '#fb923c' : '#7dd3fc'} strokeWidth="0.02"/>
                      {fixtureGlyph(fixtureAsset, selected)}
                    </g>
                  );
                })}
                <text x={bounds.minX + 0.12} y={-bounds.maxZ + 0.18} fontSize="0.12" fill="#94a3b8">N</text>
                <path d={`M ${bounds.minX + 0.16} ${-bounds.maxZ + 0.24} l 0 0.22`} stroke="#94a3b8" strokeWidth="0.018"/>
              </svg>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-700 text-xs text-slate-500">This room does not have a valid ceiling boundary.</div>
            )}
            <div className="mt-2 flex items-center justify-between gap-2 px-1 text-[9px] text-slate-500"><span>Click a clear point to place {selectedAsset?.name || 'a fixture'}.</span><span>{placing ? 'Placing…' : `${fixturesInRoom.length} fixture(s)`}</span></div>
          </main>

          <aside className="min-h-0 space-y-3 overflow-y-auto border-t border-slate-800 p-4 lg:border-l lg:border-t-0">
            <div className="flex items-center justify-between gap-2"><div className="text-xs font-bold uppercase tracking-wider text-slate-400">Placed fixtures</div><span className="rounded-full bg-slate-800 px-2 py-0.5 text-[9px] text-slate-400">{fixturesInRoom.length}</span></div>
            {fixturesInRoom.length ? (
              <div className="space-y-2">
                {fixturesInRoom.map((fixture) => (
                  <button key={fixture.instanceId} type="button" onClick={() => setSelectedFixtureId(fixture.instanceId)} className={`w-full rounded-lg border p-2 text-left ${fixture.instanceId === selectedFixtureId ? 'border-orange-400 bg-orange-500/10' : 'border-slate-800 bg-slate-900'}`}>
                    <div className="flex items-center justify-between gap-2"><span className="truncate text-[10px] font-semibold">{fixture.name || fixture.id}</span>{fixture.ceilingMountType === 'recessed' && <CircleDot className="h-3 w-3 shrink-0 text-amber-400"/>}</div>
                    <p className="mt-1 text-[8px] text-slate-500">X {finite(fixture.position?.[0]).toFixed(2)} m · Z {finite(fixture.position?.[2]).toFixed(2)} m</p>
                  </button>
                ))}
                <button type="button" onClick={removeSelectedFixture} disabled={!selectedFixtureId} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-rose-500/30 px-3 py-2 text-[10px] font-semibold text-rose-300 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="h-3 w-3"/> Remove selected fixture</button>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-800 px-3 py-5 text-center text-[10px] text-slate-500">No ceiling fixtures placed in this room yet.</div>
            )}
            {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-[10px] leading-relaxed text-rose-200">{error}</div>}
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-[9px] leading-relaxed text-slate-500">
              <strong className="text-slate-300">Design note</strong><br/>The plan stores fixture positions in the same project furniture list as ordinary GLB assets. Recessed cut-outs are saved on the room ceiling; surface-mounted fixtures do not remove ceiling geometry.
            </div>
            <button type="button" onClick={() => { setSelectedFixtureId(null); setError(''); }} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-800 px-3 py-2 text-[10px] text-slate-400 hover:bg-slate-900"><RotateCcw className="h-3 w-3"/> Clear selection</button>
          </aside>
        </div>

        <footer className="flex items-center justify-between border-t border-slate-800 px-5 py-3">
          <span className="text-[10px] text-slate-500">Changes are auto-saved with the active project.</span>
          <button type="button" onClick={onClose} className="rounded-lg bg-orange-500 px-4 py-2 text-xs font-bold text-white hover:bg-orange-400">Done</button>
        </footer>
      </section>
    </div>
  );
};
