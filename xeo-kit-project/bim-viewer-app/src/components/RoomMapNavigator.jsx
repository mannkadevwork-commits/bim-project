import { useMemo, useState } from 'react';
import { AlertTriangle, Footprints, Loader2, MapPinned, RefreshCw, Scan, X } from 'lucide-react';

const MAP_WIDTH = 304;
const MAP_HEIGHT = 150;
const MAP_PADDING = 13;

const roomName = (room, roomProperties, index = 0) => (
  roomProperties?.[room?.id]?.name
  || room?.label
  || room?.semanticSpace?.name
  || `Room ${index + 1}`
);

const getOuter = (room) => (Array.isArray(room?.boundary?.outer) ? room.boundary.outer : [])
  .map((point) => ({ x: Number(point?.x), z: Number(point?.z) }))
  .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));

const polygonCentroid = (points) => {
  if (points.length < 3) return null;
  let area2 = 0;
  let x = 0;
  let z = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.z - next.x * current.z;
    area2 += cross;
    x += (current.x + next.x) * cross;
    z += (current.z + next.z) * cross;
  }
  if (Math.abs(area2) < 1e-8) {
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      z: points.reduce((sum, point) => sum + point.z, 0) / points.length,
    };
  }
  return { x: x / (3 * area2), z: z / (3 * area2) };
};

const shorten = (value, maximum = 15) => {
  const text = String(value || '').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
};

