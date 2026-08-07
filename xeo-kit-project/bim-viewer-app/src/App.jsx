import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import BIMViewer from './BIMViewer';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import UploadModal from './components/UploadModal';
import ContactForm from './components/ContactForm';
import AdminPanel from './pages/AdminPanel';
import { AlertTriangle } from 'lucide-react';

function ViewerApp() {
  const [isUploadOpen, setIsUploadOpen] = useState(true);
  const [isContactOpen, setIsContactOpen] = useState(false);
  const [modelFile, setModelFile] = useState(null);
  
  // New state for the delete confirmation popup
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  // Triggered by the delete button in BottomDock
  const handleDeleteRequest = () => {
    setIsDeleteModalOpen(true);
  };

  // Triggered when user confirms deletion in the popup
  // Triggered when user confirms deletion in the popup
  const confirmDelete = async () => {
    if (modelFile) {
      const jobId = `job_${modelFile.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      
      // 1. Clear the specific local storage for this project
      localStorage.removeItem(`hci_state_${jobId}`);

      // 2. Clear the backend server memory for this project
      const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      try {
        await fetch(`${API_BASE_URL}/api/projects/${jobId}`, {
          method: 'DELETE'
        });
      } catch (err) {
        console.error("Failed to delete project on backend:", err);
      }
    }
    
    // 3. Clear the model from the viewer
    setModelFile(null);
    
    // 4. Close the modal and reopen the Upload screen to add a blank layout
    setIsDeleteModalOpen(false);
    setIsUploadOpen(true); 
  };

  return (
    <div className="relative w-screen h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50 transition-colors duration-300 overflow-hidden flex flex-col">
      
      {/* ── LANDING PAGE ELEMENTS (Hidden when a model is active) ── */}
      {!modelFile && (
        <Navbar
          onOpenUpload={() => setIsUploadOpen(true)}
          onOpenContact={() => setIsContactOpen(true)}
        />
      )}

      {/* ── FULL SCREEN VIEWER ── */}
      <div className="flex-1 relative h-full">
        <BIMViewer
          file={modelFile}
          onDelete={handleDeleteRequest} 
          onAdd={() => setIsUploadOpen(true)}
        />
      </div>

      {/* ── LANDING PAGE FOOTER ── */}
      {!modelFile && <Footer />}

      <UploadModal
        isOpen={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        onFileUpload={(file) => setModelFile(file)}
      />

      <ContactForm
        isOpen={isContactOpen}
        onClose={() => setIsContactOpen(false)}
      />

      {/* DELETE CONFIRMATION MODAL */}
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
                  This will remove the current structural layout and clear all placed furniture and unsaved progress from your browser. This action cannot be undone.
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
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold transition-colors shadow-sm"
              >
                Yes, Delete Project
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