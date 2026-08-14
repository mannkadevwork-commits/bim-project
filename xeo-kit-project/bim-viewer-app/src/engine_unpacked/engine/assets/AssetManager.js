import { API_BASE_URL } from '../utils/constants';

export const loadIFCAssetIntoScene = async (loadersRef, globalScaleFactorRef, instanceId, srcUrl, targetPosition, rotation) => {
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

export const isolateAndMakeMoveable = async (ctx, entityId, onAdoptCallback, updateStructuralEdit) => {
  const { file, viewerRef, loadersRef, globalScaleFactorRef, setSelectedAssetId, setSelectedObject } = ctx;
  if (!file) return;
  const jobId = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

  try {
    const response = await fetch(`${API_BASE_URL}/api/elements/${jobId}/${entityId}/isolate`, { method: 'POST' });
    if (!response.ok) return;

    const data = await response.json();
    
    const nativeEntity = viewerRef.current?.scene.objects[entityId];
    if (nativeEntity) {
      nativeEntity.visible = false;
      if (updateStructuralEdit) {
          updateStructuralEdit(entityId, 'visible', null, false);
      }
    }

    const newInstanceId = `${entityId}_isolated`;
    await loadIFCAssetIntoScene(loadersRef, globalScaleFactorRef, newInstanceId, data.fileUrl);

    const metaObject = viewerRef.current?.metaScene.metaObjects[entityId];

    if (onAdoptCallback) {
      onAdoptCallback(entityId, newInstanceId, data.fileUrl, metaObject?.name);
    }

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