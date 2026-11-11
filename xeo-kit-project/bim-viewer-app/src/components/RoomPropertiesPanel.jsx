import { useEffect, useMemo, useState } from 'react';
import { DoorOpen, Focus, Grid2X2, Lightbulb, PencilLine, Ruler, AlertTriangle, Layers3, Sparkles, Building2, Package, RefreshCw, Trash2, ChevronRight, Lock } from 'lucide-react';

const ROOM_TYPES = [
  ['living-room', 'Living room'],
  ['bedroom', 'Bedroom'],
  ['master-bedroom', 'Master bedroom'],
  ['kitchen', 'Kitchen'],
  ['dining-room', 'Dining room'],
  ['bathroom', 'Bathroom'],
  ['office', 'Study / office'],
  ['balcony', 'Balcony / terrace'],
  ['corridor', 'Corridor'],
  ['storage', 'Storage'],
  ['utility', 'Utility'],
  ['other', 'Other'],
];

function inferRoomType(room) {
  const semanticText = Array.isArray(room?.semanticSpaces) && room.semanticSpaces.length
    ? room.semanticSpaces.flatMap((space) => [space?.name, space?.description])
    : [room?.semanticSpace?.name, room?.semanticSpace?.description];
  const source = [...semanticText, room?.label].filter(Boolean).join(' ').toLowerCase();
  const rules = [
    ['master-bedroom', /master\s*(bed|bedroom)|primary\s*bed/],
    ['bedroom', /bed\s*room|bedroom|sleep/],
    ['living-room', /living|lounge|family\s*room/],
    ['kitchen', /kitchen|pantry/],
    ['dining-room', /dining/],
    ['bathroom', /bath|toilet|wc|shower/],
    ['office', /study|office|work\s*room/],
    ['balcony', /balcony|terrace|veranda|outdoor/],
    ['corridor', /corridor|hallway|passage/],
    ['storage', /store|storage|closet/],
    ['utility', /utility|laundry/],
  ];
  const match = rules.find(([, expression]) => expression.test(source));
  if (!match) return null;
  return { type: match[0], label: ROOM_TYPES.find(([value]) => value === match[0])?.[1] || 'Other', source: semanticText.some(Boolean) ? 'IFC space labels' : 'detected room label' };
}

