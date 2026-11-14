import { useMemo, useState } from 'react';
import { DoorOpen, Search, X, Loader2, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';

const formatArea = (value) => Number.isFinite(Number(value)) && Number(value) > 0
  ? `${Number(value).toFixed(1)} m²`
  : 'Area unavailable';

export const RoomBrowserPanel = ({
  open,
  onClose,
  rooms = [],
  levels = [],
  analysis = null,
  onRefresh,
  status = 'idle',
  error = '',
  selectedRoomId = null,
  roomProperties = {},
  onSelectRoom,
  onRetry,
  isDarkMode = true,
  leftOffset = 16,
}) => {
  const [query, setQuery] = useState('');
  const [levelId, setLevelId] = useState('all');
  const visibleRooms = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return rooms.filter((room) => {
      if (levelId !== 'all' && room.levelId !== levelId) return false;
      const name = roomProperties?.[room.id]?.name || room.label || '';
      const semanticLabels = Array.isArray(room.semanticSpaces) && room.semanticSpaces.length
        ? room.semanticSpaces.map((space) => `${space?.name || ''} ${space?.description || ''}`).join(' ')
        : `${room.semanticSpace?.name || ''} ${room.semanticSpace?.description || ''}`;
      return !normalized || `${name} ${semanticLabels}`.toLowerCase().includes(normalized);
    }).sort((a, b) => (Number(b.areaM2) || 0) - (Number(a.areaM2) || 0));
  }, [rooms, query, levelId, roomProperties]);

  if (!open) return null;

  const shell = isDarkMode
    ? 'border-slate-700/90 bg-[#0b1322]/95 text-slate-100 shadow-black/40'
    : 'border-slate-200 bg-white/96 text-slate-800 shadow-slate-900/15';
  const muted = isDarkMode ? 'text-slate-400' : 'text-slate-500';
  const semanticSpaceCount = Number(analysis?.stats?.semanticSpaceCount) || 0;
  const semanticSpaceAssignedToFloorCount = Number(analysis?.stats?.semanticSpaceAssignedToFloorCount) || 0;
  const expectedFloorSemanticSpaceCount = semanticSpaceAssignedToFloorCount || semanticSpaceCount;
  const matchedSemanticSpaceCount = Number(analysis?.stats?.semanticMatchedSpaceCount ?? analysis?.stats?.resolvedAnchorCount) || 0;
  const unmatchedSemanticSpaces = Array.isArray(analysis?.stats?.unmatchedSemanticSpaces) ? analysis.stats.unmatchedSemanticSpaces : [];
  const nativeFurnitureCount = Number(analysis?.stats?.nativeFurnitureAssignedCount) || 0;
  const semanticZoneCount = rooms.filter((room) => room.regionKind === 'semantic-zone').length;
  const physicalRoomCount = Math.max(0, rooms.length - semanticZoneCount);
  const anchorDiagnostics = Array.isArray(analysis?.anchorDiagnostics) ? analysis.anchorDiagnostics : [];
  const unresolvedAnchors = anchorDiagnostics.filter((anchor) => !anchor.resolved);
  const segmentationDegraded = rooms.length === 0 || (expectedFloorSemanticSpaceCount > 0 && matchedSemanticSpaceCount < expectedFloorSemanticSpaceCount);
  const reconstructionMethod = String(analysis?.stats?.roomReconstructionMethod || 'none');
  const roomCoverage = Math.max(0, Math.min(1, Number(analysis?.stats?.roomFootprintCoverageRatio ?? analysis?.stats?.roomCoverageRatio) || 0));
  const methodLabel = reconstructionMethod === 'ifc-wall-planar-graph-v1'
    ? 'IFC wall planar graph'
    : reconstructionMethod === 'ifc-wall-topology-components-and-open-zones-v1'
      ? 'Wall-constrained rooms + semantic zones'
      : reconstructionMethod === 'ifc-space-wall-constrained-geodesic-v2'
        ? 'IFC space anchors + wall-constrained grid'
        : reconstructionMethod === 'ifc-space-body-envelope-v1'
          ? 'IFC body envelope · review required'
          : 'Room reconstruction unavailable';
  const input = isDarkMode
    ? 'border-slate-700 bg-slate-950/70 text-white placeholder:text-slate-500'
    : 'border-slate-200 bg-slate-50 text-slate-900 placeholder:text-slate-400';

  return (
    <section
      className={`absolute top-[70px] z-[58] flex max-h-[min(66vh,620px)] w-[min(330px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border backdrop-blur-2xl shadow-2xl ${shell}`}
      style={{ left: leftOffset }}
      aria-label="Room browser"
    >
      <header className={`flex items-center justify-between border-b px-4 py-3 ${isDarkMode ? 'border-slate-700/80' : 'border-slate-200'}`}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#ff914d]/15 text-[#ff914d]"><DoorOpen className="h-4.5 w-4.5" /></span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold">Rooms &amp; zones</h3>
            <p className={`text-[10px] ${muted}`}>{status === 'loading' ? 'Analysing room boundaries…' : `${rooms.length} detected area${rooms.length === 1 ? '' : 's'}`}</p>
          </div>
        </div>
        <button type="button" onClick={onClose} className={`rounded-lg p-1.5 ${muted} hover:bg-white/10`} aria-label="Close room browser"><X className="h-4 w-4" /></button>
      </header>

      <div className="space-y-2 border-b border-inherit p-3">
        <div className={`flex items-center gap-2 rounded-xl border px-3 ${input}`}>
          <Search className={`h-3.5 w-3.5 shrink-0 ${muted}`} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rooms…" className="h-9 min-w-0 flex-1 bg-transparent text-xs outline-none" aria-label="Search rooms" />
        </div>
        {levels.length > 1 && (
          <select value={levelId} onChange={(event) => setLevelId(event.target.value)} className={`h-9 w-full rounded-xl border px-3 text-xs outline-none ${input}`} aria-label="Filter rooms by floor">
            <option value="all">All floors</option>
            {levels.filter((level) => level.analysisStatus === 'analysed').map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
          </select>
        )}
      </div>

      {status === 'ready' && analysis && (
        <div className={`mx-3 mt-2 rounded-xl border p-2.5 ${segmentationDegraded ? 'border-amber-500/30 bg-amber-500/[0.08]' : isDarkMode ? 'border-slate-700/70 bg-slate-900/50' : 'border-slate-200 bg-slate-50'}`}>
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[10px] font-semibold ${segmentationDegraded ? 'text-amber-500' : muted}`}>
              {`${rooms.length} detected areas · ${physicalRoomCount} physical rooms · ${semanticZoneCount} design zones`}{expectedFloorSemanticSpaceCount ? ` · ${matchedSemanticSpaceCount}/${expectedFloorSemanticSpaceCount} floor IFC labels matched` : ''}
            </span>
            {analysis.stats?.cacheHit && <span className={`text-[9px] ${muted}`}>Cached</span>}
          </div>
          {segmentationDegraded ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-4 text-amber-500">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {rooms.length === 0
                ? 'No closed physical room boundaries were reconstructed from the active floor walls. Inspect missing wall connections and floor-level assignment.'
                : `${matchedSemanticSpaceCount} of ${expectedFloorSemanticSpaceCount} IFC space labels assigned to this floor were associated with room regions. The remaining labels need review; physical room count is not expected to equal the IFC space count.`}
              {unmatchedSemanticSpaces.length > 0 && <span className="mt-1 block">Unmatched: {unmatchedSemanticSpaces.join(', ')}</span>}
            </p>
          ) : semanticSpaceCount > 0 ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-4 text-emerald-500">
              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
              All {expectedFloorSemanticSpaceCount || semanticSpaceCount} IFC space labels assigned to this floor are associated with room regions. Open-plan design zones are inferred subdivisions, not newly created physical walls.
            </p>
          ) : null}
          {analysis.stats?.roomReconstructionMethod && (
            <p className={`mt-1.5 text-[9px] ${muted}`}>Method: {methodLabel} · walkable-grid mapping {Math.round(roomCoverage * 100)}% · {Number(analysis.stats?.wallAxisCount) || 0} wall axes · {Number(analysis.stats?.wallGraphFaceCount) || rooms.length} graph faces</p>
          )}
          {nativeFurnitureCount > 0 && <p className={`mt-1.5 text-[9px] ${muted}`}>{nativeFurnitureCount} native IFC furniture/fixture element(s) assigned to detected rooms.</p>}
          {anchorDiagnostics.length > 0 && (
            <details className={`mt-2 rounded-lg border p-2 ${isDarkMode ? 'border-slate-700/70 bg-slate-950/40' : 'border-slate-200 bg-white'}`}>
              <summary className="cursor-pointer text-[9px] font-semibold">IFC space alignment · {anchorDiagnostics.length - unresolvedAnchors.length}/{anchorDiagnostics.length} aligned</summary>
              <div className="mt-2 max-h-32 space-y-1.5 overflow-y-auto">
                {anchorDiagnostics.map((anchor) => (
                  <div key={anchor.key || anchor.label} className="flex items-start justify-between gap-2 text-[9px]">
                    <span className="min-w-0 truncate">{anchor.label}</span>
                    <span className={`shrink-0 ${anchor.resolved ? 'text-emerald-500' : 'text-rose-500'}`}>
                      {anchor.resolved ? `${Number(anchor.snapDistanceMeters || 0).toFixed(2)} m snap` : String(anchor.failureReason || 'unresolved').replaceAll('-', ' ')}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {analysis.sourceIfcFileName && <p className={`mt-1 text-[9px] ${muted}`}>Source: {analysis.sourceIfcFileName} · {Number(analysis.sourceIfcSizeBytes || 0).toLocaleString()} bytes · IFC SHA {String(analysis.sourceIfcSha256 || '').slice(0, 12) || '—'}</p>}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2.5">
        {status === 'loading' && (
          <div className={`flex items-center justify-center gap-2 px-3 py-8 text-xs ${muted}`}><Loader2 className="h-4 w-4 animate-spin text-[#ff914d]" /> Finding room footprints</div>
        )}
        {status === 'error' && (
          <div className="rounded-xl border border-rose-400/20 bg-rose-500/10 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-rose-500"><AlertTriangle className="h-4 w-4" /> Room analysis failed</div>
            <p className={`mt-2 text-[10px] leading-4 ${muted}`}>We couldn't build reliable room outlines from this model yet. The floor geometry is available, but one or more room boundaries need review.</p>
            {error && <details className="mt-2 rounded-lg border border-slate-700/70 p-2"><summary className="cursor-pointer text-[9px] font-semibold text-slate-300">Technical details</summary><p className={`mt-2 whitespace-pre-wrap text-[9px] leading-4 ${muted}`}>{error}</p></details>}
            <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[#ff914d] px-3 py-2 text-[10px] font-bold text-white"><RefreshCw className="h-3 w-3" /> Retry room detection</button>
          </div>
        )}
        {status === 'ready' && visibleRooms.length === 0 && (
          <div className={`px-4 py-8 text-center text-xs ${muted}`}>{rooms.length ? 'No rooms match this search.' : 'No usable room boundaries were reconstructed. Review the analysis details or retry detection.'}</div>
        )}
        {visibleRooms.map((room, index) => {
          const isSelected = room.id === selectedRoomId;
          const name = roomProperties?.[room.id]?.name || room.label || `Room ${index + 1}`;
          const boundaryConfidence = Number(room.boundaryConfidence ?? room.confidence ?? 0);
          return (
            <button
              key={room.id}
              type="button"
              onClick={() => onSelectRoom?.(room)}
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${isSelected ? 'border-[#ff914d]/60 bg-[#ff914d]/10' : `border-transparent ${isDarkMode ? 'hover:border-slate-700 hover:bg-white/[0.045]' : 'hover:border-slate-200 hover:bg-slate-50'}`}`}
            >
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${isSelected ? 'bg-[#ff914d] text-white' : isDarkMode ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>{String(index + 1).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="block truncate text-xs font-bold">{name}</span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[8px] font-bold uppercase ${room.regionKind === 'semantic-zone' ? 'bg-amber-500/10 text-amber-500' : 'bg-slate-500/10 text-slate-400'}`}>{room.regionKind === 'semantic-zone' ? 'Zone' : 'Room'}</span>
                </span>
                <span className={`mt-1 flex flex-wrap items-center gap-x-2 text-[10px] ${muted}`}>
                  <span>{formatArea(room.areaM2)}</span>
                  <span>·</span>
                  <span>{room.levelLabel || levels.find((level) => level.id === room.levelId)?.label || 'Level'}</span>
                </span>
              </span>
              <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-semibold ${boundaryConfidence >= 0.75 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`} title="Room boundary confidence">{Math.round(boundaryConfidence * 100)}%</span>
            </button>
          );
        })}
      </div>
      <footer className={`border-t px-3 py-2.5 ${isDarkMode ? 'border-slate-700/80 text-slate-500' : 'border-slate-200 text-slate-500'}`}>
        <p className="text-[10px] leading-4">Select a room here or click its highlighted floor region. Inferred boundaries should be reviewed before structural edits.</p>
        <button type="button" onClick={onRefresh || onRetry} disabled={status === 'loading'} className={`mt-2 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold disabled:opacity-40 ${isDarkMode ? 'border-slate-700 text-slate-300 hover:border-[#ff914d]/60' : 'border-slate-200 text-slate-600 hover:border-orange-300'}`}>
          <RefreshCw className={`h-3 w-3 ${status === 'loading' ? 'animate-spin' : ''}`} /> Re-analyse IFC rooms
        </button>
      </footer>
    </section>
  );
};
