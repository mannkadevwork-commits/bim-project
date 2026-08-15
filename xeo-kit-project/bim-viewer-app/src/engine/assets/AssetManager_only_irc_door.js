import { API_BASE_URL } from '../utils/constants';

const nativeIsolationInFlight = new Set();

export const loadIFCAssetIntoScene = async (
  loadersRef,
  globalScaleFactorRef,
  instanceId,
  srcUrl,
  targetPosition,
  rotation,
  options = {}
) => {
  if (!loadersRef.current.ifc) return null;

  try {
    const response = await fetch(srcUrl);
    if (!response.ok) throw new Error(`Asset fetch failed (${response.status})`);

    const buffer = await response.arrayBuffer();
    const fileType = options.fileType || 'ifc';
    const assetModel = loadersRef.current.ifc.load({
      id: instanceId,
      ifc: new Uint8Array(buffer),
      edges: true,
      globalizeCoordinates: false,
    });

    // This marker is the authoritative discriminator between a separately loaded
    // editable asset and the original/native IFC model. Do not infer this from IDs.
    assetModel._assetMeta = {
      instanceId,
      fileType,
      srcUrl,
    };

    assetModel.on('loaded', () => {
      const userScale = Array.isArray(options.scale) && options.scale.length === 3
        ? options.scale
        : [1, 1, 1];

      const safeRotation = Array.isArray(rotation) && rotation.length === 3
        ? rotation
        : [0, 0, 0];

      assetModel.scale = [...userScale];
      assetModel.rotation = [...safeRotation];

      // Placed library assets use a target-position semantic: the saved target is
      // the desired floor/contact center, not the raw loaded model origin.
      if (Array.isArray(targetPosition) && targetPosition.length === 3) {
        const aabb = assetModel.aabb;
        if (aabb && aabb.length >= 6) {
          const centerX = (aabb[0] + aabb[3]) / 2;
          const centerZ = (aabb[2] + aabb[5]) / 2;
          const bottomY = aabb[1];
          assetModel.position = [
            targetPosition[0] - centerX,
            targetPosition[1] - bottomY,
            targetPosition[2] - centerZ,
          ];
        } else {
          assetModel.position = [...targetPosition];
        }
      }

      if (typeof options.onLoaded === 'function') {
        options.onLoaded(assetModel);
      }

      if (typeof options.onPlaced === 'function') {
        const persistedTarget = Array.isArray(targetPosition) && targetPosition.length === 3
          ? [...targetPosition]
          : [...assetModel.position];
        options.onPlaced(instanceId, persistedTarget, assetModel);
      }
    });

    return assetModel;
  } catch (error) {
    console.error('[BIM Engine] Placement failure:', error);
    throw error;
  }
};

