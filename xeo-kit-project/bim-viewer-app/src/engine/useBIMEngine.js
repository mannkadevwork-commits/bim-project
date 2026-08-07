import { useEffect, useRef, useState } from 'react';
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
      
      if (pick?.entity?._stretchMeta?.isStretchHandle) {
        e.stopPropagation();
        e.preventDefault();
        viewer.cameraControl.active = false;
        const meta = pick.entity._stretchMeta;
        const { axes, targetId, isAsset, type } = meta;
        
        // --- ROTATION HANDLER ---
        if (type === 'rotate') {
          const targetObj = isAsset ? viewer.scene.models[targetId] : viewer.scene.objects[targetId];
          const startRot = targetObj?.rotation ? [...targetObj.rotation] : [0, 0, 0];
          
          stretchDragRef.current = {
            type: 'rotate',
            targetId,
            isAsset,
            lastX: e.clientX,       // NEW: Frame-by-frame tracking origin
            currentRot: startRot[1] // NEW: Mutable running total
          };
          
          isStretchingRef.current = true;
          setIsStretching(true);
          
          stretchHandlesRef.current.forEach(mesh => {
            if (mesh === pick.entity) return;
            mesh.pickable = false;
            mesh.visible = false;
          });
          
          animateHandleTo(pick.entity, stretchAnimFramesRef, { opacity: 1, scale: STRETCH_HANDLE_DRAG_SCALE });
          return;
        }

        // --- SCALE HANDLER ---
        const getScale = (obj) => {
          if (!obj) return [1, 1, 1];
          const m = obj.matrix;
          if (!m || m.length < 11) return [1, 1, 1];
          const sx = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
          const sy = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
          const sz = Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);
          return [sx || 1, sy || 1, sz || 1];
        };
        
        let startScale, targetObj;
        if (isAsset) {
          targetObj = viewer.scene.models[targetId];
        } else {
          targetObj = viewer.scene.objects[targetId];
        }
        startScale = getScale(targetObj);
        const startPosition = targetObj?.position ? [...targetObj.position] : [0, 0, 0];
        
        let anchorWorld = null;
        if (axes.length === 1 && targetObj?.aabb) {
          const { axis, dir } = axes[0];
          anchorWorld = dir > 0 ? targetObj.aabb[axis] : targetObj.aabb[axis + 3];
        }
        
        stretchDragRef.current = { type: 'scale', axesList: axes, targetId, isAsset, startCanvasX: e.offsetX, startCanvasY: e.offsetY, startScale, startPosition, anchorWorld };
        isStretchingRef.current = true;
        setIsStretching(true);
        
        stretchHandlesRef.current.forEach(mesh => {
          if (mesh === pick.entity) return;
          if (mesh._stretchAnimId) {
            cancelAnimationFrame(mesh._stretchAnimId);
            stretchAnimFramesRef.current.delete(mesh._stretchAnimId);
            mesh._stretchAnimId = null;
          }
          mesh.pickable = false;
          mesh.visible = false;
        });
        
        animateHandleTo(pick.entity, stretchAnimFramesRef, { opacity: pick.entity._stretchMeta.restOpacity, scale: STRETCH_HANDLE_DRAG_SCALE });
      }
    };
    
    const onDocMouseMove = (e) => {
      if (!isStretchingRef.current || !stretchDragRef.current) return;
      const dragData = stretchDragRef.current;
      const rect = canvas.getBoundingClientRect();
      const curX = e.clientX - rect.left;

      // --- SMOOTH ROTATION HANDLER ---
      if (dragData.type === 'rotate') {
        const { targetId, isAsset, lastX, currentRot } = dragData;
        
        // Calculate only the distance moved since the last frame
        const deltaX = e.clientX - lastX;

        // Apply a multiplier (0.8 degrees per pixel is highly responsive)
        let newRotY = (currentRot + deltaX * 0.8) % 360;
        if (newRotY < 0) newRotY += 360;

        const targetObj = isAsset ? viewer.scene.models[targetId] : viewer.scene.objects[targetId];
        if (targetObj) {
            targetObj.rotation = [targetObj.rotation[0], newRotY, targetObj.rotation[2]];
        }

        // Save state for the next continuous frame
        dragData.lastX = e.clientX;
        dragData.currentRot = newRotY;

        setActiveStretchData({
            label: `Rotate: ${newRotY.toFixed(1)}°`,
            x: e.clientX,
            y: e.clientY
        });
        return; 
      }

      // --- SCALE HANDLER ---
      const { axesList, targetId, isAsset, startCanvasX, startCanvasY, startScale, startPosition, anchorWorld } = dragData;
      const curY = e.clientY - rect.top;
      const s = [...startScale];
      const targetObj = isAsset ? viewer.scene.models[targetId] : viewer.scene.objects[targetId];
      
      if (axesList.length === 1) {
        const { axis, dir } = axesList[0];
        const pixelDelta = axis === 1 ? (startCanvasY - curY) : (curX - startCanvasX);
        s[axis] = Math.max(0.05, startScale[axis] + pixelDelta * 0.005 * dir);
        
        if (anchorWorld !== null && startPosition && startScale[axis] !== 0) {
          if (targetObj) {
            const newPosition = [...(targetObj.position || startPosition)];
            newPosition[axis] = anchorWorld - (s[axis] / startScale[axis]) * (anchorWorld - startPosition[axis]);
            targetObj.position = newPosition;
          }
        }

        if (targetObj && targetObj.aabb) {
           const currentAABB = targetObj.aabb;
           const lengthMeters = Math.abs(currentAABB[axis + 3] - currentAABB[axis]);
           const axisName = axis === 0 ? 'Width' : axis === 1 ? 'Height' : 'Depth';
           setActiveStretchData({
               label: `${axisName}: ${lengthMeters.toFixed(2)}m`,
               x: e.clientX,
               y: e.clientY
           });
        }
      } else if (axesList.length === 2) {
        const sharedDelta = axesList.reduce((sum, { axis, dir }) => {
          const pixelDelta = axis === 1 ? (startCanvasY - curY) : (curX - startCanvasX);
          return sum + pixelDelta * dir;
        }, 0) / axesList.length;
        
        axesList.forEach(({ axis }) => {
          s[axis] = Math.max(0.05, startScale[axis] + sharedDelta * 0.005);
        });

        if (targetObj && targetObj.aabb) {
           const currentAABB = targetObj.aabb;
           const ax1 = axesList[0].axis;
           const ax2 = axesList[1].axis;
           const len1 = Math.abs(currentAABB[ax1 + 3] - currentAABB[ax1]);
           const len2 = Math.abs(currentAABB[ax2 + 3] - currentAABB[ax2]);
           const name1 = ax1 === 0 ? 'W' : ax1 === 1 ? 'H' : 'D';
           const name2 = ax2 === 0 ? 'W' : ax2 === 1 ? 'H' : 'D';
           setActiveStretchData({
               label: `${name1}: ${len1.toFixed(2)}m | ${name2}: ${len2.toFixed(2)}m`,
               x: e.clientX,
               y: e.clientY
           });
        }
      }
      applyScale(viewerRef, targetId, isAsset, s);
    };
    
    const onDocMouseUp = () => {
      if (!isStretchingRef.current || !stretchDragRef.current) return;
      const dragData = stretchDragRef.current;
      
      if (dragData.type === 'rotate') {
        const { targetId, isAsset } = dragData;
        const targetObj = isAsset ? viewer.scene.models[targetId] : viewer.scene.objects[targetId];
        const finalRotY = targetObj?.rotation ? targetObj.rotation[1] : 0;
        
        if (stretchPersistCallbackRef.current) {
          stretchPersistCallbackRef.current(targetId, 'rotation', 1, finalRotY);
        }
      } 
      else {
        const { axesList, targetId, isAsset } = dragData;
        const getScale = (obj) => {
          if (!obj) return [1, 1, 1];
          const m = obj.matrix;
          return [
            Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]),
            Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]),
            Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]),
          ];
        };
        const finalScale = isAsset
          ? getScale(viewer.scene.models[targetId])
          : getScale(viewer.scene.objects[targetId]);
          
        if (stretchPersistCallbackRef.current) {
          axesList.forEach(({ axis }) => {
            stretchPersistCallbackRef.current(targetId, 'scale', axis, finalScale[axis]);
          });
        }
      }
      
      stretchDragRef.current = null;
      isStretchingRef.current = false;
      setIsStretching(false);
      setActiveStretchData(null); 
      viewer.cameraControl.active = true;
      buildStretchHandlesRef.current?.(stretchCtx, dragData.targetId, dragData.isAsset);
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