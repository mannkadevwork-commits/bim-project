import { useRef, useState } from 'react';
import {
  X,
  FileBox,
  ImageIcon,
  Loader2,
  Home,
  Building2,
  AlertTriangle,
  CheckCircle2,
  ArrowLeft,
  RefreshCw,
} from 'lucide-react';
import { buildIfcFloorPlanPreview } from '../utils/ifcFloorPlanPreview';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const PREDEFINED_PLANS = [
  {
    id: '1bhk',
    name: '1 BHK',
    description: 'One bedroom · 5 named spaces · 8 × 7 m test layout',
    icon: Home,
    fileName: 'HCI_Test_1BHK.ifc',
    fileUrl: `${API_BASE_URL}/assets/HCI_Test_1BHK.ifc`,
    preview: {
      width: 8,
      height: 7,
      rooms: [
        { name: 'Living Room', x1: 0, y1: 0, x2: 4.4, y2: 3.4 },
        { name: 'Bedroom', x1: 4.4, y1: 0, x2: 8, y2: 3.4 },
        { name: 'Kitchen', x1: 0, y1: 3.4, x2: 4.4, y2: 7 },
        { name: 'Bathroom', x1: 4.4, y1: 3.4, x2: 6.2, y2: 5.2 },
        { name: 'Utility', x1: 4.4, y1: 5.2, x2: 8, y2: 7 },
      ],
    },
  },
  {
    id: '2bhk',
    name: '2 BHK',
    description: 'Two bedrooms · 7 named spaces · 11 × 9 m test layout',
    icon: Building2,
    fileName: 'HCI_Test_2BHK.ifc',
    fileUrl: `${API_BASE_URL}/assets/HCI_Test_2BHK.ifc`,
    preview: {
      width: 11,
      height: 9,
      rooms: [
        { name: 'Living / Dining', x1: 0, y1: 0, x2: 6.2, y2: 4.2 },
        { name: 'Master Bedroom', x1: 6.2, y1: 0, x2: 11, y2: 4.2 },
        { name: 'Kitchen', x1: 0, y1: 4.2, x2: 4.1, y2: 9 },
        { name: 'Circulation', x1: 4.1, y1: 4.2, x2: 6.2, y2: 9 },
        { name: 'Bedroom 2', x1: 6.2, y1: 4.2, x2: 8.8, y2: 9 },
        { name: 'Bathroom', x1: 8.8, y1: 4.2, x2: 11, y2: 6.2 },
        { name: 'Ensuite', x1: 8.8, y1: 6.2, x2: 11, y2: 9 },
      ],
    },
  },
  {
    id: '3bhk',
    name: '3 BHK',
    description: 'Three bedrooms · 9 named spaces · 14 × 11 m test layout',
    icon: Building2,
    fileName: 'HCI_Test_3BHK.ifc',
    fileUrl: `${API_BASE_URL}/assets/HCI_Test_3BHK.ifc`,
    preview: {
      width: 14,
      height: 11,
      rooms: [
        { name: 'Living', x1: 0, y1: 0, x2: 7.2, y2: 3.7 },
        { name: 'Dining', x1: 0, y1: 3.7, x2: 7.2, y2: 7.5 },
        { name: 'Bedroom 2', x1: 7.2, y1: 0, x2: 10.5, y2: 3.7 },
        { name: 'Bedroom 3', x1: 7.2, y1: 3.7, x2: 10.5, y2: 7.5 },
        { name: 'Master', x1: 10.5, y1: 0, x2: 14, y2: 7.5 },
        { name: 'Kitchen', x1: 0, y1: 7.5, x2: 4.2, y2: 11 },
        { name: 'Circulation', x1: 4.2, y1: 7.5, x2: 7.2, y2: 11 },
        { name: 'Bathroom', x1: 7.2, y1: 7.5, x2: 10.5, y2: 11 },
        { name: 'Ensuite', x1: 10.5, y1: 7.5, x2: 14, y2: 11 },
      ],
      openPlanEdge: true,
    },
  },
];

