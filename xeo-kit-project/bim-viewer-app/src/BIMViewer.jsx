import { useState, useRef, useEffect } from 'react';
import { useBIMEngine } from './hooks/useBIMEngine';
import { useProjectSync } from './hooks/useProjectSync';
import { useCloudRender } from './hooks/useCloudRender';

import { LeftPanel } from './components/LeftPanel';
import { RightPanel } from './components/RightPanel';
import { BottomDock } from './components/BottomDock';
import { RenderStudioModal } from './components/RenderStudioModal';
import { MeasurementPanel } from './components/MeasurementPanel';

import {
  MousePointerClick, X, PanelLeftOpen, PanelRightOpen,
  Loader2, CloudCog, Clock, Ruler
} from 'lucide-react';

const BIMViewer = ({ file, onDelete, onAdd }) => {
  const containerRef = useRef(null);

  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [isMaxView, setIsMaxView] = useState(false);
  const [rightTab, setRightTab] = useState('properties');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showRenderStudio, setShowRenderStudio] = useState(false);

  // ── Custom Hooks ────────────────────────────────────────────
  const {
    projectState, projectStateRef, saveStatus, lastSavedTime, 
    availableAssets, homeTemplates, // Extracted home templates
    toastMessage, customColor, applyMaterial, updateAsset, 
    deleteAsset, spawnAsset, applyTemplate, setCustomColor, // Extracted applyTemplate
  } = useProjectSync(file);

  const {
    refs, state: engineState, actions: engineActions,
  } = useBIMEngine(
    file,
    projectStateRef,
    (asset, coords) => spawnAsset(asset, coords, engineActions.loadIFCAssetIntoScene),
    setIsRightPanelOpen,
    setRightTab
  );

  const {
    state: renderState, config: renderConfig, setRenderConfig, executeRender,
    setRenderResult, setRenderError,
  } = useCloudRender(file, projectStateRef);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleBrowserFullscreen = () => {
    if (!document.fullscreenElement) { containerRef.current?.requestFullscreen(); }
    else { document.exitFullscreen(); }
  };

  const toggleMaxView = () => {
    const nextState = !isMaxView;
    setIsMaxView(nextState);
    setIsLeftPanelOpen(!nextState);
    setIsRightPanelOpen(!nextState);
  };

  const handleCustomColorChange = (e) => {
    const hex = e.target.value;
    const r = parseInt(hex.substring(1, 3), 16) / 255;
    const g = parseInt(hex.substring(3, 5), 16) / 255;
    const b = parseInt(hex.substring(5, 7), 16) / 255;

    const targetObject = engineState.selectedObject || { id: engineState.selectedAssetId };
    applyMaterial(refs.viewerRef, targetObject, hex, [r, g, b]);
    if (setCustomColor) setCustomColor(hex);
  };

  const activeAsset = engineState.selectedAssetId && refs.viewerRef.current
    ? refs.viewerRef.current.scene.models[engineState.selectedAssetId]
    : null;

  const handleDragEnter = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (e) => {
    e.preventDefault();

    try {
      const assetData = e.dataTransfer.getData('application/json');

      if (!assetData) {
        console.error('[BIMViewer] Drop received but no asset data found.');
        return;
      }

      const asset = JSON.parse(assetData);
      const canvasPos = [e.nativeEvent.offsetX, e.nativeEvent.offsetY];
      const worldPos = engineActions.getDropPosition(canvasPos);
      
      spawnAsset(asset, worldPos, engineActions.loadIFCAssetIntoScene);

      setIsRightPanelOpen(true);
      setRightTab('properties');

    } catch (error) {
      console.error('[BIMViewer] Error processing drop event:', error);
    }
  };

  return (
    <div
      ref={containerRef}
      className={`flex w-full h-full bg-slate-100 dark:bg-[#090b14] transition-colors duration-300 relative
        ${engineState.placementMode || engineState.isMeasuring ? 'cursor-crosshair' : ''}
        ${isFullscreen ? 'z-[100]' : 'pt-16'}`}
    >
      <div className={file ? 'contents' : 'hidden'}>
        <LeftPanel
          isOpen={isLeftPanelOpen}
          onClose={() => { setIsLeftPanelOpen(false); setIsMaxView(false); }}
          treeRef={refs.treeContainerRef}
          availableAssets={availableAssets}
          homeTemplates={homeTemplates} // Pass templates to UI
          onApplyTemplate={(templateId) => applyTemplate(templateId, engineActions.loadIFCAssetIntoScene)} // Bind loader action
          placementMode={engineState.placementMode}
          setPlacementMode={engineActions.setPlacementMode}
          resetSelection={() => {
            engineActions.setSelectedObject(null);
            engineActions.setSelectedAssetId(null);
          }}
        />
      </div>

      <div className="flex-1 relative overflow-hidden flex flex-col">

        {file && (
          <div className="absolute top-4 left-4 right-4 z-10 flex justify-between pointer-events-none">
            <div className="pointer-events-auto">
              {!isLeftPanelOpen && (
                <button
                  onClick={() => { setIsLeftPanelOpen(true); setIsMaxView(false); }}
                  className="p-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-sm text-slate-600 hover:text-indigo-600 dark:text-slate-400 transition-colors"
                >
                  <PanelLeftOpen className="w-5 h-5" />
                </button>
              )}
            </div>

            <div className="flex gap-3 pointer-events-auto items-center">
              <div className={`px-4 py-2 rounded-lg border flex items-center gap-2 text-sm font-semibold transition-all shadow-sm ${
                saveStatus === 'saved'   ? 'bg-emerald-50/90 border-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:border-emerald-800 dark:text-emerald-400' :
                saveStatus === 'saving' ? 'bg-indigo-50/90 border-indigo-200 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-800 dark:text-indigo-400' :
                saveStatus === 'error'  ? 'bg-rose-50/90 border-rose-200 text-rose-700 dark:bg-rose-900/30 dark:border-rose-800 dark:text-rose-400' :
                'bg-amber-50/90 border-amber-200 text-amber-700 dark:bg-amber-900/30 dark:border-amber-800 dark:text-amber-400'
              }`}>
                {saveStatus === 'saving' ? <Loader2 className="w-4 h-4 animate-spin" /> :
                 saveStatus === 'saved'  ? <CloudCog className="w-4 h-4" /> :
                 <Clock className="w-4 h-4" />}
                {saveStatus === 'saving' ? 'Syncing...' :
                 saveStatus === 'saved' && lastSavedTime
                   ? `Last saved at ${lastSavedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                   : saveStatus === 'error' ? 'Save Failed' : 'Unsaved Changes'}
              </div>

              {!isRightPanelOpen && (
                <button
                  onClick={() => { setIsRightPanelOpen(true); setIsMaxView(false); }}
                  className="p-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-sm text-slate-600 hover:text-indigo-600 dark:text-slate-400 transition-colors"
                >
                  <PanelRightOpen className="w-5 h-5" />
                </button>
              )}
            </div>
          </div>
        )}

        {engineState.placementMode && !engineState.isMeasuring && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-5 py-2.5 bg-indigo-600 text-white rounded-full shadow-lg animate-in slide-in-from-top-2 fade-in duration-200">
            <MousePointerClick className="w-4 h-4 animate-pulse" />
            <span className="font-semibold text-sm">
              Click canvas to place {engineState.placementMode.name}
            </span>
            <button
              onClick={() => engineActions.setPlacementMode(null)}
              className="ml-1 hover:bg-indigo-700 p-1 rounded-full"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {engineState.isMeasuring && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-5 py-2.5 bg-slate-900/80 dark:bg-slate-800/90 backdrop-blur-xl border border-slate-700 text-white rounded-full shadow-2xl animate-in slide-in-from-top-4 fade-in zoom-in-95 duration-300">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
            </span>
            <Ruler className="w-4 h-4 text-cyan-400" />
            <span className="font-medium text-sm tracking-wide">
              Click two points to measure
            </span>
            <button
              onClick={engineActions.toggleMeasurementMode}
              className="ml-2 bg-slate-700 hover:bg-slate-600 p-1.5 rounded-full transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {engineState.isMeasuring && (
          <MeasurementPanel
            measurementsList={engineState.measurementsList}
            measurementUnit={engineState.measurementUnit}
            setMeasurementUnit={engineActions.setMeasurementUnit}
            snappingEnabled={engineState.snappingEnabled}
            toggleSnapping={engineActions.toggleSnapping}
            axisBreakdownVisible={engineState.axisBreakdownVisible}
            toggleAxisBreakdown={engineActions.toggleAxisBreakdown}
            formatLength={engineActions.formatLength}
            totalMeasuredLength={engineState.totalMeasuredLength}
            deleteMeasurement={engineActions.deleteMeasurement}
            flyToMeasurement={engineActions.flyToMeasurement}
            clearMeasurements={engineActions.clearMeasurements}
            onClose={engineActions.toggleMeasurementMode}
          />
        )}

        {toastMessage && (
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-40 px-5 py-2.5 bg-slate-800 text-white rounded-full shadow-lg text-sm font-semibold animate-in slide-in-from-bottom-2 fade-in duration-200">
            {toastMessage}
          </div>
        )}

        {file && (
          <BottomDock
            onAdd={onAdd}
            onDelete={onDelete}
            onRenderClick={() => setShowRenderStudio(!showRenderStudio)}
            toggleMaxView={toggleMaxView}
            isMaxView={isMaxView}
            isFullscreen={isFullscreen}
            toggleBrowserFullscreen={toggleBrowserFullscreen}
            isMeasuring={engineState.isMeasuring}
            toggleMeasurementMode={engineActions.toggleMeasurementMode}
          />
        )}

        <RenderStudioModal
          show={showRenderStudio}
          onClose={() => setShowRenderStudio(false)}
          renderConfig={renderConfig}
          setRenderConfig={setRenderConfig}
          onExecute={executeRender}
          {...renderState}
          setRenderResult={setRenderResult}
          setRenderError={setRenderError}
        />

        <canvas
          ref={refs.canvasRef}
          tabIndex={0}
          onPointerDown={() => refs.canvasRef.current?.focus()}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          style={{ width: '100%', height: '100%', display: 'block', outline: 'none', touchAction: 'none' }}
          className={`${!file ? 'opacity-0' : 'opacity-100 transition-opacity duration-1000'} ${engineState.isMeasuring || engineState.placementMode ? 'cursor-crosshair' : 'cursor-default'}`}
        />

        <canvas id="myNavCubeCanvas" ref={refs.navCubeCanvasRef} className={!file ? 'hidden' : 'block'} />
      </div>

      <div className={file ? 'contents' : 'hidden'}>
        <RightPanel
          isOpen={isRightPanelOpen}
          onClose={() => { setIsRightPanelOpen(false); setIsMaxView(false); }}
          rightTab={rightTab}
          setRightTab={setRightTab}
          selectedObject={engineState.selectedObject}
          activeAsset={activeAsset}
          selectedAssetId={engineState.selectedAssetId}
          customColor={customColor}
          handleCustomColorChange={handleCustomColorChange}
          updateSelectedAsset={(axis, val, rot) =>
            updateAsset(refs.viewerRef, engineState.selectedAssetId, axis, val, rot)
          }
          deleteSelectedAsset={() => deleteAsset(refs.viewerRef, engineState.selectedAssetId)}
          projectState={projectState}
          engineState={engineState}
          engineActions={engineActions}
        />
      </div>
    </div>
  );
};

export default BIMViewer;