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

export const reloadMainModel = async (ctx, jobId, options = {}) => {
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
            if (!options.preserveCamera) {
              viewer.cameraFlight.duration = 0.6;
              viewer.cameraFlight.flyTo(model);
            }

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

const getAabbCenter = (model) => {
  const aabb = model?.aabb;
  if (!aabb || aabb.length < 6) return null;
  return [
    (aabb[0] + aabb[3]) / 2,
    (aabb[1] + aabb[4]) / 2,
    (aabb[2] + aabb[5]) / 2,
  ];
};

/**
 * Keep placed assets aligned with the calibrated IFC using the actual
 * pre/post calibration scene-frame centers.
 *
 * We do NOT assume that the backend rescales around the world origin.
 * Instead, the main IFC's observed center before and after reload defines
 * the same uniform scene transform that was applied to the structural model:
 *
 *   newPosition = newCenter + (oldPosition - oldCenter) * ratio
 *
 * This preserves alignment whether the backend scale is centered at the
 * origin or around another scene pivot. No arbitrary offsets are introduced.
 */
/**
 * Applies exactly the same scene-space affine transform that the backend
 * applied to the main IFC:
 *
 *   p' = newCenter + (p - oldCenter) * ratio
 *
 * In matrix form:
 *
 *   A = T(newCenter) * S(ratio) * T(-oldCenter)
 *
 * External/isolated IFC assets are not rewritten by the backend, so their
 * current model matrices must receive A once. This is deliberately different
 * from mutating model.scale/model.position independently: the resize work
 * established model.matrix as the authoritative rendered transform.
 */
export const updateFurnitureScale = (ctx, ratio, oldSceneCenter, newSceneCenter, furnitureState = []) => {
  const { viewerRef, globalScaleFactorRef, setSceneScaleFactor } = ctx;
  const viewer = viewerRef.current;
  if (!viewer) return;

  const values = [ratio, ...(oldSceneCenter || []), ...(newSceneCenter || [])];
  if (values.length !== 7 || !values.every(Number.isFinite) || ratio <= 0) {
    console.warn('[Calibration] Skipping live asset scene transform: invalid scene transform data.', {
      ratio,
      oldSceneCenter,
      newSceneCenter,
    });
    return;
  }

  const persistedIds = new Set(
    (furnitureState || [])
      .map(item => item?.instanceId)
      .filter(Boolean)
  );

  // A = T(newCenter) * S(ratio) * T(-oldCenter)
  // For a uniform scene scale this can be applied directly to a column-major
  // affine matrix without a general 4x4 multiply.
  const tx = newSceneCenter[0] - ratio * oldSceneCenter[0];
  const ty = newSceneCenter[1] - ratio * oldSceneCenter[1];
  const tz = newSceneCenter[2] - ratio * oldSceneCenter[2];

  Object.keys(viewer.scene.models || {}).forEach((id) => {
    if (id === 'main_structure' || !persistedIds.has(id)) return;

    const assetModel = viewer.scene.models[id];
    if (!assetModel) return;

    try {
      const m = assetModel.matrix;
      if (m && typeof m.length === 'number' && m.length === 16) {
        assetModel.matrix = [
          m[0] * ratio, m[1] * ratio, m[2] * ratio, m[3],
          m[4] * ratio, m[5] * ratio, m[6] * ratio, m[7],
          m[8] * ratio, m[9] * ratio, m[10] * ratio, m[11],
          m[12] * ratio + tx, m[13] * ratio + ty, m[14] * ratio + tz, m[15],
        ];
      } else {
        // Defensive fallback for a model without a readable matrix.
        const p = Array.isArray(assetModel.position) ? assetModel.position : [0, 0, 0];
        const s = Array.isArray(assetModel.scale) ? assetModel.scale : [1, 1, 1];
        assetModel.position = [
          newSceneCenter[0] + (p[0] - oldSceneCenter[0]) * ratio,
          newSceneCenter[1] + (p[1] - oldSceneCenter[1]) * ratio,
          newSceneCenter[2] + (p[2] - oldSceneCenter[2]) * ratio,
        ];
        assetModel.scale = [s[0] * ratio, s[1] * ratio, s[2] * ratio];
      }
    } catch (error) {
      console.warn('[Calibration] Failed to apply scene transform to asset:', {
        instanceId: id,
        error,
      });
    }
  });

  const persistedSceneScale = ctx.projectStateRef?.current?.scene_calibration?.scaleFactor;
  if (
    persistedSceneScale &&
    Number.isFinite(persistedSceneScale.x) &&
    Number.isFinite(persistedSceneScale.y) &&
    Number.isFinite(persistedSceneScale.z) &&
    persistedSceneScale.x > 0 &&
    persistedSceneScale.y > 0 &&
    persistedSceneScale.z > 0
  ) {
    globalScaleFactorRef.current = {
      x: persistedSceneScale.x,
      y: persistedSceneScale.y,
      z: persistedSceneScale.z,
    };
  } else {
    globalScaleFactorRef.current = {
      x: globalScaleFactorRef.current.x * ratio,
      y: globalScaleFactorRef.current.y * ratio,
      z: globalScaleFactorRef.current.z * ratio,
    };
  }

  setSceneScaleFactor({ ...globalScaleFactorRef.current });
};

const getCameraState = (viewer) => {
  const camera = viewer?.camera;
  if (!camera) return null;
  return { eye: [...camera.eye], look: [...camera.look], up: [...camera.up] };
};

const transformPointByObservedSceneScale = (point, oldCenter, newCenter, ratio) => [
  newCenter[0] + (point[0] - oldCenter[0]) * ratio,
  newCenter[1] + (point[1] - oldCenter[1]) * ratio,
  newCenter[2] + (point[2] - oldCenter[2]) * ratio,
];

const restoreCameraAfterCalibration = (viewer, cameraState, oldCenter, newCenter, ratio) => {
  if (!viewer || !cameraState) return;
  viewer.camera.eye = transformPointByObservedSceneScale(cameraState.eye, oldCenter, newCenter, ratio);
  viewer.camera.look = transformPointByObservedSceneScale(cameraState.look, oldCenter, newCenter, ratio);
  viewer.camera.up = [...cameraState.up];
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

  const currentMainModel = ctx.currentModelRef?.current;
  const oldSceneCenter = getAabbCenter(currentMainModel);
  const cameraState = getCameraState(ctx.viewerRef?.current);
  const furnitureMatrixSnapshot = ctx.snapshotFurnitureMatrices ? ctx.snapshotFurnitureMatrices() : {};
  ctx.setSelectedAssetIdSafe?.(null);
  ctx.setSelectedObject?.(null);
  ctx.destroyStretchHandles?.();
  if (!oldSceneCenter) {
    return { success: false, error: 'Unable to determine the current IFC scene frame for calibration.' };
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

    const reloadedModel = await reloadMainModel(ctx, jobId, { preserveCamera: true });
    const newSceneCenter = getAabbCenter(reloadedModel);
    if (!newSceneCenter) {
      throw new Error('Calibration completed, but the reloaded IFC scene frame could not be measured.');
    }

    let calibratedProjectState = ctx.transformFurnitureForCalibration
      ? await ctx.transformFurnitureForCalibration(ratio, oldSceneCenter, newSceneCenter, furnitureMatrixSnapshot)
      : { ...(ctx.projectStateRef?.current || {}), furniture: [] };

    ctx.projectStateRef.current = calibratedProjectState;

    updateFurnitureScale(
      ctx,
      ratio,
      oldSceneCenter,
      newSceneCenter,
      calibratedProjectState.furniture || []
    );

    if (ctx.restoreProjectStateToScene) {
      await ctx.restoreProjectStateToScene(calibratedProjectState);
    }

    restoreCameraAfterCalibration(
      ctx.viewerRef?.current,
      cameraState,
      oldSceneCenter,
      newSceneCenter,
      ratio
    );

    console.info('[Calibration] Applied consistent scene-frame transform to placed assets, native edits, and camera', {
      oldSceneCenter,
      newSceneCenter,
      ratio,
      persistedFurnitureCount: calibratedProjectState.furniture?.length || 0,
    });

    plugin.clear();
    setMeasurementsList([]);
    setIsLoading(false);

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
  if (!Number.isFinite(target) || target <= 0) {
    return { success: false, error: 'Enter a height greater than 0.' };
  }

  try {
    const dims = await inspectNativeElement({ file, jobId }, entityId);
    if (!dims || dims.error || !dims.height) {
      return { success: false, error: 'Element has no parametric height.' };
    }

    const ratio = target / dims.height;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return { success: false, error: 'Calculated calibration factor is invalid.' };
    }

    const oldSceneCenter = getAabbCenter(ctx.currentModelRef?.current);
    const cameraState = getCameraState(ctx.viewerRef?.current);
    const furnitureMatrixSnapshot = ctx.snapshotFurnitureMatrices ? ctx.snapshotFurnitureMatrices() : {};
    if (!oldSceneCenter) {
      return { success: false, error: 'Unable to determine the current IFC scene frame for calibration.' };
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
    if (!response.ok || data.error) {
      throw new Error(data.error || `Rescale request failed (${response.status}).`);
    }

    const reloadedModel = await reloadMainModel(ctx, jobId, { preserveCamera: true });
    const newSceneCenter = getAabbCenter(reloadedModel);
    if (!newSceneCenter) {
      throw new Error('Calibration completed, but the reloaded IFC scene frame could not be measured.');
    }

    const calibratedProjectState = ctx.transformFurnitureForCalibration
      ? await ctx.transformFurnitureForCalibration(ratio, oldSceneCenter, newSceneCenter, furnitureMatrixSnapshot)
      : ctx.projectStateRef?.current;

    updateFurnitureScale(
      ctx,
      ratio,
      oldSceneCenter,
      newSceneCenter,
      calibratedProjectState?.furniture || []
    );

    if (ctx.restoreProjectStateToScene && calibratedProjectState) {
      await ctx.restoreProjectStateToScene(calibratedProjectState);
    }

    restoreCameraAfterCalibration(
      ctx.viewerRef?.current,
      cameraState,
      oldSceneCenter,
      newSceneCenter,
      ratio
    );
    setIsLoading(false);

    return { success: true, ratio, jobId, response: data };
  } catch (err) {
    console.error('[BIM Engine] Height calibration failed:', { jobId, entityId, err });
    setIsLoading(false);
    return { success: false, error: err?.message || 'Height calibration failed.' };
  }
};
