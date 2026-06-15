import { useState } from 'react';
import BIMViewer from './BIMViewer';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import UploadModal from './components/UploadModal';
import ContactForm from './components/ContactForm';

function App() {
  const [isUploadOpen, setIsUploadOpen] = useState(true);
  const [isContactOpen, setIsContactOpen] = useState(false);
  const [modelFile, setModelFile] = useState(null);

  // New function to handle deleting the current model
  const handleDeleteModel = () => {
    setModelFile(null);
  };

  return (
    <div className="relative w-screen h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50 transition-colors duration-300 overflow-hidden">
      
      <Navbar 
        onOpenUpload={() => setIsUploadOpen(true)} 
        onOpenContact={() => setIsContactOpen(true)} 
      />
      
      <BIMViewer 
        file={modelFile} 
        onDelete={handleDeleteModel}
        onAdd={() => setIsUploadOpen(true)} // Pass the upload trigger to the viewer
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
      
    </div>
  );
}

export default App;