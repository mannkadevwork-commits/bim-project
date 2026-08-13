import { API_BASE_URL } from '../utils/constants';

export const applyGlobalScale = (ctx, ratioVec) => {
  const { viewerRef, currentModelRef, globalScaleFactorRef, setSceneScaleFactor, measurementsPluginRef, setMeasurementsList } = ctx;
  const viewer = viewerRef.current;
  const mainModel = currentModelRef.current;
  if (!viewer || !mainModel) return false;

  const [rx, ry, rz] = ratioVec;
  if (![rx, ry, rz].every((r) => r > 0 && isFinite(r))) return false;

  const aabb = mainModel.aabb; 
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

  const plugin = measurementsPluginRef.current;
  if (plugin) plugin.clear();
  setMeasurementsList([]);

  viewer.cameraFlight.duration = 0.6;
  viewer.cameraFlight.flyTo(mainModel);
  return true;
};

export const reloadMainModel = async (ctx, jobId) => {
  const { setIsLoading, loadersRef, currentModelRef, viewerRef, projectStateRef } = ctx;
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
      globalizeCoordinates: false, 
    });
    
    currentModelRef.current.on('loaded', () => {
      const viewer = viewerRef.current;
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

export const updateFurnitureScale = (ctx, ratio) => {
  const { viewerRef, globalScaleFactorRef, setSceneScaleFactor } = ctx;
  const viewer = viewerRef.current;
  if (!viewer) return;

  Object.keys(viewer.scene.models).forEach((id) => {
    if (id === 'main_structure') return; 
    const assetModel = viewer.scene.models[id];
    if (!assetModel) return;

    const currentScale = assetModel.scale || [1, 1, 1];
    assetModel.scale = [currentScale[0] * ratio, currentScale[1] * ratio, currentScale[2] * ratio];
    
    const currentPos = assetModel.position || [0, 0, 0];
    assetModel.position = [currentPos[0] * ratio, currentPos[1] * ratio, currentPos[2] * ratio];
  });

  globalScaleFactorRef.current = {
    x: globalScaleFactorRef.current.x * ratio,
    y: globalScaleFactorRef.current.y * ratio,
    z: globalScaleFactorRef.current.z * ratio,
  };
  setSceneScaleFactor({ ...globalScaleFactorRef.current });
};

export const scaleModelByMeasurement = async (ctx, measurementId, newDesiredLengthInMeters) => {
  const { activeProject, measurementsPluginRef, setIsLoading, setMeasurementsList } = ctx;
  
  if (!activeProject || !activeProject.jobId) return { success: false, error: 'No active file.' };
  
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

  const jobId = activeProject.jobId;
  setIsLoading(true);

  try {
    const response = await fetch(`${API_BASE_URL}/api/projects/${jobId}/rescale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ factor: ratio })
    });

    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error);

    await reloadMainModel(ctx, jobId);
    updateFurnitureScale(ctx, ratio);

    plugin.clear();
    setMeasurementsList([]);
    return { success: true };
  } catch (error) {
    console.error('[BIM Engine] Global Rescale Error:', error);
    setIsLoading(false);
    return { success: false, error: 'Failed to process calibration.' };
  }
};

export const calibrateWallHeight = async (ctx, entityId, newHeightMeters) => {
  const { activeProject, setIsLoading, inspectNativeElement } = ctx;
  if (!activeProject || !activeProject.jobId || !entityId) return { success: false, error: 'No element selected.' };

  const target = parseFloat(newHeightMeters);
  if (!target || target <= 0) return { success: false, error: 'Enter a height greater than 0.' };

  try {
    const dims = await inspectNativeElement(activeProject, entityId);
    if (!dims || dims.error || !dims.height) {
      return { success: false, error: 'Element has no parametric height.' };
    }

    const ratio = target / dims.height;
    const jobId = activeProject.jobId;
    
    setIsLoading(true);
    
    console.log(`API data ${ratio} ${jobId}`);
    const response = await fetch(`${API_BASE_URL}/api/projects/${jobId}/rescale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ factor: ratio }) 
    });

    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error);

    await reloadMainModel(ctx, jobId);
    updateFurnitureScale(ctx, ratio);
    
    return { success: true };
  } catch (err) {
    console.error('[BIM Engine] Height calibration failed:', err);
    setIsLoading(false);
    return { success: false, error: 'Height calibration failed.' };
  }
};