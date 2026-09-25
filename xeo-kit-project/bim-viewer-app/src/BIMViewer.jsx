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
import { MATERIAL_LIBRARY, COLOR_LIBRARY, FABRIC_LIBRARY, TEXTURE_LIBRARY } from './utils/materialCatalog';
import { clearNativeIFCMaterialOverride } from './utils/materialScene';
import { useCatalog } from './hooks/useCatalog';

const BIMViewer = ({ activeProject, onDelete, onAdd, onReplaceProject, onOpenSavedLayout, onSavedLayoutCreated }) => {
  const { file, jobId, fileName } = activeProject || {};
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [isMaxView, setIsMaxView] = useState(false);
  const [rightTab, setRightTab] = useState('properties');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showRenderStudio, setShowRenderStudio] = useState(false);
  const [isLayoutSaving, setIsLayoutSaving] = useState(false);
  const [lastClickPos, setLastClickPos] = useState({ x: 0, y: 0 });
  const [cameraProjection, setCameraProjection] = useState('perspective');
  const [savedCameraViews, setSavedCameraViews] = useState([]);
  const [wallSurfaceScope, setWallSurfaceScope] = useState('both');

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
    savedLayouts, savedLayoutsLoading, savedLayoutsError, saveRenderedLayout, updateSavedLayout, updateSavedLayoutSnapshot, deleteSavedLayout,
    toastMessage, customColor, applyMaterial, applyMaterialToAllWalls, applyMaterialDefinition, applyMaterialDefinitionToAllWalls, updateAsset,
    deleteAsset, spawnAsset, applyTemplate, setCustomColor, adoptIsolatedAsset,
    updateStructuralEdit, transformFurnitureForCalibration, repairLegacyCalibrationState, setToastMessage,
    undo, redo, canUndo, canRedo, beginHistoryTransaction, endHistoryTransaction, cancelHistoryTransaction
  } = useProjectSync(activeProject);

  const insertDoor = async (asset, wallSnapData) => {
    if (!file || !jobId) return;
    
    const { position, rotation, wallGlobalId } = wallSnapData;
    // Send the actual picked world point. The backend now owns the host-wall
    // frame and derives the wall-center/base position from the IFC itself.
    const doorSurfacePosition = [...position];
    const catalogAssetId = asset.catalogId ?? (
      typeof asset.id === 'string' && asset.id.startsWith('cat_')
        ? asset.id.slice(4)
        : asset.id
    );
    
    const doorDimsById = {
      'door_single': { width: 0.9, height: 2.1, thickness: 0.05 },
      'door_double': { width: 1.2, height: 2.1, thickness: 0.05 },
      'door_sliding': { width: 2.0, height: 2.1, thickness: 0.05 },
      'door_revolving': { width: 2.0, height: 2.1, thickness: 0.1 },
      'door_fire': { width: 1.0, height: 2.1, thickness: 0.06 },
      'door_3bhk': { width: 0.9, height: 2.1, thickness: 0.04 },
    };

    const doorName = String(asset.name || '').toLowerCase();
    const doorDims = doorDimsById[catalogAssetId] ||
      (doorName.includes('sliding')
        ? doorDimsById.door_sliding
        : doorName.includes('double')
          ? doorDimsById.door_double
          : doorName.includes('fire')
            ? doorDimsById.door_fire
            : doorName.includes('revolving')
              ? doorDimsById.door_revolving
              : doorName.includes('3bhk')
                ? doorDimsById.door_3bhk
                : doorDimsById.door_single);
    
    engineActions.setIsLoading(true);
    setToastMessage(`Cutting void in wall...`);
    
    try {
      const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      const response = await fetch(`${API_BASE_URL}/api/elements/${jobId}/${wallGlobalId}/insert-door`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          assetId: catalogAssetId,
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
      beginHistoryTransaction('Insert door');
      const wallEntity = refs.viewerRef.current?.scene.objects[wallGlobalId];
      clearNativeIFCMaterialOverride(refs.viewerRef.current, wallGlobalId);
      if (wallEntity) wallEntity.visible = false;
      updateStructuralEdit(wallGlobalId, 'visible', false, false);
      
      const modifiedWallId = `${wallGlobalId}_cut_${Date.now()}`;
      // IMPORTANT: do not load the full building IFC as a replacement wall model.
      // Each door insertion must add only the edited host wall; loading another full
      // building copy makes every subsequent pick ambiguous and causes wrong-wall hits.
      const previewWallUrl = data.previewFileUrl || data.fileUrl;
      await engineActions.loadIFCAssetIntoScene(modifiedWallId, previewWallUrl, null, null);
      adoptIsolatedAsset(wallGlobalId, modifiedWallId, previewWallUrl, 'Wall with Void', [0, 0, 0]);
      
      if (!data.doorPlacement) {
        throw new Error('Backend did not return doorPlacement check ifc_element_editor.py version.');
      }
      // Do not mutate the shared catalog asset object. A catalog item can be
      // reused for another wall later; hostWallId is placement-specific state.
      const placedDoorAsset = { ...asset, hostWallId: wallGlobalId };
      await spawnAsset(placedDoorAsset, data.doorPlacement.position, engineActions.loadIFCAssetIntoScene, data.doorPlacement.rotation);
      endHistoryTransaction();
      
    } catch (error) {
      console.error('[BIMViewer] Door insertion failed:', error);
      cancelHistoryTransaction();
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
    setRightTab,
    transformFurnitureForCalibration,
    repairLegacyCalibrationState,
    isDarkMode
  );

  useEffect(() => {
    const handleHistoryShortcut = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;

      const key = String(event.key || '').toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === 'y' && !event.shiftKey) {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleHistoryShortcut);
    return () => window.removeEventListener('keydown', handleHistoryShortcut);
  }, [undo, redo]);

  const {
    state: renderState, config: renderConfig, setRenderConfig, executeRender,
    setRenderResult, setRenderError, renderCurrentProject,
  } = useCloudRender(activeProject, projectStateRef);

  useEffect(() => {
    if (!jobId) {
      setSavedCameraViews([]);
      return;
    }
    try {
      const raw = window.localStorage.getItem(`hci-camera-views:${jobId}`);
      setSavedCameraViews(raw ? JSON.parse(raw) : []);
    } catch (error) {
      console.warn('[BIMViewer] Unable to restore saved camera views.', error);
      setSavedCameraViews([]);
    }
  }, [jobId]);

  const persistSavedCameraViews = (views) => {
    setSavedCameraViews(views);
    if (!jobId) return;
    try {
      window.localStorage.setItem(`hci-camera-views:${jobId}`, JSON.stringify(views));
    } catch (error) {
      console.warn('[BIMViewer] Unable to persist saved camera views.', error);
    }
  };

  const saveCameraView = (name) => {
    const snapshot = engineActions.camera.snapshot();
    if (!snapshot) return;
    const view = { id: `view_${Date.now()}`, name, snapshot };
    persistSavedCameraViews([...savedCameraViews, view].slice(-12));
  };

  const restoreCameraView = (id) => {
    const view = savedCameraViews.find((item) => item.id === id);
    if (!view) return;
    engineActions.camera.restore(view.snapshot);
    setCameraProjection(view.snapshot.projection || 'perspective');
  };

  const deleteCameraView = (id) => {
    persistSavedCameraViews(savedCameraViews.filter((item) => item.id !== id));
  };

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

  const getSelectionTargets = () => {
    const records = Array.isArray(engineState.selectedElements)
      ? engineState.selectedElements.filter(item => item?.id && item.id !== '__multi_selection__')
      : [];

    if (records.length) return records;

    if (engineState.selectedAssetId) {
      return [{
        id: engineState.selectedAssetId,
        isAsset: true,
        isWall: false,
        type: '3D Asset',
      }];
    }

    if (engineState.selectedObject?.id && engineState.selectedObject.id !== '__multi_selection__') {
      return [engineState.selectedObject];
    }

    return [];
  };

  const applyMaterialToSelection = (materialDefinition, surfaceScope = wallSurfaceScope, label = 'Apply material') => {
    const targets = getSelectionTargets();
    if (!targets.length || !materialDefinition) return 0;

    const applyToTarget = (target) => {
      if (!target?.id) return 0;
      const isWall = target.isWall || String(target.type || '').toLowerCase().includes('ifcwall');
      const definition = {
        ...materialDefinition,
        surfaceScope: isWall ? surfaceScope : undefined,
      };
      return applyMaterialDefinition(refs.viewerRef, target, definition);
    };

    if (targets.length === 1) return applyToTarget(targets[0]);

    beginHistoryTransaction(label);
    try {
      const count = targets.reduce((total, target) => total + applyToTarget(target), 0);
      endHistoryTransaction();
      return count;
    } catch (error) {
      cancelHistoryTransaction();
      throw error;
    }
  };

  const applyColorToSelection = (hex, surfaceScope = wallSurfaceScope) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return 0;

    const r = parseInt(hex.substring(1, 3), 16) / 255;
    const g = parseInt(hex.substring(3, 5), 16) / 255;
    const b = parseInt(hex.substring(5, 7), 16) / 255;
    const targets = getSelectionTargets();
    if (!targets.length) return 0;

    const count = applyMaterialToSelection(
      { kind: 'color', color: hex, rgb: [r, g, b] },
      surfaceScope,
      targets.length > 1 ? `Apply color to ${targets.length} elements` : 'Apply color',
    );

    if (setCustomColor) setCustomColor(hex);
    return count;
  };

  const handleCustomColorChange = (e, surfaceScope = wallSurfaceScope) => {
    applyColorToSelection(e.target.value, surfaceScope);
  };

  const handleApplyColorToAllWalls = (hexColor = customColor, surfaceScope = wallSurfaceScope) => {
    if (!hexColor || !/^#[0-9a-fA-F]{6}$/.test(hexColor)) return;
    const r = parseInt(hexColor.substring(1, 3), 16) / 255;
    const g = parseInt(hexColor.substring(3, 5), 16) / 255;
    const b = parseInt(hexColor.substring(5, 7), 16) / 255;
    const count = applyMaterialToAllWalls(refs.viewerRef, hexColor, [r, g, b], surfaceScope);
    if (count > 0) {
      setToastMessage(`Applied color to ${count} wall${count === 1 ? '' : 's'}.`);
      setTimeout(() => setToastMessage(null), 2200);
    } else {
      setToastMessage('No native walls found in this scene.');
      setTimeout(() => setToastMessage(null), 2200);
    }
    return count;
  };

  const selectionTargets = getSelectionTargets();
  const firstSelectedMaterial = selectionTargets.length === 1
    ? projectState.materials?.[selectionTargets[0].id] || null
    : null;
  const selectedMaterial = firstSelectedMaterial || null;

  const applyLibraryMaterial = (material, surfaceScope = wallSurfaceScope) => {
    if (!material) return;

    const targets = getSelectionTargets();
    if (!targets.length) return;

    const count = applyMaterialToSelection(
      { ...material },
      surfaceScope,
      targets.length > 1 ? `Apply ${material.name} to selection` : `Apply ${material.name}`,
    );

    setToastMessage(
      targets.length > 1
        ? `${material.name} applied to ${count} selected element${count === 1 ? '' : 's'}.`
        : `${material.name} applied.`
    );
    setTimeout(() => setToastMessage(null), 1800);
  };
  const applyLibraryMaterialToAllWalls = (material = null, surfaceScope = wallSurfaceScope) => {
    if (!material) return;
    const count = applyMaterialDefinitionToAllWalls(refs.viewerRef, { ...material, surfaceScope });
    setToastMessage(count ? `${material.name} applied to ${count} walls.` : 'No native walls found in this scene.');
    setTimeout(() => setToastMessage(null), 2200);
  };


  const activeAsset = engineState.selectedAssetId && refs.viewerRef.current
    ? refs.viewerRef.current.scene.models[engineState.selectedAssetId]
    : null;

  const activeSavedLayout = activeProject?.savedLayoutId
    ? savedLayouts.find((layout) => layout.id === activeProject.savedLayoutId || layout.renderJobId === activeProject.savedLayoutId) || {
        id: activeProject.savedLayoutId,
        renderJobId: activeProject.savedLayoutId,
        name: activeProject.savedLayoutName || 'Saved Layout',
        categoryName: '',
        subCategory: '',
      }
    : null;

  const handleDeleteSelection = () => {
    const targets = getSelectionTargets();
    if (!targets.length) return 0;

    const multi = targets.length > 1;
    beginHistoryTransaction(multi ? `Delete ${targets.length} selected elements` : 'Delete element');
    try {
      targets.forEach(target => {
        if (!target?.id) return;

        if (target.isAsset) {
          deleteAsset(refs.viewerRef, target.id, { silent: true });
          return;
        }

        clearNativeIFCMaterialOverride(refs.viewerRef.current, target.id);
        updateStructuralEdit(target.id, 'visible', false, false);
        const nativeEntity = refs.viewerRef.current?.scene?.objects?.[target.id];
        if (nativeEntity) nativeEntity.visible = false;
      });

      endHistoryTransaction();
      engineActions.destroyStretchHandles();
      engineActions.clearSelection();

      setToastMessage(
        multi
          ? `${targets.length} elements deleted.`
          : 'Element deleted.'
      );
      setTimeout(() => setToastMessage(null), 2200);
      return targets.length;
    } catch (error) {
      cancelHistoryTransaction();
      throw error;
    }
  };

  useEffect(() => {
    const handleSelectionDeleteKey = (event) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (!getSelectionTargets().length) return;

      event.preventDefault();
      try {
        handleDeleteSelection();
      } catch (error) {
        console.error('[BIMViewer] Selection delete failed:', error);
      }
    };

    window.addEventListener('keydown', handleSelectionDeleteKey);
    return () => window.removeEventListener('keydown', handleSelectionDeleteKey);
  }, [engineState.selectedElements, engineState.selectedAssetId, engineState.selectedObject]);

  useEffect(() => {
    setWallSurfaceScope('both');
  }, [engineState.selectedObject?.id, engineState.selectedAssetId]);

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
        await spawnAsset(asset, worldPos, engineActions.loadIFCAssetIntoScene);
      }
      setIsRightPanelOpen(true);
      setRightTab('properties');
    } catch (error) {
      console.error('[BIMViewer] Error processing drop event:', error);
    }
  };

  const handleSaveAsLayout = async (metadata, renderResult, renderConfig) => {
    const savedLayout = await saveRenderedLayout(metadata, renderResult, renderConfig);
    setToastMessage(`Saved “${savedLayout.name}” to Layouts.`);
    setTimeout(() => setToastMessage(null), 2200);
    return savedLayout;
  };

  const handleUpdateSavedLayoutSnapshot = async (layoutId, renderResult, renderConfig) => {
    const updatedLayout = await updateSavedLayoutSnapshot(layoutId, renderResult, renderConfig);
    setToastMessage(`Updated “${updatedLayout.name}” in Layouts.`);
    setTimeout(() => setToastMessage(null), 2200);
    return updatedLayout;
  };

  const handleSaveLayout = async (metadata = null) => {
    if (!file || !jobId || isLayoutSaving) return null;

    const savingExistingLayout = !!activeSavedLayout?.id;
    if (!savingExistingLayout && !metadata) return null;

    setIsLayoutSaving(true);
    setToastMessage(savingExistingLayout ? `Saving “${activeSavedLayout.name}”…` : 'Creating saved layout…');

    try {
      // The project state is already auto-saved. The manual Layout action only
      // needs to produce the latest compiled snapshot + thumbnail, without
      // opening Render Studio or requiring the user to configure a render.
      const silentRenderResult = await renderCurrentProject();

      if (savingExistingLayout) {
        const updatedLayout = await updateSavedLayoutSnapshot(
          activeSavedLayout.id,
          silentRenderResult,
          silentRenderResult.renderConfig || renderConfig,
        );
        setToastMessage(`Layout “${updatedLayout.name}” saved.`);
        setTimeout(() => setToastMessage(null), 2200);
        return updatedLayout;
      }

      const savedLayout = await saveRenderedLayout(
        metadata,
        silentRenderResult,
        silentRenderResult.renderConfig || renderConfig,
      );

      // Associate the active workspace with the newly-created saved layout so
      // the same Save Layout button becomes Update Layout on the next click.
      onSavedLayoutCreated?.(savedLayout);
      setToastMessage(`Layout “${savedLayout.name}” saved.`);
      setTimeout(() => setToastMessage(null), 2200);
      return savedLayout;
    } catch (error) {
      console.error('[BIMViewer] Save layout failed:', error);
      setToastMessage(error?.message || 'Failed to save layout.');
      setTimeout(() => setToastMessage(null), 3200);
      return null;
    } finally {
      setIsLayoutSaving(false);
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


  const handleOpenSaveLayout = () => {
    setRenderConfig((previous) => ({ ...previous, type: '360' }));
    setShowRenderStudio(true);
  };

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
          transformMode={engineState.transformMode}
          onMeasure={() => engineActions.toggleMeasurementMode()}
          onClip={() => engineActions.toggleClipping()}
          onMaxView={toggleMaxView}
          onFullscreen={toggleBrowserFullscreen}
          projection={cameraProjection}
          onFocus={() => engineActions.camera.focusSelected()}
          onCameraPreset={(preset) => {
            engineActions.camera.preset(preset);
            setCameraProjection(preset === 'top' ? 'ortho' : 'perspective');
          }}
          onProjection={(projection) => {
            engineActions.camera.setProjection(projection);
            setCameraProjection(projection);
          }}
          onFit={() => engineActions.camera.fitScene()}
          savedViews={savedCameraViews}
          onSaveView={saveCameraView}
          onRestoreView={restoreCameraView}
          onDeleteView={deleteCameraView}
          onResetCamera={() => engineActions.camera.reset()}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
          onSaveLayout={handleOpenSaveLayout}
          />
        </>
      )}

      <div 
        ref={tooltipRef}
        className="fixed z-[999] pointer-events-none hidden px-3 py-2 bg-slate-900/95 backdrop-blur-xl border border-slate-700/50 rounded-xl shadow-2xl transition-opacity duration-75 text-xs font-mono"
        style={{ top: 0, left: 0, willChange: 'transform' }}
      />
      
      {/* TOOLTIP OVERLAY FOR STRETCHING */}
      {!showRenderStudio && engineState.activeStretchData && (
        <StretchTooltipOverlay 
          visible={true}
          x={engineState.activeStretchData.x}
          y={engineState.activeStretchData.y}
          label={engineState.activeStretchData.label}
        />
      )}
      {/* TOOLTIP OVERLAY FOR EDITING */}
      {!showRenderStudio && (engineState.selectedAssetId || engineState.selectedObject) && !engineState.isStretching && (
        <TransformModeTooltip
          mode={engineState.transformMode}
          onModeChange={engineActions.setTransformMode}
          resizeSubmode={engineState.resizeSubmode}
          onResizeSubmodeChange={engineActions.setResizeSubmode}
          assetName={activeAsset?.name || engineState.selectedObject?.name || 'Selected element'}
          anchorX={lastClickPos.x}
          anchorY={lastClickPos.y}
          isNative={!!engineState.selectedObject && !activeAsset}
          selectedElements={engineState.selectedElements}
          selectionCount={engineState.selectedElements?.length || 1}
          isMultiSelection={(engineState.selectedElements?.length || 0) > 1}
          multiSelectMode={engineState.multiSelectMode}
          onToggleMultiSelect={engineActions.toggleMultiSelectMode}
          isDarkMode={isDarkMode}
          onIsolate={async () => {
            if (!engineState.selectedObject || activeAsset) return;

            beginHistoryTransaction('Unlock element');
            try {
              await engineActions.isolateAndMakeMoveable(
                engineState.selectedObject.id,
                adoptIsolatedAsset,
                updateStructuralEdit
              );
              endHistoryTransaction();
              setToastMessage('Element unlocked for editing.');
              setTimeout(() => setToastMessage(null), 2200);
            } catch (error) {
              console.error('[BIMViewer] Native unlock failed:', error);
              cancelHistoryTransaction();
              setToastMessage(error?.message || 'Could not unlock this IFC element.');
              setTimeout(() => setToastMessage(null), 3500);
            }
          }}
          materialLibrary={MATERIAL_LIBRARY}
          selectedMaterial={selectedMaterial}
          onMaterialSelect={applyLibraryMaterial}
          canApplyToAllWalls={!!engineState.selectedObject && String(engineState.selectedObject.type || '').toLowerCase().includes('ifcwall')}
          wallSurfaceScope={wallSurfaceScope}
          onWallSurfaceScopeChange={setWallSurfaceScope}
          onApplyMaterialToAllWalls={applyLibraryMaterialToAllWalls}
          onColorChange={(hex, surfaceScope = wallSurfaceScope) => {
            applyColorToSelection(hex, surfaceScope);
          }}
          currentColor={customColor}
          onDelete={handleDeleteSelection}
        />
      )}
      
      {isLayoutSaving && (
        <div className="absolute inset-0 z-[180] flex items-center justify-center bg-slate-950/30 backdrop-blur-[1px] pointer-events-auto">
          <div className="flex items-center gap-3 rounded-2xl border border-white/15 bg-slate-900/90 px-5 py-3 text-white shadow-2xl">
            <Loader2 className="h-4 w-4 animate-spin text-[#ff914d]" />
            <div>
              <p className="text-xs font-bold">Saving Layout…</p>
              <p className="mt-0.5 text-[10px] text-slate-400">Compiling the latest 3D snapshot and thumbnail.</p>
            </div>
          </div>
        </div>
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
        <div className="absolute top-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-5 py-2.5 bg-[#ff914d] text-white rounded-full shadow-lg animate-in slide-in-from-top-2 fade-in duration-200">
          <MousePointerClick className="w-4 h-4 animate-pulse" />
          <span className="font-semibold text-sm">
            Click canvas to place {engineState.placementMode.name}
          </span>
          <button onClick={() => engineActions.setPlacementMode(null)} className="ml-1 hover:bg-[#ff7a28] p-1 rounded-full cursor-pointer">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {engineState.isMeasuring && engineState.measurementHover && (
        <div
          className="absolute z-50 pointer-events-none px-2 py-1 rounded-md bg-slate-950/90 text-white text-[10px] font-bold shadow-lg border border-white/10"
          style={{ left: `${engineState.measurementHover.x + 14}px`, top: `${engineState.measurementHover.y + 14}px` }}
        >
          <span className={engineState.measurementHover.snapped ? 'text-cyan-300' : 'text-slate-200'}>
            {engineState.measurementHover.snapType}
          </span>
          {engineState.measurementHover.snapped && <span className="ml-1 text-slate-400">SNAP</span>}
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
          measurementPhase={engineState.measurementPhase}
          measurementMode={engineState.measurementMode}
          setMeasurementMode={engineActions.setMeasurementMode}
          orthogonalConstraint={engineState.orthogonalConstraint}
          setOrthogonalConstraint={engineActions.setOrthogonalConstraint}
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
            savedLayouts={savedLayouts}
            savedLayoutsLoading={savedLayoutsLoading}
            savedLayoutsError={savedLayoutsError}
            onOpenSavedLayout={onOpenSavedLayout}
            onEditSavedLayout={updateSavedLayout}
            onDeleteSavedLayout={deleteSavedLayout}
            fileNameForLayoutMetadata={fileName}
            activeSavedLayout={activeSavedLayout}
            onSelectLayout={onReplaceProject}
            onApplyTemplate={(templateId) => applyTemplate(templateId, engineActions.loadIFCAssetIntoScene)}
            placementMode={engineState.placementMode}
            setPlacementMode={engineActions.setPlacementMode}
            resetSelection={() => {
              engineActions.clearSelection();
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
            selectedElements={engineState.selectedElements}
            multiSelectMode={engineState.multiSelectMode}
            onToggleMultiSelect={engineActions.toggleMultiSelectMode}
            onClearSelection={engineActions.clearSelection}
            activeAsset={activeAsset}
            selectedAssetId={engineState.selectedAssetId}
            customColor={customColor}
            handleCustomColorChange={handleCustomColorChange}
            onApplyToAllWalls={handleApplyColorToAllWalls}
            materialLibrary={MATERIAL_LIBRARY}
            selectedMaterial={selectedMaterial}
            onApplyMaterial={applyLibraryMaterial}
            onApplyMaterialToAllWalls={applyLibraryMaterialToAllWalls}
            updateSelectedAsset={(axis, val, rot) =>
              updateAsset(refs.viewerRef, engineState.selectedAssetId, axis, val, rot)
            }
            deleteSelectedAsset={() => {
  deleteAsset(refs.viewerRef, engineState.selectedAssetId);
  engineActions.destroyStretchHandles();
  engineActions.clearSelection();
}}
            onDeleteSelected={handleDeleteSelection}
            projectState={projectState}
            engineState={engineState}
            engineActions={engineActions}
            adoptIsolatedAsset={adoptIsolatedAsset}
            updateStructuralEdit={updateStructuralEdit}
            onDeleteProject={onDelete}
            isDarkMode={isDarkMode}
            toggleTheme={toggleTheme}
            activeSavedLayout={activeSavedLayout}
            onSaveLayout={handleSaveLayout}
            isLayoutSaving={isLayoutSaving}
            fileNameForLayoutMetadata={fileName}
            existingSavedLayouts={savedLayouts}
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
        onSaveAsLayout={handleSaveAsLayout}
        onUpdateSavedLayoutSnapshot={handleUpdateSavedLayoutSnapshot}
        currentSavedLayout={savedLayouts.find((layout) => layout.id === activeProject?.savedLayoutId) || null}
        activeFileName={fileName}
        existingSavedLayouts={savedLayouts}
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
              <div className="rounded-xl bg-white/95 px-2 py-1.5 shadow-lg"><img src="/hci-logo.svg" alt="High Creation Interiors" className="hci-logo-badge hci-logo-badge--processing animate-pulse" /></div>
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