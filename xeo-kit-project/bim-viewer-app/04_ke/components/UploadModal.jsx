import { useRef, useState } from 'react';
import { X, FileBox, ImageIcon, Loader2, Home, Building } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const PREDEFINED_PLANS = [
  { 
    id: '1bhk', 
    name: '1 BHK Layout', 
    description: 'Compact single bedroom structure', 
    icon: Home,
    fileUrl: `${API_BASE_URL}/assets/1_BHK_Detailed.ifc` 
  },
  { 
    id: '3bhk', 
    name: '3 BHK Layout', 
    description: 'Spacious three bedroom family home', 
    icon: Building,
    fileUrl: `${API_BASE_URL}/assets/3_BHK.ifc` 
  }
];

const UploadModal = ({ isOpen, onClose, onFileUpload }) => {
  const fileInputRef = useRef(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  if (!isOpen) return null;

  // ── Handle Manual Uploads ──
  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileType = file.type;
    const isImage = fileType.startsWith('image/');
    
    // If it's a native 3D file, bypass the backend and load directly
    if (!isImage) {
      onFileUpload(file);
      onClose();
      return;
    }

    // If it's an image, send to backend for AI conversion
    setIsProcessing(true);
    setStatusMessage('Uploading floor plan...');

    const formData = new FormData();
    formData.append('image', file);

    try {
      setStatusMessage('AI is analyzing geometry...');
      
      const response = await fetch(`${API_BASE_URL}/api/convert-floorplan`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      setStatusMessage('Downloading generated 3D model...');
      const data = await response.json();

      if (data.success && data.fileUrl) {
        const fileResponse = await fetch(data.fileUrl);
        const blob = await fileResponse.blob();
        
        const generatedFile = new File([blob], `${data.jobId}_Generated.ifc`, { type: 'application/octet-stream' });
        
        onFileUpload(generatedFile);
        onClose();
      } else {
        throw new Error(data.error || 'Conversion failed');
      }

    } catch (error) {
      console.error("AI Conversion Error:", error);
      alert(`Failed to convert floor plan: ${error.message}`);
    } finally {
      setIsProcessing(false);
      setStatusMessage('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Handle Predefined Template Selection ──
  const handlePredefinedSelect = async (plan) => {
    setIsProcessing(true);
    setStatusMessage(`Loading ${plan.name} structure...`);

    try {
      const response = await fetch(plan.fileUrl);
      if (!response.ok) throw new Error(`Failed to fetch ${plan.name} from server`);
      
      const blob = await response.blob();
      // Convert the fetched blob into a standard File object so BIMViewer can read it normally
      const file = new File([blob], plan.fileUrl.split('/').pop(), { type: 'application/octet-stream' });
      
      onFileUpload(file);
      onClose();
    } catch (error) {
      console.error("Predefined Plan Error:", error);
      alert(`Failed to load predefined plan: ${error.message}. Ensure the file exists in your backend assets folder.`);
    } finally {
      setIsProcessing(false);
      setStatusMessage('');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 backdrop-blur-md transition-all duration-300 overflow-y-auto py-10">
      <div className="relative w-full max-w-2xl mx-4 bg-white/80 dark:bg-slate-900/80 backdrop-blur-2xl border border-white/40 dark:border-slate-700/50 shadow-[0_0_80px_rgba(0,0,0,0.2)] dark:shadow-[0_0_80px_rgba(0,0,0,0.5)] rounded-[2rem] p-10 animate-in fade-in zoom-in-95 duration-300">
        
        {/* Decorative background gradients */}
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-indigo-500/20 blur-3xl rounded-full pointer-events-none"></div>
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-cyan-500/20 blur-3xl rounded-full pointer-events-none"></div>

        {!isProcessing && (
          <button onClick={onClose} className="absolute top-6 right-6 p-2 bg-slate-100 dark:bg-slate-800 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors z-10">
            <X className="w-5 h-5" />
          </button>
        )}

        <div className="text-center mb-8 relative z-10">
          <h2 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-cyan-500 dark:from-indigo-400 dark:to-cyan-400 mb-3">
            XeoVision Pro
          </h2>
          <p className="text-slate-500 dark:text-slate-400 text-lg">Initialize your BIM environment</p>
        </div>

        {isProcessing ? (
          <div className="relative group border-2 border-indigo-300/50 dark:border-indigo-500/30 rounded-3xl p-12 flex flex-col items-center justify-center bg-indigo-50/30 dark:bg-indigo-900/10 overflow-hidden min-h-[320px]">
            <Loader2 className="w-16 h-16 text-indigo-500 animate-spin mb-6" />
            <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-2">Preparing Environment</h3>
            <p className="text-slate-500 dark:text-slate-400 text-center max-w-sm">
              {statusMessage}
            </p>
          </div>
        ) : (
          <>
            {/* Drag & Drop Zone */}
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="relative group border-2 border-dashed border-indigo-300/50 dark:border-indigo-500/30 rounded-3xl p-10 flex flex-col items-center justify-center bg-indigo-50/30 dark:bg-indigo-900/10 hover:bg-indigo-50/80 dark:hover:bg-indigo-900/30 transition-all duration-300 cursor-pointer overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-transparent to-indigo-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

              <div className="flex gap-4 mb-6 group-hover:scale-110 group-hover:-translate-y-2 transition-all duration-500">
                <div className="w-14 h-14 rounded-2xl bg-white dark:bg-slate-800 shadow-xl flex items-center justify-center">
                  <ImageIcon className="w-7 h-7 text-cyan-500 dark:text-cyan-400" />
                </div>
                <div className="flex items-center justify-center text-slate-300">→</div>
                <div className="w-14 h-14 rounded-2xl bg-white dark:bg-slate-800 shadow-xl flex items-center justify-center">
                  <FileBox className="w-7 h-7 text-indigo-500 dark:text-indigo-400" />
                </div>
              </div>
              
              <button className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-full font-semibold shadow-[0_8px_30px_rgb(99,102,241,0.3)] transition-all transform mb-3 pointer-events-none relative z-10">
                Upload Floor Plan or 3D Model
              </button>
              
              <div className="text-xs text-slate-400 dark:text-slate-500 text-center relative z-10 space-y-1">
                <p>Images (<span className="text-cyan-600 dark:text-cyan-400">.jpg, .png</span>) | 3D (<span className="text-indigo-600 dark:text-indigo-400">.ifc, .xkt</span>)</p>
              </div>
              
              <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileChange} accept="image/jpeg, image/png, .xkt, .ifc" />
            </div>

            {/* Divider */}
            <div className="relative flex items-center py-6">
              <div className="flex-grow border-t border-slate-200 dark:border-slate-700"></div>
              <span className="flex-shrink-0 mx-4 text-slate-400 dark:text-slate-500 text-xs font-bold tracking-widest uppercase">OR START FROM TEMPLATE</span>
              <div className="flex-grow border-t border-slate-200 dark:border-slate-700"></div>
            </div>

            {/* Predefined Floor Plans */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {PREDEFINED_PLANS.map((plan) => (
                <button
                  key={plan.id}
                  onClick={() => handlePredefinedSelect(plan)}
                  className="flex items-start gap-4 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/50 hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-lg transition-all text-left group"
                >
                  <div className="w-12 h-12 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                    <plan.icon className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div>
                    <h4 className="font-bold text-slate-900 dark:text-white text-sm">{plan.name}</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                      {plan.description}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default UploadModal;