const formatMeters = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)} m` : '—';

export const RoomPropertiesPanel = ({
  room,
  roomProperties = {},
  onUpdateRoom,
  onFocusRoom,
  onPlanRoom,
  onOpenCeilingDesigner,
  onSelectBoundaryWalls,
  roomFurniture = [],
  nativeModelElements = [],
  onSelectNativeModelElement,
  onSelectRoomAsset,
  onReplaceRoomAsset,
  onDeleteRoomAsset,
  onBrowseItems,
  isDarkMode = true,
  hasDesignedCeiling = false,
}) => {
  const saved = roomProperties?.[room?.id] || {};
  const suggestion = useMemo(() => inferRoomType(room), [room]);
  const initialName = saved.name || room?.label || 'Unnamed room';
  const initialType = saved.type || suggestion?.type || 'other';
  const [name, setName] = useState(initialName);
  const [nativeElementQuery, setNativeElementQuery] = useState('');

  useEffect(() => { setName(initialName); }, [initialName, room?.id]);

  if (!room) return null;
  const area = Number(room.areaM2);
  const height = Number(room.recommendedCeilingY) - Number(room.floorY);
  const confidence = Math.max(0, Math.min(1, Number(room.boundaryConfidence ?? room.confidence ?? 0)));
  const wallCount = Array.isArray(room.boundaryWallGlobalIds) ? room.boundaryWallGlobalIds.length : 0;
  const semanticSpaces = Array.isArray(room.semanticSpaces) && room.semanticSpaces.length
    ? room.semanticSpaces
    : room.semanticSpace ? [room.semanticSpace] : [];
  const itemNames = [
    ...roomFurniture.map((item) => String(item?.name || '').toLowerCase()),
    ...nativeModelElements.map((item) => String(item?.name || '').toLowerCase()),
  ];
  const visibleNativeElements = nativeModelElements.filter((item) => {
    const query = nativeElementQuery.trim().toLowerCase();
    return !query || `${item.name || ''} ${item.ifcType || ''} ${item.predefinedType || ''}`.toLowerCase().includes(query);
  });
  const activeRoomType = saved.type || suggestion?.type || 'other';
  const roomSuggestion = activeRoomType.includes('bedroom') && !itemNames.some((name) => name.includes('bed'))
    ? { query: 'bed', action: 'Find a bed', message: 'A bed, bedside tables and wardrobe are common starting points for a bedroom.' }
    : activeRoomType === 'living-room' && !itemNames.some((name) => /sofa|couch/.test(name))
      ? { query: 'sofa', action: 'Find a sofa', message: 'A sofa, coffee table and media unit are common starting points for a living room.' }
      : activeRoomType === 'dining-room' && !itemNames.some((name) => /dining table|dining set/.test(name))
        ? { query: 'dining table', action: 'Find a dining table', message: 'A dining table with appropriately spaced chairs is a useful starting point.' }
        : null;
  const muted = isDarkMode ? 'text-slate-400' : 'text-slate-500';
  const card = isDarkMode ? 'border-slate-700/70 bg-slate-800/50' : 'border-slate-200 bg-slate-50';
  const control = isDarkMode ? 'border-slate-700 bg-slate-950/60 text-white' : 'border-slate-200 bg-white text-slate-900';

  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(initialName);
      return;
    }
    if (trimmed !== initialName) onUpdateRoom?.(room.id, { name: trimmed });
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#ff914d]/15 text-[#ff914d]"><DoorOpen className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#e97831]">Room editor</p>
          <h3 className="mt-1 truncate text-base font-bold text-slate-900 dark:text-white">{saved.name || room.label || 'Detected room'}</h3>
          <p className={`mt-0.5 text-[10px] ${muted}`}>{room.levelLabel || room.levelId || 'Detected floor'}</p>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={onFocusRoom} className="flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#ff914d] px-3 py-2 text-[11px] font-bold text-white transition hover:bg-[#ff7a28]"><Focus className="h-3.5 w-3.5" /> Focus 3D</button>
        <button type="button" onClick={onPlanRoom} className={`flex min-h-10 items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-bold transition ${control} hover:border-[#ff914d]/60`}><Grid2X2 className="h-3.5 w-3.5" /> Plan view</button>
      </div>

      <section className="space-y-3">
        <div>
          <label className={`mb-1.5 block text-[10px] font-bold uppercase tracking-wider ${muted}`} htmlFor="hci-room-name">Room name</label>
          <div className="flex items-center gap-2">
            <input id="hci-room-name" value={name} onChange={(event) => setName(event.target.value)} onBlur={saveName} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} maxLength={120} className={`h-10 min-w-0 flex-1 rounded-xl border px-3 text-xs outline-none focus:border-[#ff914d] ${control}`} />
            <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${card}`}><PencilLine className={`h-4 w-4 ${muted}`} /></span>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label className={`text-[10px] font-bold uppercase tracking-wider ${muted}`} htmlFor="hci-room-type">Room type</label>
            {suggestion && !saved.type && <span className="text-[9px] font-semibold text-emerald-500">Suggested</span>}
          </div>
          <select id="hci-room-type" value={initialType} onChange={(event) => onUpdateRoom?.(room.id, { type: event.target.value })} className={`h-10 w-full rounded-xl border px-3 text-xs outline-none focus:border-[#ff914d] ${control}`}>
            {ROOM_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>

        {suggestion && !saved.type && (
          <div className={`rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] p-3`}>
            <div className="flex items-center gap-2 text-[11px] font-bold text-emerald-500"><Sparkles className="h-3.5 w-3.5" /> Smart suggestion: {suggestion.label}</div>
            <p className={`mt-1 text-[10px] leading-4 ${muted}`}>Suggested from the {suggestion.source}. You can override it above.</p>
          </div>
        )}
      </section>

      <section className={`mt-4 rounded-xl border p-3 ${card}`}>
        <div className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-100"><Ruler className="h-4 w-4 text-[#ff914d]" /> Room measurements</div>
        <div className="grid grid-cols-2 gap-y-3">
          <div><p className={`text-[9px] uppercase tracking-wider ${muted}`}>Floor area</p><p className="mt-1 text-sm font-bold tabular-nums">{Number.isFinite(area) && area > 0 ? `${area.toFixed(2)} m²` : '—'}</p></div>
          <div><p className={`text-[9px] uppercase tracking-wider ${muted}`}>Est. clear height</p><p className="mt-1 text-sm font-bold tabular-nums">{Number.isFinite(height) && height > 0 ? formatMeters(height) : '—'}</p></div>
          <div><p className={`text-[9px] uppercase tracking-wider ${muted}`}>Boundary walls</p><p className="mt-1 text-sm font-bold tabular-nums">{wallCount || '—'}</p></div>
          <div><p className={`text-[9px] uppercase tracking-wider ${muted}`}>Boundary confidence</p><p className="mt-1 text-sm font-bold tabular-nums">{Math.round(confidence * 100)}%</p></div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-300/50 dark:bg-slate-700"><div className={`h-full rounded-full ${confidence >= 0.75 ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${confidence * 100}%` }} /></div>
        <p className={`mt-2 text-[10px] leading-4 ${muted}`}>{room.boundarySource === 'wall-face-reconstruction' ? 'Reconstructed from IFC wall axes and their planar junction graph. IFC space placements identify and label the physical room; they do not generate its boundary. Review complex junctions before structural changes.' : room.boundarySource === 'ifc-space-wall-constrained-geodesic' || room.boundarySource === 'ifc-space-anchor-geodesic' ? 'Legacy inferred footprint from an IFC room placement and wall-constrained floor regions. Review the outline before structural changes.' : room.boundarySource === 'ifc-space-body-envelope' ? 'Fallback convex envelope from the IFC space body mesh. It may overfill concavities or voids; review and correct the outline before editing.' : 'Footprint derived from surrounding wall topology.'}</p>
        {confidence < 0.7 && <div className="mt-2 flex items-start gap-2 text-[10px] leading-4 text-amber-500"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> This footprint is approximate. Confirm the room boundary before using it for design decisions.</div>}
        {semanticSpaces.length > 0 && (
          <div className="mt-3 border-t border-inherit pt-3">
            <p className={`mb-2 text-[9px] font-bold uppercase tracking-wider ${muted}`}>IFC space labels ({semanticSpaces.length})</p>
            <div className="flex flex-wrap gap-1.5">
              {semanticSpaces.map((space, index) => (
                <span key={space.globalId || space.expressId || `${space.name}-${index}`} className={`rounded-lg border px-2 py-1 text-[10px] ${isDarkMode ? 'border-slate-700 bg-slate-950/40 text-slate-300' : 'border-slate-200 bg-white text-slate-600'}`} title={`Associated ${Number(space.associationDistanceMeters ?? space.snapDistanceMeters ?? 0).toFixed(2)} m from boundary`}>
                  {space.name || `IFC Space ${index + 1}`}
                </span>
              ))}
            </div>
            {semanticSpaces.length > 1 && <p className={`mt-2 text-[9px] leading-4 ${muted}`}>These labels share one physical wall-bounded room. No partition is inferred between them.</p>}
          </div>
        )}
      </section>

      <section className={`mt-4 rounded-xl border p-3 ${card}`}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-100"><Package className="h-4 w-4 text-[#ff914d]" /> Room contents</div>
            <p className={`mt-1 text-[10px] ${muted}`}>{roomFurniture.length} placed project asset{roomFurniture.length === 1 ? '' : 's'} in this footprint</p>
          </div>
          <button type="button" onClick={() => onBrowseItems?.('')} className="shrink-0 rounded-lg bg-[#ff914d] px-2.5 py-2 text-[10px] font-bold text-white transition hover:bg-[#ff7a28]">Add furniture</button>
        </div>

        {roomSuggestion && (
          <div className="mb-3 rounded-lg border border-sky-500/20 bg-sky-500/[0.07] p-2.5 text-[10px] leading-4 text-sky-700 dark:text-sky-200">
            <div className="flex items-start gap-2">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500" />
              <span><strong>Smart suggestion:</strong> {roomSuggestion.message}</span>
            </div>
            <button type="button" onClick={() => onBrowseItems?.(roomSuggestion.query)} className="mt-2 ml-5 rounded-md border border-sky-500/25 bg-white/70 px-2.5 py-1.5 text-[9px] font-bold text-sky-700 transition hover:bg-white dark:bg-slate-900/50 dark:text-sky-200 dark:hover:bg-slate-900">
              {roomSuggestion.action} in catalogue →
            </button>
          </div>
        )}

        {roomFurniture.length ? (
          <div className="space-y-2">
            {roomFurniture.map((item) => {
              const protectedItem = Boolean(item.doorHostWallId || item.isNativeIsolation || item.nativeSourceId);
              const fileType = String(item.fileType || item.file_type || 'asset').toUpperCase();
              return (
                <div key={item.instanceId} className={`rounded-xl border p-2.5 ${isDarkMode ? 'border-slate-700/80 bg-slate-950/35' : 'border-slate-200 bg-white'}`}>
                  <button type="button" onClick={() => onSelectRoomAsset?.(item)} className="flex w-full min-w-0 items-center gap-2.5 text-left" title={`Select ${item.name || 'room item'} for editing`}>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#ff914d]/10 text-[#ff914d]"><Package className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-bold text-slate-800 dark:text-slate-100">{item.name || 'Unnamed item'}</span>
                      <span className={`mt-0.5 block truncate text-[9px] ${muted}`}>{item.assetCategory || item.catalogCategory || fileType} · {item.fileType || item.file_type || '3D asset'}</span>
                    </span>
                    <ChevronRight className={`h-4 w-4 shrink-0 ${muted}`} />
                  </button>
                  <div className="mt-2 flex items-center gap-2 pl-[46px]">
                    <button type="button" onClick={() => onSelectRoomAsset?.(item)} className={`rounded-md border px-2 py-1.5 text-[9px] font-semibold ${isDarkMode ? 'border-slate-700 text-slate-300 hover:border-[#ff914d]/60' : 'border-slate-200 text-slate-600 hover:border-orange-300'}`}>Select & edit</button>
                    <button type="button" onClick={() => onReplaceRoomAsset?.(item)} disabled={protectedItem} title={protectedItem ? 'Hosted or isolated IFC elements require their dedicated editing workflow.' : `Replace ${item.name || 'item'}`} className="inline-flex items-center gap-1 rounded-md border border-[#ff914d]/25 px-2 py-1.5 text-[9px] font-semibold text-[#e97831] hover:bg-[#ff914d]/10 disabled:cursor-not-allowed disabled:opacity-40"><RefreshCw className="h-3 w-3" /> Replace</button>
                    <button type="button" onClick={() => onDeleteRoomAsset?.(item)} disabled={protectedItem} title={protectedItem ? 'This element is linked to a structural host and cannot be removed from this list.' : `Remove ${item.name || 'item'}`} className="inline-flex items-center gap-1 rounded-md border border-rose-500/20 px-2 py-1.5 text-[9px] font-semibold text-rose-500 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="h-3 w-3" /> Remove</button>
                    {protectedItem && <span className={`ml-auto inline-flex items-center gap-1 text-[9px] ${muted}`}><Lock className="h-3 w-3" /> Linked</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className={`rounded-lg border border-dashed px-3 py-5 text-center ${isDarkMode ? 'border-slate-700 text-slate-400' : 'border-slate-300 text-slate-500'}`}>
            <Package className="mx-auto h-5 w-5 opacity-60" />
            <p className="mt-2 text-[10px] font-semibold">No separately placed assets</p>
            <p className="mt-1 text-[9px] leading-4">Native IFC furniture is listed separately below. Add catalogue assets here to create editable project instances.</p>
          </div>
        )}
        <p className={`mt-2 text-[9px] leading-4 ${muted}`}>Select an item to use the existing Move, Rotate and Resize tools. Replacing it keeps its saved position, rotation and scale.</p>
      </section>

      {nativeModelElements.length > 0 && (
        <section className={`mt-3 rounded-xl border p-3 ${card}`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-100"><Building2 className="h-4 w-4 text-[#ff914d]" /> Native IFC furniture & fixtures</div>
              <p className={`mt-1 text-[10px] ${muted}`}>{nativeModelElements.length} source-model element{nativeModelElements.length === 1 ? '' : 's'} found in this room</p>
            </div>
            <span className="rounded-full bg-slate-500/10 px-2 py-1 text-[9px] font-semibold text-slate-500">IFC</span>
          </div>
          <input
            value={nativeElementQuery}
            onChange={(event) => setNativeElementQuery(event.target.value)}
            placeholder="Find bed, wardrobe, sofa…"
            aria-label="Search native IFC room elements"
            className={`mb-2 h-9 w-full rounded-lg border px-3 text-[10px] outline-none focus:border-[#ff914d] ${control}`}
          />
          <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {visibleNativeElements.slice(0, 40).map((element) => (
              <button
                key={element.globalId || `${element.sourceFile}:${element.expressId}`}
                type="button"
                onClick={() => onSelectNativeModelElement?.(element)}
                className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition ${isDarkMode ? 'border-slate-700/80 bg-slate-950/35 hover:border-[#ff914d]/50' : 'border-slate-200 bg-white hover:border-orange-300'}`}
                title="Select this native IFC element, then choose Enable editing in Properties to make it a project asset."
              >
                <Package className="h-3.5 w-3.5 shrink-0 text-[#ff914d]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] font-semibold text-slate-800 dark:text-slate-100">{element.name || `IFC element ${element.expressId}`}</span>
                  <span className={`mt-0.5 block truncate text-[9px] ${muted}`}>{String(element.ifcType || 'IFC element').replace(/^IFC/, '')} · #{element.expressId}</span>
                </span>
                <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${muted}`} />
              </button>
            ))}
            {visibleNativeElements.length === 0 && <p className={`px-2 py-4 text-center text-[10px] ${muted}`}>No native IFC elements match this search.</p>}
            {visibleNativeElements.length > 40 && <p className={`px-2 pt-1 text-center text-[9px] ${muted}`}>Showing 40 of {visibleNativeElements.length}. Refine your search to find another element.</p>}
          </div>
          <p className={`mt-2 text-[9px] leading-4 ${muted}`}>These elements are part of the original IFC. Select one, then use Enable editing in Properties to create a moveable isolated project instance. Multi-part furniture assemblies are not yet grouped as one editable object.</p>
        </section>
      )}

      <section className="mt-4 space-y-2">
        <button type="button" onClick={onOpenCeilingDesigner} className={`flex w-full items-center justify-between rounded-xl border px-3 py-3 text-left transition ${card} hover:border-[#ff914d]/50`}>
          <span className="flex items-center gap-2.5"><Layers3 className="h-4 w-4 text-[#ff914d]" /><span><span className="block text-xs font-bold">Ceiling design</span><span className={`mt-0.5 block text-[10px] ${muted}`}>{hasDesignedCeiling ? 'A custom ceiling is saved' : 'Create or edit this room ceiling'}</span></span></span>
          <span className="text-xs text-[#ff914d]">Open →</span>
        </button>
        {wallCount > 0 && (
          <button type="button" onClick={onSelectBoundaryWalls} className={`flex w-full items-center justify-between rounded-xl border px-3 py-3 text-left transition ${card} hover:border-[#ff914d]/50`}>
            <span className="flex items-center gap-2.5"><Building2 className="h-4 w-4 text-[#ff914d]" /><span><span className="block text-xs font-bold">Select boundary walls</span><span className={`mt-0.5 block text-[10px] ${muted}`}>Select {wallCount} associated IFC wall references</span></span></span>
            <span className="text-xs text-[#ff914d]">Select →</span>
          </button>
        )}
      </section>

      <div className={`mt-4 rounded-xl border border-dashed p-3 ${isDarkMode ? 'border-slate-700 text-slate-400' : 'border-slate-300 text-slate-500'}`}>
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider"><Lightbulb className="h-3.5 w-3.5 text-[#ff914d]" /> Editing guidance</div>
        <p className="mt-1.5 text-[10px] leading-4">Room contents use the existing asset transform and replacement pipeline. This edits individual furniture and fixtures; moving or resizing the architectural room boundary remains a separate structural-editing feature.</p>
      </div>
    </div>
  );
};
