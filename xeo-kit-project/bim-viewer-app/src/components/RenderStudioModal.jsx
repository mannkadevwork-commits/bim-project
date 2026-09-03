import { useEffect, useState } from 'react';
import { Camera, Orbit, Image as ImageIcon, Sun, Moon, X, Loader2, Clock, Download, ExternalLink, AlertCircle, Box, Layers3 } from 'lucide-react';
import { LayoutMetadataForm } from './LayoutMetadataForm';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const RenderStudioModal = ({
  show, onClose, renderConfig, setRenderConfig, onExecute,
  isRendering, renderResult, renderTime, renderError, setRenderResult, setRenderError,
  onSaveAsLayout,
  activeFileName = '',
  existingSavedLayouts = [],
}) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  const [showLayoutForm, setShowLayoutForm] = useState(false);
  const [isSavingLayout, setIsSavingLayout] = useState(false);
  const [saveLayoutMessage, setSaveLayoutMessage] = useState(null);

  useEffect(() => {
    if (!show) {
      setShowLayoutForm(false);
      setSaveLayoutMessage(null);
      setIsSavingLayout(false);
    }
  }, [show]);

  if (!show) return null;

  const jobId = renderResult?.jobId;
  const walkthroughUrl = renderResult?.walkthroughUrl || (jobId ? `${window.location.origin}/walkthrough/${encodeURIComponent(jobId)}` : null);
  const modelUrl = renderResult?.modelUrl || (jobId ? `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/output.glb` : null);

  const handleSaveAsLayout = async (metadata) => {
    if (!onSaveAsLayout || isSavingLayout) return;
    setIsSavingLayout(true);
    setSaveLayoutMessage(null);
    try {
      await onSaveAsLayout(metadata, renderResult, renderConfig);
      setSaveLayoutMessage({ type: 'success', text: `Saved “${metadata.name}” to Layouts.` });
      setShowLayoutForm(false);
    } catch (error) {
      setSaveLayoutMessage({ type: 'error', text: error.message || 'Failed to save this layout.' });
    } finally {
      setIsSavingLayout(false);
    }
  };

  const downloadModel = async () => {
    if (!modelUrl || isDownloading) return;
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const response = await fetch(modelUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${jobId || 'hci-model'}.glb`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
    } catch (error) {
      setDownloadError(error.message || 'Unable to download the model.');
    } finally {
      setIsDownloading(false);
    }
  };

  if (isRendering) return (
    <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex flex-col items-center justify-center text-white">
      <Loader2 className="w-16 h-16 animate-spin text-indigo-500 mb-6" />
      <h2 className="text-3xl font-bold mb-2">Preparing Interactive 360° Render...</h2>
      <p className="text-slate-300">Compiling the final GLB and navigation data for the walkthrough.</p>
      <p className="text-slate-400 text-sm mt-2">This may take a little while depending on scene complexity.</p>
    </div>
  );

  if (renderResult) return (
    <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-md z-[100] flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-6xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl overflow-hidden flex flex-col" style={{ height: '86vh' }}>
        <div className="flex justify-between items-center p-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div>
              <h3 className="font-bold text-lg text-slate-800 dark:text-white">Interactive 360° Render</h3>
              <p className="text-xs text-slate-400 mt-0.5">{jobId}</p>
            </div>
            <span className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-1 rounded-full"><Clock className="w-4 h-4"/> {renderTime}s</span>
          </div>
          <button onClick={() => setRenderResult(null)} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"><X className="w-6 h-6" /></button>
        </div>

        <div className="flex-1 bg-slate-100 dark:bg-[#0b0f1a] relative p-3">
          {renderConfig.type === '360' ? (
            <iframe
              src={walkthroughUrl}
              className="w-full h-full rounded-xl border-2 border-slate-200 dark:border-slate-700 shadow-inner bg-black"
              allowFullScreen
              title="HCI Interactive 360 Walkthrough"
            />
          ) : (
            <img src={renderResult.url} alt="Render Output" className="max-w-full max-h-full mx-auto rounded-xl shadow-2xl object-contain" />
          )}
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap justify-end items-center gap-3 bg-slate-50 dark:bg-slate-800/50">
          {renderConfig.type === '360' ? (
            <>
              {!renderResult?.isSavedLayout && onSaveAsLayout && (
                <div className="flex w-full items-center gap-3 rounded-xl border border-indigo-200/80 bg-indigo-50/60 p-3 dark:border-indigo-900/50 dark:bg-indigo-950/25 lg:w-auto">
                  <div className="hidden sm:flex h-9 w-9 items-center justify-center rounded-lg bg-white text-indigo-500 shadow-sm dark:bg-slate-900">
                    <Layers3 className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-slate-800 dark:text-white">Save this render as a reusable layout</p>
                    <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">Choose category → sub-category → layout name.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setSaveLayoutMessage(null); setShowLayoutForm(true); }}
                    disabled={isSavingLayout}
                    className="shrink-0 rounded-lg bg-[#ff914d] px-4 py-2.5 text-xs font-bold text-white transition hover:bg-[#ff7a28] disabled:cursor-wait disabled:opacity-60"
                  >
                    Save as Layout
                  </button>
                  {saveLayoutMessage && <span className={`hidden max-w-[220px] text-[11px] sm:block ${saveLayoutMessage.type === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{saveLayoutMessage.text}</span>}
                </div>
              )}
              <button
                type="button"
                onClick={downloadModel}
                disabled={!modelUrl || isDownloading}
                className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition-colors"
              >
                {isDownloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {isDownloading ? 'Preparing…' : 'Download 3D Model (.glb)'}
              </button>
              <a
                href={walkthroughUrl || '#'}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 px-5 py-2.5 bg-slate-800 hover:bg-slate-900 dark:bg-slate-700 dark:hover:bg-slate-600 text-white rounded-lg font-semibold transition-colors"
              >
                <ExternalLink className="w-4 h-4" /> Open 360° Fullscreen
              </a>
              {downloadError && <span className="w-full text-right text-xs text-rose-500">{downloadError}</span>}
            </>
          ) : (
            <a href={renderResult.url} download target="_blank" rel="noreferrer" className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-semibold transition-colors">
              <Download className="w-4 h-4" /> Download Image
            </a>
          )}
        </div>
      {showLayoutForm && (
        <div className="absolute inset-0 z-[140] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-md">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
            <div className="shrink-0 border-b border-slate-200 p-5 dark:border-slate-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-indigo-500">Save Layout</p>
                <h3 className="mt-1 text-lg font-bold text-slate-900 dark:text-white">Organize this layout</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">The snapshot keeps the IFC and all scene edits exactly as rendered.</p>
              </div>
              <button type="button" onClick={() => setShowLayoutForm(false)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/5 dark:hover:text-white" aria-label="Close save layout form">
                <X className="h-5 w-5" />
              </button>
            </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <LayoutMetadataForm
              mode="create"
              fileName={activeFileName}
              existingLayouts={existingSavedLayouts}
              submitting={isSavingLayout}
              onSubmit={handleSaveAsLayout}
              onCancel={() => setShowLayoutForm(false)}
            />
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );

  if (renderError) return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-96 bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-rose-200 dark:border-rose-900 overflow-hidden animate-in fade-in zoom-in-95 duration-300">
      <div className="p-6 text-center">
        <div className="w-16 h-16 bg-rose-100 dark:bg-rose-900/30 text-rose-500 rounded-full flex items-center justify-center mx-auto mb-4"><AlertCircle className="w-8 h-8" /></div>
        <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-2">Render Failed</h3>
        <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">{renderError}</p>
        <button onClick={() => setRenderError(null)} className="w-full py-3 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-white rounded-xl font-semibold transition-colors">Dismiss</button>
      </div>
    </div>
  );

  return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-96 bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-300">
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex justify-between items-center">
        <div className="flex items-center gap-2"><Camera className="w-5 h-5 text-indigo-500" /><h3 className="font-bold text-slate-800 dark:text-white">Render Studio</h3></div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-white"><X className="w-5 h-5" /></button>
      </div>

      <div className="p-6 space-y-6">
        <div>
          <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 block">Output Type</label>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setRenderConfig({ ...renderConfig, type: '360' })} className={`py-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${renderConfig.type === '360' ? 'bg-indigo-50 border-indigo-500 text-indigo-600 dark:bg-indigo-900/30 dark:border-indigo-500 dark:text-indigo-400' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400'}`}><Orbit className="w-5 h-5" /><span className="text-sm font-semibold">Interactive 360°</span></button>
            <button onClick={() => setRenderConfig({ ...renderConfig, type: 'static' })} className={`py-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${renderConfig.type === 'static' ? 'bg-indigo-50 border-indigo-500 text-indigo-600 dark:bg-indigo-900/30 dark:border-indigo-500 dark:text-indigo-400' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400'}`}><ImageIcon className="w-5 h-5" /><span className="text-sm font-semibold">4K Static Image</span></button>
          </div>
        </div>

        <div>
          <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 block">Lighting Scenario</label>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setRenderConfig({ ...renderConfig, lighting: 'daylight' })} className={`py-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${renderConfig.lighting === 'daylight' ? 'bg-amber-50 border-amber-500 text-amber-600 dark:bg-amber-900/30 dark:border-amber-500 dark:text-amber-400' : 'bg-white border-slate-200 text-slate-600 hover:border-amber-300 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400'}`}><Sun className="w-5 h-5" /><span className="text-sm font-semibold">Daylight</span></button>
            <button onClick={() => setRenderConfig({ ...renderConfig, lighting: 'night' })} className={`py-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${renderConfig.lighting === 'night' ? 'bg-slate-800 border-indigo-500 text-indigo-400 dark:bg-slate-900 dark:border-indigo-500 dark:text-indigo-400' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-800 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400'}`}><Moon className="w-5 h-5" /><span className="text-sm font-semibold">Nighttime</span></button>
          </div>
        </div>

        <div className="rounded-xl border border-indigo-100 dark:border-indigo-900/40 bg-indigo-50/70 dark:bg-indigo-950/30 p-3 text-xs text-slate-600 dark:text-slate-300 flex gap-2">
          <Box className="mt-0.5 w-4 h-4 shrink-0 text-indigo-500" />
          <span>Interactive 360° uses the final React walkthrough. After rendering, the final compiled GLB can be downloaded for local use.</span>
        </div>

        <button onClick={onExecute} className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-lg shadow-lg shadow-indigo-600/30 transition-all active:scale-[0.98] flex items-center justify-center gap-2"><Camera className="w-5 h-5" /> Start Render</button>
      </div>
    </div>
  )
};