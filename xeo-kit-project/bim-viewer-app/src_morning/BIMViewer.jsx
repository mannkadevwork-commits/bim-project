import { useState, useRef, useEffect } from 'react';
import { useBIMEngine } from './engine/useBIMEngine';
import { useProjectSync } from './hooks/useProjectSync';
import { useCloudRender } from './hooks/useCloudRender';
import { LeftPanel } from './components/LeftPanel';
import { RightPanel } from './components/RightPanel';
import { BottomDock } from './components/BottomDock';
import { RenderStudioModal } from './components/RenderStudioModal';
import { MeasurementPanel } from './components/MeasurementPanel';
import { StretchTooltipOverlay } from './components/StretchTooltipOverlay';
import { TransformModeTooltip } from './components/TransformModeTooltip';
import { MousePointerClick, X, Ruler, Hexagon, Loader2 } from 'lucide-react';
import { ViewportToolbar } from './components/ViewportToolbar';
import { TransformModesHelp } from './components/TransformModesHelp';
import { AssetContextMenu } from './components/AssetContextMenu';
import { useCatalog } from './hooks/useCatalog';

const BIMViewer = ({ activeProject, onDelete, onAdd, onReplaceProject }) => {
  const { file, jobId, fileName } = activeProject || {};
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [isMaxView, setIsMaxView] = useState(false);
  const [rightTab, setRightTab] = useState('properties');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showRenderStudio, setShowRenderStudio] = useState(false);
  const [isManualSaving, setIsManualSaving] = useState(false);
  const [lastClickPos, setLastClickPos] = useState({ x: 0, y: 0 });

  // Add the useCatalog hook call[cite: 1]
  const { tree: catalogTree, loading: catalogLoading, error: catalogError } = useCatalog();
  
  const [isDarkMode, setIsDarkMode] = useState(document.documentElement.classList.contains('dark'));
  const toggleTheme = () => {
    if (isDarkMode) {
      document.documentElement.classList.remove('dark');
      setIsDarkMode(false);
    } else {
      document.documentElement.classList.add('dark');
      setIsDarkMode(true);
    }
  };

  const {
    projectState, projectStateRef, saveStatus, lastSavedTime,
    availableAssets, availableLayouts, layoutsLoading, layoutsError, homeTemplates,
    toastMessage, customColor, applyMaterial, updateAsset,
    deleteAsset, spawnAsset, applyTemplate, setCustomColor, adoptIsolatedAsset,
    updateStructuralEdit, setToastMessage, saveNow
  } = useProjectSync(activeProject);

  const insertDoor = async (asset, wallSnapData) => {
    if (!file || !jobId) return;
    
    const { position, rotation, wallGlobalId } = wallSnapData;
    const doorSurfacePosition = [position[0], 0, position[2]];
    
    const doorDims = {
      'door_single': { width: 0.9, height: 2.1, thickness: 0.05 },
      'door_double': { width: 1.2, height: 2.1, thickness: 0.05 },
      'door_sliding': { width: 2.0, height: 2.1, thickness: 0.05 },
      'door_revolving': { width: 2.0, height: 2.1, thickness: 0.1 },
      'door_fire': { width: 1.0, height: 2.1, thickness: 0.06 },
      'door_3bhk': { width: 0.9, height: 2.1, thickness: 0.04 },
    }[asset.id] || { width: 0.9, height: 2.1, thickness: 0.05 };
    
    engineActions.setIsLoading(true);
    setToastMessage(`Cutting void in wall...`);
    
    try {
      const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      const response = await fetch(`${API_BASE_URL}/api/elements/${jobId}/${wallGlobalId}/insert-door`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          assetId: asset.id, 
          position: doorSurfacePosition, 
          rotation,
          ...doorDims 
        })
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || 'Failed to insert door');
      
      // The modified wall IFC (data.fileUrl) is the full building IFC with the
      // opening baked in — it has its own IFC placement, so we load it with
      // targetPosition=null and let the IFC coordinates place it correctly.
      const wallEntity = refs.viewerRef.current?.scene.objects[wallGlobalId];
      if (wallEntity) wallEntity.visible = false;
      updateStructuralEdit(wallGlobalId, 'visible', null, false);
      
      const modifiedWallId = `${wallGlobalId}_cut_${Date.now()}`;
      // targetPosition is null — the full IFC already has the wall at its correct
      // world coordinates via its own IfcLocalPlacement.
      await engineActions.loadIFCAssetIntoScene(modifiedWallId, data.fileUrl, null, null);
      // The modified wall file is the full building IFC — its wall element
      // already sits at the correct world coordinates via its own IfcLocalPlacement.
      // The compiler must apply zero translation so it doesn't double-offset.
      // wallWorldPos is stored only so the viewer can restore visibility correctly
      // on reload; the compiler uses position [0,0,0] for full-IFC assets.
      adoptIsolatedAsset(wallGlobalId, modifiedWallId, data.fileUrl, 'Wall with Void', [0, 0, 0]);
      
      if (!data.doorPlacement) {
        throw new Error('Backend did not return doorPlacement check ifc_element_editor.py version.');
      }
      asset.hostWallId = wallGlobalId;
      spawnAsset(asset, data.doorPlacement.position, engineActions.loadIFCAssetIntoScene, data.doorPlacement.rotation);
      
    } catch (error) {
      console.error('[BIMViewer] Door insertion failed:', error);
      setToastMessage(`Error: ${error.message}`);
    } finally {
      engineActions.setIsLoading(false);
    }
  };

  const {
    refs, state: engineState, actions: engineActions,
  } = useBIMEngine(
    activeProject,
    projectStateRef,
    projectState,
    (asset, data) => {
      if (asset.type === 'door') {
        insertDoor(asset, data);
      } else {
        spawnAsset(asset, data, engineActions.loadIFCAssetIntoScene);
      }
    },
    setIsRightPanelOpen,
    setRightTab
  );

  const {
    state: renderState, config: renderConfig, setRenderConfig, executeRender,
    setRenderResult, setRenderError,
  } = useCloudRender(activeProject, projectStateRef);

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

  const handlePointerDown = (e) => {
    refs.canvasRef.current?.focus();

    const canvas = refs.canvasRef.current;
    if (!canvas || !refs.viewerRef.current) return;

    const rect = canvas.getBoundingClientRect();
    const canvasPos = [e.clientX - rect.left, e.clientY - rect.top];
    const picked = refs.viewerRef.current.scene.pick({ canvasPos, pickSurface: false });

    // Do not move the contextual toolbar when interacting with a transform gizmo.
    if (picked?.entity?._stretchMeta?.isStretchHandle) return;

    setLastClickPos({ x: e.clientX, y: e.clientY });
  };

  const handlePointerUp = (e) => {
    refs.canvasRef.current?.focus();
  };
  
  const handlePointerMove = (e) => {
    updateCursorTooltip(e.clientX, e.clientY, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
  };
  
  const handleDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; updateCursorTooltip(e.clientX, e.clientY, e.nativeEvent.offsetX, e.nativeEvent.offsetY); };
  const handlePointerLeave = () => { if (tooltipRef.current) tooltipRef.current.style.display = 'none'; };
  const handleDragEnter = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };

  const handleDrop = async (e) => {
    e.preventDefault();
    try {
      const assetData = e.dataTransfer.getData('application/json');
      if (!assetData) return;
      const asset = JSON.parse(assetData);
      const canvasPos = [e.nativeEvent.offsetX, e.nativeEvent.offsetY];
      
      if (asset.type === 'door') {
        const dropData = engineActions.getDropPosition(canvasPos, asset.type);
        if (!dropData.snapped) {
          setToastMessage("Please drop the door onto a vertical wall.");
          setTimeout(() => setToastMessage(null), 3000);
          return;
        }
        await insertDoor(asset, dropData);
      } else {
        const worldPos = engineActions.getDropPosition(canvasPos);
        spawnAsset(asset, worldPos, engineActions.loadIFCAssetIntoScene);
      }
      setIsRightPanelOpen(true);
      setRightTab('properties');
    } catch (error) {
      console.error('[BIMViewer] Error processing drop event:', error);
    }
  };

  const handleManualSave = async () => {
    if (!file || !jobId) return;
    setIsManualSaving(true);
    try {
      await saveNow(projectStateRef.current);
      setTimeout(() => setIsManualSaving(false), 500);
    } catch (err) {
      console.error('[BIMViewer] Manual save failed:', err);
      setIsManualSaving(false);
    }
  };

  // Project changes are persisted by useProjectSync immediately after every
  // committed state change. There is intentionally no second interval-based
  // save loop here; one owner prevents duplicate/racing save pipelines.

  useEffect(() => {
    if (file && jobId) {
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
  }, [file, jobId]);


  // Sync Engine Visual Transforms -> React State (so it saves to the cloud)
  useEffect(() => {
    engineActions.setStretchPersistCallback((targetId, type, axis, value) => {
      if (type === 'position') {
        updateAsset(refs.viewerRef, targetId, axis, value, false, false);
      } else if (type === 'rotation') {
        updateAsset(refs.viewerRef, targetId, axis, value, true, false);
      } else if (type === 'scale') {
        updateAsset(refs.viewerRef, targetId, axis, value, false, true);
      }
    });
  }, [engineActions, updateAsset]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full bg-slate-100 dark:bg-[#090b14] overflow-hidden transition-colors duration-300
        ${engineState.isStretching ? (engineState.transformMode === 'move' ? 'cursor-move' : engineState.transformMode === 'rotate' ? 'cursor-grabbing' : 'cursor-ew-resize') : engineState.placementMode || engineState.isMeasuring ? 'cursor-crosshair' : 'cursor-default'}
        ${isFullscreen ? 'z-[100]' : ''}`}
    >
      {file && (
        <>
          <div
            className={`absolute top-[64px] z-[45] transition-all duration-200 ${isLeftPanelOpen ? 'left-[336px]' : 'left-4'}`}
          >
            <TransformModesHelp isDarkMode={isDarkMode} />
          </div>

          <ViewportToolbar
          isMeasuring={engineState.isMeasuring}
          isClipping={engineState.isClipping}
          isMaxView={isMaxView}
          isFullscreen={isFullscreen}
          navMode={engineState.navMode}
          onSelect={() => {
            engineActions.setPlacementMode(null);
            if (engineState.isMeasuring) engineActions.toggleMeasurementMode();
            if (engineState.isClipping) engineActions.toggleClipping();
            engineActions.setTransformMode('select');
          }}
          onNavMode={(next) => engineActions.setNavMode(next)}
          onMeasure={() => engineActions.toggleMeasurementMode()}
          onClip={() => engineActions.toggleClipping()}
          onMaxView={toggleMaxView}
          onFullscreen={toggleBrowserFullscreen}
          onFit={() => {
            const viewer = refs.viewerRef.current;
            if (viewer) {
              const mainModel = viewer.scene.models?.main_structure;
              if (mainModel) viewer.cameraFlight.flyTo(mainModel);
            }
          }}
          />
        </>
      )}

      <div 
        ref={tooltipRef}
        className="fixed z-[999] pointer-events-none hidden px-3 py-2 bg-slate-900/95 backdrop-blur-xl border border-slate-700/50 rounded-xl shadow-2xl transition-opacity duration-75 text-xs font-mono"
        style={{ top: 0, left: 0, willChange: 'transform' }}
      />
      
      {/* TOOLTIP OVERLAY FOR STRETCHING */}
      {engineState.activeStretchData && (
        <StretchTooltipOverlay 
          visible={true}
          x={engineState.activeStretchData.x}
          y={engineState.activeStretchData.y}
          label={engineState.activeStretchData.label}
        />
      )}
      {/* TOOLTIP OVERLAY FOR EDITING */}
      {(engineState.selectedAssetId || engineState.selectedObject) && !engineState.isStretching && (
        <TransformModeTooltip
          mode={engineState.transformMode}
          onModeChange={engineActions.setTransformMode}
          assetName={activeAsset?.name || engineState.selectedObject?.name || 'Selected element'}
          anchorX={lastClickPos.x}
          anchorY={lastClickPos.y}
          isNative={!!engineState.selectedObject && !activeAsset}
          onIsolate={() => {
            if (engineState.selectedObject && !activeAsset) {
              engineActions.isolateAndMakeMoveable(
                engineState.selectedObject.id, 
                adoptIsolatedAsset, 
                updateStructuralEdit
              );
            }
          }}
          onColorChange={(hex) => {
            const r = parseInt(hex.substring(1, 3), 16) / 255;
            const g = parseInt(hex.substring(3, 5), 16) / 255;
            const b = parseInt(hex.substring(5, 7), 16) / 255;
            const targetObject = engineState.selectedObject || { id: engineState.selectedAssetId };
            applyMaterial(refs.viewerRef, targetObject, hex, [r, g, b]);
            if (setCustomColor) setCustomColor(hex);
          }}
          onDelete={() => {
            if (engineState.selectedAssetId) {
              deleteAsset(refs.viewerRef, engineState.selectedAssetId);
            } else if (engineState.selectedObject) {
              // Gracefully hide native elements to simulate deletion
              updateStructuralEdit(engineState.selectedObject.id, 'visible', null, false);
              if (refs.viewerRef.current?.scene.objects[engineState.selectedObject.id]) {
                refs.viewerRef.current.scene.objects[engineState.selectedObject.id].visible = false;
              }
            }
            engineActions.destroyStretchHandles();
            engineActions.setSelectedAssetId(null);
            engineActions.setSelectedObject(null);
          }}
        />
      )}
      
      <div className={`absolute inset-0 z-0 ${!file ? 'opacity-0' : 'opacity-100 transition-opacity duration-1000'}`}>
        <canvas
          ref={refs.canvasRef}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handlePointerLeave}
          onDrop={handleDrop}
          style={{ width: '100%', height: '100%', display: 'block', outline: 'none', touchAction: 'none' }}
        />
        <div
          className={`absolute bottom-[88px] z-20 w-[176px] h-[176px] rounded-full border backdrop-blur-xl shadow-2xl flex items-center justify-center transition-all duration-200 ${isRightPanelOpen ? 'right-[294px]' : 'right-5'} ${isDarkMode ? 'bg-[#07111d]/72 border-slate-700/70 shadow-black/35' : 'bg-white/76 border-slate-200 shadow-slate-900/10'}`}
          aria-label="View orientation"
        >
          <div className={`absolute inset-[8px] rounded-full border ${isDarkMode ? 'border-slate-800/80' : 'border-slate-200/80'}`} />
          <canvas id="myNavCubeCanvas" ref={refs.navCubeCanvasRef} className="relative z-10 w-[150px] h-[150px]" />
        </div>
      </div>

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

      {file && (
        <div className={`absolute inset-y-0 left-0 w-80 z-30 transition-transform duration-300 ${isLeftPanelOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <LeftPanel
            isOpen={isLeftPanelOpen}
            onClose={() => { setIsLeftPanelOpen(false); setIsMaxView(false); }}
            treeRef={refs.treeContainerRef}
            availableAssets={availableAssets}
            catalogTree={catalogTree} 
            catalogLoading={catalogLoading} 
            catalogError={catalogError} 
            homeTemplates={homeTemplates}
            availableLayouts={availableLayouts}
            layoutsLoading={layoutsLoading}
            layoutsError={layoutsError}
            onSelectLayout={onReplaceProject}
            onApplyTemplate={(templateId) => applyTemplate(templateId, engineActions.loadIFCAssetIntoScene)}
            placementMode={engineState.placementMode}
            setPlacementMode={engineActions.setPlacementMode}
            resetSelection={() => {
              engineActions.setSelectedObject(null);
              engineActions.setSelectedAssetId(null);
            }}
            fileName={fileName}
            projectState={projectState} 
          />
        </div>
      )}

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
            deleteSelectedAsset={() => {
  deleteAsset(refs.viewerRef, engineState.selectedAssetId);
  engineActions.destroyStretchHandles();
  engineActions.setSelectedAssetId(null);
  engineActions.setSelectedObject(null);
}}
            projectState={projectState}
            engineState={engineState}
            engineActions={engineActions}
            adoptIsolatedAsset={adoptIsolatedAsset}
            updateStructuralEdit={updateStructuralEdit}
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
      
      {engineState.isLoading && (
        <div className="absolute inset-0 z-[200] flex flex-col items-center justify-center bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300">
          <div className="relative flex flex-col items-center">
            <div className="w-32 h-32 border-4 border-indigo-500/30 rounded-3xl flex items-center justify-center relative overflow-hidden shadow-[0_0_50px_rgba(99,102,241,0.3)] bg-slate-900/80">
              <div className="absolute top-0 left-0 w-full h-1 bg-cyan-400 shadow-[0_0_30px_rgba(34,211,238,1)]" style={{ animation: 'scan 1.5s ease-in-out infinite alternate' }} />
              <style>{`
                @keyframes scan {
                  0% { transform: translateY(0); }
                  100% { transform: translateY(128px); }
                }
              `}</style>
              <Hexagon className="w-14 h-14 text-indigo-400 animate-pulse" />
            </div>
            <h3 className="mt-8 text-2xl font-bold text-white tracking-wide drop-shadow-md">Recalculating Geometry</h3>
            <p className="mt-2 text-sm text-slate-300 font-medium max-w-sm text-center leading-relaxed">
              Applying structural edits and updating constraints...
            </p>
            <div className="flex items-center gap-2 mt-5 text-cyan-400">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-xs font-bold uppercase tracking-widest">Processing</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BIMViewer;