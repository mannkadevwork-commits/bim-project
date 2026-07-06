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
  MousePointerClick, X, Ruler
} from 'lucide-react';

const BIMViewer = ({ file, onDelete, onAdd }) => {
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);

  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [isMaxView, setIsMaxView] = useState(false);
  const [rightTab, setRightTab] = useState('properties');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showRenderStudio, setShowRenderStudio] = useState(false);
  
  // Track manual saving state for button animation
  const [isManualSaving, setIsManualSaving] = useState(false);

  // Manage Dark Mode locally
  const [isDarkMode, setIsDarkMode] = useState(
    document.documentElement.classList.contains('dark')
  );

  const toggleTheme = () => {
    if (isDarkMode) {
      document.documentElement.classList.remove('dark');
      setIsDarkMode(false);
    } else {
      document.documentElement.classList.add('dark');
      setIsDarkMode(true);
    }
  };

  // ── Custom Hooks ────────────────────────────────────────────
  const {
    projectState, projectStateRef, saveStatus, lastSavedTime, 
    availableAssets, homeTemplates,
    toastMessage, customColor, applyMaterial, updateAsset, 
    deleteAsset, spawnAsset, applyTemplate, setCustomColor, adoptIsolatedAsset,
    updateStructuralEdit
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

  // ── Browser Fullscreen Handler ──
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

  const updateCursorTooltip = (clientX, clientY, offsetX, offsetY) => {
    if (!tooltipRef.current || !engineActions.getCursorWorldPosition) return;
    
    const canvasPos = [offsetX, offsetY];
    const worldPos = engineActions.getCursorWorldPosition(canvasPos);
    
    if (worldPos) {
      tooltipRef.current.style.display = 'flex';
      tooltipRef.current.style.transform = `translate(${clientX + 15}px, ${clientY + 15}px)`;
      tooltipRef.current.innerHTML = `
        <div class="flex flex-col gap-0.5">
          <span class="text-[9px] uppercase tracking-wider text-slate-500 font-bold mb-0.5 border-b border-slate-700 pb-0.5">3D World Grid</span>
          <span class="text-rose-400 font-medium">X: ${worldPos[0].toFixed(3)}</span>
          <span class="text-emerald-400 font-medium">Y: ${worldPos[1].toFixed(3)}</span>
          <span class="text-cyan-400 font-medium">Z: ${worldPos[2].toFixed(3)}</span>
        </div>
      `;
    } else {
      tooltipRef.current.style.display = 'none';
    }
  };

  const handlePointerMove = (e) => updateCursorTooltip(e.clientX, e.clientY, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
  const handleDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; updateCursorTooltip(e.clientX, e.clientY, e.nativeEvent.offsetX, e.nativeEvent.offsetY); };
  const handlePointerLeave = () => { if (tooltipRef.current) tooltipRef.current.style.display = 'none'; };
  const handleDragEnter = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };

  const handleDrop = (e) => {
    e.preventDefault();
    try {
      const assetData = e.dataTransfer.getData('application/json');
      if (!assetData) return;
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

  // ── MANUAL SAVE TRIGGER ─────────────────────────────────────
  const handleManualSave = async () => {
    if (!file) return;
    setIsManualSaving(true);
    
    const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    
    try {
        await fetch(`${API_BASE_URL}/api/projects/${jobId}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectState: projectStateRef.current })
        });
        setTimeout(() => setIsManualSaving(false), 1000);
    } catch (err) {
        console.error("Manual save failed", err);
        setIsManualSaving(false);
    }
  };

  // ── AUTO SAVE LOOP ──────────────────────────────────────────
  useEffect(() => {
    if (!file) return;
    const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

    const saveInterval = setInterval(() => {
      fetch(`${API_BASE_URL}/api/projects/${jobId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectState: projectStateRef.current })
      }).catch(err => console.error("Auto-save failed", err));
    }, 15000); 

    return () => clearInterval(saveInterval);
  }, [file]);

  // ── FILE UPLOAD / RESET HANDLER ─────────────────────────────
  useEffect(() => {
    if (file) {
      projectStateRef.current = { materials: {}, furniture: [] };
      engineActions.setSelectedObject(null);
      engineActions.setSelectedAssetId(null);
      if (engineActions.clearMeasurements) engineActions.clearMeasurements();
      
      setIsLeftPanelOpen(true);
      setIsRightPanelOpen(true);
    } else {
      setIsLeftPanelOpen(false);
      setIsRightPanelOpen(false);
      setShowRenderStudio(false);
    }
  }, [file]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full bg-slate-100 dark:bg-[#090b14] overflow-hidden transition-colors duration-300
        ${engineState.placementMode || engineState.isMeasuring ? 'cursor-crosshair' : 'cursor-default'}
        ${isFullscreen ? 'z-[100]' : ''}`}
    >
      <div 
        ref={tooltipRef}
        className="fixed z-[999] pointer-events-none hidden px-3 py-2 bg-slate-900/95 backdrop-blur-xl border border-slate-700/50 rounded-xl shadow-2xl transition-opacity duration-75 text-xs font-mono"
        style={{ top: 0, left: 0, willChange: 'transform' }}
      />

      {/* ── 1. THE 3D CANVAS ── */}
      <div className={`absolute inset-0 z-0 ${!file ? 'opacity-0' : 'opacity-100 transition-opacity duration-1000'}`}>
        <canvas
          ref={refs.canvasRef}
          tabIndex={0}
          onPointerDown={() => refs.canvasRef.current?.focus()}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handlePointerLeave}
          onDrop={handleDrop}
          style={{ width: '100%', height: '100%', display: 'block', outline: 'none', touchAction: 'none' }}
        />
        <canvas id="myNavCubeCanvas" ref={refs.navCubeCanvasRef} className="absolute bottom-16 right-6 z-10 w-[150px] h-[150px]" />
      </div>

      {/* ── 2. ACTION PILLS (Placement & Measurement) ── */}
      {engineState.placementMode && !engineState.isMeasuring && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-5 py-2.5 bg-indigo-600 text-white rounded-full shadow-lg animate-in slide-in-from-top-2 fade-in duration-200">
          <MousePointerClick className="w-4 h-4 animate-pulse" />
          <span className="font-semibold text-sm">
            Click canvas to place {engineState.placementMode.name}
          </span>
          <button onClick={() => engineActions.setPlacementMode(null)} className="ml-1 hover:bg-indigo-700 p-1 rounded-full cursor-pointer">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {engineState.isMeasuring && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-5 py-2.5 bg-slate-900/90 backdrop-blur-xl border border-slate-700 text-white rounded-full shadow-2xl animate-in slide-in-from-top-4 fade-in zoom-in-95 duration-300">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
          </span>
          <Ruler className="w-4 h-4 text-cyan-400" />
          <span className="font-medium text-sm tracking-wide">
            Click two points to measure
          </span>
          <button onClick={engineActions.toggleMeasurementMode} className="ml-2 bg-slate-700 hover:bg-slate-600 p-1.5 rounded-full transition-colors cursor-pointer">
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
          scaleModelByMeasurement={engineActions.scaleModelByMeasurement}
          sceneScaleFactor={engineState.sceneScaleFactor} 
        />
      )}

      {/* ── 3. FULL-HEIGHT LEFT PANEL ── */}
      {file && (
        <div className={`absolute inset-y-0 left-0 w-80 z-30 transition-transform duration-300 ${isLeftPanelOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <LeftPanel
            isOpen={isLeftPanelOpen}
            onClose={() => { setIsLeftPanelOpen(false); setIsMaxView(false); }}
            treeRef={refs.treeContainerRef}
            availableAssets={availableAssets}
            homeTemplates={homeTemplates}
            onApplyTemplate={(templateId) => applyTemplate(templateId, engineActions.loadIFCAssetIntoScene)}
            placementMode={engineState.placementMode}
            setPlacementMode={engineActions.setPlacementMode}
            resetSelection={() => {
              engineActions.setSelectedObject(null);
              engineActions.setSelectedAssetId(null);
            }}
            fileName={file.name}
            projectState={projectState} // <--- CRITICAL FIX: Passed projectState down so the Explorer sees the furniture
          />
        </div>
      )}

      {/* ── 4. FULL-HEIGHT RIGHT PANEL ── */}
      {file && (
        <div className={`absolute inset-y-0 right-0 w-[340px] z-30 transition-transform duration-300 ${isRightPanelOpen ? 'translate-x-0' : 'translate-x-full'}`}>
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
            adoptIsolatedAsset={adoptIsolatedAsset}
            updateStructuralEdit={updateStructuralEdit}
            
            // Global Header Props
            onDeleteProject={onDelete}
            isDarkMode={isDarkMode}
            toggleTheme={toggleTheme}
            handleManualSave={handleManualSave}
            isManualSaving={isManualSaving}
            saveStatus={saveStatus}
            lastSavedTime={lastSavedTime}
          />
        </div>
      )}

      {/* ── 5. BOTTOM DOCK (FIX: Snapped to bottom-0) ── */}
      {file && (
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 z-40 pb-4">
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
        </div>
      )}

      {/* TOAST & MODALS */}
      {toastMessage && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 bg-slate-800/95 backdrop-blur-md text-white rounded-full shadow-2xl border border-slate-700 text-sm font-semibold animate-in slide-in-from-bottom-2 fade-in duration-200">
          {toastMessage}
        </div>
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
      
    </div>
  );
};

export default BIMViewer;