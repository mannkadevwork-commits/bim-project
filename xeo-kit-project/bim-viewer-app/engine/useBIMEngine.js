import { useEffect, useRef, useState } from 'react';
import { math } from '@xeokit/xeokit-sdk/src/viewer/scene/math/math';
import { Viewer } from '@xeokit/xeokit-sdk/src/viewer/Viewer';
import { XKTLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/XKTLoaderPlugin/XKTLoaderPlugin';
import { WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/WebIFCLoaderPlugin/WebIFCLoaderPlugin';
import { TreeViewPlugin } from '@xeokit/xeokit-sdk/src/plugins/TreeViewPlugin/TreeViewPlugin';
import { NavCubePlugin } from '@xeokit/xeokit-sdk/src/plugins/NavCubePlugin/NavCubePlugin';
import { SectionPlanesPlugin } from '@xeokit/xeokit-sdk/src/plugins/SectionPlanesPlugin/SectionPlanesPlugin';
import { DistanceMeasurementsPlugin } from '@xeokit/xeokit-sdk/src/plugins/DistanceMeasurementsPlugin/DistanceMeasurementsPlugin';
import * as WebIFC from 'web-ifc';
import { API_BASE_URL, AXIS_HANDLE_COLORS, STRETCH_HANDLE_DRAG_SCALE, STRETCH_HANDLE_HOVER_SCALE } from './utils/constants';
import { brightenColor } from './utils/helpers';
import { animateHandleTo, buildStretchHandles, destroyStretchHandles, hideRevealedGroup, revealGroupForFace } from './stretch/StretchHandles';
import { applyScale, cursorForAxes, resetHoveredStretchHandle } from './stretch/StretchController';
import { toggleMeasurementMode, clearMeasurements, syncMeasurementsList, deleteMeasurement, flyToMeasurement, toggleSnapping, toggleAxisBreakdown, formatLength } from './measurements/MeasurementController';
import { applyGlobalScale, scaleModelByMeasurement, calibrateWallHeight } from './calibration/CalibrationController';
import { getDropPosition, getWallSnapData, getCursorWorldPosition } from './placement/PlacementController';
import { loadIFCAssetIntoScene, isolateAndMakeMoveable, inspectNativeElement, updateStructuralTransform, updateNativeOffset, updateDynamicTransform } from './assets/AssetManager';
import { calculateGrabPoint } from './stretch/TranslationController';

export const useBIMEngine = (file, projectStateRef, onAssetPlaced, setIsRightPanelOpen, setRightTab) => {
  const canvasRef = useRef(null);
  const treeContainerRef = useRef(null);
  const navCubeCanvasRef = useRef(null);
  const viewerRef = useRef(null);
  const loadersRef = useRef({});
  const sectionPlanesRef = useRef(null);
  const currentModelRef = useRef(null);
  const currentPlaneRef = useRef(null);
  const measurementsPluginRef = useRef(null);
  const isMeasuringRef = useRef(false);
  const globalScaleFactorRef = useRef({ x: 1, y: 1, z: 1 });
  const [sceneScaleFactor, setSceneScaleFactor] = useState({ x: 1, y: 1, z: 1 });
  
  const [isLoading, setIsLoading] = useState(false);
  const [isXRay, setIsXRay] = useState(false);
  const [isClipping, setIsClipping] = useState(false);
  const [navMode, setNavMode] = useState('orbit');
  
  const [selectedObject, setSelectedObject] = useState(null);
  const [selectedAssetId, setSelectedAssetId] = useState(null);
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
  const stretchAnimFramesRef = useRef(new Set());
  const hideTimeoutRef = useRef(null); 
  
  const [isStretching, setIsStretching] = useState(false);
  const [activeStretchData, setActiveStretchData] = useState(null);
  const [transformMode, setTransformMode] = useState('move');
  const transformModeRef = useRef('move');
  
  const buildStretchHandlesRef = useRef(null);
  const destroyStretchHandlesRef = useRef(null);
  
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [measurementsList, setMeasurementsList] = useState([]); 
  const [measurementUnit, setMeasurementUnit] = useState('m'); 
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [axisBreakdownVisible, setAxisBreakdownVisible] = useState(false);
  const measurementPollRef = useRef(null);
  
  const stretchCtx = {
    viewerRef, stretchHandlesRef, selectionCageRef, stretchFaceAdjacencyRef,
    revealedFaceKeyRef, revealedHandlesRef, stretchAnimFramesRef,
    hoveredStretchMeshRef, canvasRef
  };

  useEffect(() => { placementModeRef.current = placementMode; }, [placementMode]);
  useEffect(() => { transformModeRef.current = transformMode; }, [transformMode]);
  
  const configureTransformHandles = (mode) => {
    stretchHandlesRef.current.forEach(mesh => {
      const meta = mesh._stretchMeta;
      if (!meta) return;
      const active = !mode || meta.transformMode === mode;
      mesh.visible = active;
      mesh.pickable = active && meta.type !== 'rotateRing';
    });
  };

  useEffect(() => {
    configureTransformHandles(transformMode);
  }, [transformMode]);

  useEffect(() => {
    isMeasuringRef.current = isMeasuring;
    if (measurementsPluginRef.current && measurementsPluginRef.current.control) {
        if (isMeasuring) {
            measurementsPluginRef.current.control.activate();
        } else {
            measurementsPluginRef.current.control.deactivate();
        }
    }
    if (isMeasuring) {
      measurementPollRef.current = setInterval(() => {
        syncMeasurementsList(measurementsPluginRef, setMeasurementsList);
      }, 400);
    } else if (measurementPollRef.current) {
      clearInterval(measurementPollRef.current);
      measurementPollRef.current = null;
    }
    return () => {
      if (measurementPollRef.current) {
        clearInterval(measurementPollRef.current);
        measurementPollRef.current = null;
      }
    };
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
    viewer.cameraControl.doublePickFlyTo = true;
    viewer.scene.camera.project.fov = 65;
    viewer.camera.eye = [-3.93, 2.85, 27.01];
    viewer.camera.look = [4.4, 3.72, 8.89];
    viewer.camera.up = [-0.01, 0.99, 0.039];
    
    const safeTreeContainer = treeContainerRef.current || document.createElement('div');
    new TreeViewPlugin(viewer, {
      containerElement: safeTreeContainer,
      autoExpandDepth: 2,
      hierarchy: 'containment',
    });
    
    new NavCubePlugin(viewer, {
      canvasElement: navCubeCanvasRef.current,
      color: '#f8fafc',
      hoverColor: '#6366f1',
    });
    
    sectionPlanesRef.current = new SectionPlanesPlugin(viewer);
    loadersRef.current.xkt = new XKTLoaderPlugin(viewer);
    measurementsPluginRef.current = new DistanceMeasurementsPlugin(viewer, {
        containerElement: canvasRef.current.parentElement,
        distanceLineColor: '#22d3ee',      
        distanceLineThickness: 2,
        distanceLabelColor: '#ffffff',
        distanceLabelFillColor: '#4f46e5', 
        distancePointColor: '#22d3ee',
        distancePointThickness: 6,
        defaultHoverSurface: true
    });
    measurementsPluginRef.current.setAxisVisible(false);
    
    const initializeIFCEngine = async () => {
      try {
        const ifcAPI = new WebIFC.IfcAPI();
        ifcAPI.SetWasmPath('/');
        await ifcAPI.Init();
        loadersRef.current.ifc = new WebIFCLoaderPlugin(viewer, {
          WebIFC: WebIFC,
          IfcAPI: ifcAPI,
        });
      } catch (error) {
        console.error('[BIM Engine]   Failed to boot IFC Engine.', error);
      }
    };
    initializeIFCEngine();
    viewerRef.current = viewer;
    
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
      
      if (currentModelRef.current && entity.model.id !== currentModelRef.current.id) {
        viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
        const assetModel = viewer.scene.models[entity.model.id];
        if (assetModel) assetModel.selected = true;
        setSelectedAssetId(entity.model.id);
        buildStretchHandlesRef.current?.(stretchCtx, entity.model.id, true);
        
        const assetMetaObject = viewer.metaScene.metaObjects[entity.id];
        if (assetMetaObject) {
          const groupedProps = {};
          groupedProps['General Details'] = [
            { name: 'Element Name', value: assetMetaObject.name || 'Unnamed' },
            { name: 'IFC Class', value: assetMetaObject.type || 'Unknown' },
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
            id: entity.id,
            name: assetMetaObject.name || 'Unnamed Asset',
            type: assetMetaObject.type || 'Generic Furniture',
            groupedProperties: groupedProps,
          });
        } else {
          setSelectedObject(null);
        }
        return;
      }
      
      setSelectedAssetId(null);
      viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
      entity.selected = true;
      
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
          groupedProperties: groupedProps,
          offset: entity.offset || [0, 0, 0] 
        });
      }
    });
    
    const canvas = canvasRef.current;
    
    const onCanvasMouseDown = (e) => {
      const canvasPos = [e.offsetX, e.offsetY];
      const pick = viewer.scene.pick({ canvasPos, pickSurface: false });
      const meta = pick?.entity?._stretchMeta;

      if (!meta?.isStretchHandle) return;

      const mode = transformModeRef.current;
      if (meta.transformMode !== mode) return;

      e.stopPropagation();
      e.preventDefault();
      viewer.cameraControl.active = false;

      const { targetId, isAsset, type, axes } = meta;
      const targetObj = isAsset ? viewer.scene.models[targetId] : viewer.scene.objects[targetId];
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
        };
        isStretchingRef.current = true;
        setIsStretching(true);
        setActiveStretchData({ label: 'Rotate', x: e.clientX, y: e.clientY });
        return;
      }

      if (mode === 'stretch' && (type === 'face' || type === 'corner2d')) {
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

        stretchDragRef.current = {
          type: 'scale',
          axesList: axes,
          targetId,
          isAsset,
          startCanvasX: e.offsetX,
          startCanvasY: e.offsetY,
          startScale: [...(targetObj.scale || [1, 1, 1])],
          startPosition: isAsset ? [...(targetObj.position || [0, 0, 0])] : [...(targetObj.offset || [0, 0, 0])],
          startHalf,
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

      const drag = stretchDragRef.current;
      const rect = canvas.getBoundingClientRect();
      const curX = e.clientX - rect.left;
      const curY = e.clientY - rect.top;
      const targetObj = drag.isAsset ? viewer.scene.models[drag.targetId] : viewer.scene.objects[drag.targetId];
      if (!targetObj) return;

      if (drag.type === 'move') {
        const currentGrab = calculateGrabPoint(viewerRef, canvas, [curX, curY], drag.startPosition[1]);
        if (!currentGrab) return;

        const next = [
          drag.startPosition[0] + currentGrab[0] - drag.startGrab[0],
          drag.startPosition[1],
          drag.startPosition[2] + currentGrab[2] - drag.startGrab[2],
        ];

        if (drag.isAsset) targetObj.position = next;
        else targetObj.offset = next;

        setActiveStretchData({ label: 'Move', x: e.clientX, y: e.clientY });
        return;
      }

      if (drag.type === 'rotate') {
        const currentGrab = calculateGrabPoint(viewerRef, canvas, [curX, curY], drag.center[1]);
        if (!currentGrab) return;

        const startAngle = Math.atan2(
          drag.startGrab[2] - drag.center[2],
          drag.startGrab[0] - drag.center[0]
        );
        const currentAngle = Math.atan2(
          currentGrab[2] - drag.center[2],
          currentGrab[0] - drag.center[0]
        );

        let delta = (currentAngle - startAngle) * 180 / Math.PI;
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;

        const nextRotation = drag.startRotationY + delta;
        const currentRotation = targetObj.rotation ? [...targetObj.rotation] : [0, 0, 0];
        targetObj.rotation = [currentRotation[0], nextRotation, currentRotation[2]];

        setActiveStretchData({ label: `Rotate: ${nextRotation.toFixed(1)}°`, x: e.clientX, y: e.clientY });
        return;
      }

      const deltaScreenX = curX - drag.startCanvasX;
      const deltaScreenY = drag.startCanvasY - curY;
      const viewMatrix = viewer.scene.camera.viewMatrix;
      const s = [...drag.startScale];

      let nextPosition = [...drag.startPosition];

      drag.axesList.forEach(({ axis, dir }) => {
        const v = drag.localAxes[axis];
        const screenX = viewMatrix[0] * v[0] + viewMatrix[4] * v[1] + viewMatrix[8] * v[2];
        const screenY = viewMatrix[1] * v[0] + viewMatrix[5] * v[1] + viewMatrix[9] * v[2];
        const len = Math.hypot(screenX, screenY) || 1;
        const effectiveDelta = (deltaScreenX * screenX / len + deltaScreenY * screenY / len) * dir;
        s[axis] = Math.max(0.05, drag.startScale[axis] + effectiveDelta * 0.005);

        // Keep the opposite face anchored. The center moves along the
        // object's local axis, never along world X/Z after rotation.
        const startHalf = drag.startHalf[axis];
        const scaleRatio = s[axis] / (drag.startScale[axis] || 1);
        const halfDelta = startHalf * (scaleRatio - 1);
        nextPosition[0] += v[0] * halfDelta * dir;
        nextPosition[1] += v[1] * halfDelta * dir;
        nextPosition[2] += v[2] * halfDelta * dir;
      });

      applyScale(viewerRef, drag.targetId, drag.isAsset, s);
      if (drag.isAsset) targetObj.position = nextPosition;
      else targetObj.offset = nextPosition;

      const names = drag.axesList.map(({ axis }) => axis === 0 ? 'Width' : axis === 1 ? 'Height' : 'Depth');
      setActiveStretchData({
        label: `${names.join(' + ')}: ${drag.axesList.map(({ axis }) => s[axis].toFixed(2)).join(' × ')}`,
        x: e.clientX,
        y: e.clientY,
      });
    };

    const onDocMouseUp = () => {
      if (!isStretchingRef.current || !stretchDragRef.current) return;

      const drag = stretchDragRef.current;
      const targetObj = drag.isAsset ? viewer.scene.models[drag.targetId] : viewer.scene.objects[drag.targetId];

      if (targetObj && stretchPersistCallbackRef.current) {
        if (drag.type === 'move') {
          const position = drag.isAsset ? (targetObj.position || [0, 0, 0]) : (targetObj.offset || [0, 0, 0]);
          position.forEach((value, axis) => {
            stretchPersistCallbackRef.current(drag.targetId, 'position', axis, value);
          });
        } else if (drag.type === 'rotate') {
          stretchPersistCallbackRef.current(drag.targetId, 'rotation', 1, targetObj.rotation?.[1] || 0);
        } else {
          const scale = targetObj.scale || [1, 1, 1];
          drag.axesList.forEach(({ axis }) => {
            stretchPersistCallbackRef.current(drag.targetId, 'scale', axis, scale[axis]);
          });
        }
      }

      stretchDragRef.current = null;
      isStretchingRef.current = false;
      setIsStretching(false);
      setActiveStretchData(null);
      viewer.cameraControl.active = true;

      buildStretchHandlesRef.current?.(stretchCtx, drag.targetId, drag.isAsset);
      setTimeout(() => configureTransformHandles(transformModeRef.current), 0);
    };

    const onCanvasHoverMove = (e) => {
      if (isStretchingRef.current) return;
      if (!stretchHandlesRef.current.length) return;
      
      const pick = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY], pickSurface: false });
      const meta = pick?.entity?._stretchMeta;
      
      if (meta?.isStretchHandle) {
        if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current);
          hideTimeoutRef.current = null;
        }

        if (meta.type === 'face') {
          const { axis, dir } = meta.axes[0];
          const faceKey = `${axis}_${dir}`;
          if (revealedFaceKeyRef.current !== faceKey) {
            hideRevealedGroup(revealedFaceKeyRef, revealedHandlesRef, stretchAnimFramesRef);
            revealGroupForFace(faceKey, stretchFaceAdjacencyRef, revealedFaceKeyRef, revealedHandlesRef, stretchAnimFramesRef);
          }
        }

        if (hoveredStretchMeshRef.current !== pick.entity) {
          resetHoveredStretchHandle(hoveredStretchMeshRef, stretchAnimFramesRef);
          
          const hoverColor = brightenColor(meta.color);
          pick.entity.material.diffuse = hoverColor;
          pick.entity.material.emissive = hoverColor;
          
          animateHandleTo(pick.entity, stretchAnimFramesRef, { opacity: 1, scale: STRETCH_HANDLE_HOVER_SCALE });
          hoveredStretchMeshRef.current = pick.entity;
        }
        
        if (meta.type === 'rotate') {
          canvas.style.cursor = 'ew-resize';
        } else {
          canvas.style.cursor = cursorForAxes(meta.axes);
        }

      } else {
        if (hoveredStretchMeshRef.current) {
          resetHoveredStretchHandle(hoveredStretchMeshRef, stretchAnimFramesRef);
        }
        canvas.style.cursor = '';

        if (revealedFaceKeyRef.current && !hideTimeoutRef.current) {
          hideTimeoutRef.current = setTimeout(() => {
            hideRevealedGroup(revealedFaceKeyRef, revealedHandlesRef, stretchAnimFramesRef);
            hideTimeoutRef.current = null;
          }, 1200); 
        }
      }
    };
    
    canvas.addEventListener('mousedown', onCanvasMouseDown, { capture: true });
    canvas.addEventListener('mousemove', onCanvasHoverMove);
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    
    viewer.cameraControl.on('pickedNothing', () => {
      if (placementModeRef.current) { setPlacementMode(null); return; }
      viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
      setSelectedObject(null);
      setSelectedAssetId(null);
      destroyStretchHandlesRef.current?.(stretchCtx);
      stretchDragRef.current = null;
      isStretchingRef.current = false;
      setIsStretching(false);
      setActiveStretchData(null); 
      
      if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current);
          hideTimeoutRef.current = null;
      }
    });
    
    return () => {
      canvas.removeEventListener('mousedown', onCanvasMouseDown, { capture: true });
      canvas.removeEventListener('mousemove', onCanvasHoverMove);
      document.removeEventListener('mousemove', onDocMouseMove);
      document.removeEventListener('mouseup', onDocMouseUp);
      measurementsPluginRef.current = null;
      viewerRef.current = null;
      viewer.destroy();
    };
  }, []);

  useEffect(() => {
    if (viewerRef.current) viewerRef.current.cameraControl.navMode = navMode;
  }, [navMode]);
  
  useEffect(() => {
    if (!viewerRef.current) return;
    if (!file) {
      if (currentModelRef.current) { currentModelRef.current.destroy(); currentModelRef.current = null; }
      setSelectedObject(null);
      setSelectedAssetId(null);
      return;
    }
    const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const formData = new FormData();
    formData.append('file', file);
    
    fetch(`${API_BASE_URL}/api/projects/${jobId}/upload-ifc`, {
      method: 'POST',
      body: formData
    }).catch(err => console.error('[BIM Engine] Backend file sync failed:', err));
    
    setIsLoading(true);
    
    if (currentModelRef.current) currentModelRef.current.destroy();
    const fileExtension = file.name.split('.').pop().toLowerCase();
    
    const loadMainModel = (buffer) => {
      const ifcData = new Uint8Array(buffer);
      if (fileExtension === 'ifc' && loadersRef.current.ifc) {
        currentModelRef.current = loadersRef.current.ifc.load({
          id: 'main_structure',
          ifc: ifcData,
          edges: true,
          globalizeCoordinates: false,
        });
      } else if (fileExtension === 'xkt' && loadersRef.current.xkt) {
        currentModelRef.current = loadersRef.current.xkt.load({
          id: 'main_structure',
          xkt: buffer,
          edges: true,
        });
      } else {
        setIsLoading(false);
        return;
      }
      currentModelRef.current.on('loaded', async () => {
        viewerRef.current.cameraFlight.flyTo(currentModelRef.current);
        setIsLoading(false);
        if (projectStateRef.current.materials) {
          Object.entries(projectStateRef.current.materials).forEach(([entityId, matData]) => {
            const entity = viewerRef.current.scene.objects[entityId];
            if (entity) entity.colorize = matData.rgb;
          });
        }
        if (projectStateRef.current.furniture) {
          projectStateRef.current.furniture.forEach(item => {
            if (!viewerRef.current.scene.models[item.instanceId]) {
              loadIFCAssetIntoScene(loadersRef, globalScaleFactorRef, item.instanceId, item.src, item.position, item.rotation);
            }
          });
        }
        if (projectStateRef.current.structural_edits) {
          Object.entries(projectStateRef.current.structural_edits).forEach(([entityId, edit]) => {
            const entity = viewerRef.current.scene.objects[entityId];
            if (!entity) {
              console.warn(`[BIM Engine] Structural edit skipped, entity not found: ${entityId}`);
              return;
            }
            if (edit.scale) entity.scale = edit.scale;
            if (edit.offset) entity.offset = edit.offset;
            if (edit.visible === false) entity.visible = false;
          });
        }
      });
    };
    const reader = new FileReader();
    reader.onload = (e) => loadMainModel(e.target.result);
    reader.readAsArrayBuffer(file);
  }, [file]);

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
    viewerRef, currentModelRef, globalScaleFactorRef, setSceneScaleFactor,
    measurementsPluginRef, setMeasurementsList, setIsLoading,
    loadersRef, projectStateRef, file, inspectNativeElement
  };
  
  const assetCtx = {
    file, viewerRef, loadersRef, globalScaleFactorRef, setSelectedAssetId, setSelectedObject
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
      measurementsList,
      measurementUnit,
      snappingEnabled,
      axisBreakdownVisible,
      totalMeasuredLength: measurementsList.reduce((sum, m) => sum + m.lengthMeters, 0),
      sceneScaleFactor,
      isStretching,
      activeStretchData,
       transformMode,
    },
    actions: {
      toggleXRay,
      toggleClipping,
      setNavMode,
      setSelectedObject,
      setSelectedAssetId,
      setPlacementMode,
      loadIFCAssetIntoScene: (i, s, t, r) => loadIFCAssetIntoScene(loadersRef, globalScaleFactorRef, i, s, t, r),
      getDropPosition: (c, a) => getDropPosition(viewerRef, projectStateRef, c, a),
      getWallSnapData: (c) => getWallSnapData(viewerRef, c),
      toggleMeasurementMode: () => toggleMeasurementMode(isMeasuring, setIsMeasuring, setPlacementMode, setSelectedObject, setSelectedAssetId, viewerRef),
      clearMeasurements: () => clearMeasurements(measurementsPluginRef, setMeasurementsList),
      deleteMeasurement: (id) => deleteMeasurement(id, measurementsPluginRef, setMeasurementsList),
      scaleModelByMeasurement: (id, l) => scaleModelByMeasurement(calibrationCtx, id, l),
      calibrateWallHeight: (e, h) => calibrateWallHeight(calibrationCtx, e, h),
      flyToMeasurement: (m) => flyToMeasurement(viewerRef, m),
      toggleSnapping: () => toggleSnapping(measurementsPluginRef, snappingEnabled, setSnappingEnabled),
      toggleAxisBreakdown: () => toggleAxisBreakdown(measurementsPluginRef, axisBreakdownVisible, setAxisBreakdownVisible),
      setMeasurementUnit,
      formatLength: (m) => formatLength(m, measurementUnit),
      updateNativeOffset: (id, ax, val) => updateNativeOffset(viewerRef, id, ax, val),
      updateDynamicTransform: (id, t, ax, val) => updateDynamicTransform(viewerRef, id, t, ax, val),
      updateStructuralTransform: (id, t, ax, val) => updateStructuralTransform(viewerRef, id, t, ax, val),
      isolateAndMakeMoveable: (e, onA, uSE) => isolateAndMakeMoveable(assetCtx, e, onA, uSE),
      inspectNativeElement: (e) => inspectNativeElement(file, e),
      getCursorWorldPosition: (c) => getCursorWorldPosition(viewerRef, c),
      setIsLoading,
      buildStretchHandles: (e, a) => buildStretchHandles(stretchCtx, e, a),
      destroyStretchHandles: () => destroyStretchHandles(stretchCtx),
      setStretchPersistCallback: (fn) => { stretchPersistCallbackRef.current = fn; },
    },
  };
};