import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Loader2,
  RefreshCw,
  Check,
  AlertTriangle,
  Layers3,
  Ruler,
  MoveVertical,
  Eye,
  Info,
  Palette,
  Grid3X3,
  Brush,
  Sun,
} from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const DEFAULT_COLOR = '#F4F1EA';
// Start flush with the enclosing wall heads. A dropped ceiling remains available
// through the Drop control, but should be an intentional user choice.
const DEFAULT_DROP_METRES = 0;
const DEFAULT_THICKNESS_METRES = 0.05;
const CONFIDENCE_REVIEW_THRESHOLD = 0.6;

const DEFAULT_CEILING_FINISH = {
  kind: 'color',
  id: 'ceiling-warm-white',
  materialId: 'ceiling-warm-white',
  name: 'Warm White',
  color: DEFAULT_COLOR,
  rgb: [0.9569, 0.9451, 0.9176],
  roughness: 0.9,
  metallic: 0,
  texture: null,
  repeat: [2, 2],
};

const ARCHITECTURAL_CEILING_COLORS = [
  { id: 'ceiling-soft-white', name: 'Soft White', color: '#F7F5EF' },
  { id: 'ceiling-ivory', name: 'Ivory', color: '#EEE8D8' },
  { id: 'ceiling-pearl', name: 'Pearl Grey', color: '#D9D9D3' },
  { id: 'ceiling-greige', name: 'Warm Greige', color: '#D0C7B8' },
  { id: 'ceiling-sandstone', name: 'Sandstone', color: '#C9B79C' },
  { id: 'ceiling-sage', name: 'Soft Sage', color: '#AAB6A4' },
  { id: 'ceiling-charcoal', name: 'Charcoal', color: '#45484A' },
  { id: 'ceiling-walnut', name: 'Walnut Accent', color: '#76543B' },
];

const CEILING_STYLE_PRESETS = [
  { id: 'flat', name: 'Minimal flat', description: 'Clean, seamless ceiling', icon: Layers3 },
  { id: 'cove', name: 'Soft cove', description: 'Warm perimeter reveal', icon: Sun },
  { id: 'timber-slats', name: 'Linear timber', description: 'Walnut battens with a finished base', icon: Grid3X3 },
];

