import { useState } from 'react';
import BIMViewer from './BIMViewer';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import UploadModal from './components/UploadModal';
import ContactForm from './components/ContactForm';
import { AlertTriangle } from 'lucide-react';

function App() {
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
  const confirmDelete = () => {
    if (modelFile) {
      // 1. Clear the specific local storage for this project
      const jobId = `job_${modelFile.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      localStorage.removeItem(`hci_state_${jobId}`);
    }
    
    // 2. Clear the model from the viewer
    setModelFile(null);
    
    // 3. Close the modal and reopen the Upload screen to add a blank layout
    setIsDeleteModalOpen(false);
    setIsUploadOpen(true); 
  };

  return (
    <div className="relative w-screen h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50 transition-colors duration-300 overflow-hidden">
      
      <Navbar 
        onOpenUpload={() => setIsUploadOpen(true)} 
        onOpenContact={() => setIsContactOpen(true)} 
      />
      
      <BIMViewer 
        file={modelFile} 
        onDelete={handleDeleteRequest} // Triggers popup instead of instant delete
        onAdd={() => setIsUploadOpen(true)} 
      />
      
      <Footer />

      <UploadModal 
        isOpen={isUploadOpen} 
        onClose={() => setIsUploadOpen(false)} 
        onFileUpload={(file) => setModelFile(file)} 
      />
      
      <ContactForm 
        isOpen={isContactOpen} 
        onClose={() => setIsContactOpen(false)} 
      />
      
      {/* ── DELETE CONFIRMATION MODAL ── */}
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

export default App;