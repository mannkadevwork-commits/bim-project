import { useState, useEffect, useRef } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const inferFileType = (url, explicitType) => {
  if (explicitType) return String(explicitType).toLowerCase();
  const clean = String(url || '').split('?')[0].split('#')[0];
  const ext = clean.split('.').pop()?.toLowerCase();
  return ['ifc', 'glb', 'gltf', 'xkt'].includes(ext) ? ext : 'ifc';
};

const applyColorToSceneTarget = (viewer, targetId, rgb) => {
  if (!viewer || !targetId || !Array.isArray(rgb)) return false;
  const entity = viewer.scene.objects[targetId];
  if (entity) {
    entity.colorize = rgb;
    return true;
  }
  const model = viewer.scene.models[targetId];
  if (!model) return false;
  let changed = false;
  Object.values(viewer.scene.objects || {}).forEach(object => {
    if (object.model?.id === targetId) {
      object.colorize = rgb;
      changed = true;
    }
  });
  return changed;
};

const MOCK_ROOM_TEMPLATES = [
  {
    id: 'room_master_bedroom',
    name: 'Master Bedroom Setup',
    description: 'Double bed with wardrobes and side tables.',
    items: [
      { id: 'bed_double', name: 'Master Bed', url: '/assets/bed_master.ifc', position: [2, 0, -3], rotation: [0, 90, 0] },
      { id: 'wardrobe', name: 'Wardrobe', url: '/assets/wardrobe.ifc', position: [4, 0, -3], rotation: [0, 0, 0] },
      { id: 'side_table', name: 'Side Table', url: '/assets/side_table.ifc', position: [2, 0, -1.5], rotation: [0, 0, 0] },
    ]
  },
  {
    id: 'room_living',
    name: 'Living Room Setup',
    description: 'Sofa set, center table, and TV unit.',
    items: [
      { id: 'sofa_3seater', name: 'Main Sofa', url: '/assets/sofa.ifc', position: [-2, 0, 2], rotation: [0, 0, 0] },
      { id: 'tv_unit', name: 'TV Unit', url: '/assets/tv_unit.ifc', position: [-2, 0, 5], rotation: [0, 180, 0] },
      { id: 'coffee_table', name: 'Coffee Table', url: '/assets/coffee_table.ifc', position: [-1, 0, 3.5], rotation: [0, 0, 0] },
    ]
  }
];

