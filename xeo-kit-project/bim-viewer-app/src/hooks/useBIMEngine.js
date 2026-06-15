import { useEffect, useRef, useState } from 'react';
import { Viewer } from '@xeokit/xeokit-sdk/src/viewer/Viewer';
import { XKTLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/XKTLoaderPlugin/XKTLoaderPlugin';
import { WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/WebIFCLoaderPlugin/WebIFCLoaderPlugin';
import { TreeViewPlugin } from '@xeokit/xeokit-sdk/src/plugins/TreeViewPlugin/TreeViewPlugin';
import { NavCubePlugin } from '@xeokit/xeokit-sdk/src/plugins/NavCubePlugin/NavCubePlugin';
import { SectionPlanesPlugin } from '@xeokit/xeokit-sdk/src/plugins/SectionPlanesPlugin/SectionPlanesPlugin';
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

  const [isLoading, setIsLoading] = useState(false);
  const [isXRay, setIsXRay] = useState(false);
  const [isClipping, setIsClipping] = useState(false);
  const [navMode, setNavMode] = useState('orbit');
  
  const [selectedObject, setSelectedObject] = useState(null);
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [placementMode, setPlacementMode] = useState(null);
  const placementModeRef = useRef(null);

  useEffect(() => { placementModeRef.current = placementMode; }, [placementMode]);

  // Setup Xeokit Engine
  useEffect(() => {
    const viewer = new Viewer({ canvasElement: canvasRef.current, transparent: true, antialias: true });
    viewer.cameraControl.navMode = "orbit";
    viewer.cameraControl.followPointer = true;
    viewer.cameraControl.smartPivot = true;
    viewer.cameraControl.doublePickFlyTo = true; 
    
    viewer.scene.camera.project.fov = 65; 
    viewer.camera.eye = [-3.93, 2.85, 27.01];
    viewer.camera.look = [4.4, 3.72, 8.89];
    viewer.camera.up = [-0.01, 0.99, 0.039];

    new TreeViewPlugin(viewer, { containerElement: treeContainerRef.current, autoExpandDepth: 2, hierarchy: "containment" });
    new NavCubePlugin(viewer, { canvasElement: navCubeCanvasRef.current, color: "#f8fafc", hoverColor: "#6366f1" });
    sectionPlanesRef.current = new SectionPlanesPlugin(viewer);
    loadersRef.current.xkt = new XKTLoaderPlugin(viewer);
    
    const initializeIFCEngine = async () => {
      try {
        const ifcAPI = new WebIFC.IfcAPI();
        ifcAPI.SetWasmPath("/");
        await ifcAPI.Init(); 
        loadersRef.current.ifc = new WebIFCLoaderPlugin(viewer, { WebIFC: WebIFC, IfcAPI: ifcAPI });
      } catch (error) { console.error("Failed to boot IFC Engine.", error); }
    };
    
    initializeIFCEngine();
    viewerRef.current = viewer;

    viewer.cameraControl.on("picked", (pickResult) => {
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
          assetModel.selected = true; 
          setSelectedAssetId(entity.model.id);
          setSelectedObject(null);
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
          { name: 'Global ID', value: metaObject.id }
        ];

        if (metaObject.propertySets) {
          metaObject.propertySets.forEach(propSet => {
            const groupName = propSet.name || 'Other Properties';
            if (!groupedProps[groupName]) groupedProps[groupName] = [];
            if (propSet.properties) propSet.properties.forEach(prop => groupedProps[groupName].push({ name: prop.name, value: prop.value }));
          });
        }
        setSelectedObject({ id: entity.id, name: metaObject.name || "Unnamed Object", type: metaObject.type || "Generic Component", groupedProperties: groupedProps });
      }
    });

    viewer.cameraControl.on("pickedNothing", () => {
      if (placementModeRef.current) { setPlacementMode(null); return; }
      viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
      setSelectedObject(null);
      setSelectedAssetId(null);
    });

    return () => viewer.destroy();
  }, []);

  useEffect(() => {
      if (viewerRef.current) viewerRef.current.cameraControl.navMode = navMode;
  }, [navMode]);

  const loadIFCAssetIntoScene = async (instanceId, srcUrl, position, rotation) => {
    if (!loadersRef.current.ifc) return;
    try {
        const response = await fetch(srcUrl);
        const buffer = await response.arrayBuffer();
        loadersRef.current.ifc.load({
            id: instanceId,
            ifc: new Uint8Array(buffer),
            position: position || [0, 0, 0],
            rotation: rotation || [0, 0, 0],
            edges: true,
            globalizeCoordinates: false 
        });
    } catch (error) { console.error("Failed to load IFC asset", error); }
  };

  // LOAD MAIN FILE
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
        currentModelRef.current = loadersRef.current.ifc.load({ id: "main_structure", ifc: ifcData, edges: true, globalizeCoordinates: true });
      } else if (fileExtension === 'xkt' && loadersRef.current.xkt) {
        currentModelRef.current = loadersRef.current.xkt.load({ id: "main_structure", xkt: buffer, edges: true });
      } else { setIsLoading(false); return; }
      
      currentModelRef.current.on("loaded", async () => {
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
      const center = [(aabb[0] + aabb[3])/2, (aabb[1] + aabb[4])/2, (aabb[2] + aabb[5])/2];
      currentPlaneRef.current = sectionPlanesRef.current.createSectionPlane({ id: "activeSlice", pos: center, dir: [0, -1, 0] });
      sectionPlanesRef.current.showControl("activeSlice");
    } else {
      if (currentPlaneRef.current) { currentPlaneRef.current.destroy(); currentPlaneRef.current = null; }
    }
    setIsClipping(nextState);
  };

  return {
    refs: { canvasRef, treeContainerRef, navCubeCanvasRef, viewerRef },
    state: { isLoading, isXRay, isClipping, navMode, selectedObject, selectedAssetId, placementMode },
    actions: { 
      toggleXRay, toggleClipping, setNavMode, setSelectedObject, 
      setSelectedAssetId, setPlacementMode, loadIFCAssetIntoScene 
    }
  };
};