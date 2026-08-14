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
  if (!jobId) throw new Error('Missing canonical project jobId.');

  setIsLoading(true);

  try {
    const ifcRes = await fetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/input.ifc?v=${Date.now()}`);
    if (!ifcRes.ok) {
      throw new Error(`Failed to fetch calibrated IFC (${ifcRes.status})`);
    }
    const buffer = await ifcRes.arrayBuffer();

    if (currentModelRef.current) {
      currentModelRef.current.destroy();
      currentModelRef.current = null;
    }

    return await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const model = loadersRef.current.ifc.load({
        id: 'main_structure',
        ifc: new Uint8Array(buffer),
        edges: true,
        globalizeCoordinates: false,
      });

      currentModelRef.current = model;

      model.on('loaded', () => {
        try {
          const viewer = viewerRef.current;
          if (viewer) {
            viewer.cameraFlight.duration = 0.6;
            viewer.cameraFlight.flyTo(model);

            if (projectStateRef.current?.materials) {
              Object.entries(projectStateRef.current.materials).forEach(([entityId, matData]) => {
                const entity = viewer.scene.objects[entityId];
                if (entity) entity.colorize = matData.rgb;
              });
            }
          }

          setIsLoading(false);
          settle(resolve, model);
        } catch (error) {
          setIsLoading(false);
          settle(reject, error);
        }
      });

      model.on('error', (error) => {
        setIsLoading(false);
        settle(reject, error instanceof Error ? error : new Error('IFC reload failed.'));
      });
    });
  } catch (err) {
    console.error('[BIM Engine] Failed to reload main model:', err);
    setIsLoading(false);
    throw err;
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
  const {
    file,
    jobId,
    measurementsPluginRef,
    setIsLoading,
    setMeasurementsList,
  } = ctx;

  if (!file) return { success: false, error: 'No active file.' };
  if (!jobId) return { success: false, error: 'No active project jobId.' };

  const plugin = measurementsPluginRef.current;
  if (!plugin || !plugin.measurements) return { success: false, error: 'No active measurement.' };

  const measurement = plugin.measurements[measurementId];
  if (!measurement || !measurement.origin || !measurement.target) {
    return { success: false, error: 'Selected measurement is unavailable.' };
  }

  const originPos = measurement.origin.worldPos;
  const targetPos = measurement.target.worldPos;
  const dx = originPos[0] - targetPos[0];
  const dy = originPos[1] - targetPos[1];
  const dz = originPos[2] - targetPos[2];
  const currentLength = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (!currentLength) return { success: false, error: 'Measurement is zero.' };

  const targetLength = Number(newDesiredLengthInMeters);
  if (!Number.isFinite(targetLength) || targetLength <= 0) {
    return { success: false, error: 'Enter a valid target length.' };
  }

  const ratio = targetLength / currentLength;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return { success: false, error: 'Calibration factor is invalid.' };
  }

  setIsLoading(true);

  try {
    console.info('[Calibration] Applying scene scale using canonical project', {
      measurementId,
      currentLengthMeters: currentLength,
      targetLengthMeters: targetLength,
      factor: ratio,
      jobId,
      fileName: file.name,
    });

    const response = await fetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(jobId)}/rescale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ factor: ratio }),
    });

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    console.info('[Calibration] Rescale response', {
      status: response.status,
      jobId,
      data,
    });

    if (!response.ok || data.error) {
      throw new Error(data.error || `Rescale request failed (${response.status}).`);
    }

    await reloadMainModel(ctx, jobId);
    updateFurnitureScale(ctx, ratio);

    plugin.clear();
    setMeasurementsList([]);

    return {
      success: true,
      ratio,
      jobId,
      response: data,
    };
  } catch (error) {
    console.error('[BIM Engine] Global Rescale Error:', {
      jobId,
      error,
    });
    setIsLoading(false);
    return {
      success: false,
      error: error?.message || 'Failed to process calibration.',
    };
  }
};

export const calibrateWallHeight = async (ctx, entityId, newHeightMeters) => {
  const { file, jobId, setIsLoading, inspectNativeElement } = ctx;

  if (!file || !entityId) return { success: false, error: 'No element selected.' };
  if (!jobId) return { success: false, error: 'No active project jobId.' };

  const target = parseFloat(newHeightMeters);
  if (!target || target <= 0) return { success: false, error: 'Enter a height greater than 0.' };

  try {
    const dims = await inspectNativeElement(file, entityId);
    if (!dims || dims.error || !dims.height) {
      return { success: false, error: 'Element has no parametric height.' };
    }

    const ratio = target / dims.height;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return { success: false, error: 'Calculated calibration factor is invalid.' };
    }

    setIsLoading(true);
    console.info('[Calibration] Wall height rescale using canonical project', {
      jobId,
      entityId,
      currentHeight: dims.height,
      targetHeight: target,
      factor: ratio,
    });

    const response = await fetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(jobId)}/rescale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ factor: ratio }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || `Rescale request failed (${response.status}).`);

    await reloadMainModel(ctx, jobId);
    updateFurnitureScale(ctx, ratio);

    return { success: true, ratio, jobId };
  } catch (err) {
    console.error('[BIM Engine] Height calibration failed:', { jobId, err });
    setIsLoading(false);
    return { success: false, error: err?.message || 'Height calibration failed.' };
  }
};
