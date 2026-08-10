import { useEffect, useRef, useState } from 'react';
import { Viewer } from '@xeokit/xeokit-sdk/src/viewer/Viewer';
import { XKTLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/XKTLoaderPlugin/XKTLoaderPlugin';
import { WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/WebIFCLoaderPlugin/WebIFCLoaderPlugin';
import { TreeViewPlugin } from '@xeokit/xeokit-sdk/src/plugins/TreeViewPlugin/TreeViewPlugin';
import { NavCubePlugin } from '@xeokit/xeokit-sdk/src/plugins/NavCubePlugin/NavCubePlugin';
import { SectionPlanesPlugin } from '@xeokit/xeokit-sdk/src/plugins/SectionPlanesPlugin/SectionPlanesPlugin';
import { DistanceMeasurementsPlugin } from '@xeokit/xeokit-sdk/src/plugins/DistanceMeasurementsPlugin/DistanceMeasurementsPlugin';
import { Mesh } from '@xeokit/xeokit-sdk/src/viewer/scene/mesh/Mesh';
import { ReadableGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/ReadableGeometry';
import { buildBoxGeometry } from '@xeokit/xeokit-sdk/src/viewer/scene/geometry/builders/buildBoxGeometry';
import { PhongMaterial } from '@xeokit/xeokit-sdk/src/viewer/scene/materials/PhongMaterial';
import * as WebIFC from 'web-ifc';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const AXIS_NAMES = ['X', 'Y', 'Z'];
const AXIS_HANDLE_COLORS = {
  X: [0.95, 0.25, 0.25],
  Y: [0.25, 0.85, 0.35],
  Z: [0.3, 0.5, 0.95],
  XY: [0.95, 0.85, 0.25],
  XZ: [0.9, 0.35, 0.9],
  YZ: [0.25, 0.85, 0.9],
  XYZ: [0.95, 0.95, 0.95],
};
const STRETCH_HANDLE_FACE_OPACITY = 0.85;
const STRETCH_HANDLE_EDGE_OPACITY = 0.5;
const STRETCH_HANDLE_CORNER_OPACITY = 0.3;
const STRETCH_HANDLE_HOVER_SCALE = 1.22;
const STRETCH_HANDLE_DRAG_SCALE = 1.38;
const STRETCH_HANDLE_ANIM_MS = 150;
const brightenColor = (color, factor = 1.25) => color.map(c => Math.min(1, c * factor));
const axesKey = (axesList) =>
  [...axesList].sort((a, b) => a.axis - b.axis).map(a => AXIS_NAMES[a.axis]).join('');
const SELECTION_CAGE_COLOR = [0.35, 0.62, 1];

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

  // Stretch handle state
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
  const [isStretching, setIsStretching] = useState(false);
  const buildStretchHandlesRef = useRef(null);
  const destroyStretchHandlesRef = useRef(null);

  const [isMeasuring, setIsMeasuring] = useState(false);
  const [measurementsList, setMeasurementsList] = useState([]); 
  const [measurementUnit, setMeasurementUnit] = useState('m'); 
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [axisBreakdownVisible, setAxisBreakdownVisible] = useState(false);
  const measurementPollRef = useRef(null);

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
        syncMeasurementsList();
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
        console.error('[BIM Engine] ❌ Failed to boot IFC Engine.', error);
      }
    };

    initializeIFCEngine();
    viewerRef.current = viewer;

    viewer.cameraControl.on('picked', (pickResult) => {
      if (isMeasuringRef.current) return;
      // If a stretch handle was clicked, don't re-select — the pointerdown handler owns this
      if (pickResult.entity?._stretchMeta?.isStretchHandle) return;

      if (placementModeRef.current) {
        if (placementModeRef.current.type === 'door') {
          // Re-pick at this exact canvas position with pickSurface:true —
          // the automatic cameraControl pick above doesn't include
          // worldNormal, and we need it to confirm this is a wall.
          const wallSnap = getWallSnapData(pickResult.canvasPos);
          if (!wallSnap) {
            // Deliberately a no-op rather than falling back to floor
            // placement: a door dropped off a wall has no host element
            // for the Phase 3 CSG cut, so silently placing it would
            // create an unresolvable asset. Left as a hook for the UI
            // to show a "click on a wall" toast.
            return;
          }
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
        buildStretchHandlesRef.current?.(entity.model.id, true);

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
      // Native IFC entities cannot be individually scaled (geometry is GPU-baked)
      // Only show stretch handles for dropped asset models

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
          // NEW: Capture native entity offset for translation
          offset: entity.offset || [0, 0, 0] 
        });
      }
    });

    // ── Stretch handle mouse events (native listeners, bypass cameraControl) ──
    const canvas = canvasRef.current;

    const onCanvasMouseDown = (e) => {
      const canvasPos = [e.offsetX, e.offsetY];
      const pick = viewer.scene.pick({ canvasPos, pickSurface: false });
      if (pick?.entity?._stretchMeta?.isStretchHandle) {
        e.stopPropagation();
        e.preventDefault();
        viewer.cameraControl.active = false;
        const meta = pick.entity._stretchMeta;
        const { axes, targetId, isAsset } = meta;
        // Read current scale: from matrix diagonal if matrix was set, else from _scale via position setter path
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

        stretchDragRef.current = { axesList: axes, targetId, isAsset, startCanvasX: e.offsetX, startCanvasY: e.offsetY, startScale, startPosition, anchorWorld };
        isStretchingRef.current = true;
        setIsStretching(true);

        hideRevealedGroup();
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
        animateHandleTo(pick.entity, { opacity: pick.entity._stretchMeta.restOpacity, scale: STRETCH_HANDLE_DRAG_SCALE });
      }
    };

    const applyScale = (targetId, isAsset, scaleVec) => {
      const [sx, sy, sz] = scaleVec;
      // SceneModel.scale setter is a NOP (deprecated) — must use model.matrix
      // Compose scale + existing translation so position is preserved
      if (isAsset) {
        const model = viewer.scene.models[targetId];
        if (!model) return;
        const p = model.position || [0, 0, 0];
        model.matrix = [
          sx, 0,  0,  0,
          0,  sy, 0,  0,
          0,  0,  sz, 0,
          p[0], p[1], p[2], 1,
        ];
      } else {
        const entity = viewer.scene.objects[targetId];
        if (!entity) return;
        const p = entity.position || [0, 0, 0];
        entity.matrix = [
          sx, 0,  0,  0,
          0,  sy, 0,  0,
          0,  0,  sz, 0,
          p[0], p[1], p[2], 1,
        ];
      }
    };

    const onDocMouseMove = (e) => {
      if (!isStretchingRef.current || !stretchDragRef.current) return;
      const { axesList, targetId, isAsset, startCanvasX, startCanvasY, startScale, startPosition, anchorWorld } = stretchDragRef.current;
      const rect = canvas.getBoundingClientRect();
      const curX = e.clientX - rect.left;
      const curY = e.clientY - rect.top;
      const s = [...startScale];
      if (axesList.length === 1) {
        const { axis, dir } = axesList[0];
        const pixelDelta = axis === 1 ? (startCanvasY - curY) : (curX - startCanvasX);
        s[axis] = Math.max(0.05, startScale[axis] + pixelDelta * 0.005 * dir);

        if (anchorWorld !== null && startPosition && startScale[axis] !== 0) {
          const target = isAsset ? viewer.scene.models[targetId] : viewer.scene.objects[targetId];
          if (target) {
            const newPosition = [...(target.position || startPosition)];
            newPosition[axis] = anchorWorld - (s[axis] / startScale[axis]) * (anchorWorld - startPosition[axis]);
            target.position = newPosition;
          }
        }
      } else {
        const sharedDelta = axesList.reduce((sum, { axis, dir }) => {
          const pixelDelta = axis === 1 ? (startCanvasY - curY) : (curX - startCanvasX);
          return sum + pixelDelta * dir;
        }, 0) / axesList.length;
        axesList.forEach(({ axis }) => {
          s[axis] = Math.max(0.05, startScale[axis] + sharedDelta * 0.005);
        });
      }
      applyScale(targetId, isAsset, s);
    };

    const onDocMouseUp = () => {
      if (!isStretchingRef.current || !stretchDragRef.current) return;
      const { axesList, targetId, isAsset } = stretchDragRef.current;
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
      stretchDragRef.current = null;
      isStretchingRef.current = false;
      setIsStretching(false);
      viewer.cameraControl.active = true;
      buildStretchHandlesRef.current?.(targetId, isAsset);
    };

    const resetHoveredStretchHandle = () => {
      const prev = hoveredStretchMeshRef.current;
      if (prev) {
        try {
          const base = prev._stretchMeta?.color || AXIS_HANDLE_COLORS.X;
          prev.material.diffuse = base;
          prev.material.emissive = base;
          const restOpacity = prev._stretchMeta?.restOpacity ?? STRETCH_HANDLE_FACE_OPACITY;
          animateHandleTo(prev, { opacity: restOpacity, scale: 1 });
        } catch (_) {}
        hoveredStretchMeshRef.current = null;
      }
    };

    const cursorForAxes = (axesList) => {
      if (axesList.length === 1) {
        const { axis } = axesList[0];
        return axis === 1 ? 'ns-resize' : axis === 0 ? 'ew-resize' : 'nwse-resize';
      }
      if (axesList.length === 2) {
        const key = axesKey(axesList);
        if (key === 'XY') {
          const x = axesList.find(a => a.axis === 0).dir;
          const y = axesList.find(a => a.axis === 1).dir;
          return (x * y > 0) ? 'nwse-resize' : 'nesw-resize';
        }
        return 'move';
      }
      return 'move';
    };

    const onCanvasHoverMove = (e) => {
      if (isStretchingRef.current) return;
      if (!stretchHandlesRef.current.length) return;
      const pick = viewer.scene.pick({ canvasPos: [e.offsetX, e.offsetY], pickSurface: false });
      const meta = pick?.entity?._stretchMeta;
      if (meta?.isStretchHandle) {
        if (meta.type === 'face') {
          const { axis, dir } = meta.axes[0];
          const faceKey = axisDirKey(axis, dir);
          if (revealedFaceKeyRef.current !== faceKey) {
            hideRevealedGroup();
            revealGroupForFace(faceKey);
          }
        }
        if (hoveredStretchMeshRef.current !== pick.entity) {
          resetHoveredStretchHandle();
          const hoverColor = brightenColor(meta.color);
          pick.entity.material.diffuse = hoverColor;
          pick.entity.material.emissive = hoverColor;
          animateHandleTo(pick.entity, { opacity: 1, scale: STRETCH_HANDLE_HOVER_SCALE });
          hoveredStretchMeshRef.current = pick.entity;
        }
        canvas.style.cursor = cursorForAxes(meta.axes);
      } else {
        if (hoveredStretchMeshRef.current) {
          resetHoveredStretchHandle();
        }
        hideRevealedGroup();
        canvas.style.cursor = '';
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
      destroyStretchHandlesRef.current?.();
      stretchDragRef.current = null;
      isStretchingRef.current = false;
      setIsStretching(false);
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


    // ── NEW: Silently sync the file to the backend so Python has physical access to it ──
    const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const formData = new FormData();
    formData.append('file', file);
    
    fetch(`${API_BASE_URL}/api/projects/${jobId}/upload-ifc`, {
      method: 'POST',
      body: formData
    }).catch(err => console.error('[BIM Engine] Backend file sync failed:', err));
    // ────────────────────────────────────────────────────────────────────────────────────

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
              loadIFCAssetIntoScene(item.instanceId, item.src, item.position, item.rotation);
            }
          });
        }

        // ── Delta-Based State Management ──────────────────────────────
        // input.ifc is read-only. Re-apply every saved structural edit
        // (scale ratio / offset) visually against the freshly loaded
        // native entities — nothing on disk was ever touched.
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

  const toggleMeasurementMode = () => {
    const nextState = !isMeasuring;
    setIsMeasuring(nextState);
    if (nextState) {
        setPlacementMode(null);
        setSelectedObject(null);
        setSelectedAssetId(null);
        if (viewerRef.current) viewerRef.current.scene.setObjectsSelected(viewerRef.current.scene.selectedObjectIds, false);
    }
  };

  const clearMeasurements = () => {
    if (measurementsPluginRef.current) {
        measurementsPluginRef.current.clear();
    }
    setMeasurementsList([]);
  };

  const vec3Distance = (a, b) => {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

const syncMeasurementsList = () => {
    const plugin = measurementsPluginRef.current;
    if (!plugin || !plugin.measurements) return;

    const next = Object.values(plugin.measurements)
      .map((m) => {
        const originPos = m.origin?.worldPos;
        const targetPos = m.target?.worldPos;
        if (!originPos || !targetPos) return null;

        // CRITICAL: Capture the model ID of the entity that was clicked
        const modelId = m.origin?.entity?.model?.id || m.target?.entity?.model?.id || null;

        return {
          id: m.id,
          lengthMeters: vec3Distance(originPos, targetPos),
          modelId: modelId, 
          midpoint: [
            (originPos[0] + targetPos[0]) / 2,
            (originPos[1] + targetPos[1]) / 2,
            (originPos[2] + targetPos[2]) / 2,
          ],
        };
      })
      .filter(Boolean);

    setMeasurementsList(next);
  };

  const deleteMeasurement = (id) => {
    const plugin = measurementsPluginRef.current;
    if (!plugin) return;
    plugin.destroyMeasurement(id);
    syncMeasurementsList();
  };

// ── Shared global scaling engine ────────────────────────────────────
// Applies a per-axis ratio [rx, ry, rz] to the ENTIRE scene (main
// structure + every dropped asset), pivoting around the main structure's
// current visual center so nothing rockets off-screen, then re-frames
// the camera on the result. Both calibration flows below route through
// this single function so there's exactly one place scene-scale bugs
// can hide.
const applyGlobalScale = (ratioVec) => {
  const viewer = viewerRef.current;
  const mainModel = currentModelRef.current;
  if (!viewer || !mainModel) return false;

  const [rx, ry, rz] = ratioVec;
  if (![rx, ry, rz].every((r) => r > 0 && isFinite(r))) return false;

  const aabb = mainModel.aabb; // [xmin,ymin,zmin,xmax,ymax,zmax]
  const pivot = [
    (aabb[0] + aabb[3]) / 2,
    (aabb[1] + aabb[4]) / 2,
    (aabb[2] + aabb[5]) / 2,
  ];

  const scalePositionAboutPivot = (pos) => [
    pivot[0] + (pos[0] - pivot[0]) * rx,
    pivot[1] + (pos[1] - pivot[1]) * ry,
    pivot[2] + (pos[2] - pivot[2]) * rz,
  ];

  const mainScale = mainModel.scale || [1, 1, 1];
  mainModel.scale = [mainScale[0] * rx, mainScale[1] * ry, mainScale[2] * rz];
  mainModel.position = scalePositionAboutPivot(mainModel.position || [0, 0, 0]);

  const scene = viewer.scene;
  Object.keys(scene.models).forEach((id) => {
    if (id === mainModel.id) return;
    const assetModel = scene.models[id];
    if (!assetModel) return;
    const s = assetModel.scale || [1, 1, 1];
    assetModel.scale = [s[0] * rx, s[1] * ry, s[2] * rz];
    assetModel.position = scalePositionAboutPivot(assetModel.position || [0, 0, 0]);
  });

  globalScaleFactorRef.current = {
    x: globalScaleFactorRef.current.x * rx,
    y: globalScaleFactorRef.current.y * ry,
    z: globalScaleFactorRef.current.z * rz,
  };
  setSceneScaleFactor({ ...globalScaleFactorRef.current });

  // Old ruler lines no longer reflect real-world distance now that the
  // scene resized underneath them.
  const plugin = measurementsPluginRef.current;
  if (plugin) plugin.clear();
  setMeasurementsList([]);

  // NEW: re-frame the camera on the resized model. Without this, a
  // scene that shrinks around a pivot away from the camera's look-at
  // point reads as "it moved" rather than "it resized" — which is
  // exactly the bug from your screenshots.
  viewer.cameraFlight.duration = 0.6;
  viewer.cameraFlight.flyTo(mainModel);

  return true;
};

// Uniform "fix import scale" calibration — draw a ruler line, type its
// real-world length. Use this when the whole model came in at the wrong
// units (e.g. an IFC authored in millimeters loaded as if it were meters).
// ── CORE GLOBAL CALIBRATION ENGINE (The Coohom Way) ───────────────────
  // Helper to destroy and reload the main model after the backend scales it
  const reloadMainModel = async (jobId) => {
    setIsLoading(true);
    try {
      const ifcRes = await fetch(`${API_BASE_URL}/jobs/${jobId}/input.ifc?v=${Date.now()}`);
      const buffer = await ifcRes.arrayBuffer();
      
      if (currentModelRef.current) {
        currentModelRef.current.destroy();
        currentModelRef.current = null;
      }
      
      currentModelRef.current = loadersRef.current.ifc.load({
        id: 'main_structure',
        ifc: new Uint8Array(buffer),
        edges: true,
        globalizeCoordinates: false, // Ensures we can still mutate it later if needed
      });
      
      currentModelRef.current.on('loaded', () => {
        const viewer = viewerRef.current;
        // Fly camera to match the new size of the house
        viewer.cameraFlight.duration = 0.6;
        viewer.cameraFlight.flyTo(currentModelRef.current);
        setIsLoading(false);
        
        if (projectStateRef.current.materials) {
          Object.entries(projectStateRef.current.materials).forEach(([entityId, matData]) => {
            const entity = viewer.scene.objects[entityId];
            if (entity) entity.colorize = matData.rgb;
          });
        }
      });
    } catch (err) {
      console.error('[BIM Engine] Failed to reload main model:', err);
      setIsLoading(false);
    }
  };

  const updateFurnitureScale = (ratio) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    
    // Scale existing dropped assets visually and positionally
    Object.keys(viewer.scene.models).forEach((id) => {
      if (id === 'main_structure') return; 
      const assetModel = viewer.scene.models[id];
      if (!assetModel) return;

      const currentScale = assetModel.scale || [1, 1, 1];
      assetModel.scale = [currentScale[0] * ratio, currentScale[1] * ratio, currentScale[2] * ratio];

      const currentPos = assetModel.position || [0, 0, 0];
      assetModel.position = [currentPos[0] * ratio, currentPos[1] * ratio, currentPos[2] * ratio];
    });

    // Save scale memory for FUTURE dropped assets
    globalScaleFactorRef.current = {
      x: globalScaleFactorRef.current.x * ratio,
      y: globalScaleFactorRef.current.y * ratio,
      z: globalScaleFactorRef.current.z * ratio,
    };
    setSceneScaleFactor({ ...globalScaleFactorRef.current });
  };

  // 1. Rescale using the Ruler Line
  const scaleModelByMeasurement = async (measurementId, newDesiredLengthInMeters) => {
    if (!file) return { success: false, error: 'No active file.' };
    const plugin = measurementsPluginRef.current;
    if (!plugin || !plugin.measurements) return { success: false, error: 'No active measurement.' };

    const measurement = plugin.measurements[measurementId];
    if (!measurement || !measurement.origin || !measurement.target) return { success: false };

    const originPos = measurement.origin.worldPos;
    const targetPos = measurement.target.worldPos;
    const dx = originPos[0] - targetPos[0];
    const dy = originPos[1] - targetPos[1];
    const dz = originPos[2] - targetPos[2];
    const currentLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    if (!currentLength) return { success: false, error: 'Measurement is zero.' };

    const ratio = parseFloat(newDesiredLengthInMeters) / currentLength;
    if (!ratio || ratio <= 0 || !isFinite(ratio)) return { success: false, error: 'Enter a valid length.' };

    const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    setIsLoading(true);

    try {
      // Send command to python backend to rewrite the IFC
      const response = await fetch(`${API_BASE_URL}/api/projects/${jobId}/rescale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factor: ratio })
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error);

      // Reload the newly scaled architectural file & update existing furniture
      await reloadMainModel(jobId);
      updateFurnitureScale(ratio);

      plugin.clear();
      setMeasurementsList([]);
      return { success: true };
    } catch (error) {
      console.error('[BIM Engine] Global Rescale Error:', error);
      setIsLoading(false);
      return { success: false, error: 'Failed to process calibration.' };
    }
  };

  // 2. Rescale using the Right Panel (Typing a new Wall Height)
  const calibrateWallHeight = async (entityId, newHeightMeters) => {
    if (!file || !entityId) return { success: false, error: 'No element selected.' };
    const target = parseFloat(newHeightMeters);
    if (!target || target <= 0) return { success: false, error: 'Enter a height greater than 0.' };

    try {
      const dims = await inspectNativeElement(entityId);
      if (!dims || dims.error || !dims.height) {
        return { success: false, error: 'Element has no parametric height.' };
      }
      const ratio = target / dims.height;
      const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      
      setIsLoading(true);
      console.log(`API data ${ratio} ${jobId}`);
      const response = await fetch(`${API_BASE_URL}/api/projects/${jobId}/rescale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factor: ratio }) // Uniform scale so everything remains proportionate
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error);

      await reloadMainModel(jobId);
      updateFurnitureScale(ratio);
      
      return { success: true };
    } catch (err) {
      console.error('[BIM Engine] Height calibration failed:', err);
      setIsLoading(false);
      return { success: false, error: 'Height calibration failed.' };
    }
  };

  const flyToMeasurement = (midpoint) => {
    const viewer = viewerRef.current;
    if (!viewer || !midpoint) return;
    const pad = 1.5;
    viewer.cameraFlight.flyTo({
      aabb: [
        midpoint[0] - pad, midpoint[1] - pad, midpoint[2] - pad,
        midpoint[0] + pad, midpoint[1] + pad, midpoint[2] + pad,
      ],
      duration: 0.6,
    });
  };

  const toggleSnapping = () => {
    const control = measurementsPluginRef.current?.control;
    const next = !snappingEnabled;
    if (control) {
      control.snapToVertex = next;
      control.snapToEdge = next;
    }
    setSnappingEnabled(next);
  };

  const toggleAxisBreakdown = () => {
    const plugin = measurementsPluginRef.current;
    const next = !axisBreakdownVisible;
    if (plugin) {
      plugin.setAxisVisible(next); 
    }
    setAxisBreakdownVisible(next);
  };

  const formatLength = (meters) => {
    if (measurementUnit === 'ft') {
      return `${(meters * 3.28084).toFixed(2)} ft`;
    }
    return `${meters.toFixed(2)} m`;
  };

  const totalMeasuredLength = measurementsList.reduce((sum, m) => sum + m.lengthMeters, 0);

  const resolveCollisionFreePosition = (pos, minDistance = 0.9) => {
    const furniture = projectStateRef.current.furniture || [];
    let [x, y, z] = pos;

    const isClear = (px, pz) =>
      furniture.every(f => {
        const dx = (f.position?.[0] ?? 0) - px;
        const dz = (f.position?.[2] ?? 0) - pz;
        return Math.sqrt(dx * dx + dz * dz) >= minDistance;
      });

    let attempt = 0;
    const maxAttempts = 24;
    while (!isClear(x, z) && attempt < maxAttempts) {
      attempt++;
      const angle = attempt * 0.8;   
      const radius = 0.3 * attempt;
      x = pos[0] + Math.cos(angle) * radius;
      z = pos[2] + Math.sin(angle) * radius;
    }

    return [x, y, z];
  };

  // NOTE: `assetType` is new and optional. Every existing caller that
  // passes just `canvasPos` gets the exact same [x,y,z] array back as
  // before — furniture placement is untouched. Only `assetType ===
  // 'door'` takes the new branch, and it returns a different (richer)
  // shape: { position, rotation, wallGlobalId, snapped } instead of a
  // bare array, since callers need the rotation + wall id too. Wiring
  // the drag-drop UI to read this new shape for doors is outside
  // useBIMEngine.js (that's your drop handler component) — flagging so
  // it doesn't get missed.
  const getDropPosition = (canvasPos, assetType = null) => {
    const viewer = viewerRef.current;
    if (!viewer) return assetType === 'door' ? { position: [0, 0, 0], rotation: [0, 0, 0], wallGlobalId: null, snapped: false } : [0, 0, 0];

    if (assetType === 'door') {
      const wallSnap = getWallSnapData(canvasPos);
      if (wallSnap) {
        return { ...wallSnap, snapped: true };
      }
      // No wall under the cursor — surface a non-snapped fallback so
      // the drop UI can render a "no wall here" cue instead of
      // silently placing on the floor like furniture would.
      const cursorPick = viewer.scene.pick({ canvasPos, pickSurface: true });
      return {
        position: cursorPick?.worldPos
          ? [cursorPick.worldPos[0], cursorPick.worldPos[1], cursorPick.worldPos[2]]
          : [viewer.camera.look[0], 0, viewer.camera.look[2]],
        rotation: [0, 0, 0],
        wallGlobalId: null,
        snapped: false,
      };
    }

    const cursorPick = viewer.scene.pick({
      canvasPos: canvasPos,
      pickSurface: true,
    });

    let x = cursorPick?.worldPos?.[0] ?? viewer.camera.look[0];
    let z = cursorPick?.worldPos?.[2] ?? viewer.camera.look[2];
    let y = 0;

    const floorPick = viewer.scene.pick({
      origin: [x, 1000, z],
      direction: [0, -1, 0],
      pickSurface: true,
    });

    if (floorPick?.worldPos && floorPick?.worldNormal && floorPick.worldNormal[1] > 0.7) {
      x = floorPick.worldPos[0];
      y = floorPick.worldPos[1];
      z = floorPick.worldPos[2];
    }
    
    return resolveCollisionFreePosition([x, y, z]);
  };

