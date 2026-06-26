import { useEffect, useRef, useState } from 'react';
import { Viewer } from '@xeokit/xeokit-sdk/src/viewer/Viewer';
import { XKTLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/XKTLoaderPlugin/XKTLoaderPlugin';
import { WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/WebIFCLoaderPlugin/WebIFCLoaderPlugin';
import { TreeViewPlugin } from '@xeokit/xeokit-sdk/src/plugins/TreeViewPlugin/TreeViewPlugin';
import { NavCubePlugin } from '@xeokit/xeokit-sdk/src/plugins/NavCubePlugin/NavCubePlugin';
import { SectionPlanesPlugin } from '@xeokit/xeokit-sdk/src/plugins/SectionPlanesPlugin/SectionPlanesPlugin';
import { DistanceMeasurementsPlugin } from '@xeokit/xeokit-sdk/src/plugins/DistanceMeasurementsPlugin/DistanceMeasurementsPlugin';
import * as WebIFC from 'web-ifc';

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

  const [isLoading, setIsLoading] = useState(false);
  const [isXRay, setIsXRay] = useState(false);
  const [isClipping, setIsClipping] = useState(false);
  const [navMode, setNavMode] = useState('orbit');

  const [selectedObject, setSelectedObject] = useState(null);
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [placementMode, setPlacementMode] = useState(null);
  const placementModeRef = useRef(null);

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

      if (placementModeRef.current) {
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
          // NEW: Capture native entity offset for translation
          offset: entity.offset || [0, 0, 0] 
        });
      }
    });

    viewer.cameraControl.on('pickedNothing', () => {
      if (placementModeRef.current) { setPlacementMode(null); return; }
      viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
      setSelectedObject(null);
      setSelectedAssetId(null);
    });

    return () => {
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
          globalizeCoordinates: true,
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

        return {
          id: m.id,
          lengthMeters: vec3Distance(originPos, targetPos),
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

  const getDropPosition = (canvasPos) => {
    const viewer = viewerRef.current;
    if (!viewer) return [0, 0, 0];

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
        const aabb = assetModel.aabb;

        if (aabb && targetPosition) {
          const centerX = (aabb[0] + aabb[3]) / 2;
          const centerZ = (aabb[2] + aabb[5]) / 2;
          const bottomY = aabb[1];

          assetModel.position = [
            targetPosition[0] - centerX,
            targetPosition[1] - bottomY,
            targetPosition[2] - centerZ,
          ];
        }

        if (rotation) assetModel.rotation = rotation;
      });

    } catch (error) {
      console.error('[BIM Engine] Placement failure:', error);
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
      totalMeasuredLength
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
      toggleMeasurementMode,
      clearMeasurements,
      deleteMeasurement,
      flyToMeasurement,
      toggleSnapping,
      toggleAxisBreakdown,
      setMeasurementUnit,
      formatLength,
      updateNativeOffset,     // Expose for floor plan elements
      updateDynamicTransform  // Expose for dropped assets
    },
  };
};