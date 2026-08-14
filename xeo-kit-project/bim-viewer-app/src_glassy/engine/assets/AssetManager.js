import { API_BASE_URL } from '../utils/constants';

export const resolveAssetUrl = (url) => {
  if (!url) return null;
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  return `${API_BASE_URL}${url.startsWith('/') ? url : `/${url}`}`;
};

export const inferAssetFileType = (url, explicitType) => {
  if (explicitType) return String(explicitType).toLowerCase();
  const clean = String(url || '').split('?')[0].split('#')[0];
  const ext = clean.split('.').pop()?.toLowerCase();
  if (ext === 'glb' || ext === 'gltf') return ext;
  if (ext === 'xkt') return 'xkt';
  if (ext === 'ifc') return 'ifc';
  return null;
};

/**
 * Loads a standalone scene asset into xeokit's scene.
 *
 * Supported:
 *   - IFC  -> WebIFCLoaderPlugin
 *   - GLB/glTF -> GLTFLoaderPlugin
 *   - XKT -> XKTLoaderPlugin
 *
 * Important: GLB is loaded by URL because the legacy xeokit GLTFLoaderPlugin
 * expects a src/data-source path for binary glTF. The returned Entity is the
 * same kind of Scene model Entity exposed through viewer.scene.models.
 */
export const loadSceneAsset = async ({
  loadersRef,
  instanceId,
  srcUrl,
  fileType,
  targetPosition = null,
  rotation = [0, 0, 0],
  scale = [1, 1, 1],
  edges = true,
  globalScale = null,
  onPlaced = null,
  nativeSourceId = null,
}) => {
  const url = resolveAssetUrl(srcUrl);
  const type = inferAssetFileType(url, fileType);

  if (!url || !instanceId) {
    throw new Error('Asset load requires an instanceId and srcUrl.');
  }

  let loader;
  if (type === 'glb' || type === 'gltf') loader = loadersRef.current.gltf;
  else if (type === 'ifc') loader = loadersRef.current.ifc;
  else if (type === 'xkt') loader = loadersRef.current.xkt;

  if (!loader) {
    throw new Error(`No loader is ready for asset type "${type || 'unknown'}".`);
  }

  const baseScale = [
    Number(globalScale?.x ?? 1) || 1,
    Number(globalScale?.y ?? 1) || 1,
    Number(globalScale?.z ?? 1) || 1,
  ];
  const localScale = [
    Number(scale?.[0] ?? 1) || 1,
    Number(scale?.[1] ?? 1) || 1,
    Number(scale?.[2] ?? 1) || 1,
  ];
  const effectiveScale = [
    baseScale[0] * localScale[0],
    baseScale[1] * localScale[1],
    baseScale[2] * localScale[2],
  ];

  let model;

  if (type === 'ifc') {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch IFC asset (${response.status}): ${url}`);
    }
    const buffer = await response.arrayBuffer();

    model = loader.load({
      id: instanceId,
      ifc: new Uint8Array(buffer),
      edges,
      globalizeCoordinates: false,
    });
  } else if (type === 'xkt') {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch XKT asset (${response.status}): ${url}`);
    }
    const buffer = await response.arrayBuffer();

    model = loader.load({
      id: instanceId,
      xkt: buffer,
      edges,
    });
  } else {
    model = loader.load({
      id: instanceId,
      src: url,
      edges,
      pbrEnabled: true,
      colorTextureEnabled: true,
      scale: effectiveScale,
      rotation: rotation || [0, 0, 0],
      position: [0, 0, 0],
    });
  }

  await new Promise((resolve, reject) => {
    if (!model?.on) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    model.on('loaded', () => finish(resolve));
    model.on('error', (err) => finish(reject, err));
  });

  // All asset formats use the same world-space contract:
  // `targetPosition` is the bottom-center point that should touch the floor.
  // We apply scale/rotation first, then correct the model position from its
  // actual world AABB. This avoids format-specific placement math.
  model.scale = effectiveScale;
  model.rotation = rotation || [0, 0, 0];

  if (targetPosition) {
    const aabb = model.aabb;
    if (aabb) {
      const centerX = (aabb[0] + aabb[3]) / 2;
      const centerZ = (aabb[2] + aabb[5]) / 2;
      const bottomY = aabb[1];

      model.position = [
        targetPosition[0] - centerX,
        targetPosition[1] - bottomY,
        targetPosition[2] - centerZ,
      ];
    } else {
      model.position = targetPosition;
    }
    // Report the final corrected world position back so the project state
    // stores what the compiler will later use directly (no re-correction needed).
    onPlaced?.(instanceId, [...model.position]);
  }

  model._assetMeta = {
    instanceId,
    src: url,
    fileType: type,
    ...(nativeSourceId ? { nativeSourceId, isNativeIsolation: true } : {}),
  };

  return model;
};