const getCursorWorldPosition = (canvasPos) => {
    const viewer = viewerRef.current;
    if (!viewer) return null;

    const cursorPick = viewer.scene.pick({
      canvasPos: canvasPos,
      pickSurface: true,
    });

    return cursorPick?.worldPos || null;
  };

  // ── Phase 1: Door Wall-Snapping ─────────────────────────────────────
  // Distinct from getDropPosition's floor-snap. A door must land ON a
  // vertical wall face, not the floor, and needs the wall's GlobalId so
  // Phase 2/3 know which native IFC element to CSG-cut. We re-pick at
  // the given canvasPos with pickSurface:true (same reason floorPick
  // does its own separate pick above — the raw cameraControl 'picked'
  // event doesn't carry worldNormal).
  //
  // Convention check (please verify visually before wiring Phase 2):
  // rotationY = atan2(normal.x, normal.z) assumes the door asset's
  // unrotated (Y=0) forward axis is +Z, matching how your furniture
  // rotations are authored (e.g. tv_unit at [0,180,0] to face the
  // opposite way). If door assets face a different local axis at
  // rest, flip the sign or add 180.
  const WALL_IFC_CLASSES = new Set(['IfcWall', 'IfcWallStandardCase', 'IfcCurtainWall']);

  const getWallSnapData = (canvasPos) => {
    const viewer = viewerRef.current;
    if (!viewer || !canvasPos) return null;

    const wallPick = viewer.scene.pick({
      canvasPos,
      pickSurface: true,
    });

    if (!wallPick?.worldPos || !wallPick?.worldNormal || !wallPick?.entity) {
      return null;
    }

    const normal = wallPick.worldNormal;

    // Vertical wall face = normal lies (mostly) flat in the XZ plane.
    // Mirrors the floor check above (worldNormal[1] > 0.7 ⇒ floor);
    // here we want the opposite — near-zero Y component.
    const horizontalMag = Math.sqrt(normal[0] * normal[0] + normal[2] * normal[2]);
    const isVertical = Math.abs(normal[1]) < 0.25 && horizontalMag > 0.9;
    if (!isVertical) return null;

    const metaObject = viewer.metaScene.metaObjects[wallPick.entity.id];
    if (!metaObject || !WALL_IFC_CLASSES.has(metaObject.type)) {
      return null;
    }

    const rotationYRad = Math.atan2(normal[0], normal[2]);
    const rotationYDeg = rotationYRad * (180 / Math.PI);

    return {
      position: [wallPick.worldPos[0], wallPick.worldPos[1], wallPick.worldPos[2]],
      rotation: [0, rotationYDeg, 0],
      wallGlobalId: wallPick.entity.id,
      wallNormal: [normal[0], normal[1], normal[2]],
    };
  };

  // ── Stretch Handles ─────────────────────────────────────────────────
  const destroySelectionCage = () => {
    if (selectionCageRef.current) {
      try { selectionCageRef.current.destroy(); } catch (_) {}
      selectionCageRef.current = null;
    }
  };

  const buildSelectionCage = (aabb) => {
    destroySelectionCage();
    const viewer = viewerRef.current;
    if (!viewer || !aabb) return;
    const [xMin, yMin, zMin, xMax, yMax, zMax] = aabb;
    const positions = [
      xMin, yMin, zMin,  xMax, yMin, zMin,  xMax, yMax, zMin,  xMin, yMax, zMin,
      xMin, yMin, zMax,  xMax, yMin, zMax,  xMax, yMax, zMax,  xMin, yMax, zMax,
    ];
    const indices = [
      0, 1, 1, 2, 2, 3, 3, 0,
      4, 5, 5, 6, 6, 7, 7, 4,
      0, 4, 1, 5, 2, 6, 3, 7,
    ];
    selectionCageRef.current = new Mesh(viewer.scene, {
      id: `sel_cage_${Date.now()}`,
      geometry: new ReadableGeometry(viewer.scene, {
        primitive: 'lines',
        positions,
        indices,
      }),
      material: new PhongMaterial(viewer.scene, {
        diffuse: SELECTION_CAGE_COLOR,
        emissive: SELECTION_CAGE_COLOR,
        lineWidth: 1,
      }),
      pickable: false,
      collidable: false,
    });
  };

  const axisDirKey = (axis, dir) => `${axis}_${dir}`;

  const animateHandleTo = (mesh, { opacity, scale, onComplete }) => {
    if (!mesh) return;
    if (mesh._stretchAnimId) {
      cancelAnimationFrame(mesh._stretchAnimId);
      stretchAnimFramesRef.current.delete(mesh._stretchAnimId);
      mesh._stretchAnimId = null;
    }
    const startOpacity = mesh.material.opacity;
    const startScale = Array.isArray(mesh.scale) ? mesh.scale[0] : 1;
    const startTime = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - startTime) / STRETCH_HANDLE_ANIM_MS);
      try {
        mesh.material.opacity = startOpacity + (opacity - startOpacity) * t;
        const s = startScale + (scale - startScale) * t;
        mesh.scale = [s, s, s];
      } catch (_) {
        stretchAnimFramesRef.current.delete(mesh._stretchAnimId);
        mesh._stretchAnimId = null;
        return;
      }
      if (t < 1) {
        mesh._stretchAnimId = requestAnimationFrame(tick);
        stretchAnimFramesRef.current.add(mesh._stretchAnimId);
      } else {
        mesh._stretchAnimId = null;
        if (onComplete) onComplete();
      }
    };
    mesh._stretchAnimId = requestAnimationFrame(tick);
    stretchAnimFramesRef.current.add(mesh._stretchAnimId);
  };

  const revealGroupForFace = (faceKey) => {
    const group = stretchFaceAdjacencyRef.current.get(faceKey) || [];
    group.forEach(mesh => {
      mesh.visible = true;
      mesh.pickable = true;
      animateHandleTo(mesh, { opacity: mesh._stretchMeta.restOpacity, scale: 1 });
    });
    revealedFaceKeyRef.current = faceKey;
    revealedHandlesRef.current = group;
  };

  const hideRevealedGroup = () => {
    if (!revealedFaceKeyRef.current) return;
    revealedHandlesRef.current.forEach(mesh => {
      mesh.pickable = false;
      animateHandleTo(mesh, { opacity: 0, scale: 1, onComplete: () => { try { mesh.visible = false; } catch (_) {} } });
    });
    revealedFaceKeyRef.current = null;
    revealedHandlesRef.current = [];
  };

  const destroyStretchHandles = () => {
    stretchAnimFramesRef.current.forEach(id => cancelAnimationFrame(id));
    stretchAnimFramesRef.current.clear();
    stretchHandlesRef.current.forEach(mesh => { try { mesh.destroy(); } catch (_) {} });
    stretchHandlesRef.current = [];
    destroySelectionCage();
    hoveredStretchMeshRef.current = null;
    revealedFaceKeyRef.current = null;
    revealedHandlesRef.current = [];
    stretchFaceAdjacencyRef.current = new Map();
    if (canvasRef.current) canvasRef.current.style.cursor = '';
  };
  destroyStretchHandlesRef.current = destroyStretchHandles;

  const buildStretchHandles = (entityId, isAsset) => {
    destroyStretchHandles();
    const viewer = viewerRef.current;
    if (!viewer) return;

    let aabb;
    if (isAsset) {
      const model = viewer.scene.models[entityId];
      if (!model) return;
      aabb = model.aabb;
    } else {
      const entity = viewer.scene.objects[entityId];
      if (!entity) return;
      aabb = entity.aabb;
    }
    if (!aabb) return;

    buildSelectionCage(aabb);

    const [xMin, yMin, zMin, xMax, yMax, zMax] = aabb;
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    const cz = (zMin + zMax) / 2;
    const AXIS_MIN = [xMin, yMin, zMin];
    const AXIS_MAX = [xMax, yMax, zMax];
    const AXIS_CENTER = [cx, cy, cz];
    const pointFor = (axesList) => {
      const p = [...AXIS_CENTER];
      axesList.forEach(({ axis, dir }) => { p[axis] = dir > 0 ? AXIS_MAX[axis] : AXIS_MIN[axis]; });
      return p;
    };

    const FACE_SIZE = { 0: [0.07, 0.22, 0.07], 1: [0.22, 0.07, 0.07], 2: [0.22, 0.07, 0.07] };
    const EDGE_SIZE = [0.075, 0.075, 0.075];
    const CORNER_SIZE = [0.05, 0.05, 0.05];

    const handleDefs = [];

    for (let axis = 0; axis < 3; axis++) {
      for (const dir of [+1, -1]) {
        const axesList = [{ axis, dir }];
        handleDefs.push({ pos: pointFor(axesList), size: FACE_SIZE[axis], axesList });
      }
    }

    [[0, 1], [0, 2], [1, 2]].forEach(([a1, a2]) => {
      for (const d1 of [+1, -1]) {
        for (const d2 of [+1, -1]) {
          const axesList = [{ axis: a1, dir: d1 }, { axis: a2, dir: d2 }];
          handleDefs.push({ pos: pointFor(axesList), size: EDGE_SIZE, axesList });
        }
      }
    });

    for (const dx of [+1, -1]) {
      for (const dy of [+1, -1]) {
        for (const dz of [+1, -1]) {
          const axesList = [{ axis: 0, dir: dx }, { axis: 1, dir: dy }, { axis: 2, dir: dz }];
          handleDefs.push({ pos: pointFor(axesList), size: CORNER_SIZE, axesList });
        }
      }
    }

    stretchFaceAdjacencyRef.current = new Map();
    for (let axis = 0; axis < 3; axis++) {
      for (const dir of [+1, -1]) {
        stretchFaceAdjacencyRef.current.set(axisDirKey(axis, dir), []);
      }
    }

    const ts = Date.now();
    handleDefs.forEach((def, i) => {
      const [xSize, ySize, zSize] = def.size;
      const color = AXIS_HANDLE_COLORS[axesKey(def.axesList)] || AXIS_HANDLE_COLORS.XYZ;
      const type = def.axesList.length === 1 ? 'face' : def.axesList.length === 2 ? 'edge' : 'corner';
      const isFaceHandle = type === 'face';
      const restOpacity = type === 'face'
        ? STRETCH_HANDLE_FACE_OPACITY
        : type === 'edge'
          ? STRETCH_HANDLE_EDGE_OPACITY
          : STRETCH_HANDLE_CORNER_OPACITY;
      const mesh = new Mesh(viewer.scene, {
        id: `sh_${ts}_${i}`,
        geometry: new ReadableGeometry(viewer.scene, buildBoxGeometry({
          xSize, ySize, zSize,
        })),
        material: new PhongMaterial(viewer.scene, {
          diffuse: color,
          emissive: color,
          opacity: isFaceHandle ? restOpacity : 0,
        }),
        position: def.pos,
        visible: isFaceHandle,
        pickable: isFaceHandle,
      });
      mesh._stretchMeta = { isStretchHandle: true, axes: def.axesList, targetId: entityId, isAsset, color, type, restOpacity };
      stretchHandlesRef.current.push(mesh);
      if (!isFaceHandle) {
        def.axesList.forEach(({ axis, dir }) => {
          stretchFaceAdjacencyRef.current.get(axisDirKey(axis, dir))?.push(mesh);
        });
      }
    });
  };
  buildStretchHandlesRef.current = buildStretchHandles;

  const setStretchPersistCallback = (fn) => {
    stretchPersistCallbackRef.current = fn;
  };

  const loadIFCAssetIntoScene = async (instanceId, srcUrl, targetPosition, rotation) => {
    if (!loadersRef.current.ifc) return;

    try {
      const response = await fetch(srcUrl);
      if (!response.ok) return;

      const buffer = await response.arrayBuffer();

      const assetModel = loadersRef.current.ifc.load({
        id: instanceId,
        ifc: new Uint8Array(buffer),
        edges: true,
        globalizeCoordinates: false,
      });

   assetModel.on('loaded', () => {
   console.log("");
    console.log("======================================================");
    console.log("FURNITURE LOAD DEBUG");
    console.log("======================================================");

    console.log("Instance:", instanceId);

    const gs = globalScaleFactorRef.current;

    console.log("Incoming Target Position:", targetPosition);
    console.log("Incoming Rotation:", rotation);
    console.log("Incoming Global Scale:", gs);
    if (gs && (gs.x !== 1 || gs.y !== 1 || gs.z !== 1)) {
      assetModel.scale = [gs.x, gs.y, gs.z];
    }

     console.log("");
    console.log("AFTER SCALE");
    console.log("----------------");

    console.log("Scale:", assetModel.scale);

    const aabb = assetModel.aabb;

    console.log("AABB:", aabb);


    // const aabb = assetModel.aabb;

    if (aabb && targetPosition) {
      const centerX = (aabb[0] + aabb[3]) / 2;
      const centerZ = (aabb[2] + aabb[5]) / 2;
      const bottomY = aabb[1];

    //    console.log("CenterX:", centerX);
    // console.log("CenterY:", bottomY);
    // console.log("CenterZ:", centerZ);

    // console.log("BottomY:", bottomY);


      assetModel.position = [
        targetPosition[0] - centerX,
        targetPosition[1] - bottomY,
        targetPosition[2] - centerZ,
      ];


      // console.log(assetModel);
      // console.log("Model Origin:", assetModel.origin);

// console.log("Model Position:", assetModel.position);

// console.log("Model Matrix:", assetModel.matrix);

// console.log("Model AABB:", assetModel.aabb);

// // console.log("Scene AABB:", viewer.scene.aabb);

// console.log("Asset Rotation:", assetModel.rotation);
// console.log("Asset World Matrix:", assetModel.worldMatrix);
//       console.log("AABB AFTER POSITION:", assetModel.aabb);

//       console.log("Position After Assignment:", assetModel.position);
    }

    if (rotation) assetModel.rotation = rotation;

    // console.log("AABB AFTER ROTATION:", assetModel.aabb);

    // console.log("");
    // console.log("FINAL MODEL STATE");
    // console.log("----------------");

    // console.log("Position:", assetModel.position);
    // console.log("Rotation:", assetModel.rotation);
    // console.log("Scale:", assetModel.scale);

    // console.log("");

    // console.log("Matrix:", assetModel.matrix);

    // console.log("World Matrix:", assetModel.worldMatrix);

    // console.log("");

    // console.log("Entire Asset Model");

    // console.dir(assetModel);

    // console.log("======================================================");
    // console.log("");
});

    } catch (error) {
      console.error('[BIM Engine] Placement failure:', error);
    }
  };

 // Add `updateStructuralEdit` to the arguments
  const isolateAndMakeMoveable = async (entityId, onAdoptCallback, updateStructuralEdit) => {
    if (!file) return;
    const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

    try {
      const response = await fetch(`${API_BASE_URL}/api/elements/${jobId}/${entityId}/isolate`, { method: 'POST' });
      if (!response.ok) return;

      const data = await response.json();
      
      // Hide the native element AND save that action to state memory
      const nativeEntity = viewerRef.current?.scene.objects[entityId];
      if (nativeEntity) {
        nativeEntity.visible = false;
        if (updateStructuralEdit) {
            updateStructuralEdit(entityId, 'visible', null, false);
        }
      }

      // (Leave the rest of the function untouched...)
      const newInstanceId = `${entityId}_isolated`;
      await loadIFCAssetIntoScene(newInstanceId, data.fileUrl);
      

      // Update the metadata panel
      const metaObject = viewerRef.current?.metaScene.metaObjects[entityId];

      if (onAdoptCallback) {
        onAdoptCallback(entityId, newInstanceId, fileUrl, metaObject?.name);
      }

      // Automatically select the newly dropped standalone asset
      const isolatedModel = viewerRef.current?.scene.models[newInstanceId];
      if (isolatedModel) {
        viewerRef.current.scene.setObjectsSelected(viewerRef.current.scene.selectedObjectIds, false);
        isolatedModel.selected = true;
      }

      setSelectedAssetId(newInstanceId);

      setSelectedObject({
        id: newInstanceId,
        name: metaObject?.name || 'Isolated Element',
        type: metaObject?.type || 'Generic Component',
        groupedProperties: metaObject
          ? {
              'General Details': [
                { name: 'Element Name', value: metaObject.name || 'Unnamed' },
                { name: 'IFC Class', value: metaObject.type || 'Unknown' },
                { name: 'Global ID', value: metaObject.id },
              ],
            }
          : {},
      });

      return newInstanceId;
    } catch (error) {
      console.error('[BIM Engine] Isolate-and-move failure:', error);
    }
  };

  const inspectNativeElement = async (entityId) => {
    if (!file || !entityId) return { error: true };

    const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

    try {
      const response = await fetch(`${API_BASE_URL}/api/elements/${jobId}/${entityId}/inspect`);
      const data = await response.json();

      if (!response.ok || data?.error) {
        return { error: true };
      }

      return data;
    } catch (error) {
      console.error('[BIM Engine] Inspect failure:', error);
      return { error: true };
    }
  };

  // ── Delta-Based State Management ────────────────────────────────────
  // Replaces the old resizeNativeElement() backend round-trip. input.ifc
  // is strictly read-only now — a parametric resize is just a scale
  // ratio applied directly to the live native entity in Xeokit. The
  // caller (RightPanel) is responsible for persisting the same value via
  // useProjectSync's updateStructuralEdit so it survives a reload.
  //
  // NOTE: this assumes viewer.scene.objects[entityId].scale is writable
  // for native (non-standalone-model) entities in your xeokit-sdk
  // version. If your build's WebIFCLoaderPlugin produces entities where
  // .scale is read-only on individual objects (only Models expose a
  // writable .scale in some xeokit versions), this call will silently
  // no-op and you'll need a matrix-based transform instead — flagging
  // this now rather than papering over it.
  const updateStructuralTransform = (entityId, transformType, axis, value) => {
    const entity = viewerRef.current?.scene.objects[entityId];
    if (!entity) return;

    if (transformType === 'scale') {
      const newScale = [...(entity.scale || [1, 1, 1])];
      newScale[axis] = value;
      entity.scale = newScale;
    } else if (transformType === 'offset') {
      const newOffset = [...(entity.offset || [0, 0, 0])];
      newOffset[axis] = value;
      entity.offset = newOffset;
    }
  };

  // ── NEW: Direct Engine Actions for guaranteed visual transformation ──
  const updateNativeOffset = (id, axis, value) => {
    const entity = viewerRef.current?.scene.objects[id];
    if (entity) {
        const newOffset = [...(entity.offset || [0, 0, 0])];
        newOffset[axis] = value;
        entity.offset = newOffset;
    }
  };

  const updateDynamicTransform = (modelId, type, axis, value) => {
      const model = viewerRef.current?.scene.models[modelId];
      if (!model) return;
      if (type === 'scale') {
          const newScale = [...(model.scale || [1, 1, 1])];
          newScale[axis] = value;
          model.scale = newScale;
      } else if (type === 'rotation') {
          const newRot = [...(model.rotation || [0, 0, 0])];
          newRot[1] = value; // Y-Axis
          model.rotation = newRot;

//           console.log("");
// console.log("ROTATION CHANGED");
// console.log("Rotation:", model.rotation);
// console.log("Position:", model.position);
// console.log("Scale:", model.scale);
// console.log("Matrix:", model.matrix);
// console.log("World Matrix:", model.worldMatrix);
// console.log("");
      } else if (type === 'position') {
          const newPos = [...(model.position || [0, 0, 0])];
          newPos[axis] = value;
          model.position = newPos;
      }
  };

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
      totalMeasuredLength,
      sceneScaleFactor,
      isStretching,
    },
    actions: {
      toggleXRay,
      toggleClipping,
      setNavMode,
      setSelectedObject,
      setSelectedAssetId,
      setPlacementMode,
      loadIFCAssetIntoScene,
      getDropPosition,
      getWallSnapData,
      toggleMeasurementMode,
      clearMeasurements,
      deleteMeasurement,
      scaleModelByMeasurement,
      calibrateWallHeight,
      flyToMeasurement,
      toggleSnapping,
      toggleAxisBreakdown,
      setMeasurementUnit,
      formatLength,
      updateNativeOffset,
      updateDynamicTransform,
      updateStructuralTransform,
      isolateAndMakeMoveable,
      inspectNativeElement,
      getCursorWorldPosition,
      setIsLoading,
      buildStretchHandles,
      destroyStretchHandles,
      setStretchPersistCallback,
    },
  };
};