export const useProjectSync = (activeProject) => {
  const { file, jobId } = activeProject || {};
  const [projectState, setProjectState] = useState({ materials: {}, furniture: [], structural_edits: {} });
  const projectStateRef = useRef(projectState);
  
  const [availableAssets, setAvailableAssets] = useState([]);
  const [availableLayouts, setAvailableLayouts] = useState([]);
  const [layoutsLoading, setLayoutsLoading] = useState(false);
  const [layoutsError, setLayoutsError] = useState(null);
  const [homeTemplates, setHomeTemplates] = useState(MOCK_ROOM_TEMPLATES);
  const [saveStatus, setSaveStatus] = useState('saved');
  const [lastSavedTime, setLastSavedTime] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);
  const [customColor, setCustomColor] = useState('#ffffff');

  // Concurrency controls for saving
  const isSavingRef = useRef(false);
  const pendingSaveRef = useRef(null);

  useEffect(() => { projectStateRef.current = projectState; }, [projectState]);

  // 1. LOAD: Fetch initial project state & asset catalog on startup
  useEffect(() => {
    if (file && jobId) {
      setProjectState({ materials: {}, furniture: [], structural_edits: {}, scene_calibration: { scaleFactor: { x: 1, y: 1, z: 1 } } });

      fetch(`${API_BASE_URL}/api/projects/${jobId}/load`)
        .then(res => {
          if (!res.ok) throw new Error('Failed to load from server');
          return res.json();
        })
        .then(data => {
          if (data) {
            setProjectState({
              materials: data.materials || {},
              furniture: data.furniture || [],
              structural_edits: data.structural_edits || {},
              scene_calibration: data.scene_calibration || { scaleFactor: { x: 1, y: 1, z: 1 } },
            });
          }
        })
        .catch(() => {
          const localState = localStorage.getItem(`hci_state_${jobId}`);
          if (localState) {
            try {
              const parsed = JSON.parse(localState);
              setProjectState({
                materials: parsed.materials || {},
                furniture: parsed.furniture || [],
                structural_edits: parsed.structural_edits || {},
                scene_calibration: parsed.scene_calibration || { scaleFactor: { x: 1, y: 1, z: 1 } },
              });
            } catch (e) {
              console.warn('[ProjectSync] Failed to parse local state, starting fresh.');
            }
          }
        });
    } else {
      setProjectState({ materials: {}, furniture: [], structural_edits: {}, scene_calibration: { scaleFactor: { x: 1, y: 1, z: 1 } } });
    }

    fetch(`${API_BASE_URL}/api/assets`)
      .then(res => res.json())
      .then(data => setAvailableAssets(data))
      .catch(err => console.error('[ProjectSync] Failed to load asset catalog:', err));

    setLayoutsLoading(true);
    setLayoutsError(null);
    fetch(`${API_BASE_URL}/api/layouts`)
      .then(res => {
        if (!res.ok) throw new Error(`Failed to load layouts (${res.status})`);
        return res.json();
      })
      .then(data => setAvailableLayouts(Array.isArray(data?.layouts) ? data.layouts : []))
      .catch(err => {
        console.error('[ProjectSync] Failed to load predefined layouts:', err);
        setLayoutsError(err.message);
        setAvailableLayouts([]);
      })
      .finally(() => setLayoutsLoading(false));
  }, [file, jobId]);

  // 2. AUTO-SAVE: Safe sequential queue
  const processSaveQueue = async () => {
    if (isSavingRef.current || !pendingSaveRef.current) return;

    const { state, targetJobId } = pendingSaveRef.current;
    pendingSaveRef.current = null;
    isSavingRef.current = true;
    setSaveStatus('saving');

    try {
      localStorage.setItem(`hci_state_${targetJobId}`, JSON.stringify(state));
      await fetch(`${API_BASE_URL}/api/projects/${targetJobId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      setSaveStatus('saved');
      setLastSavedTime(new Date());
    } catch (err) {
      console.error('[ProjectSync] Cloud auto-save failed:', err);
      setSaveStatus('error');
    } finally {
      isSavingRef.current = false;
      if (pendingSaveRef.current) {
        processSaveQueue();
      }
    }
  };

  useEffect(() => {
    if (
      Object.keys(projectState.materials || {}).length === 0 &&
      (projectState.furniture || []).length === 0 &&
      Object.keys(projectState.structural_edits || {}).length === 0
    ) return;

    if (!jobId) return;

    setSaveStatus('unsaved');
    pendingSaveRef.current = { state: projectState, targetJobId: jobId };
    processSaveQueue();
  }, [projectState, jobId]);

  const saveNow = async (stateOverride) => {
    if (!jobId) return;
    const stateToSave = stateOverride || projectStateRef.current;
    setSaveStatus('saving');
    try {
      localStorage.setItem(`hci_state_${jobId}`, JSON.stringify(stateToSave));
      await fetch(`${API_BASE_URL}/api/projects/${jobId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stateToSave),
      });
      setSaveStatus('saved');
      setLastSavedTime(new Date());
    } catch (err) {
      console.error('[ProjectSync] Manual save failed:', err);
      setSaveStatus('error');
    }
  };

  const applyMaterial = (viewerRef, selectedObject, hexColor, rgbArray) => {
    if (!selectedObject || !viewerRef.current) return 0;

    const viewer = viewerRef.current;
    applyColorToSceneTarget(viewer, selectedObject.id, rgbArray);
    setCustomColor(hexColor);

    setProjectState(prev => ({
      ...prev,
      materials: {
        ...(prev.materials || {}),
        [selectedObject.id]: { color: hexColor, rgb: rgbArray },
      },
    }));
    return 1;
  };

  // ACTION: Apply one material color to every native wall in the current IFC scene.
  // Scope is deliberately semantic (IFC class from metaObjects), not name matching.
  const applyMaterialToAllWalls = (viewerRef, hexColor, rgbArray) => {
    const viewer = viewerRef.current;
    if (!viewer || !Array.isArray(rgbArray) || rgbArray.length !== 3) return 0;

    const wallIds = [];
    const metaObjects = viewer.metaScene?.metaObjects || {};
    Object.values(metaObjects).forEach(meta => {
      const type = String(meta?.type || '').toLowerCase();
      if (!type.includes('ifcwall')) return;
      const id = meta?.id;
      if (!id || !viewer.scene.objects[id]) return;
      wallIds.push(id);
    });

    if (!wallIds.length) return 0;

    wallIds.forEach(id => applyColorToSceneTarget(viewer, id, rgbArray));

    setCustomColor(hexColor);
    setProjectState(prev => {
      const nextMaterials = { ...(prev.materials || {}) };
      wallIds.forEach(id => {
        nextMaterials[id] = { color: hexColor, rgb: rgbArray };
      });
      return { ...prev, materials: nextMaterials };
    });

    return wallIds.length;
  };

  const normalizeMatrix = (matrix) => {
    if (!matrix || typeof matrix.length !== 'number' || matrix.length !== 16) return null;
    return Array.from(matrix, Number);
  };

  // ACTION: Update asset transform
  const updateAsset = (viewerRef, selectedAssetId, axis, value, isRotation = false, isScale = false) => {
    if (!selectedAssetId || !viewerRef.current) return;
    const assetModel = viewerRef.current.scene.models[selectedAssetId];
    if (!assetModel) return;
    const numValue = parseFloat(value);
    if (!Number.isFinite(numValue)) return;

    let updatedPos;
    let updatedRot;
    let updatedScale;

    if (isScale) {
      updatedScale = [...(assetModel.scale || [1, 1, 1])];
      updatedScale[axis] = Math.max(0.001, numValue);
      assetModel.scale = updatedScale;
    } else if (isRotation) {
      updatedRot = [...(assetModel.rotation || [0, 0, 0])];
      updatedRot[axis] = numValue;
      assetModel.rotation = updatedRot;
    } else {
      updatedPos = [...(assetModel.position || [0, 0, 0])];
      updatedPos[axis] = numValue;
      assetModel.position = updatedPos;
    }

    const persistedPosition = isRotation || isScale
      ? null
      : assetModelToTargetPosition(assetModel);
    const persistedMatrix = normalizeMatrix(assetModel.matrix);

    setProjectState(prev => ({
      ...prev,
      furniture: (prev.furniture || []).map(f =>
        f.instanceId === selectedAssetId
          ? {
              ...f,
              position: persistedPosition || f.position || [0, 0, 0],
              rotation: updatedRot || f.rotation || [0, 0, 0],
              scale: updatedScale || f.scale || [1, 1, 1],
              ...(persistedMatrix ? { matrix: persistedMatrix } : {}),
            }
          : f
      ),
    }));
  };

  const deleteAsset = (viewerRef, selectedAssetId) => {
    if (!selectedAssetId) return;

    const assetModel = viewerRef.current?.scene.models[selectedAssetId];
    if (assetModel) {
      assetModel.destroy();
    }

    // Persistence is authoritative. Even if the live xeokit model is already
    // gone (for example after a reload/race), the saved furniture entry must
    // always be removed so a later calibration/reload cannot resurrect it.
    setProjectState(prev => ({
      ...prev,
      furniture: (prev.furniture || []).filter(f => f.instanceId !== selectedAssetId),
    }));

    setToastMessage('Asset removed.');
    setTimeout(() => setToastMessage(null), 3000);
  };

  const applyTemplate = (templateId, loadIFCAssetIntoScene) => {
    const template = homeTemplates.find(t => t.id === templateId);
    if (!template) return;
    const newFurnitureItems = template.items.map(item => {
      const uniqueId = `${item.id}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const fullAssetUrl = item.url.startsWith('http') ? item.url : `${API_BASE_URL}${item.url}`;
      const baseScale = item.scale || [1, 1, 1];
      const sceneScale = globalSceneScale(projectStateRef.current);
      // Newly placed library assets do not contain the calibrated scene scale in
      // their source geometry. Bake the CURRENT scene calibration into the initial
      // runtime/persisted scale exactly once for this new asset. Existing assets are
      // already persisted in the current scene frame and are not rescaled on restore.
      const effectiveScale = baseScale.map((v, i) => v * sceneScale[i]);

      loadIFCAssetIntoScene(uniqueId, fullAssetUrl, item.position, item.rotation, { fileType: inferFileType(item.url, item.file_type), scale: effectiveScale });
      
      return {
        id: item.id,
        instanceId: uniqueId,
        name: item.name,
        src: fullAssetUrl,
        fileType: inferFileType(item.url, item.file_type),
        position: item.position || [0, 0, 0],
        rotation: item.rotation || [0, 0, 0],
        scale: effectiveScale,
      };
    });

    setProjectState(prev => ({
      ...prev,
      furniture: [...(prev.furniture || []), ...newFurnitureItems],
    }));
    setToastMessage(`${template.name} Applied!`);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const globalSceneScale = (state) => {
    const s = state?.scene_calibration?.scaleFactor;
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) return [1, 1, 1];
    return [s.x, s.y, s.z];
  };

  const assetModelToTargetPosition = (assetModel) => {
    const aabb = assetModel?.aabb;
    const pos = Array.isArray(assetModel?.position) ? assetModel.position : [0, 0, 0];
    if (!aabb || aabb.length < 6) return [...pos];
    return [
      pos[0] + (aabb[0] + aabb[3]) / 2,
      pos[1] + aabb[1],
      pos[2] + (aabb[2] + aabb[5]) / 2,
    ];
  };


  const spawnAsset = (asset, coordinates, loadIFCAssetIntoScene, rotation = [0, 0, 0]) => {
    const uniqueId = `${asset.id}_${Date.now()}`;
    const urlPath = asset.url || asset.src || `/assets/${asset.id}.ifc`;
    const fullAssetUrl = urlPath.startsWith('http') ? urlPath : `${API_BASE_URL}${urlPath}`;
    const fileType = inferFileType(urlPath, asset.file_type || asset.fileType);
    const baseScale = Array.isArray(asset.scale) && asset.scale.length === 3 ? asset.scale : [1, 1, 1];
    const sceneScale = globalSceneScale(projectStateRef.current);
    // Newly placed library assets need the current scene calibration baked into
    // their initial effective scale. Existing persisted assets already carry the
    // effective scale for their current scene frame.
    const effectiveScale = baseScale.map((value, i) => value * sceneScale[i]);
    const position = Array.isArray(coordinates) && coordinates.length === 3 ? [...coordinates] : [0, 0, 0];
    const safeRotation = Array.isArray(rotation) && rotation.length === 3 ? [...rotation] : [0, 0, 0];

    // GLB doors placed via insert-door carry hostWallId. Persisting doorHostWallId
    // tells the compiler to use the exact Python-computed void-center position
    // instead of applying a furniture-style AABB pivot correction.
    const doorHostWallId = asset.hostWallId || null;

    const furnitureItem = {
      id: asset.id,
      instanceId: uniqueId,
      name: asset.name || asset.id,
      src: fullAssetUrl,
      fileType,
      position,
      rotation: safeRotation,
      scale: effectiveScale,
      ...(doorHostWallId ? { doorHostWallId } : {}),
    };

    setProjectState(prev => ({
      ...prev,
      furniture: [...(prev.furniture || []), furnitureItem],
    }));

    const onPlaced = (instanceId, finalPosition, model) => {
      const matrix = normalizeMatrix(model?.matrix);
      setProjectState(prev => ({
        ...prev,
        furniture: (prev.furniture || []).map(item =>
          item.instanceId === instanceId
            ? {
                ...item,
                position: Array.isArray(finalPosition) ? [...finalPosition] : item.position,
                ...(matrix ? { matrix } : {}),
              }
            : item
        ),
      }));
    };

    loadIFCAssetIntoScene(
      uniqueId,
      fullAssetUrl,
      position,
      safeRotation,
      { fileType, scale: effectiveScale, onPlaced }
    ).catch(error => {
      console.error('[ProjectSync] Failed to load placed asset:', error);
      setProjectState(prev => ({
        ...prev,
        furniture: (prev.furniture || []).filter(item => item.instanceId !== uniqueId),
      }));
    });

    setToastMessage(`${furnitureItem.name} placed!`);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const updateStructuralEdit = (entityId, transformType, axis, value) => {
    if (!entityId) return;
    if (transformType !== 'scale' && transformType !== 'offset' && transformType !== 'visible') return;

    setProjectState(prev => {
      const structuralEdits = prev.structural_edits || {};
      const existingEdit = structuralEdits[entityId] || {};

      if (transformType === 'visible') {
        return {
          ...prev,
          structural_edits: {
            ...structuralEdits,
            [entityId]: {
              ...existingEdit,
              visible: value,
            },
          },
        };
      }

      const defaultVector = transformType === 'scale' ? [1, 1, 1] : [0, 0, 0];
      const updatedVector = [...(existingEdit[transformType] || defaultVector)];
      if (axis !== null && axis !== undefined) updatedVector[axis] = value;

      return {
        ...prev,
        structural_edits: {
          ...structuralEdits,
          [entityId]: {
            ...existingEdit,
            [transformType]: updatedVector,
          },
        },
      };
    });
  };

  const adoptIsolatedAsset = (
    entityId,
    newInstanceId,
    fileUrl,
    assetName,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    scale = [1, 1, 1],
    metadata = {}
  ) => {
    setProjectState(prev => {
      const furniture = prev.furniture || [];
      if (furniture.some(item => item.instanceId === newInstanceId)) return prev;

      return {
        ...prev,
        furniture: [
          ...furniture,
          {
            id: entityId,
            instanceId: newInstanceId,
            name: assetName || 'Isolated Element',
            src: fileUrl,
            fileType: 'ifc',
            position: Array.isArray(position) ? [...position] : [0, 0, 0],
            rotation: Array.isArray(rotation) ? [...rotation] : [0, 0, 0],
            scale: Array.isArray(scale) ? [...scale] : [1, 1, 1],
            ...(Array.isArray(metadata?.matrix) && metadata.matrix.length === 16 ? { matrix: [...metadata.matrix] } : {}),
            nativeSourceId: metadata?.nativeSourceId || entityId,
            isNativeIsolation: metadata?.isNativeIsolation !== false,
          },
        ],
      };
    });
  };

  const persistProjectStateForCalibration = async (state) => {
    if (!jobId) throw new Error('No active project jobId for calibration persistence.');

    while (isSavingRef.current || pendingSaveRef.current) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    localStorage.setItem(`hci_state_${jobId}`, JSON.stringify(state));
    const response = await fetch(`${API_BASE_URL}/api/projects/${jobId}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to persist calibrated project state (${response.status})${text ? `: ${text}` : ''}`);
    }

    return true;
  };

  const transformMatrixBySceneScale = (matrix, ratio, oldSceneCenter, newSceneCenter) => {
    const m = normalizeMatrix(matrix);
    if (!m) return null;
    const tx = newSceneCenter[0] - ratio * oldSceneCenter[0];
    const ty = newSceneCenter[1] - ratio * oldSceneCenter[1];
    const tz = newSceneCenter[2] - ratio * oldSceneCenter[2];
    return [
      m[0] * ratio, m[1] * ratio, m[2] * ratio, m[3],
      m[4] * ratio, m[5] * ratio, m[6] * ratio, m[7],
      m[8] * ratio, m[9] * ratio, m[10] * ratio, m[11],
      m[12] * ratio + tx, m[13] * ratio + ty, m[14] * ratio + tz, m[15],
    ];
  };

  const transformFurnitureForCalibration = async (ratio, oldSceneCenter, newSceneCenter, matrixSnapshots = {}) => {
    if (!Number.isFinite(ratio) || ratio <= 0 ||
        !Array.isArray(oldSceneCenter) || !Array.isArray(newSceneCenter) ||
        oldSceneCenter.length !== 3 || newSceneCenter.length !== 3 ||
        !oldSceneCenter.every(Number.isFinite) || !newSceneCenter.every(Number.isFinite)) {
      throw new Error('Invalid calibration scene transform.');
    }

    const currentState = projectStateRef.current || {
      materials: {},
      furniture: [],
      structural_edits: {},
      scene_calibration: { scaleFactor: { x: 1, y: 1, z: 1 } },
    };

    const previousSceneScale = currentState.scene_calibration?.scaleFactor || { x: 1, y: 1, z: 1 };
    const safePrevious = {
      x: Number.isFinite(previousSceneScale.x) && previousSceneScale.x > 0 ? previousSceneScale.x : 1,
      y: Number.isFinite(previousSceneScale.y) && previousSceneScale.y > 0 ? previousSceneScale.y : 1,
      z: Number.isFinite(previousSceneScale.z) && previousSceneScale.z > 0 ? previousSceneScale.z : 1,
    };

    // IMPORTANT STATE INVARIANT:
    // Normal placed assets store a semantic placement target in the CURRENT IFC
    // scene frame. Native-isolated IFCs use position as the explicit model
    // translation term because their source geometry remains in IFC/world space.
    // Both are transformed by the same observed scene affine transform.
    //
    // furniture.scale is the effective authored/render scale in the CURRENT
    // scene frame. The backend rescales the main IFC; external assets therefore
    // receive the same ratio exactly once. No arbitrary offset and no extra
    // calibrationSourceScale multiplication are introduced.
    const nextFurniture = (currentState.furniture || []).map(item => {
      const position = Array.isArray(item.position) && item.position.length === 3
        ? item.position
        : [0, 0, 0];
      const scale = Array.isArray(item.scale) && item.scale.length === 3
        ? item.scale
        : [1, 1, 1];

      const sourceMatrix = normalizeMatrix(item.matrix) || normalizeMatrix(matrixSnapshots?.[item.instanceId]);
      const nextMatrix = sourceMatrix
        ? transformMatrixBySceneScale(sourceMatrix, ratio, oldSceneCenter, newSceneCenter)
        : null;

      return {
        ...item,
        position: [
          newSceneCenter[0] + (position[0] - oldSceneCenter[0]) * ratio,
          newSceneCenter[1] + (position[1] - oldSceneCenter[1]) * ratio,
          newSceneCenter[2] + (position[2] - oldSceneCenter[2]) * ratio,
        ],
        scale: [
          scale[0] * ratio,
          scale[1] * ratio,
          scale[2] * ratio,
        ],
        ...(nextMatrix ? { matrix: nextMatrix } : {}),
      };
    });

    const nextState = {
      ...currentState,
      furniture: nextFurniture,
      scene_calibration: {
        ...(currentState.scene_calibration || {}),
        scaleFactor: {
          x: safePrevious.x * ratio,
          y: safePrevious.y * ratio,
          z: safePrevious.z * ratio,
        },
        migratedToFrameScale: true,
      },
    };

    projectStateRef.current = nextState;
    setProjectState(nextState);
    await persistProjectStateForCalibration(nextState);
    return nextState;
  };

  // One-time migration for Phase 11 projects that stored user-scale and
  // calibration-source metadata separately. The current architecture stores
  // furniture directly in the current scene frame, so we fold the legacy scene
  // factor into the persisted furniture exactly once and mark the migration.
  const repairLegacyCalibrationState = async (oldSceneCenter, newSceneCenter) => {
    const currentState = projectStateRef.current;
    if (!currentState) return currentState;

    const sceneScale = globalSceneScale(currentState);
    const hasLegacyMetadata = (currentState.furniture || []).some(item =>
      Array.isArray(item?.calibrationSourceScale)
    );
    const alreadyMigrated = currentState.scene_calibration?.migratedToFrameScale === true;

    if (!hasLegacyMetadata || alreadyMigrated || sceneScale.every(v => Math.abs(v - 1) < 1e-9)) {
      return currentState;
    }

    if (!Array.isArray(oldSceneCenter) || !Array.isArray(newSceneCenter) ||
        oldSceneCenter.length !== 3 || newSceneCenter.length !== 3 ||
        !oldSceneCenter.every(Number.isFinite) || !newSceneCenter.every(Number.isFinite)) {
      throw new Error('Invalid legacy calibration frame.');
    }

    const nextFurniture = (currentState.furniture || []).map(item => {
      const position = Array.isArray(item.position) && item.position.length === 3 ? item.position : [0, 0, 0];
      const scale = Array.isArray(item.scale) && item.scale.length === 3 ? item.scale : [1, 1, 1];
      return {
        ...item,
        position: [
          newSceneCenter[0] + (position[0] - oldSceneCenter[0]) * sceneScale[0],
          newSceneCenter[1] + (position[1] - oldSceneCenter[1]) * sceneScale[1],
          newSceneCenter[2] + (position[2] - oldSceneCenter[2]) * sceneScale[2],
        ],
        scale: [scale[0] * sceneScale[0], scale[1] * sceneScale[1], scale[2] * sceneScale[2]],
        calibrationSourceScale: undefined,
      };
    });

    const nextState = {
      ...currentState,
      furniture: nextFurniture,
      scene_calibration: {
        ...(currentState.scene_calibration || {}),
        migratedToFrameScale: true,
      },
    };

    projectStateRef.current = nextState;
    setProjectState(nextState);
    await persistProjectStateForCalibration(nextState);
    return nextState;
  };


  return {
    projectState,
    projectStateRef,
    saveStatus,
    lastSavedTime,
    availableAssets,
    availableLayouts,
    layoutsLoading,
    layoutsError,
    homeTemplates,
    toastMessage,
    customColor,
    applyMaterial,
    applyMaterialToAllWalls,
    updateAsset,
    deleteAsset,
    spawnAsset,
    applyTemplate,
    adoptIsolatedAsset,
    updateStructuralEdit,
    transformFurnitureForCalibration,
    repairLegacyCalibrationState,
    setToastMessage,
    setCustomColor,
    saveNow,
  };
};