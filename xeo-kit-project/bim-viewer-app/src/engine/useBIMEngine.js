import { useEffect, useRef, useState } from 'react';
import { Viewer } from '@xeokit/xeokit-sdk/src/viewer/Viewer';
import { XKTLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/XKTLoaderPlugin/XKTLoaderPlugin';
import { GLTFLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/GLTFLoaderPlugin/GLTFLoaderPlugin';
import { WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/WebIFCLoaderPlugin/WebIFCLoaderPlugin';
import { TreeViewPlugin } from '@xeokit/xeokit-sdk/src/plugins/TreeViewPlugin/TreeViewPlugin';
import { NavCubePlugin } from '@xeokit/xeokit-sdk/src/plugins/NavCubePlugin/NavCubePlugin';
import { SectionPlanesPlugin } from '@xeokit/xeokit-sdk/src/plugins/SectionPlanesPlugin/SectionPlanesPlugin';
import { DistanceMeasurementsPlugin } from '@xeokit/xeokit-sdk/src/plugins/DistanceMeasurementsPlugin/DistanceMeasurementsPlugin';
import { DistanceMeasurementsMouseControl } from '@xeokit/xeokit-sdk/src/plugins/DistanceMeasurementsPlugin/DistanceMeasurementsMouseControl';
import * as WebIFC from 'web-ifc';

import { API_BASE_URL, AXIS_HANDLE_COLORS, STRETCH_HANDLE_DRAG_SCALE, STRETCH_HANDLE_HOVER_SCALE } from './utils/constants';
import { brightenColor } from './utils/helpers';
import { animateHandleTo, buildStretchHandles, destroyStretchHandles, hideRevealedGroup, revealGroupForFace } from './stretch/StretchHandles';
import { applyScale, cursorForAxes, resetHoveredStretchHandle } from './stretch/StretchController';
import { toggleMeasurementMode, clearMeasurements, syncMeasurementsList, deleteMeasurement, flyToMeasurement, toggleSnapping, toggleAxisBreakdown, formatLength, cancelActiveMeasurement, applyMeasurementUnitToPlugin, MEASUREMENT_MODES, ORTHOGONAL_CONSTRAINTS, pickMeasurementReference, createProgrammaticDistanceMeasurement } from './measurements/MeasurementController';
import { scaleModelByMeasurement, calibrateWallHeight } from './calibration/CalibrationController';
import { getDropPosition, getWallSnapData, getCursorWorldPosition } from './placement/PlacementController';
import { loadIFCAssetIntoScene, isolateAndMakeMoveable, inspectNativeElement, updateStructuralTransform, updateNativeOffset, updateDynamicTransform } from './assets/AssetManager';
import { calculateGrabPoint } from './stretch/TranslationController';
import { CameraManager } from './CameraManager';

const getNavCubeTheme = (isDarkMode) => ({
  color: isDarkMode ? '#1a2435' : '#eef2f7',
  frontColor: isDarkMode ? '#202d40' : '#ffffff',
  backColor: isDarkMode ? '#1a2435' : '#eef2f7',
  leftColor: isDarkMode ? '#152033' : '#e2e8f0',
  rightColor: isDarkMode ? '#152033' : '#e2e8f0',
  topColor: isDarkMode ? '#26364b' : '#f8fafc',
  bottomColor: isDarkMode ? '#152033' : '#e2e8f0',
  hoverColor: 'rgba(255,145,77,0.45)',
});


export const useBIMEngine = (activeProject, projectStateRef, projectState, onAssetPlaced, setIsRightPanelOpen, setRightTab, transformFurnitureForCalibration, repairLegacyCalibrationState, isDarkMode = true) => {
  const { file, jobId, fileName } = activeProject || {};

  const canvasRef = useRef(null);
  const treeContainerRef = useRef(null);
  const navCubeCanvasRef = useRef(null);
  const navCubeRef = useRef(null);
  const viewerRef = useRef(null);
  const loadersRef = useRef({});
  const ifcLoaderOwnerRef = useRef(null);
  const sectionPlanesRef = useRef(null);
  const currentModelRef = useRef(null);
  const currentPlaneRef = useRef(null);
  const measurementsPluginRef = useRef(null);
  const measurementControlRef = useRef(null);
  const isMeasuringRef = useRef(false);
  const [measurementPhase, setMeasurementPhase] = useState('idle');
  const globalScaleFactorRef = useRef({ x: 1, y: 1, z: 1 });
  
  // NEW: Concurrency lock for async asset loading to prevent duplication
  const loadingModelsRef = useRef(new Set());
  const legacyCalibrationRepairInFlightRef = useRef(false);

  // Hard rendering boundary lock
  const isModelLoadedRef = useRef(false);
  // Prevent stale async FileReader/loader work from creating duplicate main models.
  // React StrictMode intentionally mounts effects twice in development; without
  // a generation guard both readers can finish and both can create
  // `main_structure`, leaving two copies of the IFC in the viewer.
  const mainLoadGenerationRef = useRef(0);

  const [sceneScaleFactor, setSceneScaleFactor] = useState({ x: 1, y: 1, z: 1 });
  const [isLoading, setIsLoading] = useState(false);
  const [isXRay, setIsXRay] = useState(false);
  const [isClipping, setIsClipping] = useState(false);
  const [navMode, setNavMode] = useState('orbit');
  const cameraManagerRef = useRef(null);
  const [selectedObject, setSelectedObject] = useState(null);
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const selectedAssetIdRef = useRef(null);
  const setSelectedAssetIdSafe = (id) => {
    selectedAssetIdRef.current = id ?? null;
    setSelectedAssetId(id ?? null);
  };
  const [placementMode, setPlacementMode] = useState(null);
  const placementModeRef = useRef(null);

  const stretchHandlesRef = useRef([]);
  const selectionCageRef = useRef(null);
  const hoveredStretchMeshRef = useRef(null);
  const stretchDragRef = useRef(null);
  const isStretchingRef = useRef(false);
  const stretchPersistCallbackRef = useRef(null);
  const stretchFaceAdjacencyRef = useRef(new Map());
  const revealedFaceKeyRef = useRef(null);
  const revealedHandlesRef = useRef([]);
  const activeResizeFaceKeyRef = useRef(null);
  const stretchAnimFramesRef = useRef(new Set());
  const hideTimeoutRef = useRef(null);
  const [isStretching, setIsStretching] = useState(false);
  const [activeStretchData, setActiveStretchData] = useState(null);
  const [transformMode, setTransformMode] = useState('move');
  const transformModeRef = useRef('move');
  const [resizeSubmode, setResizeSubmode] = useState('face');
  const resizeSubmodeRef = useRef('face');
  const buildStretchHandlesRef = useRef(null);
  const destroyStretchHandlesRef = useRef(null);
  
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [measurementsList, setMeasurementsList] = useState([]); 
  const [measurementMode, setMeasurementMode] = useState('point');
  const measurementModeRef = useRef('point');
  const [orthogonalConstraint, setOrthogonalConstraint] = useState('horizontal');
  const orthogonalConstraintRef = useRef('horizontal');
  const pointMeasurementOriginRef = useRef(null);
  const pointMeasurementPreviewRef = useRef(null);
  const pointMeasurementPreviewIdRef = useRef(`hci_measurement_preview_${Math.random().toString(36).slice(2)}`);
  const [measurementHover, setMeasurementHover] = useState(null);
  const [measurementUnit, setMeasurementUnit] = useState('m');
  const measurementUnitRef = useRef('m');
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const snappingEnabledRef = useRef(true);
  const [axisBreakdownVisible, setAxisBreakdownVisible] = useState(false);
  const [measurementDisplayMode, setMeasurementDisplayMode] = useState('distance');

  useEffect(() => {
    snappingEnabledRef.current = snappingEnabled;
  }, [snappingEnabled]);

  useEffect(() => {
    measurementUnitRef.current = measurementUnit;
    applyMeasurementUnitToPlugin(measurementsPluginRef, measurementUnit);
  }, [measurementUnit]);

  const stretchCtx = {
    viewerRef, stretchHandlesRef, selectionCageRef, stretchFaceAdjacencyRef,
    revealedFaceKeyRef, revealedHandlesRef, stretchAnimFramesRef,
    hoveredStretchMeshRef, activeResizeFaceKeyRef, canvasRef
  };

  const measureOriginalProjectCenter = async () => {
    if (!activeProject?.jobId || !loadersRef.current.ifc) return null;
    const tempId = `__hci_original_reference_${Date.now()}`;
    try {
      const res = await fetch(`${API_BASE_URL}/jobs/${encodeURIComponent(activeProject.jobId)}/original.ifc?v=${Date.now()}`);
      if (!res.ok) return null;
      const buffer = await res.arrayBuffer();
      const model = loadersRef.current.ifc.load({
        id: tempId,
        ifc: new Uint8Array(buffer),
        edges: false,
        globalizeCoordinates: false,
      });
      return await new Promise((resolve) => {
        model.on('loaded', () => {
          const aabb = model.aabb;
          const center = aabb && aabb.length >= 6
            ? [(aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2]
            : null;
          try { model.destroy(); } catch (_) {}
          resolve(center);
        });
        model.on('error', () => {
          try { model.destroy(); } catch (_) {}
          resolve(null);
        });
      });
    } catch (error) {
      console.warn('[Calibration] Unable to inspect original IFC for legacy-state repair.', error);
      return null;
    }
  };


  const snapshotFurnitureMatrices = () => {
    const snapshot = {};
    const state = projectStateRef.current || {};
    (state.furniture || []).forEach(item => {
      const model = item?.instanceId ? viewerRef.current?.scene?.models?.[item.instanceId] : null;
      if (model?.matrix && model.matrix.length === 16) snapshot[item.instanceId] = Array.from(model.matrix);
    });
    return snapshot;
  };

  const restoreProjectStateToScene = (stateOverride) => {
    if (!viewerRef.current || !currentModelRef.current) return Promise.resolve([]);
    const state = stateOverride || projectStateRef.current;
    if (!state) return Promise.resolve([]);

    // Hydrate the cumulative scene calibration from persisted project state.
    // This is display/scene metadata only; furniture.scale is already stored in
    // the current scene frame and must NOT be multiplied by this value on restore.
    const persistedScale = state.scene_calibration?.scaleFactor;
    if (persistedScale &&
        Number.isFinite(persistedScale.x) && Number.isFinite(persistedScale.y) && Number.isFinite(persistedScale.z) &&
        persistedScale.x > 0 && persistedScale.y > 0 && persistedScale.z > 0) {
      globalScaleFactorRef.current = {
        x: persistedScale.x,
        y: persistedScale.y,
        z: persistedScale.z,
      };
      setSceneScaleFactor({ ...globalScaleFactorRef.current });
    }

    const legacyState = !state.scene_calibration?.migratedToFrameScale
      && (state.furniture || []).some(item => Array.isArray(item.calibrationSourceScale))
      && (() => {
        const s = state.scene_calibration?.scaleFactor;
        return s && [s.x, s.y, s.z].every(Number.isFinite) && [s.x, s.y, s.z].some(v => Math.abs(v - 1) > 1e-9);
      })();

    if (legacyState && !legacyCalibrationRepairInFlightRef.current) {
      legacyCalibrationRepairInFlightRef.current = true;
      const currentCenter = currentModelRef.current?.aabb;
      const newCenter = currentCenter && currentCenter.length >= 6
        ? [(currentCenter[0] + currentCenter[3]) / 2, (currentCenter[1] + currentCenter[4]) / 2, (currentCenter[2] + currentCenter[5]) / 2]
        : null;
      measureOriginalProjectCenter().then(oldCenter => {
        if (oldCenter && newCenter && repairLegacyCalibrationState) {
          return repairLegacyCalibrationState(oldCenter, newCenter);
        }
        return null;
      }).finally(() => {
        legacyCalibrationRepairInFlightRef.current = false;
      });
      return Promise.resolve([]);
    }

    if (state.materials) {
      Object.entries(state.materials).forEach(([targetId, matData]) => {
        const entity = viewerRef.current.scene.objects[targetId];
        
        // DEVELOPMENT LOG: Verify exactly what we are applying to and if it exists
        console.log('[Material][RESTORE]', {
          targetId,
          directMatch: !!entity,
          modelMatch: false 
        });

        if (entity) {
          entity.colorize = matData.rgb;
        } else {
          let matched = false;
          Object.values(viewerRef.current.scene.objects || {}).forEach(object => {
            if (object.model?.id === targetId) {
              object.colorize = matData.rgb;
              matched = true;
            }
          });
          
          if (matched) {
            console.log('[Material][RESTORE]', {
              targetId,
              directMatch: false,
              modelMatch: true
            });
          } else {
            const availableMatchingIds = Object.keys(viewerRef.current.scene.objects)
              .filter(id => id.includes(targetId.split('#').pop()))
              .slice(0, 5);
              
            console.log('[Material][MISS]', {
              targetId,
              availableMatchingIds
            });
          }
        }
      });
    }

    // Reconstruct the exact model matrix after an asset/isolation finishes loading.
  // Resize writes model.matrix directly (the authoritative Xeokit transform).
  // SceneModel.matrix overrides position/rotation/scale setters, so restoring only
  // item.scale would not reliably restore the persisted resize.
  const applyPersistedModelMatrix = (model, item) => {
    if (!model || !item) return;

    if (Array.isArray(item.matrix) && item.matrix.length === 16 && item.matrix.every(Number.isFinite)) {
      model.matrix = Array.from(item.matrix);
      return;
    }

    const position = item.isNativeIsolation
      ? (Array.isArray(item.position) ? [...item.position] : [0, 0, 0])
      : (Array.isArray(model.position) && model.position.length === 3
        ? [...model.position]
        : (Array.isArray(item.position) ? [...item.position] : [0, 0, 0]));
    const rotation = Array.isArray(item.rotation) && item.rotation.length === 3
      ? item.rotation
      : [0, 0, 0];
    const scale = Array.isArray(item.scale) && item.scale.length === 3
      ? item.scale
      : [1, 1, 1];

    const ry = (rotation[1] || 0) * Math.PI / 180;
    const c = Math.cos(ry);
    const s = Math.sin(ry);

    model.matrix = [
      scale[0] * c, 0, -scale[0] * s, 0,
      0, scale[1], 0, 0,
      scale[2] * s, 0, scale[2] * c, 0,
      position[0], position[1], position[2], 1,
    ];
  };

  const applyPersistedMaterialToModel = (model, item, state) => {
    if (!model || !state?.materials) return;
    const material = state.materials[item.instanceId] || state.materials[item.nativeSourceId];
    if (!Array.isArray(material?.rgb)) return;
    Object.values(viewerRef.current?.scene?.objects || {}).forEach(object => {
      if (object?.model?.id === model.id) {
        try { object.colorize = material.rgb; } catch (_) {}
      }
    });
  };


  // Restore native IFC edits FIRST, before loading any isolated IFC assets.
    //
    // An isolated IFC contains the same GlobalId as its native source. If the
    // isolated model is loaded first, xeokit may replace/override the object
    // accessible from scene.objects[entityId], making it impossible to reliably
    // hide the original native geometry. That was the exact reload regression:
    // the editable/stretched isolation existed, but the original wall remained
    // visible underneath it.
    //
    // The original main IFC is guaranteed to be available here because this
    // function is only called from the main model's `loaded` callback.
    if (state.structural_edits) {
      Object.entries(state.structural_edits).forEach(([entityId, edit]) => {
        const entity = currentModelRef.current
          ? Object.values(viewerRef.current.scene.objects || {})
              .find(object => object?.id === entityId && object.model === currentModelRef.current)
          : null;

        if (!entity) {
          console.warn('[NativeEdit][RESTORE] Original native entity not found in main model:', {
            entityId,
            mainModelId: currentModelRef.current?.id || null,
          });
          return;
        }

        if (edit.scale) {
          try { entity.scale = edit.scale; } catch (error) {
            console.warn('[NativeEdit][RESTORE] Ignoring unsupported native scale:', entityId, error);
          }
        }

        if (edit.visible === false) {
          try {
            entity.visible = false;
            console.info('[NativeEdit][RESTORE] Hid original native entity before isolation load:', {
              entityId,
              mainModelId: currentModelRef.current?.id || null,
            });
          } catch (error) {
            console.warn('[NativeEdit][RESTORE] Failed to hide original native entity:', entityId, error);
          }
        }
      });
    }

    // Now restore separately loaded editable assets. Any native isolation has
    // already had its source geometry hidden above, so a duplicate GlobalId in
    // the isolated IFC cannot visually resurrect the original native element.
    const restorePromises = [];
    if (state.furniture) {
      state.furniture.forEach(item => {
        if (!item?.instanceId || !item?.src) return;

        // A furniture/ghost model can be created by a live user action (for
        // example Unlock/Isolate) and then immediately added to projectState.
        // The projectState effect will run again after that state update. Never
        // create a second xeokit model for an instance that already exists or
        // is currently being loaded.
        if (viewerRef.current.scene.models[item.instanceId]) return;
        if (loadingModelsRef.current.has(item.instanceId)) return;

        loadingModelsRef.current.add(item.instanceId);

        const isNativeIsolation = !!item.isNativeIsolation;

        // Native-isolated IFCs already contain the element in its original
        // IFC/world coordinate space. Passing item.position as targetPosition
        // would run the generic AABB-to-floor placement correction and move the
        // isolated wall. Load these at model origin, then restore their model
        // transform exactly as persisted.
        const hasPersistedMatrix = Array.isArray(item.matrix) && item.matrix.length === 16;
        const targetPosition = (isNativeIsolation || hasPersistedMatrix) ? null : (item.position || [0, 0, 0]);

        const restorePromise = loadIFCAssetIntoScene(
          loadersRef,
          globalScaleFactorRef,
          item.instanceId,
          item.src,
          targetPosition,
          item.rotation || [0, 0, 0],
          {
            fileType: item.fileType || item.file_type,
            scale: item.scale || [1, 1, 1],
            nativeSourceId: item.nativeSourceId || item.id || null,
            isNativeIsolation,
            onLoaded: (model) => {
              // Matrix is the authoritative authored transform once present.
              // Legacy records fall back to the proven target-position + TRS path.
              applyPersistedModelMatrix(model, item);
              applyPersistedMaterialToModel(model, item, state);
            },
          }
        ).then((model) => {
          loadingModelsRef.current.delete(item.instanceId);
          if (!model) throw new Error('Asset restore returned no model.');
          return model;
        }).catch(error => {
          loadingModelsRef.current.delete(item.instanceId);
          console.error('[BIM Engine] Failed to restore asset:', item.instanceId, error);
          throw error;
        });

        restorePromises.push(restorePromise);
      });
    }

    return Promise.all(restorePromises);
  };

  // Strictly controlled effect: Never process the state until the scene finishes loading completely.
  // This physically prevents race conditions where the state load finishes slightly before the 
  // geometry finishes being instantiated into `viewerRef.current.scene.objects`.
  useEffect(() => {
    if (isModelLoadedRef.current) {
      restoreProjectStateToScene(projectState).catch(error => {
        console.error('[BIM Engine] Failed to restore persisted project state:', error);
      });
    }
  }, [projectState]);

  useEffect(() => { placementModeRef.current = placementMode; }, [placementMode]);
  useEffect(() => { transformModeRef.current = transformMode; }, [transformMode]);

  const configureTransformHandles = (mode) => {
    const baseMode = mode === 'stretch' ? 'stretch' : mode;
    const activeResizeType =
      resizeSubmodeRef.current === 'edge' ? 'edge' :
      resizeSubmodeRef.current === 'corner' ? 'corner' :
      'face';

    // Always start from a fully hidden state. This prevents stale gizmos from
    // surviving a mode switch and makes the active tool the single source of
    // truth for what is visible/pickable.
    stretchHandlesRef.current.forEach(mesh => {
      if (!mesh?._stretchMeta) return;
      mesh.visible = false;
      mesh.pickable = false;
    });

    stretchHandlesRef.current.forEach(mesh => {
      const meta = mesh._stretchMeta;
      if (!meta) return;

      let active = false;
      if (meta.transformMode === 'move' && baseMode === 'move') active = true;
      if (meta.transformMode === 'rotate' && baseMode === 'rotate') active = true;
      if (meta.transformMode === 'stretch' && baseMode === 'stretch') {
        // Resize is explicit: Face = 1 axis, Edge = 2 axes, Corner = 3 axes.
        // Only the selected family is visible/pickable; no hover-based disclosure.
        active = meta.type === activeResizeType;
      }

      if (active) {
        mesh.visible = true;
        mesh.pickable = true;
      }
    });

    if (selectionCageRef.current) {
      selectionCageRef.current.visible = baseMode === 'stretch';
    }
  };

  useEffect(() => {
    configureTransformHandles(transformMode);
  }, [transformMode]);

  const destroyPointMeasurementPreview = () => {
    const plugin = measurementsPluginRef.current;
    const preview = pointMeasurementPreviewRef.current;
    if (plugin && preview?.id) {
      try { plugin.destroyMeasurement(preview.id); } catch (e) {}
    }
    pointMeasurementPreviewRef.current = null;
    pointMeasurementOriginRef.current = null;
    setMeasurementHover(null);
  };

  const setMeasurementInteractionMode = (nextMode) => {
    const safeMode = MEASUREMENT_MODES[nextMode] ? nextMode : 'point';
    measurementModeRef.current = safeMode;
    setMeasurementMode(safeMode);
    destroyPointMeasurementPreview();

    if (!isMeasuringRef.current) return;

    const viewer = viewerRef.current;
    const control = measurementControlRef.current;

    try { control?.reset?.(); } catch (e) {}

    if (safeMode === 'point' || safeMode === 'orthogonal') {
      try { control?.deactivate(); } catch (e) {}
      if (viewer?.cameraControl) viewer.cameraControl.active = false;
      setMeasurementPhase('ready');
      return;
    }

    if (viewer?.cameraControl) viewer.cameraControl.active = true;
    control?.activate();
    setMeasurementPhase(control?.currentMeasurement ? 'selecting-target' : 'ready');
  };

  const setOrthogonalMeasurementConstraint = (nextConstraint) => {
    const safeConstraint = ORTHOGONAL_CONSTRAINTS[nextConstraint] ? nextConstraint : 'horizontal';
    orthogonalConstraintRef.current = safeConstraint;
    setOrthogonalConstraint(safeConstraint);
    destroyPointMeasurementPreview();
    if (isMeasuringRef.current && measurementModeRef.current === 'orthogonal') {
      setMeasurementPhase('ready');
    }
  };

  useEffect(() => {
    isMeasuringRef.current = isMeasuring;

    const control = measurementControlRef.current;
    const viewer = viewerRef.current;

    if (!isMeasuring) {
      destroyPointMeasurementPreview();
      try { control?.deactivate(); } catch (e) {}
      if (viewer?.cameraControl) viewer.cameraControl.active = true;
      setMeasurementPhase('idle');
      return;
    }

    if (measurementModeRef.current === 'point' || measurementModeRef.current === 'orthogonal') {
      try { control?.deactivate(); } catch (e) {}
      if (viewer?.cameraControl) viewer.cameraControl.active = false;
      setMeasurementPhase('ready');
    } else {
      if (viewer?.cameraControl) viewer.cameraControl.active = true;
      control?.activate();
      setMeasurementPhase(control?.currentMeasurement ? 'selecting-target' : 'ready');
    }
  }, [isMeasuring]);

  const constrainOrthogonalPoint = (origin, target, constraint) => {
    if (constraint === 'vertical') {
      return [origin[0], target[1], origin[2]];
    }
    return [target[0], origin[1], target[2]];
  };

  useEffect(() => {
    if (!isMeasuring || !canvasRef.current) return undefined;

    const canvas = canvasRef.current;

    const handlePointMove = (event) => {
      const activeMode = measurementModeRef.current;
      if (activeMode !== 'point' && activeMode !== 'orthogonal') return;

      const point = pickMeasurementReference(
        viewerRef.current,
        [event.offsetX, event.offsetY],
        snappingEnabledRef.current,
      );

      if (!point) {
        setMeasurementHover(null);
        const preview = pointMeasurementPreviewRef.current;
        if (preview) preview.targetVisible = false;
        return;
      }

      setMeasurementHover({
        x: point.canvasPos[0],
        y: point.canvasPos[1],
        snapType: point.snapType,
        snapped: point.snapped,
      });

      const preview = pointMeasurementPreviewRef.current;
      if (preview) {
        const origin = pointMeasurementOriginRef.current;
        let displayTarget = point;
        if (activeMode === 'orthogonal' && origin) {
          displayTarget = { ...point, worldPos: constrainOrthogonalPoint(origin.worldPos, point.worldPos, orthogonalConstraintRef.current) };
        }
        preview.target.entity = displayTarget.entity;
        preview.target.worldPos = displayTarget.worldPos;
        preview.targetVisible = true;
      }
    };

    const handlePointDown = (event) => {
      const activeMode = measurementModeRef.current;
      if ((activeMode !== 'point' && activeMode !== 'orthogonal') || event.button !== 0) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const point = pickMeasurementReference(
        viewerRef.current,
        [event.offsetX, event.offsetY],
        snappingEnabledRef.current,
      );
      if (!point?.entity) return;

      const origin = pointMeasurementOriginRef.current;

      if (!origin) {
        pointMeasurementOriginRef.current = point;
        const preview = createProgrammaticDistanceMeasurement(
          measurementsPluginRef,
          point,
          point,
          {
            id: pointMeasurementPreviewIdRef.current,
            axisVisible: false,
            visible: true,
            wireVisible: true,
            kind: activeMode === 'orthogonal' ? 'orthogonal' : 'point',
            constraint: activeMode === 'orthogonal' ? orthogonalConstraintRef.current : null,
          },
        );

        if (preview) {
          preview.target.entity = point.entity;
          preview.target.worldPos = point.worldPos;
          preview.targetVisible = true;
          preview.labelStringFormat = (len) => formatLength(len, measurementUnitRef.current);
          pointMeasurementPreviewRef.current = preview;
        }

        setMeasurementPhase('selecting-target');
        return;
      }

      const finalTarget = activeMode === 'orthogonal'
        ? { ...point, worldPos: constrainOrthogonalPoint(origin.worldPos, point.worldPos, orthogonalConstraintRef.current) }
        : point;

      const dx = finalTarget.worldPos[0] - origin.worldPos[0];
      const dy = finalTarget.worldPos[1] - origin.worldPos[1];
      const dz = finalTarget.worldPos[2] - origin.worldPos[2];
      if (Math.hypot(dx, dy, dz) < 1e-6) return;

      const previewId = pointMeasurementPreviewRef.current?.id;
      if (previewId) {
        try { measurementsPluginRef.current?.destroyMeasurement(previewId); } catch (e) {}
      }

      const finalMeasurement = createProgrammaticDistanceMeasurement(
        measurementsPluginRef,
        origin,
        finalTarget,
        {
          axisVisible: false,
          visible: true,
          wireVisible: true,
          kind: activeMode === 'orthogonal' ? 'orthogonal' : 'point',
          constraint: activeMode === 'orthogonal' ? orthogonalConstraintRef.current : null,
        },
      );

      if (finalMeasurement) {
        finalMeasurement.labelStringFormat = (len) => formatLength(len, measurementUnitRef.current);
      }

      pointMeasurementPreviewRef.current = null;
      pointMeasurementOriginRef.current = null;
      setMeasurementPhase('ready');
      setMeasurementHover(null);
      applyMeasurementUnitToPlugin(measurementsPluginRef, measurementUnitRef.current);
      syncMeasurementsList(measurementsPluginRef, setMeasurementsList);
    };

    canvas.addEventListener('mousemove', handlePointMove);
    canvas.addEventListener('mousedown', handlePointDown, { capture: true });

    return () => {
      canvas.removeEventListener('mousemove', handlePointMove);
      canvas.removeEventListener('mousedown', handlePointDown, { capture: true });
      setMeasurementHover(null);
    };
  }, [isMeasuring]);

  // Escape cancels only the unfinished measurement and keeps Measure active.
  useEffect(() => {
    if (!isMeasuring) return undefined;

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if ((measurementModeRef.current === 'point' || measurementModeRef.current === 'orthogonal') && pointMeasurementOriginRef.current) {
        event.preventDefault();
        destroyPointMeasurementPreview();
        setMeasurementPhase('ready');
        return;
      }

      const control = measurementControlRef.current;
      if (!control?.active || !control.currentMeasurement) return;
      event.preventDefault();
      cancelActiveMeasurement(measurementControlRef);
      setMeasurementPhase('ready');
      applyMeasurementUnitToPlugin(measurementsPluginRef, measurementUnitRef.current);
      syncMeasurementsList(measurementsPluginRef, setMeasurementsList);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMeasuring]);

  useEffect(() => {
    if (!canvasRef.current) return;

    const viewer = new Viewer({
      canvasElement: canvasRef.current,
      transparent: true,
      antialias: true,
    });
    
    viewer.cameraControl.navMode = 'orbit';
    viewer.cameraControl.followPointer = true;
    viewer.cameraControl.smartPivot = true;
    viewer.cameraControl.doublePickFlyTo = false;
    viewer.cameraControl.mouseWheelDollyRate = 0; // zoom handled by our non-passive wheel listener
    viewer.scene.camera.project.fov = 65;
    cameraManagerRef.current = new CameraManager(viewer);

    // Modern BIM selection treatment: preserve the asset's real materials
    // and show a subtle cool outline/tint instead of xeokit's default
    // opaque green selection wash. This keeps furniture readable while
    // making the active object obvious.
    const selectionMaterial = viewer.scene.selectedMaterial;
    selectionMaterial.fill = false;
    selectionMaterial.edges = true;
    selectionMaterial.edgeColor = [0.12, 0.78, 0.95];
    selectionMaterial.edgeAlpha = 0.96;
    selectionMaterial.edgeWidth = 2.2;
    selectionMaterial.glowThrough = false;

    // Hover/preselection stays lighter than a committed selection.
    const highlightMaterial = viewer.scene.highlightMaterial;
    highlightMaterial.fill = false;
    highlightMaterial.edges = true;
    highlightMaterial.edgeColor = [0.35, 0.9, 1.0];
    highlightMaterial.edgeAlpha = 0.9;
    highlightMaterial.edgeWidth = 1.5;
    highlightMaterial.glowThrough = false;

    viewer.camera.eye = [-3.93, 2.85, 27.01];
    viewer.camera.look = [4.4, 3.72, 8.89];
    viewer.camera.up = [-0.01, 0.99, 0.039];
    
    const safeTreeContainer = treeContainerRef.current || document.createElement('div');
    new TreeViewPlugin(viewer, {
      containerElement: safeTreeContainer,
      autoExpandDepth: 2,
      hierarchy: 'containment',
    });
    
    navCubeRef.current = new NavCubePlugin(viewer, {
      canvasElement: navCubeCanvasRef.current,
      ...getNavCubeTheme(isDarkMode),
    });
    
    sectionPlanesRef.current = new SectionPlanesPlugin(viewer);
    loadersRef.current.xkt = new XKTLoaderPlugin(viewer);
    loadersRef.current.gltf = new GLTFLoaderPlugin(viewer);
    
    const measurementContainer = canvasRef.current.parentElement || document.body;

    measurementsPluginRef.current = new DistanceMeasurementsPlugin(viewer, {
      container: measurementContainer,
      defaultColor: '#22d3ee',
      defaultAxisVisible: false,
      defaultLabelsVisible: true,
      defaultLengthLabelEnabled: true,
      defaultLabelsOnWires: true,
      zIndex: 10000,
    });

    applyMeasurementUnitToPlugin(measurementsPluginRef, measurementUnitRef.current);

    // Use an explicit control instance. Xeokit's plugin.control is a deprecated
    // convenience getter; keeping our control as a ref gives the editor one
    // authoritative measurement input controller and makes lifecycle/debugging
    // deterministic.
    measurementControlRef.current = new DistanceMeasurementsMouseControl(
      measurementsPluginRef.current,
      { snapping: true },
    );

    // Keep the plugin's event stream as the source of truth for React state.
    measurementsPluginRef.current.on('measurementStart', (measurement) => {
      console.debug('[Measurement] start', {
        id: measurement?.id,
        origin: measurement?.origin?.worldPos,
      });
      setMeasurementPhase('selecting-target');
      applyMeasurementUnitToPlugin(measurementsPluginRef, measurementUnitRef.current);
      syncMeasurementsList(measurementsPluginRef, setMeasurementsList);
    });

    measurementsPluginRef.current.on('measurementEnd', (measurement) => {
      console.debug('[Measurement] end', {
        id: measurement?.id,
        origin: measurement?.origin?.worldPos,
        target: measurement?.target?.worldPos,
      });
      setMeasurementPhase('ready');
      applyMeasurementUnitToPlugin(measurementsPluginRef, measurementUnitRef.current);
      syncMeasurementsList(measurementsPluginRef, setMeasurementsList);
    });

    measurementsPluginRef.current.on('measurementCancel', (measurement) => {
      console.debug('[Measurement] cancel', { id: measurement?.id });
      setMeasurementPhase('ready');
      applyMeasurementUnitToPlugin(measurementsPluginRef, measurementUnitRef.current);
      syncMeasurementsList(measurementsPluginRef, setMeasurementsList);
    });

    measurementsPluginRef.current.on('measurementCreated', (measurement) => {
      console.debug('[Measurement] created', { id: measurement?.id });
      applyMeasurementUnitToPlugin(measurementsPluginRef, measurementUnitRef.current);
      syncMeasurementsList(measurementsPluginRef, setMeasurementsList);
    });

    measurementsPluginRef.current.on('measurementDestroyed', (measurement) => {
      console.debug('[Measurement] destroyed', { id: measurement?.id });
      syncMeasurementsList(measurementsPluginRef, setMeasurementsList);
    });

    
    let viewerAlive = true;

    const initializeIFCEngine = async () => {
      try {
        const ifcAPI = new WebIFC.IfcAPI();
        ifcAPI.SetWasmPath('/');
        await ifcAPI.Init();

        // StrictMode/layout switches can destroy this viewer while WASM init
        // is still pending. Never attach a loader to a dead/stale viewer.
        if (!viewerAlive || viewerRef.current !== viewer) return;

        loadersRef.current.ifc = new WebIFCLoaderPlugin(viewer, {
          WebIFC: WebIFC,
          IfcAPI: ifcAPI,
        });
        ifcLoaderOwnerRef.current = viewer;
      } catch (error) {
        console.error('[BIM Engine] Failed to boot IFC Engine.', error);
      }
    };

    viewerRef.current = viewer;
    initializeIFCEngine();
    
    // Clear BOTH object-level and model-level selection. This matters because
    // the scene now contains the native IFC model plus separately loaded
    // editable/ghost models.
    const clearSelection = () => {
      const ids = [...viewer.scene.selectedObjectIds];
      for (const id of ids) {
        const object = viewer.scene.objects[id];
        if (object) object.selected = false;
      }

      for (const model of Object.values(viewer.scene.models || {})) {
        if (model) model.selected = false;
      }
    };

    const isPlacedAssetEntity = (entity) => {
      const model = entity?.model;
      if (!model) return false;

      // AssetManager/loadSceneAsset stamps separately loaded editable assets
      // with _assetMeta. The original project model does not have this marker.
      // Use this as the authoritative native-vs-asset discriminator instead
      // of relying on model IDs, which can diverge across loader/model wrappers.
      return !!model._assetMeta;
    };

    viewer.cameraControl.on('picked', (pickResult) => {
      if (isMeasuringRef.current) return;
      if (pickResult.entity?._stretchMeta?.isStretchHandle) return;
      
      if (placementModeRef.current) {
        if (placementModeRef.current.type === 'door') {
          const wallSnap = getWallSnapData(viewerRef, pickResult.canvasPos);
          if (!wallSnap) return;
          onAssetPlaced(placementModeRef.current, wallSnap);
          setPlacementMode(null);
          return;
        }
        onAssetPlaced(placementModeRef.current, pickResult.worldPos || [0, 0, 0]);
        setPlacementMode(null);
        return;
      }
      
      if (!pickResult.entity) return;
      
      const entity = pickResult.entity;
      setIsRightPanelOpen(true);
      setRightTab('properties');

      // IMPORTANT: Do not classify native IFC objects using
      // entity.model.id !== currentModelRef.current.id. A native pick can
      // legitimately expose a model wrapper whose ID does not compare equal,
      // which incorrectly routes the click into the asset branch and selects
      // the entire IFC model.
      const isPlacedAsset = isPlacedAssetEntity(entity);

      if (isPlacedAsset) {
        clearSelection();
        const assetModel = entity.model;
        if (!assetModel) return;
        assetModel.selected = true;
        const assetId = assetModel.id;
        if (!assetId) return;
        setSelectedAssetIdSafe(assetId);
        
        buildStretchHandlesRef.current?.(stretchCtx, entity.model.id, true);
        
        transformModeRef.current = 'select';
        setTransformMode('select');
        setTimeout(() => configureTransformHandles('select'), 0);
        
        const assetMetaObject = viewer.metaScene.metaObjects[entity.id];
        const furnitureItem = (projectStateRef.current.furniture || [])
          .find(item => item.instanceId === entity.model.id);

        if (assetMetaObject) {
          const groupedProps = {};
          groupedProps['General Details'] = [
            { name: 'Element Name', value: assetMetaObject.name || furnitureItem?.name || 'Unnamed' },
            { name: 'IFC Class', value: assetMetaObject.type || 'GLB Asset' },
            { name: 'Global ID', value: assetMetaObject.id },
          ];
          if (assetMetaObject.propertySets) {
            assetMetaObject.propertySets.forEach(propSet => {
              const groupName = propSet.name || 'Other Properties';
              if (!groupedProps[groupName]) groupedProps[groupName] = [];
              if (propSet.properties) {
                propSet.properties.forEach(prop =>
                  groupedProps[groupName].push({ name: prop.name, value: prop.value })
                );
              }
            });
          }
          setSelectedObject({
            id: entity.model.id,
            name: assetMetaObject.name || furnitureItem?.name || 'Unnamed Asset',
            type: assetMetaObject.type || 'GLB Furniture',
            groupedProperties: groupedProps,
          });
        } else {
          setSelectedObject({
            id: entity.model.id,
            name: furnitureItem?.name || viewer.scene.models[entity.model.id]?._assetMeta?.fileType?.toUpperCase() || '3D Asset',
            type: furnitureItem?.fileType === 'glb' || furnitureItem?.file_type === 'glb'
              ? 'GLB Furniture'
              : '3D Asset',
            groupedProperties: {
              'Asset Details': [
                { name: 'Format', value: furnitureItem?.fileType || furnitureItem?.file_type || viewer.scene.models[entity.model.id]?._assetMeta?.fileType || 'unknown' },
                { name: 'Instance ID', value: entity.model.id },
              ],
            },
          });
        }
        return;
      }
      
      // Native element branch.
      // Directly set selected on the picked entity only.
      // Do NOT use setObjectsSelected — it calls withObjects() which, if the
      // id is not found in scene.objects directly, falls back to globalizing
      // the id against every model and can match unintended objects.
      clearSelection();
      setSelectedAssetIdSafe(null);
      if (entity.model) entity.model.selected = false;
      entity.selected = true;
      destroyStretchHandlesRef.current?.(stretchCtx);
      transformModeRef.current = 'select';
      setTransformMode('select');
      
      const metaObject = viewer.metaScene.metaObjects[entity.id];
      if (metaObject) {
        const groupedProps = {};
        groupedProps['General Details'] = [
          { name: 'Element Name', value: metaObject.name || 'Unnamed' },
          { name: 'IFC Class', value: metaObject.type || 'Unknown' },
          { name: 'Global ID', value: metaObject.id },
        ];
        if (metaObject.propertySets) {
          metaObject.propertySets.forEach(propSet => {
            const groupName = propSet.name || 'Other Properties';
            if (!groupedProps[groupName]) groupedProps[groupName] = [];
            if (propSet.properties) {
              propSet.properties.forEach(prop =>
                groupedProps[groupName].push({ name: prop.name, value: prop.value })
              );
            }
          });
        }
        setSelectedObject({
          id: entity.id,
          name: metaObject.name || 'Unnamed Object',
          type: metaObject.type || 'Generic Component',
          groupedProperties: groupedProps
        });
      }
    });
    
    const canvas = canvasRef.current;
    
    const onCanvasMouseDown = (e) => {
      if (isMeasuringRef.current && (measurementModeRef.current === 'point' || measurementModeRef.current === 'orthogonal')) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const canvasPos = [e.clientX - rect.left, e.clientY - rect.top];
      const pick = viewer.scene.pick({ canvasPos, pickSurface: false });
      const meta = pick?.entity?._stretchMeta;
      
      if (!meta?.isStretchHandle) return;
      
      const mode = transformModeRef.current;
      const baseMetaMode = mode === 'stretch' ? 'stretch' : mode;
      if (meta.transformMode !== baseMetaMode) return;
      
      e.stopPropagation();
      e.preventDefault();
      viewer.cameraControl.active = false;
      const { targetId, isAsset, type, axes } = meta;
      
      // Native IFC elements are intentionally NOT transform targets. They must
      // first go through Unlock -> isolated asset before Move/Rotate/Stretch.
      if (!isAsset) {
        viewer.cameraControl.active = true;
        return;
      }

      const targetObj = viewer.scene.models[targetId];
      if (!targetObj) return;

      if (mode === 'move' && type === 'move') {
        const startPosition = isAsset
          ? [...(targetObj.position || [0, 0, 0])]
          : [...(targetObj.offset || [0, 0, 0])];
        const startGrab = calculateGrabPoint(viewerRef, canvas, canvasPos, startPosition[1]);
        if (!startGrab) {
          viewer.cameraControl.active = true;
          return;
        }

        stretchDragRef.current = {
          type: 'move',
          targetId,
          isAsset,
          startPosition,
          startGrab: [...startGrab],
        };
        isStretchingRef.current = true;
        setIsStretching(true);
        setActiveStretchData({ label: 'Move', x: e.clientX, y: e.clientY });
        return;
      }

      if (mode === 'rotate' && type === 'rotate') {
        const center = targetObj.aabb
          ? [(targetObj.aabb[0] + targetObj.aabb[3]) / 2, (targetObj.aabb[1] + targetObj.aabb[4]) / 2, (targetObj.aabb[2] + targetObj.aabb[5]) / 2]
          : [...(targetObj.position || [0, 0, 0])];
        
        const startGrab = calculateGrabPoint(viewerRef, canvas, canvasPos, center[1]);
        if (!startGrab) {
          viewer.cameraControl.active = true;
          return;
        }
        
        stretchDragRef.current = {
          type: 'rotate',
          targetId,
          isAsset,
          center,
          startGrab: [...startGrab],
          startRotationY: targetObj.rotation?.[1] || 0,
          rotationGizmoMeshes: stretchHandlesRef.current.filter(mesh => (
            mesh?._stretchMeta?.type === 'rotate' &&
            mesh?._stretchMeta?.targetId === targetId &&
            mesh?._stretchMeta?.isAsset === isAsset
          )),
        };
        
        isStretchingRef.current = true;
        setIsStretching(true);
        canvas.style.cursor = 'grabbing';
        setActiveStretchData({ label: 'Rotate • drag around the arrow', x: e.clientX, y: e.clientY });
        return;
      }

      if (mode === 'stretch' && (type === 'face' || type === 'edge' || type === 'corner')) {
        const rotationY = ((targetObj.rotation?.[1] || 0) * Math.PI) / 180;
        const c = Math.cos(rotationY);
        const sn = Math.sin(rotationY);
        const localAxes = [
          [c, 0, -sn],
          [0, 1, 0],
          [sn, 0, c],
        ];
        
        const startAabb = targetObj.aabb;
        const startHalf = startAabb
          ? [
              (startAabb[3] - startAabb[0]) / 2,
              (startAabb[4] - startAabb[1]) / 2,
              (startAabb[5] - startAabb[2]) / 2,
            ]
          : [1, 1, 1];
          
        const getScale = (obj) => {
          if (!obj) return [1, 1, 1];
          const m = obj.matrix;
          if (!m || m.length < 11) return [1, 1, 1];
          const sx = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
          const sy = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
          const sz = Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);
          return [sx || 1, sy || 1, sz || 1];
        };

        const startScale = getScale(targetObj);
        const startPosition = targetObj.position ? [...targetObj.position] : (targetObj.offset ? [...targetObj.offset] : [0, 0, 0]);
          
        stretchDragRef.current = {
          type: 'scale',
          axesList: axes,
          targetId,
          isAsset,
          startCanvasX: canvasPos[0],
          startCanvasY: canvasPos[1],
          startScale,
          startPosition,
          startHalf,
          startDimensions: startAabb ? [
            startAabb[3] - startAabb[0],
            startAabb[4] - startAabb[1],
            startAabb[5] - startAabb[2],
          ] : [1, 1, 1],
          localAxes,
        };

        isStretchingRef.current = true;
        setIsStretching(true);
        return;
      }
      viewer.cameraControl.active = true;
    };

    const onDocMouseMove = (e) => {
      if (!isStretchingRef.current || !stretchDragRef.current) return;
      const dragData = stretchDragRef.current;
      const rect = canvas.getBoundingClientRect();
      const curX = e.clientX - rect.left;
      const curY = e.clientY - rect.top;
      
      const targetObj = dragData.isAsset ? viewer.scene.models[dragData.targetId] : viewer.scene.objects[dragData.targetId];
      if (!targetObj) return;

      if (dragData.type === 'move') {
        const currentGrab = calculateGrabPoint(viewerRef, canvas, [curX, curY], dragData.startPosition[1]);
        if (!currentGrab) return;

        const next = [
          dragData.startPosition[0] + currentGrab[0] - dragData.startGrab[0],
          dragData.startPosition[1],
          dragData.startPosition[2] + currentGrab[2] - dragData.startGrab[2],
        ];

        if (dragData.isAsset) targetObj.position = next;
        else targetObj.offset = next;

        setActiveStretchData({ label: 'Move', x: e.clientX, y: e.clientY });
        return;
      }

      if (dragData.type === 'rotate') {
        const currentGrab = calculateGrabPoint(viewerRef, canvas, [curX, curY], dragData.center[1]);
        if (!currentGrab) return;
        
        const startAngle = Math.atan2(
          dragData.startGrab[2] - dragData.center[2],
          dragData.startGrab[0] - dragData.center[0]
        );
        const currentAngle = Math.atan2(
          currentGrab[2] - dragData.center[2],
          currentGrab[0] - dragData.center[0]
        );
        
        let delta = (startAngle - currentAngle) * 180 / Math.PI; 
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        
        let nextRotation = dragData.startRotationY + delta;
        while (nextRotation < 0) nextRotation += 360;
        nextRotation = nextRotation % 360;

        const pivot = targetObj._transformPivot?.local;
        if (pivot && dragData.isAsset && targetObj.position) {
          const scale = targetObj.scale || [1, 1, 1];
          const scaledLocal = [
            pivot[0] * (scale[0] || 1),
            pivot[1] * (scale[1] || 1),
            pivot[2] * (scale[2] || 1),
          ];
          const oldRot = targetObj.rotation?.[1] || 0;
          const currentPivot = [
            targetObj.position[0] + scaledLocal[0] * Math.cos(oldRot * Math.PI / 180) - scaledLocal[2] * Math.sin(oldRot * Math.PI / 180),
            targetObj.position[1] + scaledLocal[1],
            targetObj.position[2] + scaledLocal[0] * Math.sin(oldRot * Math.PI / 180) + scaledLocal[2] * Math.cos(oldRot * Math.PI / 180),
          ];
          const nr = nextRotation * Math.PI / 180;
          targetObj.rotation = [targetObj.rotation?.[0] || 0, nextRotation, targetObj.rotation?.[2] || 0];
          targetObj.position = [
            currentPivot[0] - (scaledLocal[0] * Math.cos(nr) - scaledLocal[2] * Math.sin(nr)),
            currentPivot[1] - scaledLocal[1],
            currentPivot[2] - (scaledLocal[0] * Math.sin(nr) + scaledLocal[2] * Math.cos(nr)),
          ];
        } else {
          const currentRotation = targetObj.rotation ? [...targetObj.rotation] : [0, 0, 0];
          targetObj.rotation = [currentRotation[0], nextRotation, currentRotation[2]];
        }

        if (dragData.rotationGizmoMeshes?.length) {
          dragData.rotationGizmoMeshes.forEach(mesh => {
            try {
              mesh.position = [...dragData.center];
              mesh.rotation = [0, nextRotation, 0];
            } catch (_) {}
          });
        }
        
        setActiveStretchData({ label: `Rotate: ${nextRotation.toFixed(1)}°`, x: e.clientX, y: e.clientY });
        return;
      }

      const deltaScreenX = curX - dragData.startCanvasX;
      const deltaScreenY = dragData.startCanvasY - curY;

      const viewMatrix = viewer.scene.camera.viewMatrix;
      
      const s = [...dragData.startScale];
      let nextPosition = [...dragData.startPosition];
      
      dragData.axesList.forEach(({ axis, dir }) => {
        const v = dragData.localAxes[axis];
        
        const screenX = viewMatrix[0] * v[0] + viewMatrix[4] * v[1] + viewMatrix[8] * v[2];
        const screenY = viewMatrix[1] * v[0] + viewMatrix[5] * v[1] + viewMatrix[9] * v[2];
        const len = Math.hypot(screenX, screenY) || 1;
        
        const effectiveDelta = (deltaScreenX * screenX / len + deltaScreenY * screenY / len) * dir;
        
        s[axis] = Math.max(0.05, dragData.startScale[axis] + effectiveDelta * 0.005);
        
        const startHalf = dragData.startHalf[axis];
        const scaleRatio = s[axis] / (dragData.startScale[axis] || 1);
        const halfDelta = startHalf * (scaleRatio - 1);
        
        nextPosition[0] += v[0] * halfDelta * dir;
        nextPosition[1] += v[1] * halfDelta * dir;
        nextPosition[2] += v[2] * halfDelta * dir;
      });
      
      applyScale(viewerRef, dragData.targetId, dragData.isAsset, s);
      
      if (dragData.isAsset) targetObj.position = nextPosition;
      else targetObj.offset = nextPosition;
      
      const names = dragData.axesList.map(({ axis }) => axis === 0 ? 'Width' : axis === 1 ? 'Height' : 'Depth');
      setActiveStretchData({
        label: `${names.join(' + ')}: ${dragData.axesList.map(({ axis }) => s[axis].toFixed(2)).join(' × ')}`,
        x: e.clientX,
        y: e.clientY,
      });
    };

    const onDocMouseUp = () => {
      if (!isStretchingRef.current || !stretchDragRef.current) return;
      const dragData = stretchDragRef.current;
      const targetObj = dragData.isAsset ? viewer.scene.models[dragData.targetId] : viewer.scene.objects[dragData.targetId];
      
      if (targetObj && stretchPersistCallbackRef.current) {
        if (dragData.type === 'move') {
          const position = dragData.isAsset ? (targetObj.position || [0, 0, 0]) : (targetObj.offset || [0, 0, 0]);
          position.forEach((value, axis) => {
            stretchPersistCallbackRef.current(dragData.targetId, 'position', axis, value);
          });
        } else if (dragData.type === 'rotate') {
          stretchPersistCallbackRef.current(dragData.targetId, 'rotation', 1, targetObj.rotation?.[1] || 0);
        } else {
          // Resize writes the live transform through model.matrix. Xeokit does
          // not necessarily reflect that matrix back into model.scale, so
          // reading targetObj.scale here can persist [1, 1, 1] even though the
          // rendered model was visibly resized. Persist the same scale encoded
          // in the matrix that the resize operation just applied.
          const matrix = targetObj.matrix;
          const matrixScale = matrix && matrix.length >= 11
            ? [
                Math.sqrt(matrix[0] * matrix[0] + matrix[1] * matrix[1] + matrix[2] * matrix[2]) || 1,
                Math.sqrt(matrix[4] * matrix[4] + matrix[5] * matrix[5] + matrix[6] * matrix[6]) || 1,
                Math.sqrt(matrix[8] * matrix[8] + matrix[9] * matrix[9] + matrix[10] * matrix[10]) || 1,
              ]
            : (targetObj.scale || [1, 1, 1]);

          dragData.axesList.forEach(({ axis }) => {
            stretchPersistCallbackRef.current(dragData.targetId, 'scale', axis, matrixScale[axis]);
          });
        }
      }
      
      stretchDragRef.current = null;
      isStretchingRef.current = false;
      setIsStretching(false);
      setActiveStretchData(null);
      canvas.style.cursor = '';
      viewer.cameraControl.active = true;

      buildStretchHandlesRef.current?.(stretchCtx, dragData.targetId, dragData.isAsset);
      setTimeout(() => {
        configureTransformHandles(transformModeRef.current);
      }, 0);
    };

    const onCanvasHoverMove = (e) => {
      if (isStretchingRef.current) return;
      if (isMeasuringRef.current && (measurementModeRef.current === 'point' || measurementModeRef.current === 'orthogonal')) return;
      if (!stretchHandlesRef.current.length) return;
      
      const pick = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY], pickSurface: false });
      const meta = pick?.entity?._stretchMeta;
      
      if (meta?.isStretchHandle) {
        if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current);
          hideTimeoutRef.current = null;
        }
        
        // Resize disclosure is click-driven. Hover only highlights the grip;
        // it must never reveal additional controls unexpectedly.

        if (hoveredStretchMeshRef.current !== pick.entity) {
          resetHoveredStretchHandle(hoveredStretchMeshRef, stretchAnimFramesRef);
          
          const hoverColor = brightenColor(meta.type === 'rotate' ? (meta.hoverColor || meta.color) : meta.color);
          if (meta.type === 'rotate') {
            const group = meta.rotationGroup || [pick.entity];
            group.forEach(mesh => {
              const color = brightenColor(meta.hoverColor || meta.color);
              mesh.material.diffuse = color;
              mesh.material.emissive = color;
              mesh.material.opacity = 1.0;
            });
          } else {
            pick.entity.material.diffuse = hoverColor;
            pick.entity.material.emissive = hoverColor;
            animateHandleTo(pick.entity, stretchAnimFramesRef, { opacity: 1, scale: STRETCH_HANDLE_HOVER_SCALE });
          }
          hoveredStretchMeshRef.current = pick.entity;
        }
        
        if (meta.type === 'rotate') {
          canvas.style.cursor = 'grab';
        } else {
          canvas.style.cursor = cursorForAxes(meta.axes);
        }
      } else {
        if (hoveredStretchMeshRef.current) {
          resetHoveredStretchHandle(hoveredStretchMeshRef, stretchAnimFramesRef);
        }
        // Keep any click-revealed resize controls visible until another face
        // is clicked or the selection is cleared.
        canvas.style.cursor = '';

      }
    };
    
    // Intercept wheel events with { passive: false } so we can call
    // preventDefault() and stop the browser from scrolling the page.
    // We then drive a smooth pointer-targeted zoom through CameraManager.
    const onCanvasWheel = (e) => {
      e.preventDefault();
      if (!cameraManagerRef.current) return;
      const rect = canvas.getBoundingClientRect();
      cameraManagerRef.current.zoomToPointer(
        e.deltaY,
        [e.clientX - rect.left, e.clientY - rect.top],
      );
    };

    canvas.addEventListener('mousedown', onCanvasMouseDown, { capture: true });
    canvas.addEventListener('mousemove', onCanvasHoverMove);
    canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    
    viewer.cameraControl.on('pickedNothing', () => {
      if (placementModeRef.current) { setPlacementMode(null); return; }
      clearSelection();
      setSelectedObject(null);
      setSelectedAssetIdSafe(null);
      destroyStretchHandlesRef.current?.(stretchCtx);
      stretchDragRef.current = null;
      isStretchingRef.current = false;
      setIsStretching(false);
      setActiveStretchData(null);
      activeResizeFaceKeyRef.current = null;
      hideRevealedGroup(revealedFaceKeyRef, revealedHandlesRef, stretchAnimFramesRef);
      
      transformModeRef.current = 'move';
      setTransformMode('move');
      
      if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current);
          hideTimeoutRef.current = null;
      }
    });
    
    return () => {
      canvas.removeEventListener('mousedown', onCanvasMouseDown, { capture: true });
      canvas.removeEventListener('mousemove', onCanvasHoverMove);
      canvas.removeEventListener('wheel', onCanvasWheel, { passive: false });
      document.removeEventListener('mousemove', onDocMouseMove);
      document.removeEventListener('mouseup', onDocMouseUp);
      destroyPointMeasurementPreview();
      try { measurementControlRef.current?.deactivate(); } catch (e) {}
      try { measurementControlRef.current?.destroy(); } catch (e) {}
      try { viewer.cameraControl.active = true; } catch (e) {}
      measurementControlRef.current = null;
      try { measurementsPluginRef.current?.destroy(); } catch (e) {}
      measurementsPluginRef.current = null;
      try { navCubeRef.current?.destroy(); } catch (e) {}
      navCubeRef.current = null;
      setMeasurementPhase('idle');
      viewerAlive = false;
      ifcLoaderOwnerRef.current = null;
      loadersRef.current = {};
      cameraManagerRef.current = null;
      viewerRef.current = null;
      try { viewer.destroy(); } catch (e) {}
    };
  }, []);

  const navCubeThemeInitializedRef = useRef(false);

  useEffect(() => {
    if (!viewerRef.current || !navCubeCanvasRef.current) return undefined;

    // The viewer bootstrap creates the first cube. Recreate only when the theme
    // actually changes so we do not duplicate the plugin during initial mount.
    if (!navCubeThemeInitializedRef.current) {
      navCubeThemeInitializedRef.current = true;
      return undefined;
    }

    try { navCubeRef.current?.destroy(); } catch (e) {}
    navCubeRef.current = new NavCubePlugin(viewerRef.current, {
      canvasElement: navCubeCanvasRef.current,
      ...getNavCubeTheme(isDarkMode),
    });

    return () => {
      // Do not destroy here on every render; the next theme change replaces it.
    };
  }, [isDarkMode]);

  useEffect(() => {
    if (viewerRef.current) {
      viewerRef.current.cameraControl.navMode = navMode;
      viewerRef.current.cameraControl.active = true;
    }
  }, [navMode]);

  useEffect(() => {
    if (!viewerRef.current) return;

    const generation = ++mainLoadGenerationRef.current;
    let cancelled = false;
    let activeReader = null;

    const isCurrentLoad = () => (
      !cancelled &&
      generation === mainLoadGenerationRef.current &&
      !!viewerRef.current
    );

    const clearScene = () => {
      if (viewerRef.current && viewerRef.current.scene) {
        Object.keys(viewerRef.current.scene.models).forEach(id => {
          try { viewerRef.current.scene.models[id].destroy(); } catch (e) {}
        });
      }
      currentModelRef.current = null;
      // Clear the render boundary lock to wait for the new model
      isModelLoadedRef.current = false;
    };

    if (!file || !jobId || !fileName) {
      clearScene();
      setSelectedObject(null);
      setSelectedAssetIdSafe(null);
      return;
    }

    clearScene();
    const fileExtension = fileName.split('.').pop().toLowerCase();

    setIsLoading(true);

    const waitForLoader = async (key) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (loadersRef.current[key]) return loadersRef.current[key];
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return null;
    };

    const loadMainModel = async (buffer) => {
      if (!isCurrentLoad()) return;
      const loadViewer = viewerRef.current;
      if (!loadViewer || !loadViewer.scene) {
        console.error('[BIM Engine] Aborting model load: viewer scene is unavailable.');
        setIsLoading(false);
        return;
      }

      const requiredLoader = fileExtension === 'ifc'
        ? 'ifc'
        : fileExtension === 'xkt'
          ? 'xkt'
          : (fileExtension === 'glb' || fileExtension === 'gltf')
            ? 'gltf'
            : null;

      if (requiredLoader && !(await waitForLoader(requiredLoader))) {
        if (isCurrentLoad()) {
          console.error(`[BIM Engine] Timed out waiting for ${requiredLoader} loader.`);
          setIsLoading(false);
        }
        return;
      }

      if (!isCurrentLoad()) return;

      const ifcData = new Uint8Array(buffer);

      if (fileExtension === 'ifc' && loadersRef.current.ifc) {
        if (!isCurrentLoad()) return;
        if (ifcLoaderOwnerRef.current !== loadViewer) {
          console.error('[BIM Engine] Aborting IFC load: loader belongs to a stale viewer.');
          setIsLoading(false);
          return;
        }
        try {
          currentModelRef.current = loadersRef.current.ifc.load({
            id: 'main_structure',
            ifc: ifcData,
            edges: true,
            globalizeCoordinates: false,
          });
        } catch (error) {
          console.error('[BIM Engine] IFC load failed:', error);
          currentModelRef.current = null;
          if (isCurrentLoad()) setIsLoading(false);
          return;
        }
      } else if (fileExtension === 'xkt' && loadersRef.current.xkt) {
        if (!isCurrentLoad()) return;
        currentModelRef.current = loadersRef.current.xkt.load({
          id: 'main_structure',
          xkt: buffer,
          edges: true,
        });
      } else if ((fileExtension === 'glb' || fileExtension === 'gltf') && loadersRef.current.gltf) {
        if (!isCurrentLoad()) return;
        const objectUrl = URL.createObjectURL(new Blob([buffer], {
          type: fileExtension === 'glb' ? 'model/gltf-binary' : 'model/gltf+json',
        }));
        currentModelRef.current = loadersRef.current.gltf.load({
          id: 'main_structure',
          src: objectUrl,
          edges: true,
          pbrEnabled: true,
          colorTextureEnabled: true,
        });
        currentModelRef.current.on('destroyed', () => URL.revokeObjectURL(objectUrl));
      } else {
        console.error(`[BIM Engine] No loader for main model type: ${fileExtension}`);
        setIsLoading(false);
        return;
      }

      if (!currentModelRef.current) {
        console.error('[BIM Engine] Loader did not create main_structure.');
        setIsLoading(false);
        return;
      }

      currentModelRef.current.on('loaded', async () => {
        if (!isCurrentLoad()) {
          try { currentModelRef.current?.destroy(); } catch (e) {}
          return;
        }

        viewerRef.current.cameraFlight.flyTo(currentModelRef.current);
        
        setIsLoading(false);
        
        // IMPORTANT: Unlocking the hard rendering boundary.
        // We know for a fact that the viewer scene has all initial native elements now.
        isModelLoadedRef.current = true;
        
        // Only safely trigger state logic exactly when model becomes ready
        restoreProjectStateToScene(projectStateRef.current);
      });
    };

    const reader = new FileReader();
    activeReader = reader;
    reader.onload = (e) => {
      if (!isCurrentLoad()) return;
      loadMainModel(e.target.result);
    };
    reader.onerror = () => {
      if (isCurrentLoad()) {
        setIsLoading(false);
        console.error('[BIM Engine] Failed to read IFC/model file.');
      }
    };
    reader.readAsArrayBuffer(file);

    return () => {
      cancelled = true;
      if (activeReader && activeReader.readyState === FileReader.LOADING) {
        try { activeReader.abort(); } catch (e) {}
      }
      // Invalidate any loader work that is still awaiting a plugin or model event.
      if (generation === mainLoadGenerationRef.current) {
        mainLoadGenerationRef.current += 1;
      }
    };
  }, [jobId, file, fileName]);

  const toggleXRay = () => {
    const scene = viewerRef.current.scene;
    scene.setObjectsXRayed(scene.objectIds, !isXRay);
    setIsXRay(!isXRay);
  };

  const toggleClipping = () => {
    const nextState = !isClipping;
    if (nextState) {
      const aabb = viewerRef.current.scene.getAABB();
      const center = [
        (aabb[0] + aabb[3]) / 2,
        (aabb[1] + aabb[4]) / 2,
        (aabb[2] + aabb[5]) / 2,
      ];
      currentPlaneRef.current = sectionPlanesRef.current.createSectionPlane({
        id: 'activeSlice',
        pos: center,
        dir: [0, -1, 0],
      });
      sectionPlanesRef.current.showControl('activeSlice');
    } else {
      if (currentPlaneRef.current) { currentPlaneRef.current.destroy(); currentPlaneRef.current = null; }
    }
    setIsClipping(nextState);
  };

  const calibrationCtx = {
    file, jobId, activeProject,
    viewerRef, currentModelRef, globalScaleFactorRef, setSceneScaleFactor,
    measurementsPluginRef, setMeasurementsList, setIsLoading,
    loadersRef, projectStateRef, inspectNativeElement, transformFurnitureForCalibration,
    restoreProjectStateToScene, snapshotFurnitureMatrices,
    setSelectedAssetIdSafe,
    setSelectedObject,
    destroyStretchHandles: () => destroyStretchHandles(stretchCtx),
  };

  const assetCtx = {
    activeProject,
    file,
    jobId,
    viewerRef,
    currentModelRef,
    loadersRef,
    globalScaleFactorRef,
    loadingModelsRef,
    setSelectedAssetId: setSelectedAssetIdSafe,
    setSelectedObject,
  };

  buildStretchHandlesRef.current = buildStretchHandles;
  destroyStretchHandlesRef.current = destroyStretchHandles;

  return {
    refs: { canvasRef, treeContainerRef, navCubeCanvasRef, viewerRef },
    state: {
      isLoading,
      isXRay,
      isClipping,
      navMode,
      selectedObject,
      selectedAssetId,
      placementMode,
      isMeasuring,
      measurementPhase,
      measurementMode,
      orthogonalConstraint,
      measurementHover,
      measurementsList,
      measurementUnit,
      snappingEnabled,
      axisBreakdownVisible,
      measurementDisplayMode,
      totalMeasuredLength: measurementsList.reduce((sum, m) => sum + m.lengthMeters, 0),
      sceneScaleFactor,
      isStretching,
      activeStretchData,
      transformMode,
      resizeSubmode,
    },
    actions: {
      toggleXRay,
      toggleClipping,
      setNavMode,
      setSelectedObject,
      setSelectedAssetId: setSelectedAssetIdSafe,
      setPlacementMode,
      camera: {
        fitScene: () => cameraManagerRef.current?.fitScene(),
        focusSelected: () => {
          const selectedAsset = selectedAssetIdRef.current;
          if (selectedAsset) return cameraManagerRef.current?.focus(selectedAsset, true);
          const selected = selectedObject?.id;
          if (selected) return cameraManagerRef.current?.focus(selected, false);
          return cameraManagerRef.current?.fitScene();
        },
        preset: (name) => cameraManagerRef.current?.preset(name),
        setProjection: (projection) => cameraManagerRef.current?.setProjection(projection),
        zoom: (direction) => cameraManagerRef.current?.zoom(direction),
        getProjection: () => cameraManagerRef.current?.getProjection() || 'perspective',
        snapshot: () => cameraManagerRef.current?.snapshot(),
        restore: (snapshot) => cameraManagerRef.current?.restore(snapshot),
        reset: () => cameraManagerRef.current?.reset(),
      },
      loadIFCAssetIntoScene: async (i, s, t, r, options) => {
        loadingModelsRef.current.add(i);
        try {
          const model = await loadIFCAssetIntoScene(loadersRef, globalScaleFactorRef, i, s, t, r, options);
          loadingModelsRef.current.delete(i);
          return model;
        } catch (err) {
          loadingModelsRef.current.delete(i);
          throw err;
        }
      },
      getDropPosition: (c, a) => getDropPosition(viewerRef, projectStateRef, c, a),
      getWallSnapData: (c) => getWallSnapData(viewerRef, c),
      toggleMeasurementMode: () => toggleMeasurementMode(isMeasuring, setIsMeasuring, setPlacementMode, setSelectedObject, setSelectedAssetId, viewerRef),
      setMeasurementMode: setMeasurementInteractionMode,
      orthogonalConstraint,
      setOrthogonalConstraint: setOrthogonalMeasurementConstraint,
      clearMeasurements: () => clearMeasurements(measurementsPluginRef, setMeasurementsList),
      deleteMeasurement: (id) => deleteMeasurement(id, measurementsPluginRef, setMeasurementsList),
      scaleModelByMeasurement: (id, l) => scaleModelByMeasurement(calibrationCtx, id, l),
      calibrateWallHeight: (e, h) => calibrateWallHeight(calibrationCtx, e, h),
      flyToMeasurement: (m) => flyToMeasurement(viewerRef, m),
      toggleSnapping: () => toggleSnapping(measurementControlRef, snappingEnabled, setSnappingEnabled),
      toggleAxisBreakdown: () => toggleAxisBreakdown(measurementsPluginRef, axisBreakdownVisible, setAxisBreakdownVisible),
      setMeasurementUnit,
      setMeasurementDisplayMode,
      formatLength: (m) => formatLength(m, measurementUnit),
      updateNativeOffset: (id, ax, val) => updateNativeOffset(viewerRef, id, ax, val),
      updateDynamicTransform: (id, t, ax, val) => updateDynamicTransform(viewerRef, id, t, ax, val),
      updateStructuralTransform: (id, t, ax, val) => updateStructuralTransform(viewerRef, id, t, ax, val),
      isolateAndMakeMoveable: async (e, onA, uSE) => {
        const instanceId = await isolateAndMakeMoveable(assetCtx, e, onA, uSE);
        if (instanceId && viewerRef.current?.scene.models[instanceId]) {
          destroyStretchHandlesRef.current?.(stretchCtx);
          buildStretchHandlesRef.current?.(stretchCtx, instanceId, true);
          transformModeRef.current = 'move';
          setTransformMode('move');
        }
        return instanceId;
      },
      inspectNativeElement: (e) => inspectNativeElement(activeProject, e),
      getCursorWorldPosition: (c) => getCursorWorldPosition(viewerRef, c),
      setIsLoading,
      buildStretchHandles: (e, a) => buildStretchHandles(stretchCtx, e, a),
      destroyStretchHandles: () => destroyStretchHandles(stretchCtx),
      setStretchPersistCallback: (fn) => { stretchPersistCallbackRef.current = fn; },
      setTransformMode: (mode) => {
        if (!['select', 'move', 'rotate', 'stretch'].includes(mode)) return;

        if (mode === 'stretch' && transformModeRef.current !== 'stretch') {
          resizeSubmodeRef.current = 'face';
          setResizeSubmode('face');
        }

        transformModeRef.current = mode;

        // Toolbar actions can fire in the same tick as selection updates.
        // Rebuild the local gizmo set synchronously when needed so the chosen
        // tool always has real pickable handles before the next mouse event.
        const viewer = viewerRef.current;
        const selectedId = selectedAssetIdRef.current || selectedAssetId;
        if (viewer && mode !== 'select' && stretchHandlesRef.current.length === 0 && selectedId) {
          const model = viewer.scene.models[selectedId];
          if (model) {
            buildStretchHandlesRef.current?.(stretchCtx, selectedId, true);
          }
        }

        setTransformMode(mode);
        requestAnimationFrame(() => configureTransformHandles(mode));
      },
      setResizeSubmode: (submode) => {
        if (!['face', 'edge', 'corner'].includes(submode)) return;
        resizeSubmodeRef.current = submode;
        setResizeSubmode(submode);
        if (transformModeRef.current === 'stretch') {
          configureTransformHandles('stretch');
        }
      },
    },
  };
};
