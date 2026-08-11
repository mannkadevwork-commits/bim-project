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
  }

  model._assetMeta = {
    instanceId,
    src: url,
    fileType: type,
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
    const next = [...(model.scale || [1, 1, 1])];
    next[axis] = value;
    model.scale = next;
  } else if (type === 'rotation') {
    const next = [...(model.rotation || [0, 0, 0])];
    next[axis] = value;
    model.rotation = next;
  } else if (type === 'position') {
    const next = [...(model.position || [0, 0, 0])];
    next[axis] = value;
    model.position = next;
  }
};

export const isolateAndMakeMoveable = async (ctx, entityId, onAdoptCallback, updateStructuralEdit) => {
  const {
    file,
    viewerRef,
    loadersRef,
    globalScaleFactorRef,
    setSelectedAssetId,
    setSelectedObject,
  } = ctx;

  if (!file) return;
  const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

  try {
    const response = await fetch(`${API_BASE_URL}/api/elements/${jobId}/${entityId}/isolate`, {
      method: 'POST',
    });
    if (!response.ok) return;

    const data = await response.json();

    const nativeEntity = viewerRef.current?.scene.objects[entityId];
    if (nativeEntity) {
      nativeEntity.visible = false;
      updateStructuralEdit?.(entityId, 'visible', null, false);
    }

    const newInstanceId = `${entityId}_isolated`;
    await loadSceneAsset({
      loadersRef,
      globalScaleFactorRef,
      instanceId: newInstanceId,
      srcUrl: data.fileUrl,
      fileType: 'ifc',
    });

    const metaObject = viewerRef.current?.metaScene.metaObjects[entityId];

    onAdoptCallback?.(entityId, newInstanceId, data.fileUrl, metaObject?.name);

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

export const inspectNativeElement = async (file, entityId) => {
  if (!file || !entityId) return { error: true };

  const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

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