/**
 * Backward-compatible name used by the current UI.
 * It now supports IFC, GLB/glTF and XKT instead of being IFC-only.
 */
export const loadIFCAssetIntoScene = async (
  loadersRef,
  globalScaleFactorRef,
  instanceId,
  srcUrl,
  targetPosition,
  rotation,
  options = {}
) => {
  const fileType = inferAssetFileType(srcUrl, options.fileType);
  return loadSceneAsset({
    loadersRef,
    instanceId,
    srcUrl,
    fileType,
    targetPosition,
    rotation,
    scale: options.scale || [1, 1, 1],
    globalScale: globalScaleFactorRef?.current,
    edges: options.edges !== false,
    onPlaced: options.onPlaced || null,
    nativeSourceId: options.nativeSourceId || null,
  });
};

export const updateStructuralTransform = (viewerRef, entityId, transformType, axis, value) => {
  const entity = viewerRef.current?.scene.objects[entityId];
  if (!entity) return;

  if (transformType === 'scale') {
    const newScale = [...(entity.scale || [1, 1, 1])];
    newScale[axis] = value;
    entity.scale = newScale;
  } else if (transformType === 'offset') {
    // Native IFC object offsets are not enabled in this Viewer.
    // Native movement is intentionally handled by the Unlock -> isolated
    // model workflow instead of Entity#offset.
    return;
  }
};

export const updateNativeOffset = () => {
  // Deprecated: native IFC objects do not enable Entity#offset in this Viewer.
  // Keep the API for compatibility, but never attempt to write the property.
};

const rotateYVector = (v, degrees) => {
  const rad = (degrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    v[0] * c - v[2] * s,
    v[1],
    v[0] * s + v[2] * c,
  ];
};

const getPivotWorldPosition = (model) => {
  if (!model?._transformPivot?.local) {
    const aabb = model?.aabb;
    if (!aabb) return [...(model?.position || [0, 0, 0])];
    return [
      (aabb[0] + aabb[3]) / 2,
      (aabb[1] + aabb[4]) / 2,
      (aabb[2] + aabb[5]) / 2,
    ];
  }

  const scale = model.scale || [1, 1, 1];
  const local = [
    model._transformPivot.local[0] * (scale[0] || 1),
    model._transformPivot.local[1] * (scale[1] || 1),
    model._transformPivot.local[2] * (scale[2] || 1),
  ];
  const rot = model.rotation?.[1] || 0;
  const rotated = rotateYVector(local, rot);
  const pos = model.position || [0, 0, 0];
  return [pos[0] + rotated[0], pos[1] + rotated[1], pos[2] + rotated[2]];
};

const setModelRotationPreservingPivot = (model, axis, value) => {
  const nextRotation = [...(model.rotation || [0, 0, 0])];
  nextRotation[axis] = value;

  // Native-isolation ghosts rotate around their element center, not the IFC
  // file origin. Keep the current pivot fixed while changing the model angle.
  if (model._transformPivot?.local && axis === 1) {
    const pivotWorld = getPivotWorldPosition(model);
    const scale = model.scale || [1, 1, 1];
    const localScaled = [
      model._transformPivot.local[0] * (scale[0] || 1),
      model._transformPivot.local[1] * (scale[1] || 1),
      model._transformPivot.local[2] * (scale[2] || 1),
    ];
    const rotated = rotateYVector(localScaled, value);
    model.rotation = nextRotation;
    model.position = [
      pivotWorld[0] - rotated[0],
      pivotWorld[1] - rotated[1],
      pivotWorld[2] - rotated[2],
    ];
    return;
  }

  model.rotation = nextRotation;
};

const setModelScalePreservingPivot = (model, axis, value) => {
  const nextScale = [...(model.scale || [1, 1, 1])];
  if (model._transformPivot?.local) {
    const pivotWorld = getPivotWorldPosition(model);
    nextScale[axis] = value;
    const localScaled = [
      model._transformPivot.local[0] * (nextScale[0] || 1),
      model._transformPivot.local[1] * (nextScale[1] || 1),
      model._transformPivot.local[2] * (nextScale[2] || 1),
    ];
    const rotated = rotateYVector(localScaled, model.rotation?.[1] || 0);
    model.scale = nextScale;
    model.position = [
      pivotWorld[0] - rotated[0],
      pivotWorld[1] - rotated[1],
      pivotWorld[2] - rotated[2],
    ];
    return;
  }
  nextScale[axis] = value;
  model.scale = nextScale;
};

export const updateDynamicTransform = (viewerRef, modelId, type, axis, value) => {
  const model = viewerRef.current?.scene.models[modelId];
  if (!model) return;

  if (type === 'scale') {
    setModelScalePreservingPivot(model, axis, value);
  } else if (type === 'rotation') {
    setModelRotationPreservingPivot(model, axis, value);
  } else if (type === 'position') {
    const next = [...(model.position || [0, 0, 0])];
    next[axis] = value;
    model.position = next;
  }
};

