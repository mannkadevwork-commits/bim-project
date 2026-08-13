import { Camera, Orbit, Image as ImageIcon, Sun, Moon, X, Loader2, Clock, Download, AlertCircle } from 'lucide-react';

export const RenderStudioModal = ({ 
  show, onClose, renderConfig, setRenderConfig, onExecute, 
  isRendering, renderResult, renderTime, renderError, setRenderResult, setRenderError
}) => {
  if (!show) return null;

  if (isRendering) return (
    <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex flex-col items-center justify-center text-white">
      <Loader2 className="w-16 h-16 animate-spin text-indigo-500 mb-6" />
      <h2 className="text-3xl font-bold mb-2">Rendering in Cloud...</h2>
      <p className="text-slate-300">Sending customized BIM geometries to 3ds Max Engine.</p>
      <p className="text-slate-400 text-sm mt-2">This may take 30-60 seconds depending on scene complexity.</p>
    </div>
  );

  if (renderResult) return (
    <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-md z-[100] flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-5xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl overflow-hidden flex flex-col" style={{ height: '80vh' }}>
        <div className="flex justify-between items-center p-4 border-b border-slate-200 dark:border-slate-800">
          <h3 className="font-bold text-lg text-slate-800 dark:text-white">Render Complete</h3>
          <div className="flex items-center gap-4">
            <span className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-1 rounded-full"><Clock className="w-4 h-4"/> {renderTime}s</span>
            <button onClick={() => setRenderResult(null)} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"><X className="w-6 h-6"/></button>
          </div>
        </div>
        
        <div className="flex-1 bg-slate-100 dark:bg-[#0b0f1a] relative flex justify-center items-center p-4">
          {renderConfig.type === '360' ? (
            <iframe src={renderResult.url} className="w-full h-full rounded-xl border-2 border-slate-200 dark:border-slate-700 shadow-inner bg-black" allowFullScreen title="360 Render" />
          ) : (
            <img src={renderResult.url} alt="Render Output" className="max-w-full max-h-full rounded-xl shadow-2xl object-contain" />
          )}
        </div>
        
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-3 bg-slate-50 dark:bg-slate-800/50">
          <a href={renderResult.url} download target="_blank" rel="noreferrer" className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-semibold transition-colors">
            <Download className="w-4 h-4" /> Download {renderConfig.type === '360' ? 'HTML Package' : 'Image'}
          </a>
        </div>
      </div>
    </div>
  );

  if (renderError) return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-96 bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-rose-200 dark:border-rose-900 overflow-hidden animate-in fade-in zoom-in-95 duration-300">
        <div className="p-6 text-center">
          <div className="w-16 h-16 bg-rose-100 dark:bg-rose-900/30 text-rose-500 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8" />
          </div>
          <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-2">Render Failed</h3>
          <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">{renderError}</p>
          <button onClick={() => setRenderError(null)} className="w-full py-3 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-white rounded-xl font-semibold transition-colors">Dismiss</button>
        </div>
    </div>
  );

  return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-96 bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-300">
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <Camera className="w-5 h-5 text-indigo-500" />
          <h3 className="font-bold text-slate-800 dark:text-white">Render Studio</h3>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-white"><X className="w-5 h-5"/></button>
      </div>
      
      <div className="p-6 space-y-6">
        <div>
          <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 block">Output Type</label>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setRenderConfig({...renderConfig, type: '360'})} className={`py-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${renderConfig.type === '360' ? 'bg-indigo-50 border-indigo-500 text-indigo-600 dark:bg-indigo-900/30 dark:border-indigo-500 dark:text-indigo-400' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400'}`}>
              <Orbit className="w-5 h-5" />
              <span className="text-sm font-semibold">Interactive 360°</span>
            </button>
            <button onClick={() => setRenderConfig({...renderConfig, type: 'static'})} className={`py-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${renderConfig.type === 'static' ? 'bg-indigo-50 border-indigo-500 text-indigo-600 dark:bg-indigo-900/30 dark:border-indigo-500 dark:text-indigo-400' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400'}`}>
              <ImageIcon className="w-5 h-5" />
              <span className="text-sm font-semibold">4K Static Image</span>
            </button>
          </div>
        </div>

        <div>
          <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 block">Lighting Scenario</label>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setRenderConfig({...renderConfig, lighting: 'daylight'})} className={`py-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${renderConfig.lighting === 'daylight' ? 'bg-amber-50 border-amber-500 text-amber-600 dark:bg-amber-900/30 dark:border-amber-500 dark:text-amber-400' : 'bg-white border-slate-200 text-slate-600 hover:border-amber-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400'}`}>
              <Sun className="w-5 h-5" />
              <span className="text-sm font-semibold">Daylight</span>
            </button>
            <button onClick={() => setRenderConfig({...renderConfig, lighting: 'night'})} className={`py-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${renderConfig.lighting === 'night' ? 'bg-slate-800 border-indigo-500 text-indigo-400 dark:bg-slate-900 dark:border-indigo-500 dark:text-indigo-400' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-800 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400'}`}>
              <Moon className="w-5 h-5" />
              <span className="text-sm font-semibold">Nighttime</span>
            </button>
          </div>
        </div>

        <button onClick={onExecute} className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-lg shadow-lg shadow-indigo-600/30 transition-all active:scale-[0.98] flex items-center justify-center gap-2">
          <Camera className="w-5 h-5" /> Start Cloud Render
        </button>
      </div>
    </div>
  );
};