export const RoomMapNavigator = ({
  rooms = [],
  levels = [],
  analysis = null,
  status = 'ready',
  error = '',
  onRetry,
  activeRoomId = null,
  roomProperties = {},
  onSelectRoom,
  onExitRoom,
  onPlanRoom,
  navMode = 'orbit',
  isDarkMode = true,
}) => {
  const [levelId, setLevelId] = useState('all');
  const [hoveredRoomId, setHoveredRoomId] = useState(null);
  const [entryViewPreset, setEntryViewPreset] = useState('auto');
  const [entryEyeHeight, setEntryEyeHeight] = useState('1.55');
  const enterRoomWithCamera = (room) => onSelectRoom?.(room, {
    viewPreset: entryViewPreset,
    eyeHeight: Number(entryEyeHeight) || 1.55,
  });
  const availableLevels = useMemo(() => levels.filter((level) => (
    level?.analysisStatus === 'analysed' || rooms.some((room) => room.levelId === level?.id)
  )), [levels, rooms]);
  const visibleRooms = useMemo(() => rooms.filter((room) => (
    levelId === 'all' || room.levelId === levelId
  )), [rooms, levelId]);

  const mapModel = useMemo(() => {
    const prepared = visibleRooms.map((room, index) => ({
      room,
      index,
      name: roomName(room, roomProperties, index),
      points: getOuter(room),
    })).filter((item) => item.points.length >= 3);
    const allPoints = prepared.flatMap((item) => item.points);
    if (!allPoints.length) return { rooms: prepared, empty: true };

    const minX = Math.min(...allPoints.map((point) => point.x));
    const maxX = Math.max(...allPoints.map((point) => point.x));
    const minZ = Math.min(...allPoints.map((point) => point.z));
    const maxZ = Math.max(...allPoints.map((point) => point.z));
    const spanX = Math.max(maxX - minX, 0.1);
    const spanZ = Math.max(maxZ - minZ, 0.1);
    const scale = Math.min(
      (MAP_WIDTH - MAP_PADDING * 2) / spanX,
      (MAP_HEIGHT - MAP_PADDING * 2) / spanZ,
    );
    const offsetX = (MAP_WIDTH - spanX * scale) / 2;
    const offsetY = (MAP_HEIGHT - spanZ * scale) / 2;
    const project = (point) => ({
      x: offsetX + (point.x - minX) * scale,
      y: offsetY + (point.z - minZ) * scale,
    });

    const mappedRooms = prepared.map((item) => {
      const mapped = item.points.map(project);
      const label = polygonCentroid(mapped) || mapped.reduce((acc, point) => ({ x: acc.x + point.x / mapped.length, y: acc.y + point.y / mapped.length }), { x: 0, y: 0 });
      const path = `${mapped.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')} Z`;
      return { ...item, mapped, label, path };
    });
    return { rooms: mappedRooms, empty: false };
  }, [visibleRooms, roomProperties]);

  const activeRoom = rooms.find((room) => String(room.id) === String(activeRoomId)) || null;
  const activeName = activeRoom ? roomName(activeRoom, roomProperties) : 'Choose a room';
  const walkMode = navMode === 'firstPerson';
  const shell = isDarkMode
    ? 'border-slate-700/80 bg-[#101a2b] text-slate-100'
    : 'border-slate-200 bg-white text-slate-800';

  return (
    <section className={`mx-3 mt-3 shrink-0 overflow-hidden rounded-xl border ${shell}`} aria-label="Room map navigator">
      <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#ff914d]/15 text-[#ff914d]"><MapPinned className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h3 className="text-[11px] font-bold">Floor map</h3>
            <p className={`text-[9px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{visibleRooms.length} areas · select to enter</p>
          </div>
        </div>
        {availableLevels.length > 1 && (
          <select
            value={levelId}
            onChange={(event) => setLevelId(event.target.value)}
            className={`max-w-[112px] rounded-lg border px-2 py-1 text-[9px] outline-none ${isDarkMode ? 'border-slate-700 bg-slate-950 text-slate-200' : 'border-slate-200 bg-slate-50 text-slate-700'}`}
            aria-label="Map floor"
          >
            <option value="all">All floors</option>
            {availableLevels.map((level) => <option key={level.id} value={level.id}>{level.label || level.name || 'Floor'}</option>)}
          </select>
        )}
        {onRetry && (
          <button type="button" onClick={onRetry} disabled={status === 'loading'} className={`rounded-md border p-1.5 disabled:opacity-40 ${isDarkMode ? 'border-slate-700 text-slate-400 hover:text-[#ff914d]' : 'border-slate-200 text-slate-500 hover:text-orange-600'}`} title="Rebuild room map" aria-label="Rebuild room map">
            <RefreshCw className={`h-3 w-3 ${status === 'loading' ? 'animate-spin' : ''}`} />
          </button>
        )}
      </header>

      {status === 'ready' && analysis?.stats && (() => {
        const semanticSpaceCount = Number(analysis.stats.semanticSpaceCount || 0);
        const floorSpaceCount = Number(analysis.stats.semanticSpaceAssignedToFloorCount || 0);
        const matchedSpaceCount = Number(analysis.stats.semanticMatchedSpaceCount ?? analysis.stats.resolvedAnchorCount ?? 0);
        const semanticZoneCount = visibleRooms.filter((room) => room.regionKind === 'semantic-zone').length;
        const physicalRoomCount = visibleRooms.length - semanticZoneCount;
        const anchorDiagnostics = Array.isArray(analysis.anchorDiagnostics) ? analysis.anchorDiagnostics : [];
        const unresolved = anchorDiagnostics.filter((item) => !item.resolved);
        const incomplete = floorSpaceCount > 0 && matchedSpaceCount < floorSpaceCount;
        const wallMaskCoverage = Math.round(Math.max(0, Math.min(1, Number(analysis.stats.wallMaskCoverageRatio) || 0)) * 100);
        const activeWallCount = Number(analysis.stats.activeLevelWallGeometryCount || 0);
        return (
          <div className={`px-3 pb-2 text-[8px] ${isDarkMode ? 'text-slate-500' : 'text-slate-500'}`}>
            <p>IFC spaces {semanticSpaceCount} · this floor {floorSpaceCount} · aligned {matchedSpaceCount} · {physicalRoomCount} rooms · {semanticZoneCount} zones</p>
            {incomplete && (
              <div className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.08] px-2 py-1.5 text-[9px] leading-4 text-amber-500">
                {matchedSpaceCount} of {floorSpaceCount} IFC space anchors aligned to this floor. The map still includes independently reconstructed physical regions; unresolved labels are not silently merged. {activeWallCount} active wall elements contributed to the boundary analysis, with {wallMaskCoverage}% wall-mask coverage of the floor grid.
                {unresolved.length > 0 && <details className="mt-1"><summary className="cursor-pointer font-semibold">Show {unresolved.length} unresolved space labels</summary><div className="mt-1 space-y-0.5">{unresolved.map((item) => <p key={item.key}>{item.label}: {String(item.failureReason || 'unresolved').replaceAll('-', ' ')}{Number.isFinite(Number(item.outsideFloorDistanceMeters)) ? ` · ${Number(item.outsideFloorDistanceMeters).toFixed(2)} m from floor` : ''}</p>)}</div></details>}
              </div>
            )}
          </div>
        );
      })()}
      <div className={`mx-2 overflow-hidden rounded-lg border ${isDarkMode ? 'border-slate-700 bg-[#0a1220]' : 'border-slate-200 bg-slate-50'}`}>
        {status === 'loading' && rooms.length === 0 ? (
          <div className={`flex h-[150px] flex-col items-center justify-center gap-2 px-5 text-center text-[10px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            <Loader2 className="h-5 w-5 animate-spin text-[#ff914d]" />
            <span>Building your room map…</span>
            <span className="text-[9px] opacity-75">Reading room boundaries from the IFC model</span>
          </div>
        ) : status === 'error' && rooms.length === 0 ? (
          <div className={`flex h-[150px] flex-col items-center justify-center gap-2 px-5 text-center text-[10px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <span className="font-semibold">Room map unavailable</span>
            <span className="line-clamp-2 text-[9px]">{error || 'Room analysis could not be completed.'}</span>
            <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 rounded-md bg-[#ff914d] px-2.5 py-1.5 text-[9px] font-bold text-white"><RefreshCw className="h-3 w-3" /> Retry analysis</button>
          </div>
        ) : mapModel.empty ? (
          <div className={`flex h-[150px] items-center justify-center px-5 text-center text-[10px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Room outlines are unavailable. Select a room from the Rooms browser to focus the camera.
          </div>
        ) : (
          <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} className="block h-[150px] w-full" role="group" aria-label="Clickable floor plan">
            <defs>
              <pattern id="hci-room-map-grid" width="16" height="16" patternUnits="userSpaceOnUse">
                <path d="M 16 0 L 0 0 0 16" fill="none" stroke={isDarkMode ? '#223149' : '#e2e8f0'} strokeWidth="0.7" />
              </pattern>
            </defs>
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#hci-room-map-grid)" />
            {mapModel.rooms.map((item) => {
              const isActive = String(item.room.id) === String(activeRoomId);
              const isHovered = String(item.room.id) === String(hoveredRoomId);
              return (
                <g
                  key={item.room.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Enter ${item.name}`}
                  onClick={() => enterRoomWithCamera(item.room)}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); enterRoomWithCamera(item.room); } }}
                  onMouseEnter={() => setHoveredRoomId(String(item.room.id))}
                  onMouseLeave={() => setHoveredRoomId(null)}
                  className="cursor-pointer outline-none"
                >
                  <path
                    d={item.path}
                    fill={isActive ? '#ff914d' : isHovered ? '#60a5fa' : (isDarkMode ? '#475569' : '#cbd5e1')}
                    fillOpacity={isActive ? 0.55 : isHovered ? 0.42 : 0.34}
                    stroke={isActive ? '#ff914d' : isHovered ? '#60a5fa' : (isDarkMode ? '#a8b7ca' : '#64748b')}
                    strokeWidth={isActive ? 2.8 : 1.6}
                    vectorEffect="non-scaling-stroke"
                  />
                  <text
                    x={item.label.x}
                    y={item.label.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="8.5"
                    fontWeight={isActive ? '800' : '600'}
                    fill={isDarkMode ? '#f8fafc' : '#1e293b'}
                    paintOrder="stroke"
                    stroke={isDarkMode ? '#0a1220' : '#f8fafc'}
                    strokeWidth="2.6"
                    strokeLinejoin="round"
                    pointerEvents="none"
                  >
                    {shorten(item.name, 17)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div className={`grid grid-cols-2 gap-2 px-3 pb-2 pt-2 ${isDarkMode ? 'border-t border-slate-700/60' : 'border-t border-slate-200'}`}>
        <label className="min-w-0 text-[9px] font-semibold">
          <span className={`mb-1 block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Entry angle</span>
          <select
            value={entryViewPreset}
            onChange={(event) => setEntryViewPreset(event.target.value)}
            className={`w-full rounded-md border px-2 py-1.5 text-[10px] outline-none focus:border-[#ff914d] ${isDarkMode ? 'border-slate-700 bg-slate-950 text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}
            aria-label="Room camera entry angle"
          >
            <option value="auto">Auto · clearest view</option>
            <option value="front">Front (+Z)</option>
            <option value="back">Back (−Z)</option>
            <option value="left">Left (−X)</option>
            <option value="right">Right (+X)</option>
            <option value="front-left">Front left</option>
            <option value="front-right">Front right</option>
            <option value="back-left">Back left</option>
            <option value="back-right">Back right</option>
          </select>
        </label>
        <label className="min-w-0 text-[9px] font-semibold">
          <span className={`mb-1 block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Eye height</span>
          <select
            value={entryEyeHeight}
            onChange={(event) => setEntryEyeHeight(event.target.value)}
            className={`w-full rounded-md border px-2 py-1.5 text-[10px] outline-none focus:border-[#ff914d] ${isDarkMode ? 'border-slate-700 bg-slate-950 text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}
            aria-label="Room camera eye height"
          >
            <option value="1.35">1.35 m · Low</option>
            <option value="1.55">1.55 m · Standard</option>
            <option value="1.70">1.70 m · High</option>
          </select>
        </label>
      </div>

      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-2">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-bold">{activeName}</p>
          <p className={`text-[9px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            {activeRoom
              ? `${Number(activeRoom.areaM2 || 0).toFixed(1)} m² · ${walkMode ? 'Inside room · click an object to edit' : 'Room selected'}`
              : 'Select a room on the map'}
          </p>
          {walkMode && <p className={`mt-0.5 text-[8px] ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>Drag to look · W/A/S/D to move · click an item to edit</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => activeRoom && onPlanRoom?.(activeRoom)} disabled={!activeRoom} className={`rounded-md border p-1.5 disabled:opacity-35 ${isDarkMode ? 'border-slate-700 text-slate-300 hover:border-[#ff914d]' : 'border-slate-200 text-slate-600 hover:border-orange-300'}`} title="Switch to 2D plan view"><Scan className="h-3.5 w-3.5" /><span className="text-[9px] font-semibold">2D</span></button>
          {walkMode ? (
            <button type="button" onClick={onExitRoom} className="inline-flex items-center gap-1 rounded-md bg-[#ff914d] px-2 py-1.5 text-[9px] font-bold text-white hover:bg-[#f47e36]" title="Exit room to building view"><X className="h-3 w-3" /> Building</button>
          ) : (
            <button type="button" onClick={() => activeRoom && enterRoomWithCamera(activeRoom)} disabled={!activeRoom} className="inline-flex items-center gap-1 rounded-md bg-[#ff914d] px-2 py-1.5 text-[9px] font-bold text-white hover:bg-[#f47e36] disabled:opacity-40" title="Enter selected room"><Footprints className="h-3 w-3" /> Enter</button>
          )}
        </div>
      </div>
      <div className={`flex max-h-[64px] flex-wrap gap-1.5 overflow-y-auto border-t px-2.5 py-2 ${isDarkMode ? 'border-slate-700/70' : 'border-slate-200'}`}>
        {visibleRooms.map((room, index) => {
          const selected = String(room.id) === String(activeRoomId);
          return (
            <button
              key={room.id}
              type="button"
              onClick={() => enterRoomWithCamera(room)}
              className={`max-w-full truncate rounded-md border px-2 py-1 text-[9px] font-semibold transition ${selected ? 'border-[#ff914d] bg-[#ff914d] text-white' : isDarkMode ? 'border-slate-700 bg-slate-900/80 text-slate-300 hover:border-[#ff914d]/70' : 'border-slate-200 bg-white text-slate-600 hover:border-orange-300'}`}
              title={roomName(room, roomProperties, index)}
            >
              {roomName(room, roomProperties, index)}
            </button>
          );
        })}
      </div>
    </section>
  );
};
