import { useState, useRef } from 'react';
import { Upload, FolderOpen, Loader2 } from 'lucide-react';

function getAPI() {
  return `${import.meta.env.VITE_API_URL || 'http://localhost:3000'}/api/ifc-editor`;
}

export function IFCEditorUpload({ onSessionReady, activeJobId }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const uploadFile = async (file) => {
    if (!file?.name.toLowerCase().endsWith('.ifc')) {
      setError('Please select a valid .ifc file.');
      return;
    }
    setIsUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('ifc', file);
      const res = await fetch(`${getAPI()}/upload`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      onSessionReady(data.sessionId, data.originalName);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const useProjectIFC = async () => {
    if (!activeJobId) { setError('No active project found. Upload an IFC instead.'); return; }
    setIsUploading(true);
    setError('');
    try {
      const res = await fetch(`${getAPI()}/use-project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: activeJobId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load project IFC');
      onSessionReady(data.sessionId, data.originalName);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">IFC Element Editor</h1>
          <p className="text-slate-400 text-sm">Define rooms and rename elements — saved directly into the IFC file</p>
        </div>

        {/* Upload zone */}
        <div
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); }}
          onClick={() => fileRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-colors mb-4 ${isDragging ? 'border-[#ff914d] bg-[#ff914d]/10' : 'border-slate-700 hover:border-slate-500 bg-slate-900'}`}
        >
          <input ref={fileRef} type="file" accept=".ifc" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); }} />
          {isUploading ? (
            <Loader2 className="w-10 h-10 text-[#ff914d] animate-spin mx-auto mb-3" />
          ) : (
            <Upload className="w-10 h-10 text-slate-500 mx-auto mb-3" />
          )}
          <p className="text-white font-semibold text-sm mb-1">
            {isUploading ? 'Uploading…' : 'Upload New IFC File'}
          </p>
          <p className="text-slate-500 text-xs">Drag & drop or click to browse</p>
        </div>

        {/* Use project IFC */}
        <button
          onClick={useProjectIFC}
          disabled={isUploading || !activeJobId}
          className="w-full flex items-center justify-center gap-3 py-4 rounded-2xl border border-slate-700 bg-slate-900 hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <FolderOpen className="w-5 h-5 text-slate-400" />
          <div className="text-left">
            <p className="text-white font-semibold text-sm">Use Current Project IFC</p>
            <p className="text-slate-500 text-xs">{activeJobId ? `Job: ${activeJobId}` : 'No active project'}</p>
          </div>
        </button>

        {error && (
          <p className="mt-4 text-center text-rose-400 text-sm">{error}</p>
        )}
      </div>
    </div>
  );
}
