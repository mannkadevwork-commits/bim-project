import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import BIMViewer from './BIMViewer';
import AdminPanel from './pages/AdminPanel';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import UploadModal from './components/UploadModal';
import ContactForm from './components/ContactForm';
import { AlertTriangle } from 'lucide-react';

function ViewerApp() {
  const [isUploadOpen, setIsUploadOpen] = useState(true);
  const [isContactOpen, setIsContactOpen] = useState(false);
  
  // NEW: Canonical project state holding { jobId, file, fileName }
  const [activeProject, setActiveProject] = useState(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isResettingProject, setIsResettingProject] = useState(false);

  // Resume active project on refresh
  useEffect(() => {
    const resumeProject = async () => {
      const saved = localStorage.getItem('hci_active_project');
      if (saved) {
        try {
          const { jobId, fileName } = JSON.parse(saved);
          const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
          
          // Reconstruct the File object from the backend's original IFC copy
          const res = await fetch(`${API_BASE_URL}/jobs/${jobId}/original.ifc`);
          if (!res.ok) throw new Error('Could not fetch original ifc from backend');
          
          const blob = await res.blob();
          const file = new File([blob], fileName, { type: 'application/octet-stream' });
          
          setActiveProject({ jobId, file, fileName });
          setIsUploadOpen(false);
        } catch (err) {
          console.error("[App] Failed to resume project. Starting fresh.", err);
          localStorage.removeItem('hci_active_project');
        }
      }
    };
    resumeProject();
  }, []);

  const handleProjectUpload = (projectData) => {
    setActiveProject(projectData);
    localStorage.setItem('hci_active_project', JSON.stringify({
      jobId: projectData.jobId,
      fileName: projectData.fileName
    }));
    setIsUploadOpen(false);
  };

  const handleDeleteRequest = () => {
    setIsDeleteModalOpen(true);
  };

  const confirmDelete = async () => {
    if (!activeProject?.jobId) {
      setIsDeleteModalOpen(false);
      return;
    }

    const { jobId, fileName } = activeProject;
    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

    setIsDeleteModalOpen(false);
    setIsResettingProject(true);

    try {
      // Backend archives the current project and returns a brand-new jobId.
      const response = await fetch(`${API_BASE_URL}/api/projects/${jobId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || `Project reset failed (${response.status})`);
      }

      const data = await response.json();
      if (!data.success || !data.newJobId) {
        throw new Error('Backend did not return a new project jobId.');
      }

      const newJobId = data.newJobId;
      const resIfc = await fetch(`${API_BASE_URL}/jobs/${newJobId}/original.ifc`, {
        cache: 'no-store',
      });
      if (!resIfc.ok) {
        throw new Error('Fresh project was created, but its original IFC could not be loaded.');
      }

      const blob = await resIfc.blob();
      const file = new File([blob], fileName, { type: 'application/octet-stream' });

      // Remove only the old project's browser cache. The backend project itself
      // is intentionally retained as archived history.
      localStorage.removeItem(`hci_state_${jobId}`);

      const nextProject = { jobId: newJobId, file, fileName };
      localStorage.setItem('hci_active_project', JSON.stringify({
        jobId: newJobId,
        fileName,
      }));
      setActiveProject(nextProject);
    } catch (error) {
      console.error('[App] Failed to reset project:', error);
      // Do not silently pretend reset succeeded. Keep the existing project
      // active so a failed reset cannot make the UI lose the user's work.
      alert(`Failed to reset project: ${error.message}`);
    } finally {
      setIsResettingProject(false);
    }
  };


  return (
    <div className="relative w-screen h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50 transition-colors duration-300 overflow-hidden flex flex-col">
      {!activeProject && (
        <Navbar
          onOpenUpload={() => setIsUploadOpen(true)}
          onOpenContact={() => setIsContactOpen(true)}
        />
      )}

      <div className="flex-1 relative h-full">
        <BIMViewer
          key={activeProject?.jobId || 'no-active-project'}
          activeProject={activeProject}
          onDelete={handleDeleteRequest} 
          onAdd={() => setIsUploadOpen(true)}
        />
      </div>

      {!activeProject && <Footer />}

      <UploadModal
        isOpen={isUploadOpen}
        onClose={() => { if (activeProject) setIsUploadOpen(false); }}
        onProjectCreated={handleProjectUpload}
      />

      <ContactForm
        isOpen={isContactOpen}
        onClose={() => setIsContactOpen(false)}
      />

      {isResettingProject && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
          <div className="rounded-2xl bg-slate-900 border border-slate-700 px-8 py-7 text-center shadow-2xl">
            <div className="mx-auto mb-4 h-10 w-10 rounded-full border-4 border-slate-600 border-t-indigo-400 animate-spin" />
            <p className="text-white font-semibold">Resetting project…</p>
            <p className="mt-1 text-sm text-slate-400">Creating a fresh workspace from the original IFC.</p>
          </div>
        </div>
      )}

      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md p-6 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-start gap-4 mb-4">
              <div className="w-12 h-12 rounded-full bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-6 h-6 text-rose-600 dark:text-rose-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Delete Current Project?</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  This will reset the current workspace to a fresh copy of the original IFC. Your current project will be archived on the server and kept for future project history.
                </p>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button 
                onClick={() => setIsDeleteModalOpen(false)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={confirmDelete}
                disabled={isResettingProject}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold transition-colors shadow-sm"
              >
                {isResettingProject ? 'Resetting...' : 'Yes, Delete Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ViewerApp />} />
        <Route path="/admin" element={<AdminPanel />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;