function rgbFromHex(hex) {
  const value = String(hex || '#FFFFFF').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return [1, 1, 1];
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function texturePathForMaterial(material) {
  if (material?.texture?.src) return material.texture.src;
  if (material?.textureUrl) return material.textureUrl;
  const source = material?.textureSrc;
  if (!source) return null;
  try {
    return /^https?:\/\//i.test(source) ? new URL(source).pathname : source;
  } catch {
    return null;
  }
}

function materialToCeilingFinish(material) {
  const kind = ['color', 'fabric', 'texture'].includes(material?.kind) ? material.kind : 'color';
  const color = material?.color || '#FFFFFF';
  const repeat = Array.isArray(material?.texture?.repeat)
    ? material.texture.repeat
    : Array.isArray(material?.repeat) ? material.repeat : [2, 2];
  const texturePath = kind === 'color' ? null : texturePathForMaterial(material);
  return {
    kind,
    id: material?.id || material?.slug || material?.materialAssetId || null,
    materialId: material?.materialAssetId || material?.id || material?.slug || null,
    name: material?.name || 'Custom finish',
    brand: material?.brand || null,
    collection: material?.collection || null,
    color,
    rgb: Array.isArray(material?.rgb) ? material.rgb : rgbFromHex(color),
    texture: texturePath ? {
      id: material?.texture?.id || material?.slug || material?.id || null,
      name: material?.name || null,
      src: texturePath,
      repeat: [...repeat],
    } : null,
    textureSrc: texturePath,
    repeat: [...repeat],
    roughness: Number.isFinite(Number(material?.roughness)) ? Number(material.roughness) : 0.86,
    metallic: Number.isFinite(Number(material?.metallic)) ? Number(material.metallic) : 0,
  };
}

const safeNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const round3 = (value) => Number(Number(value).toFixed(3));

function normalizeBoundary(boundary) {
  const outer = Array.isArray(boundary?.outer) ? boundary.outer : [];
  const holes = Array.isArray(boundary?.holes) ? boundary.holes : [];
  const normalizeRing = (ring) => ring
    .map((point) => ({ x: Number(point?.x), z: Number(point?.z) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  return {
    outer: normalizeRing(outer),
    holes: holes.map(normalizeRing).filter((ring) => ring.length >= 3),
  };
}

function usesWallTopReference(room) {
  return room?.elevationSource === 'boundary-wall-top'
    || room?.elevationSource === 'fallback-estimate';
}

function getFinishedBottomY(room, structuralY, drop, thickness) {
  // RoomDetector reports the underside of an existing IFC overhead surface,
  // but a wall-top reference describes the top of the generated slab. Keep
  // the slab's top face on the wall head for wall-top/fallback references.
  const topFaceReferenceOffset = usesWallTopReference(room) ? thickness : 0;
  return round3(structuralY - drop - topFaceReferenceOffset);
}

function buildCeilingDesign(room, analysis, settings) {
  const boundary = normalizeBoundary(room?.boundary);
  if (boundary.outer.length < 3) {
    throw new Error('This room has an invalid boundary. Re-run room analysis or choose another room.');
  }

  const structuralY = safeNumber(settings.structuralY, safeNumber(room.recommendedCeilingY, room.floorY + 2.7));
  const drop = Math.max(0, Math.min(1, safeNumber(settings.drop, DEFAULT_DROP_METRES)));
  const thickness = Math.max(0.025, Math.min(0.25, safeNumber(settings.thickness, DEFAULT_THICKNESS_METRES)));
  const finishedBottomY = getFinishedBottomY(room, structuralY, drop, thickness);
  const ceilingId = `ceiling_${String(room.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return {
    schemaVersion: 1,
    id: ceilingId,
    roomId: room.id,
    navigationRoomId: room.navigationRoomId || null,
    levelId: room.levelId || null,
    label: `${room.label || 'Room'} ceiling`,
    sourceModelFingerprint: analysis?.sourceFingerprint || null,
    kind: 'flat',
    boundary,
    elevation: {
      structuralY: round3(structuralY),
      drop: round3(drop),
      finishedBottomY,
      thickness: round3(thickness),
      unit: 'm',
    },
    profileType: settings.profileType || 'flat',
    parameters: {
      perimeterInset: 0,
      profileDepth: settings.profileType === 'cove' ? 0.022 : settings.profileType === 'timber-slats' ? 0.045 : 0,
      coveWidth: settings.profileType === 'cove' ? 0.026 : 0,
      slatSpacing: settings.profileType === 'timber-slats' ? 0.18 : 0,
    },
    finish: {
      ...(settings.finish || DEFAULT_CEILING_FINISH),
      kind: settings.finish?.kind || 'color',
      color: settings.finish?.color || settings.color || DEFAULT_COLOR,
      rgb: settings.finish?.rgb || rgbFromHex(settings.finish?.color || settings.color || DEFAULT_COLOR),
      materialId: settings.finish?.materialId || settings.finish?.id || null,
    },
    visible: true,
    areaM2: safeNumber(room.areaM2, 0),
    analysis: {
      elevationSource: room.elevationSource || 'fallback-estimate',
      confidence: safeNumber(room.confidence, 0),
      boundarySource: room.boundarySource || 'wall-topology-grid',
      boundaryConfidence: safeNumber(room.boundaryConfidence, 0),
      semanticSpace: room.semanticSpace || null,
      diagnostics: Array.isArray(room.diagnostics) ? room.diagnostics : [],
      ceilingCandidateIds: (room.ceilingCandidates || []).map((candidate) => candidate.id),
    },
    revision: 1,
  };
}

function getElevationSourceLabel(room) {
  switch (room?.elevationSource) {
    case 'ifc-overhead-surface': return 'IFC overhead surface';
    case 'boundary-wall-top': return 'Enclosing wall tops';
    default: return 'Fallback estimate — manual review required';
  }
}

function getBoundarySourceLabel(room) {
  switch (room?.boundarySource) {
    case 'ifc-space-anchor-geodesic': return 'IFC room anchor + wall constraints (inferred)';
    case 'wall-topology-grid': return 'Wall-topology footprint';
    default: return 'Unclassified boundary source';
  }
}

function getConfidenceTone(confidence) {
  if (confidence >= 0.8) return 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200';
  if (confidence >= CONFIDENCE_REVIEW_THRESHOLD) return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200';
  return 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200';
}

export const CeilingDesignerModal = ({
  open,
  jobId,
  existingCeilings = [],
  onClose,
  onApply,
  onPreview,
  materialLibrary = [],
  materialLibraryLoading = false,
  materialLibraryError = '',
}) => {
  const [analysis, setAnalysis] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [levels, setLevels] = useState([]);
  const [selectedLevelId, setSelectedLevelId] = useState('');
  const [selectedRoomId, setSelectedRoomId] = useState('');
  const [drop, setDrop] = useState(DEFAULT_DROP_METRES);
  const [thickness, setThickness] = useState(DEFAULT_THICKNESS_METRES);
  const [heightOverrides, setHeightOverrides] = useState({});
  const [finish, setFinish] = useState(DEFAULT_CEILING_FINISH);
  const [finishMode, setFinishMode] = useState('color');
  const [finishSearch, setFinishSearch] = useState('');
  const [profileType, setProfileType] = useState('flat');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);
  const [confirmLowConfidence, setConfirmLowConfidence] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const requestVersionRef = useRef(0);
  const onPreviewRef = useRef(onPreview);
  const abortRef = useRef(null);

  useEffect(() => { onPreviewRef.current = onPreview; }, [onPreview]);

  const existingRoomIds = useMemo(
    () => new Set(existingCeilings.flatMap((item) => [item?.roomId, item?.navigationRoomId]).filter(Boolean)),
    [existingCeilings],
  );

  const analysedLevels = useMemo(
    () => levels.filter((level) => level.analysisStatus === 'analysed'),
    [levels],
  );

  const visibleRooms = useMemo(() => {
    const source = selectedLevelId ? rooms.filter((room) => room.levelId === selectedLevelId) : rooms;
    return source;
  }, [rooms, selectedLevelId]);

  const selectedRoom = useMemo(
    () => visibleRooms.find((room) => room.id === selectedRoomId) || null,
    [visibleRooms, selectedRoomId],
  );

  // Reopen a room's saved ceiling settings when the user selects a room that
  // already has a design. This prevents a simple edit from silently replacing
  // an existing finish/profile with the dialog defaults.
  useEffect(() => {
    if (!selectedRoomId) return;
    const room = rooms.find((item) => item.id === selectedRoomId);
    if (!room) return;
    const saved = existingCeilings.find((item) => (
      item?.roomId === room.id ||
      item?.roomId === room.navigationRoomId ||
      item?.navigationRoomId === room.navigationRoomId
    ));
    if (!saved) return;

    const elevation = saved.elevation && typeof saved.elevation === 'object' ? saved.elevation : {};
    const structuralY = safeNumber(elevation.structuralY, safeNumber(room.recommendedCeilingY, safeNumber(room.floorY, 0) + 2.7));
    const savedThickness = Math.max(0.025, Math.min(0.25, safeNumber(elevation.thickness, DEFAULT_THICKNESS_METRES)));
    setHeightOverrides((previous) => ({ ...previous, [room.id]: round3(structuralY) }));
    setDrop(Math.max(0, Math.min(1, safeNumber(elevation.drop, 0))));
    setThickness(savedThickness);
    setProfileType(['flat', 'cove', 'timber-slats'].includes(saved.profileType) ? saved.profileType : 'flat');

    const savedFinish = saved.finish && typeof saved.finish === 'object'
      ? saved.finish
      : { kind: 'color', color: saved.color || DEFAULT_COLOR };
    const finishKind = ['color', 'fabric', 'texture'].includes(savedFinish.kind) ? savedFinish.kind : 'color';
    setFinish({
      ...DEFAULT_CEILING_FINISH,
      ...savedFinish,
      kind: finishKind,
      color: savedFinish.color || DEFAULT_COLOR,
      rgb: Array.isArray(savedFinish.rgb) ? savedFinish.rgb : rgbFromHex(savedFinish.color || DEFAULT_COLOR),
    });
    setFinishMode(finishKind);
  }, [selectedRoomId, rooms, existingCeilings]);

  const architecturalColorMaterials = useMemo(() => {
    const builtIns = ARCHITECTURAL_CEILING_COLORS.map((item) => ({
      ...item,
      kind: 'color',
      brand: 'HCI Architectural Palette',
      collection: 'Ceiling finishes',
      rgb: rgbFromHex(item.color),
      roughness: 0.9,
      metallic: 0,
    }));
    const source = (Array.isArray(materialLibrary) ? materialLibrary : []).filter((item) => item?.kind === 'color');
    const seen = new Set();
    return [...builtIns, ...source].filter((item) => {
      const key = String(item.color || '').toUpperCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [materialLibrary]);

  const filteredFinishMaterials = useMemo(() => {
    const query = finishSearch.trim().toLowerCase();
    return (Array.isArray(materialLibrary) ? materialLibrary : [])
      .filter((item) => item?.kind === finishMode && finishMode !== 'color')
      .filter((item) => !query || [item.name, item.category, item.brand, item.collection, item.shadeCode].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [materialLibrary, finishMode, finishSearch]);

  const detectRooms = useCallback(async (rebuild = false) => {
    if (!jobId) {
      setError('Open a saved IFC project before creating a room ceiling.');
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    setConfirmLowConfidence(false);
    setAnalysis(null);
    setRooms([]);
    setLevels([]);
    setSelectedLevelId('');
    setSelectedRoomId('');
    onPreviewRef.current?.(null);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/projects/${encodeURIComponent(jobId)}/ceiling-analysis`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ forceRebuild: Boolean(rebuild) }),
          signal: controller.signal,
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const details = payload.details ? `\n${payload.details}` : '';
        throw new Error(`${payload.error || `Ceiling analysis failed (${response.status}).`}${details}`);
      }
      if (![1, 2].includes(Number(payload.schemaVersion)) || !Array.isArray(payload.rooms) || !Array.isArray(payload.levels)) {
        throw new Error('The backend returned an unsupported ceiling-analysis response. Update the backend analyzer and restart it.');
      }
      if (requestVersion !== requestVersionRef.current) return;

      const detectedRooms = payload.rooms.filter((room) => (
        room && room.id && room.levelId && Array.isArray(room.boundary?.outer) && room.boundary.outer.length >= 3
      ));
      if (!detectedRooms.length) {
        const reason = payload.warnings?.length ? ` ${payload.warnings.join(' ')}` : '';
        throw new Error(`No usable room regions were detected on the analysed floor.${reason}`);
      }

      const activeLevels = payload.levels.filter((level) => level.analysisStatus === 'analysed');
      const nextLevelId = activeLevels[0]?.id || detectedRooms[0]?.levelId || '';
      const firstRoom = detectedRooms.find((room) => room.levelId === nextLevelId) || detectedRooms[0];

      setAnalysis(payload);
      setRooms(detectedRooms);
      setLevels(payload.levels);
      setSelectedLevelId(nextLevelId);
      setSelectedRoomId(firstRoom?.id || '');
      setHeightOverrides(Object.fromEntries(detectedRooms.map((room) => [
        room.id,
        round3(safeNumber(room.recommendedCeilingY, safeNumber(room.floorY, 0) + 2.7)),
      ])));
      setLoadedAt(new Date());
    } catch (caught) {
      if (caught?.name !== 'AbortError' && requestVersion === requestVersionRef.current) {
        setError(caught?.message || 'Could not analyse this IFC model.');
      }
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    if (!open) {
      requestVersionRef.current += 1;
      abortRef.current?.abort();
      setAnalysis(null);
      setRooms([]);
      setLevels([]);
      setSelectedLevelId('');
      setSelectedRoomId('');
      setError('');
      setLoading(false);
      onPreviewRef.current?.(null);
      setPreviewError('');
      return undefined;
    }
    void detectRooms(false);
    return () => {
      requestVersionRef.current += 1;
      abortRef.current?.abort();
      onPreviewRef.current?.(null);
    };
  }, [open, jobId, detectRooms]);

  const previewDesign = useMemo(() => {
    if (!selectedRoom || !analysis) return null;
    try {
      return buildCeilingDesign(selectedRoom, analysis, {
        structuralY: heightOverrides[selectedRoom.id] ?? selectedRoom.recommendedCeilingY,
        drop,
        thickness,
        finish,
        profileType,
      });
    } catch {
      return null;
    }
  }, [selectedRoom, analysis, heightOverrides, drop, thickness, finish, profileType]);

  useEffect(() => {
    if (!open) return undefined;
    if (!previewDesign) {
      onPreviewRef.current?.(null);
      return undefined;
    }
    const previewCreated = onPreviewRef.current?.(previewDesign);
    setPreviewError(previewCreated === false ? 'The preview mesh could not be created. Check the room boundary and browser console.' : '');
    return () => onPreviewRef.current?.(null);
  }, [open, previewDesign]);

  useEffect(() => {
    setConfirmLowConfidence(false);
  }, [selectedRoomId, selectedLevelId, drop, thickness, finish, profileType]);

  if (!open) return null;

  const confidence = safeNumber(selectedRoom?.confidence, 0);
  const boundaryConfidence = safeNumber(selectedRoom?.boundaryConfidence, selectedRoom?.confidence || 0);
  const needsManualConfirmation = Boolean(selectedRoom && (
    confidence < 0.75 ||
    boundaryConfidence < 0.75 ||
    selectedRoom.elevationSource !== 'ifc-overhead-surface' ||
    selectedRoom.boundarySource === 'ifc-space-anchor-geodesic' ||
    analysis?.units?.confidence === 'assumed-metre'
  ));
  const selectedExistingCeiling = selectedRoom ? existingCeilings.find((item) => (
    item?.roomId === selectedRoom.id ||
    item?.roomId === selectedRoom.navigationRoomId ||
    item?.navigationRoomId === selectedRoom.navigationRoomId
  )) : null;
  const selectedStructuralY = selectedRoom
    ? safeNumber(heightOverrides[selectedRoom.id], selectedRoom.recommendedCeilingY)
    : 0;
  const finishedBottomY = selectedRoom
    ? getFinishedBottomY(selectedRoom, selectedStructuralY, drop, thickness)
    : 0;
  const topFaceY = round3(finishedBottomY + thickness);
  const selectedUsesWallTop = usesWallTopReference(selectedRoom);

  const selectFinishMaterial = (material) => {
    setFinish(materialToCeilingFinish(material));
  };

  const selectCustomCeilingColor = (nextColor) => {
    setFinish({
      kind: 'color',
      id: `custom-${nextColor.replace('#', '').toLowerCase()}`,
      materialId: null,
      name: 'Custom colour',
      color: nextColor,
      rgb: rgbFromHex(nextColor),
      roughness: 0.9,
      metallic: 0,
      texture: null,
      textureSrc: null,
      repeat: [2, 2],
    });
  };

  const createCeiling = () => {
    if (!selectedRoom || !analysis || !previewDesign) return;
    if (needsManualConfirmation && !confirmLowConfidence) return;
    const next = [
      ...existingCeilings.filter((ceiling) => (
        ceiling?.roomId !== selectedRoom.id &&
        ceiling?.roomId !== selectedRoom.navigationRoomId &&
        ceiling?.navigationRoomId !== selectedRoom.navigationRoomId
      )),
      previewDesign,
    ];
    onApply?.(next);
    onClose?.();
  };

  const formatLevelLabel = (level) => `${level.label || 'Level'} · ${Number(level.elevationY || 0).toFixed(2)} m${level.analysisStatus === 'analysed' ? '' : ' · not segmented'}`;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="hci-ceiling-designer-title">
      <section className="flex max-h-[min(92vh,820px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
              <Layers3 className="h-4 w-4 text-[#ff914d]"/> HCI Room-aware Ceiling Designer
            </div>
            <p id="hci-ceiling-designer-title" className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Analyse IFC rooms, preview one fitted ceiling, then apply it to the selected room.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close ceiling designer">
            <X className="h-4 w-4"/>
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {analysis && (
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-700 dark:bg-slate-800/50 md:grid-cols-5">
              <div><span className="block text-[10px] text-slate-400">Detected rooms</span><strong className="text-slate-800 dark:text-slate-100">{analysis.stats?.roomCount ?? rooms.length}</strong></div>
              <div><span className="block text-[10px] text-slate-400">IFC space anchors</span><strong className="text-slate-800 dark:text-slate-100">{analysis.stats?.semanticSpaceCount ?? 0}</strong></div>
              <div><span className="block text-[10px] text-slate-400">Candidate ceilings</span><strong className="text-slate-800 dark:text-slate-100">{analysis.stats?.candidateCeilingCount ?? 0}</strong></div>
              <div><span className="block text-[10px] text-slate-400">IFC length unit</span><strong className="text-slate-800 dark:text-slate-100">{analysis.units?.sourceLengthUnit || 'Unknown'}</strong></div>
              <div><span className="block text-[10px] text-slate-400">Analysis cache</span><strong className="text-slate-800 dark:text-slate-100">{analysis.stats?.cacheHit ? 'Reused' : 'Fresh'}</strong></div>
            </div>
          )}

          {analysis?.units?.confidence === 'assumed-metre' && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0"/>
              <span>IFC length units could not be confirmed. The geometry is currently interpreted in metre-like scene units. Check the project scale before applying a ceiling.</span>
            </div>
          )}

          {analysis?.warnings?.length > 0 && (
            <details className="rounded-xl border border-slate-200 p-3 text-xs dark:border-slate-700">
              <summary className="cursor-pointer font-semibold text-slate-700 dark:text-slate-200">Analysis notes ({analysis.warnings.length})</summary>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-slate-500 dark:text-slate-400">
                {analysis.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
              </ul>
            </details>
          )}

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-[220px] flex-1">
              <label className="mb-1.5 block text-xs font-semibold text-slate-600 dark:text-slate-300">Building level</label>
              <select
                value={selectedLevelId}
                onChange={(event) => {
                  const nextLevelId = event.target.value;
                  setSelectedLevelId(nextLevelId);
                  const nextRoom = rooms.find((room) => room.levelId === nextLevelId);
                  setSelectedRoomId(nextRoom?.id || '');
                }}
                disabled={!analysedLevels.length || loading}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              >
                {analysedLevels.map((level) => <option key={level.id} value={level.id}>{formatLevelLabel(level)}</option>)}
                {!analysedLevels.length && <option value="">No analysed levels</option>}
              </select>
            </div>
            <button
              type="button"
              onClick={() => { void detectRooms(true); }}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:border-orange-300 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}/> Re-analyse IFC
            </button>
          </div>

          {loading && (
            <div className="flex items-center justify-center gap-2 rounded-xl bg-slate-50 py-10 text-sm text-slate-500 dark:bg-slate-800/60">
              <Loader2 className="h-4 w-4 animate-spin"/> Analysing IFC room boundaries, levels and overhead surfaces…
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 whitespace-pre-wrap rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0"/>{error}
            </div>
          )}

          {!loading && rooms.length > 0 && (
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(300px,0.9fr)]">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Rooms on this level ({visibleRooms.length})</div>
                  <span className="text-[10px] text-slate-400">Select one room to preview</span>
                </div>
                <div className="max-h-[330px] space-y-2 overflow-y-auto pr-1">
                  {visibleRooms.map((room) => {
                    const roomConfidence = safeNumber(room.confidence, 0);
                    const isSelected = room.id === selectedRoomId;
                    const hasExisting = existingRoomIds.has(room.id) || existingRoomIds.has(room.navigationRoomId);
                    return (
                      <button
                        key={room.id}
                        type="button"
                        onClick={() => setSelectedRoomId(room.id)}
                        aria-pressed={isSelected}
                        className={`w-full rounded-xl border p-3 text-left transition ${isSelected ? 'border-orange-400 bg-orange-50/70 ring-1 ring-orange-200 dark:border-orange-400/60 dark:bg-orange-500/10 dark:ring-orange-500/20' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-500'}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{room.label || room.id}</span>
                              {hasExisting && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[9px] font-bold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">Ceiling exists</span>}
                            </div>
                            <p className="mt-1 text-[10px] text-slate-500">{safeNumber(room.areaM2, 0).toFixed(2)} m² · Floor Y {safeNumber(room.floorY, 0).toFixed(2)} m</p>
                            <p className="mt-0.5 text-[10px] text-slate-400">{getBoundarySourceLabel(room)}</p>
                            <p className="mt-0.5 text-[10px] text-slate-400">{room.ceilingCandidates?.length || 0} overhead candidates · {getElevationSourceLabel(room)}</p>
                          </div>
                          <span className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-bold ${getConfidenceTone(roomConfidence)}`}>Height {Math.round(roomConfidence * 100)}%</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-[9px] text-slate-500">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">Boundary {Math.round(safeNumber(room.boundaryConfidence, 0) * 100)}%</span>
                          {room.semanticSpace?.globalId && <span className="truncate">IFC space · {room.semanticSpace.globalId.slice(0, 8)}</span>}
                        </div>
                        {room.diagnostics?.length > 0 && <p className="mt-2 line-clamp-2 text-[10px] text-amber-700 dark:text-amber-300">{room.diagnostics[0]}</p>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-bold text-slate-800 dark:text-slate-100">Ceiling preview settings</div>
                    <div className="mt-0.5 text-[10px] text-slate-400">Preview appears in the 3D viewport</div>
                  </div>
                  <Eye className="h-4 w-4 text-orange-500"/>
                </div>

                {selectedRoom ? (
                  <>
                    <div className="rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/70">
                      <div className="flex justify-between gap-2"><span className="text-slate-500">Reference ceiling Y</span><strong className="text-slate-800 dark:text-slate-100">{safeNumber(selectedRoom.recommendedCeilingY, 0).toFixed(3)} m</strong></div>
                      <div className="mt-1 flex justify-between gap-2"><span className="text-slate-500">Proposed underside Y</span><strong className="text-slate-800 dark:text-slate-100">{finishedBottomY.toFixed(3)} m</strong></div>
                      <div className="mt-1 flex justify-between gap-2"><span className="text-slate-500">Proposed top-face Y</span><strong className="text-slate-800 dark:text-slate-100">{topFaceY.toFixed(3)} m</strong></div>
                      <div className="mt-1 flex justify-between gap-2"><span className="text-slate-500">Top-face alignment</span><strong className="text-slate-800 dark:text-slate-100">{selectedUsesWallTop ? 'Wall head' : 'IFC overhead reference'}</strong></div>
                      <div className="mt-1 flex justify-between gap-2"><span className="text-slate-500">Room footprint</span><strong className="text-slate-800 dark:text-slate-100">{selectedRoom.boundary?.outer?.length || 0} vertices · {selectedRoom.boundary?.holes?.length || 0} openings</strong></div>
                      <div className="mt-1 flex justify-between gap-2"><span className="text-slate-500">Boundary confidence</span><strong className="text-slate-800 dark:text-slate-100">{Math.round(boundaryConfidence * 100)}%</strong></div>
                      <div className="mt-1 flex justify-between gap-2"><span className="text-slate-500">Boundary method</span><strong className="max-w-[62%] text-right text-slate-800 dark:text-slate-100">{getBoundarySourceLabel(selectedRoom)}</strong></div>
                    </div>

                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
                      Structural/reference height (m)
                      <input
                        type="number" step="0.01" value={selectedStructuralY}
                        onChange={(event) => setHeightOverrides((previous) => ({ ...previous, [selectedRoom.id]: safeNumber(event.target.value, selectedStructuralY) }))}
                        className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                      />
                    </label>

                    <div className="grid grid-cols-2 gap-2">
                      <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
                        <span className="inline-flex items-center gap-1"><MoveVertical className="h-3 w-3"/> Drop (m)</span>
                        <input type="number" min="0" max="1" step="0.01" value={drop} onChange={(event) => setDrop(Math.max(0, Math.min(1, safeNumber(event.target.value, DEFAULT_DROP_METRES))))} className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"/>
                      </label>
                      <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
                        <span className="inline-flex items-center gap-1"><Ruler className="h-3 w-3"/> Thickness (m)</span>
                        <input type="number" min="0.025" max="0.25" step="0.005" value={thickness} onChange={(event) => setThickness(Math.max(0.025, Math.min(0.25, safeNumber(event.target.value, DEFAULT_THICKNESS_METRES))))} className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"/>
                      </label>
                    </div>

                    <section className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-bold text-slate-800 dark:text-slate-100">Ceiling design</div>
                          <p className="mt-0.5 text-[10px] text-slate-400">Choose a profile and then its surface finish.</p>
                        </div>
                        <Brush className="h-4 w-4 text-orange-500"/>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {CEILING_STYLE_PRESETS.map((preset) => {
                          const StyleIcon = preset.icon;
                          const selected = profileType === preset.id;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => setProfileType(preset.id)}
                              aria-pressed={selected}
                              className={`min-w-0 rounded-xl border p-2 text-left transition ${selected ? 'border-orange-400 bg-orange-50 ring-1 ring-orange-200 dark:border-orange-400/60 dark:bg-orange-500/10 dark:ring-orange-500/20' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-500'}`}
                            >
                              <div className={`mb-2 flex h-10 items-center justify-center rounded-lg ${preset.id === 'cove' ? 'bg-gradient-to-b from-amber-100 to-slate-100 dark:from-amber-400/15 dark:to-slate-800' : preset.id === 'timber-slats' ? 'bg-[repeating-linear-gradient(90deg,#A77B4A_0px,#A77B4A_3px,#E6D5BF_3px,#E6D5BF_8px)]' : 'bg-slate-100 dark:bg-slate-800'}`}>
                                <StyleIcon className={`h-4 w-4 ${preset.id === 'timber-slats' ? 'text-white drop-shadow' : 'text-orange-500'}`}/>
                              </div>
                              <span className="block truncate text-[10px] font-bold text-slate-800 dark:text-slate-100">{preset.name}</span>
                              <span className="mt-0.5 block text-[9px] leading-3 text-slate-500 dark:text-slate-400">{preset.description}</span>
                            </button>
                          );
                        })}
                      </div>
                    </section>

                    <section className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-bold text-slate-800 dark:text-slate-100">Architectural finishes</div>
                          <p className="mt-0.5 text-[10px] text-slate-400">The selected finish is mapped to both faces and exposed edges.</p>
                        </div>
                        <Palette className="h-4 w-4 text-orange-500"/>
                      </div>
                      <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                        {['color', 'fabric', 'texture'].map((mode) => (
                          <button key={mode} type="button" onClick={() => { setFinishMode(mode); setFinishSearch(''); }} className={`rounded-md py-1.5 text-[9px] font-bold capitalize transition ${finishMode === mode ? 'bg-white text-slate-800 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'}`}>
                            {mode === 'color' ? 'Colours' : mode === 'fabric' ? 'Fabric' : 'Texture'}
                          </button>
                        ))}
                      </div>

                      {finishMode === 'color' ? (
                        <>
                          <div className="grid grid-cols-4 gap-2">
                            {architecturalColorMaterials.map((material) => {
                              const selected = String(finish.color || '').toUpperCase() === String(material.color || '').toUpperCase();
                              return (
                                <button key={`${material.id}-${material.color}`} type="button" onClick={() => selectFinishMaterial(material)} title={`${material.name} ${material.color}`} aria-pressed={selected} className={`min-w-0 rounded-lg border p-1.5 text-left transition ${selected ? 'border-orange-400 ring-1 ring-orange-300 dark:border-orange-400' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'}`}>
                                  <span className="block h-7 rounded-md border border-black/10" style={{ backgroundColor: material.color }}/>
                                  <span className="mt-1 block truncate text-[8px] font-semibold text-slate-600 dark:text-slate-300">{material.name}</span>
                                </button>
                              );
                            })}
                          </div>
                          <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-2 text-[10px] font-semibold text-slate-600 dark:border-slate-700 dark:text-slate-300">
                            Custom colour
                            <input aria-label="Custom ceiling finish colour" type="color" value={finish.color || DEFAULT_COLOR} onChange={(event) => selectCustomCeilingColor(event.target.value)} className="h-8 w-12 cursor-pointer rounded-md border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-950"/>
                          </label>
                        </>
                      ) : (
                        <>
                          <input value={finishSearch} onChange={(event) => setFinishSearch(event.target.value)} placeholder={`Search ${finishMode === 'fabric' ? 'fabrics' : 'textures'}…`} className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[10px] text-slate-700 outline-none focus:border-orange-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"/>
                          {filteredFinishMaterials.length > 0 ? (
                            <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto pr-1">
                              {filteredFinishMaterials.map((material) => {
                                const selected = finish.materialId === material.materialAssetId || finish.id === material.id || finish.name === material.name;
                                const image = material.textureSrc || material.texture?.src;
                                return (
                                  <button key={material.id} type="button" onClick={() => selectFinishMaterial(material)} aria-pressed={selected} className={`flex min-w-0 items-center gap-2 rounded-lg border p-2 text-left transition ${selected ? 'border-orange-400 bg-orange-50 dark:bg-orange-500/10' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'}`}>
                                    <span className="h-9 w-9 shrink-0 rounded-md border border-black/10 bg-cover bg-center" style={{ backgroundColor: material.color || '#FFFFFF', backgroundImage: image ? `url(${image})` : 'none' }}/>
                                    <span className="min-w-0"><span className="block truncate text-[9px] font-bold text-slate-700 dark:text-slate-200">{material.name}</span><span className="block truncate text-[8px] text-slate-400">{material.brand || material.category || 'Surface finish'}</span></span>
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-center dark:border-slate-700">
                              <p className="text-[10px] font-semibold text-slate-600 dark:text-slate-300">{materialLibraryLoading ? 'Loading finishes…' : materialLibraryError ? 'Material library unavailable' : 'No matching finishes uploaded'}</p>
                              <p className="mt-1 text-[9px] text-slate-400">{materialLibraryError || 'Upload reusable fabrics and textures under Admin → Surface Materials.'}</p>
                            </div>
                          )}
                        </>
                      )}

                      <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-[10px] dark:bg-slate-800/70">
                        <span className="min-w-0 truncate text-slate-500">Selected: <strong className="text-slate-800 dark:text-slate-100">{finish.name || 'Custom colour'}</strong></span>
                        <span className="shrink-0 rounded-md border border-slate-200 px-2 py-1 font-mono text-slate-500 dark:border-slate-700">{finish.kind || 'color'}</span>
                      </div>
                      {finishMode !== 'color' && !filteredFinishMaterials.length && materialLibraryLoading && <div className="flex items-center gap-2 text-[9px] text-slate-400"><span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-orange-500"/> Loading reusable finishes…</div>}
                    </section>

                    {needsManualConfirmation && (
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[10px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                        <input type="checkbox" checked={confirmLowConfidence} onChange={(event) => setConfirmLowConfidence(event.target.checked)} className="mt-0.5 accent-orange-500"/>
                        <span><strong>Confirm manual review.</strong> The room boundary is inferred and/or the ceiling elevation needs review. I have inspected the selected room footprint and proposed height in the 3D preview.</span>
                      </label>
                    )}

                    {previewDesign && !previewError && <div className="flex items-center gap-2 text-[10px] text-emerald-700 dark:text-emerald-300"><Check className="h-3.5 w-3.5"/> Live preview active in the 3D viewport</div>}
                    {previewError && <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[10px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0"/>{previewError}</div>}
                  </>
                ) : (
                  <div className="rounded-lg bg-slate-50 p-6 text-center text-xs text-slate-500 dark:bg-slate-800/60">Choose a detected room to preview a ceiling.</div>
                )}
              </div>
            </div>
          )}

          {analysis && !loading && rooms.length > 0 && levels.some((level) => level.analysisStatus === 'detected-not-segmented') && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0"/>
              <span>Additional floor elevations were found, but this first release only segments the lowest analysed level. Higher floors are intentionally not mixed into the current room boundaries.</span>
            </div>
          )}

          {loadedAt && <p className="text-[10px] text-slate-400">Analysis completed {loadedAt.toLocaleTimeString()} · {analysis?.coordinateSystem || 'coordinate frame unavailable'} · Source {analysis?.sourceFingerprint?.slice(0, 20) || 'unknown'}…</p>}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 dark:border-slate-700">
          <span className="text-xs text-slate-500">{selectedRoom ? `One room selected: ${selectedRoom.label || selectedRoom.id}` : 'Select a room to continue'}</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 dark:border-slate-700 dark:text-slate-300">Cancel</button>
            <button
              type="button"
              onClick={createCeiling}
              disabled={!selectedRoom || !previewDesign || Boolean(previewError) || loading || (needsManualConfirmation && !confirmLowConfidence)}
              className="inline-flex items-center gap-2 rounded-lg bg-[#ff914d] px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-[#f47f39] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Check className="h-3.5 w-3.5"/>{selectedExistingCeiling ? 'Replace room ceiling' : 'Apply ceiling to this room'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
};
