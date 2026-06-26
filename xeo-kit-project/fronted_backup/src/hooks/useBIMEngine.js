import { useEffect, useRef, useState } from 'react';
import { Viewer } from '@xeokit/xeokit-sdk/src/viewer/Viewer';
import { XKTLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/XKTLoaderPlugin/XKTLoaderPlugin';
import { WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/WebIFCLoaderPlugin/WebIFCLoaderPlugin';
import { TreeViewPlugin } from '@xeokit/xeokit-sdk/src/plugins/TreeViewPlugin/TreeViewPlugin';
import { NavCubePlugin } from '@xeokit/xeokit-sdk/src/plugins/NavCubePlugin/NavCubePlugin';
import { SectionPlanesPlugin } from '@xeokit/xeokit-sdk/src/plugins/SectionPlanesPlugin/SectionPlanesPlugin';
import { GLTFLoaderPlugin } from '@xeokit/xeokit-sdk/src/plugins/GLTFLoaderPlugin/GLTFLoaderPlugin';
import * as WebIFC from 'web-ifc';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const useBIMEngine = (file, projectStateRef, onAssetPlaced, setIsRightPanelOpen, setRightTab) => {
  const canvasRef = useRef(null);
  const treeContainerRef = useRef(null);
  const navCubeCanvasRef = useRef(null);
  
  const viewerRef = useRef(null);
  const loadersRef = useRef({});
  const sectionPlanesRef = useRef(null);
  const currentModelRef = useRef(null);
  const currentPlaneRef = useRef(null);
  const treeViewPluginRef = useRef(null);

  const [isLoading, setIsLoading] = useState(false);
  const [isXRay, setIsXRay] = useState(false);
  const [isClipping, setIsClipping] = useState(false);
  const [navMode, setNavMode] = useState('orbit');
  
  const [selectedObject, setSelectedObject] = useState(null);
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [placementMode, setPlacementMode] = useState(null);
  const placementModeRef = useRef(null);
  const ghostModelRef = useRef(null);

  useEffect(() => { placementModeRef.current = placementMode; }, [placementMode]);

  // 1. GHOST INITIALIZATION (Universal Router)
  useEffect(() => {
    const initGhost = async () => {
      if (!placementMode) {
        if (ghostModelRef.current && ghostModelRef.current.model) {
          ghostModelRef.current.model.destroy();
          ghostModelRef.current = null;
        }
        return;
      }

      try {
        const assetPath = placementMode.url || placementMode.src || placementMode.file || '';
        const fullSrcUrl = assetPath.startsWith('http') ? assetPath : `${API_BASE_URL}${assetPath.startsWith('/') ? '' : '/'}${assetPath}`;
        const ghostId = `ghost_${Date.now()}`;
        const extension = fullSrcUrl.split('.').pop().toLowerCase();

        let model;
        // Route to the correct plugin based on the file extension
        if (extension === 'glb' || extension === 'gltf') {
            model = loadersRef.current.gltf.load({ id: ghostId, src: fullSrcUrl, edges: true });
        } else {
            model = loadersRef.current.ifc.load({ id: ghostId, src: fullSrcUrl, edges: true, globalizeCoordinates: true });
        }

        model.on("loaded", () => {
          if (!viewerRef.current) return;
          const scene = viewerRef.current.scene;
          
          const ids = model.objectIds || Object.keys(model.objects || {});
          if (ids && ids.length > 0) {
              scene.setObjectsOpacity(ids, 0.4);
              scene.setObjectsPickable(ids, false);
          }

          const aabb = model.aabb;
          if (!aabb || aabb[0] === Infinity) {
             console.error(`[Ghost] No Geometry found in ${fullSrcUrl}`);
             ghostModelRef.current = { model, offsetX: 0, offsetY: 0, offsetZ: 0 };
             return;
          }

          const originalCenterX = (aabb[0] + aabb[3]) / 2;
          const originalBottomY = aabb[1]; 
          const originalCenterZ = (aabb[2] + aabb[5]) / 2;

          ghostModelRef.current = {
              model: model,
              offsetX: -originalCenterX,
              offsetY: -originalBottomY,
              offsetZ: -originalCenterZ
          };
          
          model.position = [0, -1000, 0]; 
        });
      } catch (error) { console.error("Failed to load 3D Ghost:", error); }
    };

    initGhost();
  }, [placementMode]);

  // 2. GHOST TRACKING 
  useEffect(() => {
    if (!canvasRef.current || !viewerRef.current) return;
    const canvas = canvasRef.current;

    const handleMouseMove = (e) => {
      if (!placementModeRef.current || !ghostModelRef.current) return;

      const rect = canvas.getBoundingClientRect();
      const canvasPos = [e.clientX - rect.left, e.clientY - rect.top];

      const pickResult = viewerRef.current.scene.pick({
          canvasPos: canvasPos,
          pickSurface: true
      });

      const ghost = ghostModelRef.current;
      
      if (pickResult && pickResult.worldPos) {
          ghost.model.position = [
              pickResult.worldPos[0] + ghost.offsetX,
              pickResult.worldPos[1] + ghost.offsetY + 0.05, 
              pickResult.worldPos[2] + ghost.offsetZ
          ];
      } else {
          const cameraLook = viewerRef.current.camera.look;
          ghost.model.position = [
             cameraLook[0] + ghost.offsetX, 
             cameraLook[1] + ghost.offsetY, 
             cameraLook[2] + ghost.offsetZ
          ];
      }
    };

    canvas.addEventListener('mousemove', handleMouseMove);
    return () => canvas.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // 3. ENGINE SETUP 
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

    new NavCubePlugin(viewer, { canvasElement: navCubeCanvasRef.current, color: "#f8fafc", hoverColor: "#6366f1" });
    sectionPlanesRef.current = new SectionPlanesPlugin(viewer);
    loadersRef.current.xkt = new XKTLoaderPlugin(viewer);
    
    loadersRef.current.gltf = new GLTFLoaderPlugin(viewer);

    const initializeIFCEngine = async () => {
      try {
        const ifcAPI = new WebIFC.IfcAPI();
        ifcAPI.SetWasmPath("/");
        await ifcAPI.Init(); 
        loadersRef.current.ifc = new WebIFCLoaderPlugin(viewer, { 
            wasmPath: "/", 
            WebIFC: WebIFC,
            IfcAPI: ifcAPI 
        });
      } catch (error) { console.error("Failed to boot IFC Engine.", error); }
    };
    
    initializeIFCEngine();
    viewerRef.current = viewer;

    viewer.cameraControl.on("picked", (pickResult) => {
      if (placementModeRef.current) {
          if (pickResult.worldPos) {
              onAssetPlaced(placementModeRef.current, [
                  pickResult.worldPos[0], 
                  pickResult.worldPos[1],
                  pickResult.worldPos[2]
              ]);
          }
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
    });

    viewer.cameraControl.on("pickedNothing", () => {
      if (placementModeRef.current) { 
          const cameraLook = viewerRef.current.camera.look;
          onAssetPlaced(placementModeRef.current, [cameraLook[0], cameraLook[1], cameraLook[2]]);
          setPlacementMode(null);
          return; 
      }
      viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
      setSelectedObject(null);
      setSelectedAssetId(null);
    });

    return () => viewer.destroy();
  }, []);

  useEffect(() => {
    if (viewerRef.current && treeContainerRef.current && !treeViewPluginRef.current) {
        try {
            treeViewPluginRef.current = new TreeViewPlugin(viewerRef.current, {
                containerElement: treeContainerRef.current,
                autoExpandDepth: 2,
                hierarchy: "containment"
            });
        } catch (err) { console.warn("Could not initialize TreeViewPlugin", err); }
    }
  }, [file]);

  useEffect(() => {
      if (viewerRef.current) viewerRef.current.cameraControl.navMode = navMode;
  }, [navMode]);

  // 4. LOAD ASSET INTO SCENE (Universal Router)
 const loadAssetIntoScene = (instanceId, srcUrl, position, rotation, scale = [1, 1, 1]) => {
    const extension = srcUrl.split('.').pop().toLowerCase();
    
    try {
        if (extension === 'glb' || extension === 'gltf') {
            if (!loadersRef.current.gltf) return;
            const model = loadersRef.current.gltf.load({
                id: instanceId,
                src: srcUrl, 
                position: position ? [position[0], position[1], position[2]] : [0, 0, 0],
                rotation: rotation || [0, 0, 0],
                scale: scale || [1, 1, 1],
                edges: true
            });
            model.on("loaded", () => console.log(`[BIMEngine] GLTF Asset ${instanceId} perfectly mounted!`));
            
        } else {
            // Support legacy IFC furniture files gracefully
            if (!loadersRef.current.ifc) return;
            const model = loadersRef.current.ifc.load({
                id: instanceId,
                src: srcUrl, 
                edges: true,
                globalizeCoordinates: true 
            });

            model.on("loaded", () => {
                const aabb = model.aabb;
                const isValidGeometry = aabb && aabb.length === 6 && aabb[0] !== Infinity && aabb[0] > -1e10;
                
                let offsetX = 0, offsetY = 0, offsetZ = 0;
                if (isValidGeometry) {
                    offsetX = (aabb[0] + aabb[3]) / 2;
                    offsetY = aabb[1];
                    offsetZ = (aabb[2] + aabb[5]) / 2;
                }

                model.position = [
                    (position[0] || 0) - offsetX,
                    (position[1] || 0) - offsetY,
                    (position[2] || 0) - offsetZ
                ];
                model.rotation = rotation || [0, 0, 0];
                model.scale = scale || [1, 1, 1];
                
                const ids = model.objectIds || Object.keys(model.objects || {});
                if (ids && ids.length > 0) viewerRef.current.scene.setObjectsVisible(ids, true);
            });
        }
    } catch (error) { 
        console.error("Asset Placement Error", error); 
    }
  };

  // 5. LOAD MAIN FILE
  useEffect(() => {
    if (!viewerRef.current) return;
    if (!file) {
      if (currentModelRef.current) { currentModelRef.current.destroy(); currentModelRef.current = null; }
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
                    loadAssetIntoScene(item.instanceId, item.src, item.position, item.rotation);
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
    actions: { toggleXRay, toggleClipping, setNavMode, setSelectedObject, setSelectedAssetId, setPlacementMode, loadAssetIntoScene }
  };
};