export const isolateAndMakeMoveable = async (ctx, entityId, onAdoptCallback, updateStructuralEdit) => {
  const {
    activeProject,
    viewerRef,
    loadersRef,
    globalScaleFactorRef,
    loadingModelsRef,
    setSelectedAssetId,
    setSelectedObject,
  } = ctx;

  if (!activeProject?.jobId) return null;

  const jobId = activeProject.jobId;

  try {
    const viewer = viewerRef.current;
    const nativeEntity = viewer?.scene.objects[entityId];

    if (!viewer || !nativeEntity) {
      console.warn('[NativeIsolation] Native entity not found:', entityId);
      return null;
    }

    // Faithful to the Aug-11 workflow:
    // the backend creates a standalone IFC containing this single element.
    const response = await fetch(
      `${API_BASE_URL}/api/elements/${jobId}/${entityId}/isolate`,
      { method: 'POST' }
    );

    if (!response.ok) {
      console.error('[NativeIsolation] Isolate request failed:', response.status);
      return null;
    }

    const data = await response.json();
    if (!data?.fileUrl) {
      console.error('[NativeIsolation] Backend returned no fileUrl.', data);
      return null;
    }

    const newInstanceId = `${entityId}_isolated`;

    // Do not invent a new placement transform for the isolated IFC.
    // The old working implementation loaded the isolated file at its own
    // IFC/world coordinates with no AABB target-position correction.
    let isolatedModel = viewer.scene.models[newInstanceId];

    if (!isolatedModel) {
      if (loadingModelsRef?.current?.has(newInstanceId)) {
        // Another call is already creating it; wait briefly for that live model
        // rather than asking Xeokit to instantiate the same ID twice.
        for (let i = 0; i < 100; i += 1) {
          await new Promise(resolve => setTimeout(resolve, 25));
          isolatedModel = viewer.scene.models[newInstanceId];
          if (isolatedModel) break;
        }
      } else {
        loadingModelsRef?.current?.add(newInstanceId);
        try {
          isolatedModel = await loadIFCAssetIntoScene(
            loadersRef,
            globalScaleFactorRef,
            newInstanceId,
            data.fileUrl,
            null,
            null,
            {
              fileType: 'ifc',
              // Mark it as native isolation, but do not alter its placement.
              nativeSourceId: entityId,
            }
          );
        } finally {
          loadingModelsRef?.current?.delete(newInstanceId);
        }
      }
    }

    if (!isolatedModel) {
      console.error('[NativeIsolation] Isolated model was not created:', newInstanceId);
      return null;
    }

    // The original element is hidden only after the replacement exists.
    nativeEntity.visible = false;
    updateStructuralEdit?.(entityId, 'visible', null, false);

    const metaObject = viewer.metaScene.metaObjects[entityId];

    // Store the isolated model as an editable furniture/asset entry.
    // IMPORTANT: position is the model transform, not an AABB-corrected
    // target position. For a freshly isolated IFC this should normally be [0,0,0].
    onAdoptCallback?.(
      entityId,
      newInstanceId,
      data.fileUrl,
      metaObject?.name,
      [...(isolatedModel.position || [0, 0, 0])],
      [...(isolatedModel.rotation || [0, 0, 0])],
      [...(isolatedModel.scale || [1, 1, 1])]
    );

    // Clear both object and model selection, then select the isolated model.
    const selectedIds = [...viewer.scene.selectedObjectIds];
    for (const id of selectedIds) {
      const object = viewer.scene.objects[id];
      if (object) object.selected = false;
    }
    for (const model of Object.values(viewer.scene.models || {})) {
      if (model) model.selected = false;
    }

    isolatedModel.selected = true;
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
    console.error('[NativeIsolation] Isolate-and-move failure:', error);
    return null;
  }
};

const currentNativeModelForEntity = (viewer, entityId) => {
  if (!viewer?.scene?.objects || !viewer?.scene?.models) return null;
  const entity = viewer.scene.objects[entityId];
  if (!entity?.model) return null;
  // Native entity must belong to the original main IFC model, never the
  // standalone ghost. This is the same boundary used by native restoration.
  const mainModel = Object.values(viewer.scene.models || {})
    .find(model => model?.id === 'main_structure');
  if (mainModel && entity.model === mainModel) return mainModel;
  return entity.model._assetMeta ? null : entity.model;
};

export const inspectNativeElement = async (activeProject, entityId) => {
  if (!activeProject || !activeProject.jobId || !entityId) return { error: true };
  const jobId = activeProject.jobId;

  try {
    const response = await fetch(`${API_BASE_URL}/api/elements/${jobId}/${entityId}/inspect`);
    const data = await response.json();

    if (!response.ok || data?.error) return { error: true };
    return data;
  } catch (error) {
    console.error('[BIM Engine] Inspect failure:', error);
    return { error: true };
  }
};
