import { useState } from 'react';
import { ArrowLeft, Download, CheckCircle, XCircle } from 'lucide-react';
import { IFCEditorUpload } from '../components/ifc-editor/IFCEditorUpload';
import { IFCEditorViewer } from '../components/ifc-editor/IFCEditorViewer';
import { IFCEditorSidebar } from '../components/ifc-editor/IFCEditorSidebar';
import { useIFCEditor } from '../hooks/useIFCEditor';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export default function IFCEditorPage() {
  const [sessionId, setSessionId]       = useState(null);
  const [originalName, setOriginalName] = useState('');

  // Read active jobId from localStorage (set by the main BIM viewer)
  const activeJobId = (() => {
    try { return JSON.parse(localStorage.getItem('hci_active_project') || '{}').jobId || null; }
    catch { return null; }
  })();

  const editor = useIFCEditor(sessionId);

  const handleSessionReady = async (id, name) => {
    setSessionId(id);
    setOriginalName(name);
    // Load any IfcSpace entities already present in the uploaded IFC
    await editor.loadRoomsFromIFC(id);
  };

  if (!sessionId) {
    return <IFCEditorUpload onSessionReady={handleSessionReady} activeJobId={activeJobId} />;
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 overflow-hidden">

      {/* Navbar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-3">
          <a
            href="/"
            className="flex items-center gap-1.5 text-slate-400 hover:text-white text-xs transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to BIM Viewer
          </a>
          <span className="text-slate-700">|</span>
          <span className="text-white font-bold text-sm">IFC Element Editor</span>
          {originalName && (
            <span className="text-slate-500 text-xs truncate max-w-[200px]">{originalName}</span>
          )}
        </div>

        <a
          href={`${API_BASE}/api/ifc-editor/download/${sessionId}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-4 py-1.5 bg-[#ff914d] hover:bg-[#ff7a28] text-white text-xs font-bold rounded-lg transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          Download Modified IFC
        </a>
      </div>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">
        <IFCEditorViewer
          sessionId={sessionId}
          selectedIds={editor.selectedIds}
          rooms={editor.rooms}
          onSelect={(id, name) => {
            if (id) editor.handleSelect(id, name);
            else editor.clearSelection();
          }}
          onMultiSelect={editor.handleMultiSelect}
        />

        <IFCEditorSidebar
          selectedIds={editor.selectedIds}
          selectedNames={editor.selectedNames}
          rooms={editor.rooms}
          isLoading={editor.isLoading}
          nameOverrides={editor.nameOverrides}
          activeSpaceId={editor.activeSpaceId}
          onDefineRoom={editor.defineRoom}
          onRenameElement={editor.renameElement}
          onSelectRoom={editor.selectRoom}
          onDeleteRoom={editor.deleteRoom}
          onUpdateSpace={editor.updateSpace}
        />
      </div>

      {/* Toast */}
      {editor.toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-2xl text-sm font-semibold z-50 transition-all ${editor.toast.type === 'error' ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
          {editor.toast.type === 'error'
            ? <XCircle className="w-4 h-4" />
            : <CheckCircle className="w-4 h-4" />
          }
          {editor.toast.msg}
        </div>
      )}
    </div>
  );
}