function getTemplateProjection(plan, width, height, padding = 12) {
  const scale = Math.min((width - padding * 2) / plan.width, (height - padding * 2) / plan.height);
  const drawnWidth = plan.width * scale;
  const drawnHeight = plan.height * scale;
  const offsetX = (width - drawnWidth) / 2;
  const offsetY = (height - drawnHeight) / 2;
  return {
    scale,
    rect: (room) => ({
      x: offsetX + room.x1 * scale,
      y: offsetY + room.y1 * scale,
      width: (room.x2 - room.x1) * scale,
      height: (room.y2 - room.y1) * scale,
      cx: offsetX + ((room.x1 + room.x2) / 2) * scale,
      cy: offsetY + ((room.y1 + room.y2) / 2) * scale,
    }),
    offsetX,
    offsetY,
  };
}

function TemplatePlanPreview({ plan, compact = false }) {
  const width = compact ? 270 : 760;
  const height = compact ? 132 : 300;
  const projection = getTemplateProjection(plan.preview, width, height, compact ? 9 : 18);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-full w-full" role="img" aria-label={`${plan.name} full floor plan preview`}>
      <rect width={width} height={height} fill="#f8fafc" />
      <rect
        x={projection.offsetX}
        y={projection.offsetY}
        width={plan.preview.width * projection.scale}
        height={plan.preview.height * projection.scale}
        fill="#e7e5e4"
        stroke="#1e293b"
        strokeWidth={compact ? 3 : 5}
      />
      {plan.preview.rooms.map((room, index) => {
        const rect = projection.rect(room);
        const fontSize = compact ? 7 : 12;
        return (
          <g key={`${plan.id}-${room.name}`}>
            <rect
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              fill={index % 2 === 0 ? '#dce8e8' : '#e8e5dd'}
              stroke="#334155"
              strokeWidth={compact ? 1.8 : 2.8}
            />
            <text
              x={rect.cx}
              y={rect.cy}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={fontSize}
              fontWeight="600"
              fill="#334155"
              pointerEvents="none"
            >
              {room.name.length > (compact ? 12 : 22) ? `${room.name.slice(0, compact ? 11 : 21)}…` : room.name}
            </text>
          </g>
        );
      })}
      <text x={width - 10} y={height - 8} textAnchor="end" fontSize={compact ? 7 : 10} fill="#64748b">
        {plan.preview.width} × {plan.preview.height} m · schematic test layout
      </text>
    </svg>
  );
}

