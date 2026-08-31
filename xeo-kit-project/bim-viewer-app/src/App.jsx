import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import BIMViewer from './BIMViewer';
import AdminPanel from './pages/AdminPanel';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import UploadModal from './components/UploadModal';
import ContactForm from './components/ContactForm';
import { AlertTriangle } from 'lucide-react';
import ProjectStartModal from './components/ProjectStartModal';
import WalkthroughPage from './pages/WalkthroughPage';

const ensureIfcFileName = (value, fallback = 'model.ifc') => {
  const name = String(value || '').trim();
  if (!name) return fallback;
  return /\.ifc$/i.test(name) ? name : `${name}.ifc`;
};

function ViewerApp() {
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const [showStartChoice, setShowStartChoice] = useState(false);
  const [previousProject, setPreviousProject] = useState(null);
  const [isContinuingProject, setIsContinuingProject] = useState(false);
  const [isContactOpen, setIsContactOpen] = useState(false);
  const [startupMode, setStartupMode] = useState(() => localStorage.getItem('hci_startup_mode') || null);
  
  // NEW: Canonical project state holding { jobId, file, fileName }
  const [activeProject, setActiveProject] = useState(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isResettingProject, setIsResettingProject] = useState(false);
  const [isSwitchingLayout, setIsSwitchingLayout] = useState(false);

  // Validate the last project on startup, but DO NOT automatically open it.
  // The user explicitly decides whether to continue or start a new project.
  useEffect(() => {
    let cancelled = false;

    const bootstrapProject = async () => {
      const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      const saved = localStorage.getItem('hci_active_project');
      const requestedMode = localStorage.getItem('hci_startup_mode');

      if (requestedMode === 'new') {
        if (!cancelled) {
          setStartupMode('new');
          setPreviousProject(null);
          setShowStartChoice(false);
          setIsUploadOpen(true);
          setIsBooting(false);
        }
        return;
      }

      if (!saved) {
        if (!cancelled) {
          setPreviousProject(null);
          setShowStartChoice(false);
          setIsUploadOpen(true);
          setIsBooting(false);
        }
        return;
      }

      try {
        const savedProject = JSON.parse(saved);
        const { jobId, fileName } = savedProject || {};
        if (!jobId || !fileName) throw new Error('Saved project identity is incomplete.');

        const validationResponse = await fetch(
          `${API_BASE_URL}/api/projects/${jobId}/validate`,
          { cache: 'no-store' }
        );

        if (!validationResponse.ok) {
          throw new Error(`Saved project validation failed (${validationResponse.status}).`);
        }

        const validation = await validationResponse.json();
        if (!validation.valid) {
          throw new Error(`Saved project is invalid: ${validation.reason || 'unknown reason'}`);
        }

        if (cancelled) return;

        localStorage.removeItem('hci_startup_mode');
        setStartupMode(null);
        setPreviousProject({
          jobId,
          fileName,
          savedLayoutsSourceJobId: savedProject.savedLayoutsSourceJobId || null,
          savedLayoutId: savedProject.savedLayoutId || null,
          savedLayoutName: savedProject.savedLayoutName || null,
        });
        setShowStartChoice(true);
        setIsUploadOpen(false);
      } catch (error) {
        console.warn('[App] Saved project is stale/unavailable. Starting without previous-work option.', error);
        if (cancelled) return;

        localStorage.removeItem('hci_active_project');
        localStorage.removeItem('hci_startup_mode');
        setStartupMode(null);
        setPreviousProject(null);
        setShowStartChoice(false);
        setIsUploadOpen(true);
      } finally {
        if (!cancelled) setIsBooting(false);
      }
    };

    bootstrapProject();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handlePageShow = (event) => {
      if (!event.persisted) return;
      const mode = localStorage.getItem('hci_startup_mode');
      if (mode === 'new') {
        setActiveProject(null);
        setPreviousProject(null);
        setShowStartChoice(false);
        setIsUploadOpen(true);
        setIsBooting(false);
      }
    };

    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  const handleContinuePreviousProject = async () => {
    localStorage.removeItem('hci_startup_mode');
    setStartupMode(null);
    if (!previousProject?.jobId || isContinuingProject) return;

    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    setIsContinuingProject(true);

    try {
      const previousFilePath = previousProject.savedLayoutId ? 'input.ifc' : 'original.ifc';
      const response = await fetch(
        `${API_BASE_URL}/jobs/${previousProject.jobId}/${previousFilePath}`,
        { cache: 'no-store' }
      );

      if (!response.ok) {
        throw new Error(`Previous project IFC could not be loaded (${response.status}).`);
      }

      const blob = await response.blob();
      const resolvedFileName = previousProject.savedLayoutId
        ? ensureIfcFileName(previousProject.fileName, 'Saved Layout.ifc')
        : previousProject.fileName;
      const file = new File([blob], resolvedFileName, {
        type: 'application/octet-stream',
      });

      setActiveProject({
        jobId: previousProject.jobId,
        file,
        fileName: resolvedFileName,
        savedLayoutsSourceJobId: previousProject.savedLayoutsSourceJobId || null,
        savedLayoutId: previousProject.savedLayoutId || null,
        savedLayoutName: previousProject.savedLayoutName || null,
      });
      setShowStartChoice(false);
      setIsUploadOpen(false);
    } catch (error) {
      console.error('[App] Failed to continue previous project:', error);
      localStorage.removeItem('hci_active_project');
      setPreviousProject(null);
      setShowStartChoice(false);
      setIsUploadOpen(true);
      alert(`Previous project could not be opened: ${error.message}`);
    } finally {
      setIsContinuingProject(false);
    }
  };

  const handleStartNewProject = () => {
    localStorage.setItem('hci_startup_mode', 'new');
    setStartupMode('new');
    setShowStartChoice(false);
    setIsUploadOpen(true);
  };

  const handleProjectUpload = (projectData) => {
    localStorage.removeItem('hci_startup_mode');
    setStartupMode(null);
    setActiveProject(projectData);
    localStorage.setItem('hci_active_project', JSON.stringify({
      jobId: projectData.jobId,
      fileName: projectData.fileName,
      savedLayoutsSourceJobId: projectData.savedLayoutsSourceJobId || null,
      savedLayoutId: projectData.savedLayoutId || null,
      savedLayoutName: projectData.savedLayoutName || null,
    }));
    setIsUploadOpen(false);
    setShowStartChoice(false);
  };

  const handleDeleteRequest = () => {
    setIsDeleteModalOpen(true);
  };

  const confirmDelete = async () => {
    if (!activeProject?.jobId) {
      setIsDeleteModalOpen(false);
      localStorage.removeItem('hci_active_project');
      setActiveProject(null);
      setIsUploadOpen(true);
      return;
    }

    const { jobId } = activeProject;
    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

    setIsDeleteModalOpen(false);
    setIsResettingProject(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/projects/${jobId}`, {
        method: 'DELETE',
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Project delete failed (${response.status})`);
      }

      localStorage.removeItem(`hci_state_${jobId}`);
      localStorage.removeItem('hci_active_project');
      localStorage.removeItem('hci_startup_mode');
      setStartupMode(null);

      // Unmount the viewer before opening the modal so no old loader can keep
      // running while the next project is being created.
      setActiveProject(null);
      setIsUploadOpen(true);
    } catch (error) {
      console.error('[App] Failed to delete project:', error);
      alert(`Failed to delete project: ${error.message}`);
    } finally {
      setIsResettingProject(false);
    }
  };

  const handleOpenSavedLayout = async (layout) => {
    if (!activeProject?.jobId || !layout?.id || !layout?.renderJobId || isSwitchingLayout) return;

    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    setIsSwitchingLayout(true);

    try {
      // Create a fresh working project from the saved snapshot. This is the
      // important distinction from the 360 preview: the editor receives the
      // snapshot IFC + project_state and restores it through the normal xeokit
      // project-loading path.
      const response = await fetch(
        `${API_BASE_URL}/api/projects/${encodeURIComponent(activeProject.jobId)}/saved-layouts/${encodeURIComponent(layout.id)}/restore`,
        { method: 'POST' }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success || !data.newJobId) {
        throw new Error(data.error || `Saved layout restore failed (${response.status})`);
      }

      const fileUrl = data.fileUrl || `${API_BASE_URL}/jobs/${encodeURIComponent(data.newJobId)}/input.ifc`;
      const responseIfc = await fetch(fileUrl, { cache: 'no-store' });
      if (!responseIfc.ok) throw new Error(`Saved layout IFC could not be loaded (${responseIfc.status}).`);

      const blob = await responseIfc.blob();
      const fileName = ensureIfcFileName(
        data.fileName,
        `Saved Layout - ${layout.name}.ifc`
      );
      const file = new File([blob], fileName, { type: 'application/octet-stream' });

      const nextProject = {
        jobId: data.newJobId,
        file,
        fileName,
        savedLayoutsSourceJobId: data.savedLayoutsSourceJobId || activeProject.jobId,
        savedLayoutId: data.savedLayoutId || layout.id,
        savedLayoutName: data.savedLayoutName || layout.name,
      };

      localStorage.removeItem('hci_startup_mode');
      setStartupMode(null);
      localStorage.setItem('hci_active_project', JSON.stringify({
        jobId: nextProject.jobId,
        fileName: nextProject.fileName,
        savedLayoutsSourceJobId: nextProject.savedLayoutsSourceJobId,
        savedLayoutId: nextProject.savedLayoutId,
        savedLayoutName: nextProject.savedLayoutName,
      }));

      setActiveProject(nextProject);
      setIsUploadOpen(false);
      setShowStartChoice(false);
    } catch (error) {
      console.error('[App] Failed to restore saved layout:', error);
      alert(`Failed to load ${layout.name}: ${error.message}`);
    } finally {
      setIsSwitchingLayout(false);
    }
  };

  const handleLayoutReplace = async (layout) => {
    if (!activeProject?.jobId || !layout?.id) return;

    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    const oldJobId = activeProject.jobId;

    setIsSwitchingLayout(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/projects/${oldJobId}/layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layoutId: layout.id }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success || !data.newJobId) {
        throw new Error(data.error || `Layout switch failed (${response.status})`);
      }

      const newJobId = data.newJobId;
      const fileUrl = data.fileUrl || `${API_BASE_URL}/jobs/${newJobId}/original.ifc`;
      const resIfc = await fetch(fileUrl, { cache: 'no-store' });
      if (!resIfc.ok) throw new Error('New layout was created, but its IFC could not be loaded.');

      const blob = await resIfc.blob();
      const file = new File([blob], data.fileName || layout.fileName || `${layout.id}.ifc`, {
        type: 'application/octet-stream',
      });

      // The layout is a full project replacement: discard only the browser
      // state for the previous active project. The backend archives the old
      // project for server-side history.
      localStorage.removeItem(`hci_state_${oldJobId}`);

      const nextProject = {
        jobId: newJobId,
        file,
        fileName: data.fileName || layout.fileName || file.name,
        savedLayoutsSourceJobId: null,
        savedLayoutId: null,
        savedLayoutName: null,
      };

      localStorage.removeItem('hci_startup_mode');
      setStartupMode(null);
      localStorage.setItem('hci_active_project', JSON.stringify({
        jobId: newJobId,
        fileName: nextProject.fileName,
        savedLayoutsSourceJobId: null,
        savedLayoutId: null,
        savedLayoutName: null,
      }));

      // Changing the project key forces BIMViewer to unmount the old viewer
      // and initialize a completely fresh scene for the new IFC.
      setActiveProject(nextProject);
      setIsUploadOpen(false);
    } catch (error) {
      console.error('[App] Failed to replace project with layout:', error);
      alert(`Failed to load ${layout.name}: ${error.message}`);
    } finally {
      setIsSwitchingLayout(false);
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
        {!isBooting && activeProject ? (
          <BIMViewer
            key={activeProject.jobId}
            activeProject={activeProject}
            onDelete={handleDeleteRequest}
            onAdd={() => setIsUploadOpen(true)}
            onReplaceProject={handleLayoutReplace}
            onOpenSavedLayout={handleOpenSavedLayout}
          />
        ) : null}
      </div>

      {isBooting && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-slate-950">
          <div className="text-center">
            <div className="mx-auto mb-4 h-10 w-10 rounded-full border-4 border-slate-700 border-t-cyan-400 animate-spin" />
            <p className="text-white font-semibold">Preparing your workspace</p>
            <p className="mt-1 text-sm text-slate-400">Checking your last project…</p>
          </div>
        </div>
      )}

      {!activeProject && <Footer />}

      <ProjectStartModal
        isOpen={showStartChoice && !activeProject}
        previousProject={previousProject}
        onContinue={handleContinuePreviousProject}
        onStartNew={handleStartNewProject}
        onClose={handleStartNewProject}
        isContinuing={isContinuingProject}
      />

      <UploadModal
        isOpen={isUploadOpen && !showStartChoice}
        onClose={() => {
          if (activeProject) {
            setIsUploadOpen(false);
            return;
          }
          if (previousProject) {
            localStorage.removeItem('hci_startup_mode');
            setStartupMode(null);
            setIsUploadOpen(false);
            setShowStartChoice(true);
            return;
          }
          setIsUploadOpen(false);
        }}
        onProjectCreated={handleProjectUpload}
      />

      <ContactForm
        isOpen={isContactOpen}
        onClose={() => setIsContactOpen(false)}
      />

      {isSwitchingLayout && (
        <div className="fixed inset-0 z-[260] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
          <div className="rounded-2xl bg-slate-900 border border-slate-700 px-8 py-7 text-center shadow-2xl">
            <div className="mx-auto mb-4 h-10 w-10 rounded-full border-4 border-slate-600 border-t-[#ff914d] animate-spin" />
            <p className="text-white font-semibold">Loading new layout…</p>
            <p className="mt-1 text-sm text-slate-400">Replacing the current project with a fresh workspace.</p>
          </div>
        </div>
      )}

      {isResettingProject && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
          <div className="rounded-2xl bg-slate-900 border border-slate-700 px-8 py-7 text-center shadow-2xl">
            <div className="mx-auto mb-4 h-10 w-10 rounded-full border-4 border-slate-600 border-t-[#ff914d] animate-spin" />
            <p className="text-white font-semibold">Resetting project…</p>
            <p className="mt-1 text-sm text-slate-400">Returning to the project start screen.</p>
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
                  This will archive the current project and return you to the project start screen. Choose a new layout or upload an IFC to start again.
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
         <Route path="/walkthrough/:jobId" element={<WalkthroughPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;