export const isolateAndMakeMoveable = async (ctx, entityId, onAdoptCallback, updateStructuralEdit) => {
  const {
    file: ctxFile,
    jobId: ctxJobId,
    activeProject,
    viewerRef,
    currentModelRef,
    loadersRef,
    globalScaleFactorRef,
    setSelectedAssetId,
    setSelectedObject,
  } = ctx;

  const file = ctxFile || activeProject?.file;
  const jobId = ctxJobId || activeProject?.jobId;

  if (!file || !jobId || !entityId) {
    const error = new Error('Cannot unlock native element: missing canonical project jobId or entityId.');
    console.error('[NativeEdit] Cannot unlock:', { jobId, entityId, error: error.message });
    throw error;
  }

  const isolationKey = `${jobId}:${entityId}`;
  if (nativeIsolationInFlight.has(isolationKey)) {
    console.warn('[NativeEdit] Unlock already in progress:', { jobId, entityId });
    return null;
  }
  nativeIsolationInFlight.add(isolationKey);

  try {
    const viewer = viewerRef.current;
    const originalModel = currentModelRef?.current || null;
    const originalNativeEntities = viewer
      ? Object.values(viewer.scene.objects || {}).filter((object) => (
          object?.id === entityId
          && (!originalModel || object.model === originalModel)
        ))
      : [];

    console.info('[NativeEdit] Unlock request:', {
      jobId,
      entityId,
      originalModelId: originalModel?.id || null,
      capturedNativeEntityCount: originalNativeEntities.length,
    });

    const response = await fetch(
      `${API_BASE_URL}/api/elements/${encodeURIComponent(jobId)}/${encodeURIComponent(entityId)}/isolate`,
      { method: 'POST' }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.fileUrl) {
      throw new Error(data?.error || `Native element isolate failed (${response.status})`);
    }

    const newInstanceId = `${entityId}_isolated`;
    const metaObject = viewerRef.current?.metaScene.metaObjects[entityId];

    let resolveLoaded;
    let rejectLoaded;
    const loadedPromise = new Promise((resolve, reject) => {
      resolveLoaded = resolve;
      rejectLoaded = reject;
    });

    const isolatedModel = await loadIFCAssetIntoScene(
      loadersRef,
      globalScaleFactorRef,
      newInstanceId,
      data.fileUrl,
      null,
      [0, 0, 0],
      {
        fileType: 'ifc',
        scale: [1, 1, 1],
        onLoaded: (model) => {
          model._assetMeta = {
            ...(model._assetMeta || {}),
            isNativeIsolation: true,
            nativeSourceId: entityId,
            sourceJobId: jobId,
          };
          resolveLoaded(model);
        },
      }
    );

    if (!isolatedModel) throw new Error('Isolated IFC model could not be created.');
    if (typeof isolatedModel.on === 'function') {
      isolatedModel.on('error', (err) => rejectLoaded(err || new Error('Isolated IFC model failed to load.')));
    }
    await loadedPromise;

    // IMPORTANT: the isolated IFC can contain the same GlobalId as the native
    // element. Once it has loaded, scene.objects[entityId] may resolve to the
    // isolated entity instead of the original one. We therefore hide the exact
    // native entity reference captured BEFORE loading the isolated model.
    // Never hide by a post-load global ID lookup.
    const nativeEntitiesToHide = originalNativeEntities.length > 0
      ? originalNativeEntities
      : (viewerRef.current
        ? Object.values(viewerRef.current.scene.objects || {}).filter((object) => (
            object?.id === entityId
            && object?.model
            && object.model !== isolatedModel
          ))
        : []);

    nativeEntitiesToHide.forEach((entity) => {
      try { entity.visible = false; } catch (error) {
        console.warn('[NativeEdit] Failed to hide original native entity:', entityId, error);
      }
    });

    if (nativeEntitiesToHide.length > 0) {
      updateStructuralEdit?.(entityId, 'visible', null, false);
    } else {
      console.warn('[NativeEdit] Original native entity was not found after isolation:', {
        jobId,
        entityId,
        isolatedModelId: isolatedModel.id,
      });
    }

    onAdoptCallback?.(
      entityId,
      newInstanceId,
      data.fileUrl,
      metaObject?.name,
      [...(isolatedModel.position || [0, 0, 0])],
      [...(isolatedModel.rotation || [0, 0, 0])],
      [...(isolatedModel.scale || [1, 1, 1])],
      {
        isNativeIsolation: true,
        nativeSourceId: entityId,
        sourceJobId: jobId,
        matrix: isolatedModel.matrix && isolatedModel.matrix.length === 16 ? Array.from(isolatedModel.matrix) : null,
      }
    );

    if (viewer) {
      viewer.scene.setObjectsSelected(viewer.scene.selectedObjectIds, false);
      isolatedModel.selected = true;
    }

    setSelectedAssetId(newInstanceId);
    setSelectedObject({
      id: newInstanceId,
      name: metaObject?.name || 'Isolated Element',
      type: metaObject?.type || 'Generic Component',
      groupedProperties: metaObject
        ? { 'General Details': [
            { name: 'Element Name', value: metaObject.name || 'Unnamed' },
            { name: 'IFC Class', value: metaObject.type || 'Unknown' },
            { name: 'Global ID', value: metaObject.id },
          ] }
        : {},
    });

    console.info('[NativeEdit] Unlock complete:', { jobId, entityId, newInstanceId });
    return newInstanceId;
  } catch (error) {
    console.error('[BIM Engine] Isolate-and-move failure:', { jobId, entityId, error });
    throw error;
  } finally {
    nativeIsolationInFlight.delete(isolationKey);
  }
};

export const inspectNativeElement = async (activeProject, entityId) => {
  const file = activeProject?.file;
  const jobId = activeProject?.jobId;
  if (!file || !jobId || !entityId) return { error: true };

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

export const updateStructuralTransform = (viewerRef, entityId, transformType, axis, value) => {
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

export const updateNativeOffset = (viewerRef, id, axis, value) => {
  const entity = viewerRef.current?.scene.objects[id];
  if (entity) {
      const newOffset = [...(entity.offset || [0, 0, 0])];
      newOffset[axis] = value;
      entity.offset = newOffset;
  }
};

export const updateDynamicTransform = (viewerRef, modelId, type, axis, value) => {
  const model = viewerRef.current?.scene.models[modelId];
  if (!model) return;
  if (type === 'scale') {
      const newScale = [...(model.scale || [1, 1, 1])];
      newScale[axis] = value;
      model.scale = newScale;
  } else if (type === 'rotation') {
      const newRot = [...(model.rotation || [0, 0, 0])];
      newRot[1] = value; 
      model.rotation = newRot;
  } else if (type === 'position') {
      const newPos = [...(model.position || [0, 0, 0])];
      newPos[axis] = value;
      model.position = newPos;
  }
};