function UploadedPlanPreview({ preview }) {
  const width = 760;
  const height = 300;
  const points = [
    ...(preview?.wallPolygons || []).flat(),
    ...(preview?.slabPolygons || []).flat(),
    ...(preview?.spaces || []),
  ];
  if (!points.length || !preview?.bounds) return null;
  const minX = preview.bounds.minX;
  const maxX = preview.bounds.maxX;
  const minY = preview.bounds.minY;
  const maxY = preview.bounds.maxY;
  const spanX = Math.max(maxX - minX, 0.01);
  const spanY = Math.max(maxY - minY, 0.01);
  const scale = Math.min((width - 44) / spanX, (height - 36) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const project = (point) => ({
    x: offsetX + (point.x - minX) * scale,
    y: height - offsetY - (point.y - minY) * scale,
  });
  const polygonPath = (polygon) => polygon.map((point, index) => {
    const p = project(point);
    return `${index === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }).join(' ') + ' Z';

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-full w-full" role="img" aria-label="Extracted IFC floor plan preview">
      <defs>
        <pattern id="ifc-upload-preview-grid" width="18" height="18" patternUnits="userSpaceOnUse">
          <path d="M 18 0 L 0 0 0 18" fill="none" stroke="#e2e8f0" strokeWidth="0.7" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="#f8fafc" />
      <rect width={width} height={height} fill="url(#ifc-upload-preview-grid)" />
      {(preview.slabPolygons || []).map((polygon, index) => (
        <path key={`slab-${index}`} d={polygonPath(polygon)} fill="#e2e8f0" fillOpacity="0.6" stroke="#cbd5e1" strokeWidth="1.2" />
      ))}
      {(preview.wallPolygons || []).map((polygon, index) => (
        <path key={`wall-${index}`} d={polygonPath(polygon)} fill="#334155" stroke="#1e293b" strokeWidth="0.8" />
      ))}
      {(preview.spaces || []).map((space) => {
        const point = project(space);
        return (
          <g key={space.id}>
            <circle cx={point.x} cy={point.y} r="4" fill="#ff914d" stroke="#fff" strokeWidth="1.5" />
            <text x={point.x + 6} y={point.y - 5} fontSize="10" fontWeight="600" fill="#0f172a" paintOrder="stroke" stroke="#f8fafc" strokeWidth="3" strokeLinejoin="round">
              {space.name.length > 20 ? `${space.name.slice(0, 19)}…` : space.name}
            </text>
          </g>
        );
      })}
      <text x={width - 12} y={height - 10} textAnchor="end" fontSize="10" fill="#64748b">
        IFC geometry preview · {preview.spaces?.length || 0} named spaces
      </text>
    </svg>
  );
}

const UploadModal = ({ isOpen, onClose, onProjectCreated }) => {
  const fileInputRef = useRef(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [pendingFile, setPendingFile] = useState(null);
  const [pendingPreview, setPendingPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [reviewMode, setReviewMode] = useState(false);

  if (!isOpen) return null;

  const resetReview = () => {
    setPendingFile(null);
    setPendingPreview(null);
    setPreviewError('');
    setReviewMode(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClose = () => {
    if (isProcessing) return;
    resetReview();
    onClose?.();
  };

  const prepareIfcForReview = async (file) => {
    setIsProcessing(true);
    setStatusMessage('Reading floor geometry, walls and named rooms…');
    setPendingFile(file);
    setPendingPreview(null);
    setPreviewError('');
    try {
      const preview = await buildIfcFloorPlanPreview(file);
      setPendingPreview(preview);
    } catch (error) {
      console.warn('[UploadModal] IFC floor-plan preview unavailable:', error);
      setPreviewError(error?.message || 'The IFC preview could not be generated. You can still continue to the 3D viewer.');
    } finally {
      setIsProcessing(false);
      setStatusMessage('');
      setReviewMode(true);
    }
  };

  const createProject = async (fileToUpload) => {
    if (!fileToUpload) return;
    setIsProcessing(true);
    setStatusMessage('Initializing project workspace…');
    try {
      const formData = new FormData();
      formData.append('ifcFile', fileToUpload);
      const response = await fetch(`${API_BASE_URL}/api/projects`, { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok || !data.success || !data.jobId) {
        throw new Error(data.error || `Project creation failed (${response.status})`);
      }
      onProjectCreated({ jobId: data.jobId, file: fileToUpload, fileName: fileToUpload.name });
      resetReview();
    } catch (error) {
      console.error('[UploadModal] Project creation error:', error);
      alert(`Failed to initialize project: ${error.message}`);
    } finally {
      setIsProcessing(false);
      setStatusMessage('');
    }
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const extension = file.name.split('.').pop()?.toLowerCase();

    if (!isImage && extension === 'ifc') {
      await prepareIfcForReview(file);
      return;
    }
    if (!isImage && extension === 'xkt') {
      setPendingFile(file);
      setPendingPreview(null);
      setPreviewError('XKT is a compiled scene format and does not expose IFC room names for this upload-time map. You can continue; room analysis will run after the project loads.');
      setReviewMode(true);
      return;
    }
    if (!isImage) {
      setPreviewError('Choose an IFC, XKT or supported floor-plan image.');
      setReviewMode(true);
      return;
    }

    setIsProcessing(true);
    setStatusMessage('Uploading floor plan for AI conversion…');
    try {
      const formData = new FormData();
      formData.append('image', file);
      const response = await fetch(`${API_BASE_URL}/api/convert-floorplan`, { method: 'POST', body: formData });
      if (!response.ok) throw new Error(`Floor-plan conversion returned ${response.status}`);
      const data = await response.json();
      if (!data.success || !data.fileUrl) throw new Error(data.error || 'Floor-plan conversion failed.');
      setStatusMessage('Downloading generated IFC for floor-map preview…');
      const generatedResponse = await fetch(data.fileUrl);
      if (!generatedResponse.ok) throw new Error(`Generated IFC download returned ${generatedResponse.status}`);
      const blob = await generatedResponse.blob();
      const generatedFile = new File([blob], `${data.jobId || 'generated'}_FloorPlan.ifc`, { type: 'application/octet-stream' });
      setIsProcessing(false);
      await prepareIfcForReview(generatedFile);
    } catch (error) {
      console.error('[UploadModal] AI floor-plan conversion error:', error);
      alert(`Failed to convert floor plan: ${error.message}`);
      setIsProcessing(false);
      setStatusMessage('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handlePredefinedSelect = async (plan) => {
    setIsProcessing(true);
    setStatusMessage(`Loading ${plan.name} IFC…`);
    try {
      const response = await fetch(plan.fileUrl);
      if (!response.ok) {
        throw new Error(`Could not find ${plan.fileName} at ${plan.fileUrl}. Copy the supplied test IFC into backend/assets/ and retry.`);
      }
      const blob = await response.blob();
      const file = new File([blob], plan.fileName, { type: 'application/octet-stream' });
      setIsProcessing(false);
      await prepareIfcForReview(file);
    } catch (error) {
      console.error('[UploadModal] Template loading error:', error);
      alert(error.message);
      setIsProcessing(false);
      setStatusMessage('');
    }
  };

  const selectedPlanName = pendingFile?.name || '';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-slate-900/70 px-3 py-6 backdrop-blur-md">
      <div className="relative my-auto w-full max-w-6xl overflow-hidden rounded-[2rem] border border-white/30 bg-white/95 p-5 shadow-2xl dark:border-slate-700/70 dark:bg-slate-900/95 md:p-8">
        <div className="pointer-events-none absolute -right-40 -top-40 h-80 w-80 rounded-full bg-indigo-500/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-cyan-500/15 blur-3xl" />

        {!isProcessing && (
          <button onClick={handleClose} className="absolute right-5 top-5 z-20 rounded-full bg-slate-100 p-2 text-slate-500 transition hover:text-slate-900 dark:bg-slate-800 dark:text-slate-400 dark:hover:text-white" aria-label="Close upload dialog">
            <X className="h-5 w-5" />
          </button>
        )}

        <div className="relative z-10 mb-6 text-center">
          <img src="/hci-logo.svg" alt="High Creation Interiors" className="hci-logo-badge hci-logo-badge--upload mb-3 inline-block" />
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.24em] text-[#ff914d]">HIGH CREATION INTERIORS</p>
          <h2 className="mb-1 text-2xl font-extrabold text-slate-900 dark:text-white md:text-3xl">Interior BIM Studio</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Preview the complete floor plan before opening the design workspace.</p>
        </div>

        {isProcessing ? (
          <div className="relative z-10 flex min-h-[300px] flex-col items-center justify-center rounded-3xl border border-[#ff914d]/30 bg-[#ff914d]/5 p-10 text-center">
            <Loader2 className="mb-5 h-14 w-14 animate-spin text-[#ff914d]" />
            <h3 className="mb-2 text-lg font-bold text-slate-800 dark:text-white">Preparing floor-plan preview</h3>
            <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">{statusMessage}</p>
          </div>
        ) : reviewMode && pendingFile ? (
          <div className="relative z-10 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-[#ff914d]">Floor-plan review</p>
                <h3 className="truncate text-lg font-bold text-slate-900 dark:text-white">{selectedPlanName}</h3>
                {pendingPreview && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {pendingPreview.spaces.length} named spaces · {pendingPreview.wallCount} wall elements · {pendingPreview.size.width.toFixed(1)} × {pendingPreview.size.height.toFixed(1)} m plan extent
                  </p>
                )}
              </div>
              <button type="button" onClick={resetReview} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:border-[#ff914d] dark:border-slate-700 dark:text-slate-300">
                <ArrowLeft className="h-3.5 w-3.5" /> Choose another file
              </button>
            </div>

            {pendingPreview ? (
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950">
                <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2 dark:border-slate-800">
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-200">Complete floor map</span>
                  <span className="text-[10px] text-slate-500">Wall geometry + IFC room labels</span>
                </div>
                <div className="h-[300px] w-full"><UploadedPlanPreview preview={pendingPreview} /></div>
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <div><p className="font-bold">Floor-map preview unavailable</p><p className="mt-1 text-xs leading-5">{previewError}</p></div>
              </div>
            )}

            {pendingPreview && previewError && <p className="text-xs text-amber-600 dark:text-amber-400">Preview note: {previewError}</p>}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                This is a visual preflight only; full room reconstruction runs after project creation.
              </div>
              <button type="button" onClick={() => createProject(pendingFile)} className="rounded-xl bg-[#ff914d] px-6 py-3 text-sm font-bold text-white shadow-lg shadow-orange-500/20 transition hover:bg-[#f47f39]">
                Create project and open editor
              </button>
            </div>
          </div>
        ) : (
          <div className="relative z-10 space-y-6">
            <div
              onClick={() => fileInputRef.current?.click()}
              className="group flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed border-[#ff914d]/40 bg-[#ff914d]/5 p-8 text-center transition hover:bg-[#ff914d]/10 md:p-10"
            >
              <div className="mb-4 flex items-center gap-4 transition group-hover:-translate-y-1">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow dark:bg-slate-800"><ImageIcon className="h-6 w-6 text-cyan-500" /></span>
                <span className="text-slate-300">→</span>
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow dark:bg-slate-800"><FileBox className="h-6 w-6 text-indigo-500" /></span>
              </div>
              <span className="mb-2 rounded-full bg-[#ff914d] px-6 py-2.5 text-sm font-bold text-white shadow">Upload floor plan or 3D model</span>
              <p className="text-xs text-slate-500 dark:text-slate-400">IFC files are analysed in-browser before project creation. Review the full wall layout, named IFC spaces, dimensions and room markers. XKT files continue directly to the viewer.</p>
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} accept="image/jpeg,image/png,image/webp,.xkt,.ifc" />
            </div>

            <div className="flex items-center gap-4">
              <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Or choose a standard test plan</span>
              <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {PREDEFINED_PLANS.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => handlePredefinedSelect(plan)}
                  className="overflow-hidden rounded-2xl border border-slate-200 bg-white text-left transition hover:-translate-y-0.5 hover:border-[#ff914d] hover:shadow-xl dark:border-slate-700 dark:bg-slate-800/70"
                >
                  <div className="h-[132px] border-b border-slate-200 dark:border-slate-700"><TemplatePlanPreview plan={plan} compact /></div>
                  <div className="flex items-start gap-3 p-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#ff914d]/10 text-[#ff914d]"><plan.icon className="h-5 w-5" /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-slate-900 dark:text-white">{plan.name} floor plan</span>
                      <span className="mt-1 block text-[10px] leading-4 text-slate-500 dark:text-slate-400">{plan.description}</span>
                    </span>
                  </div>
                  <div className="px-3 pb-3 text-[10px] font-bold text-[#ff914d]">Preview this IFC →</div>
                </button>
              ))}
            </div>

            <p className="text-center text-[10px] text-slate-400">
              The included 1 BHK, 2 BHK and 3 BHK files are simplified IFC4 room-topology test fixtures, not construction documentation or certified architectural plans. Copy the supplied IFC files into backend/assets to enable these template cards.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default UploadModal;
