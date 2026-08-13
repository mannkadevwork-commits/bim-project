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
      setProjectState({ materials: {}, furniture: [], structural_edits: {} });

      fetch(`${API_BASE_URL}/api/projects/${jobId}/load`)
        .then(res => {
          if (!res.ok) throw new Error('Failed to load from server');
          return res.json();
        })
        .then(data => {
          if (data) {
            setProjectState(prev => ({
              ...prev,
              materials: data.materials || prev.materials,
              furniture: data.furniture || prev.furniture,
              structural_edits: data.structural_edits || prev.structural_edits
            }));
          }
        })
        .catch(() => {
          const localState = localStorage.getItem(`hci_state_${jobId}`);
          if (localState) {
            try {
              const parsed = JSON.parse(localState);
              setProjectState(prev => ({
                ...prev,
                materials: parsed.materials || prev.materials,
                furniture: parsed.furniture || prev.furniture,
                structural_edits: parsed.structural_edits || prev.structural_edits
              }));
            } catch (e) {
              console.warn('[ProjectSync] Failed to parse local state, starting fresh.');
            }
          }
        });
    } else {
      setProjectState({ materials: {}, furniture: [], structural_edits: {} });
    }

    fetch(`${API_BASE_URL}/api/assets`)
      .then(res => res.json())
      .then(data => setAvailableAssets(data))
      .catch(err => console.error('[ProjectSync] Failed to load asset catalog:', err));
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

  // ACTION: Apply material color
  const applyMaterial = (viewerRef, selectedObject, hexColor, rgbArray) => {
    if (!selectedObject || !viewerRef.current) return;
    
    // DEVELOPMENT LOG: Verify exactly what is being sent to persistence
    console.log('[Material][SAVE]', {
      targetId: selectedObject.id,
      targetObjectType: selectedObject.type,
      modelId: viewerRef.current.scene.objects[selectedObject.id]?.model?.id,
      entityId: selectedObject.id,
      rgb: rgbArray
    });

    applyColorToSceneTarget(viewerRef.current, selectedObject.id, rgbArray);
    setCustomColor(hexColor);
    
    setProjectState(prev => ({
      ...prev,
      materials: {
        ...(prev.materials || {}),
        [selectedObject.id]: { color: hexColor, rgb: rgbArray },
      },
    }));
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

    setProjectState(prev => ({
      ...prev,
      furniture: (prev.furniture || []).map(f =>
        f.instanceId === selectedAssetId
          ? {
              ...f,
              position: updatedPos || f.position || [0, 0, 0],
              rotation: updatedRot || f.rotation || [0, 0, 0],
              scale: updatedScale || f.scale || [1, 1, 1],
            }
          : f
      ),
    }));
  };

  const deleteAsset = (viewerRef, selectedAssetId) => {
    if (!selectedAssetId || !viewerRef.current) return;
    const assetModel = viewerRef.current.scene.models[selectedAssetId];
    if (assetModel) {
      assetModel.destroy();
      setProjectState(prev => ({
        ...prev,
        furniture: (prev.furniture || []).filter(f => f.instanceId !== selectedAssetId),
      }));
    }
    setToastMessage('Asset removed.');
    setTimeout(() => setToastMessage(null), 3000);
  };

  const applyTemplate = (templateId, loadIFCAssetIntoScene) => {
    const template = homeTemplates.find(t => t.id === templateId);
    if (!template) return;
    const newFurnitureItems = template.items.map(item => {
      const uniqueId = `${item.id}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const fullAssetUrl = item.url.startsWith('http') ? item.url : `${API_BASE_URL}${item.url}`;
      
      loadIFCAssetIntoScene(uniqueId, fullAssetUrl, item.position, item.rotation, { fileType: inferFileType(item.url, item.file_type), scale: item.scale || [1, 1, 1] });
      
      return {
        id: item.id,
        instanceId: uniqueId,
        name: item.name,
        src: fullAssetUrl,
        fileType: inferFileType(item.url, item.file_type),
        position: item.position || [0, 0, 0],
        rotation: item.rotation || [0, 0, 0],
        scale: item.scale || [1, 1, 1],
      };
    });

    setProjectState(prev => ({
      ...prev,
      furniture: [...(prev.furniture || []), ...newFurnitureItems],
    }));
    setToastMessage(`${template.name} Applied!`);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const spawnAsset = (asset, coordinates, loadIFCAssetIntoScene, rotation = [0, 0, 0]) => {
    const uniqueId = `${asset.id}_${Date.now()}`;
    const urlPath = asset.url || asset.src || `/assets/${asset.id}.ifc`;
    const fullAssetUrl = urlPath.startsWith('http') ? urlPath : `${API_BASE_URL}${urlPath}`;
    const fileType = inferFileType(urlPath, asset.file_type || asset.fileType);
    const scale = Array.isArray(asset.scale) ? asset.scale : [1, 1, 1];
    const position = Array.isArray(coordinates) ? coordinates : [0, 0, 0];
    const safeRotation = Array.isArray(rotation) ? rotation : [0, 0, 0];

    const furnitureItem = {
      id: asset.id,
      instanceId: uniqueId,
      name: asset.name || asset.id,
      src: fullAssetUrl,
      fileType,
      position,
      rotation: safeRotation,
      scale,
    };

    setProjectState(prev => ({
      ...prev,
      furniture: [...(prev.furniture || []), furnitureItem],
    }));

    // onPlaced is called by AssetManager after AABB correction with the real
    // final world position. We patch the saved furniture entry so the compiler
    // receives the corrected coordinates and can use them directly.
    const onPlaced = (instanceId, finalPosition) => {
      setProjectState(prev => ({
        ...prev,
        furniture: (prev.furniture || []).map(f =>
          f.instanceId === instanceId ? { ...f, position: finalPosition } : f
        ),
      }));
    };

    loadIFCAssetIntoScene(
      uniqueId,
      fullAssetUrl,
      position,
      safeRotation,
      { fileType, scale, onPlaced }
    ).catch(error => {
      console.error('[ProjectSync] Failed to load placed asset:', error);
      setProjectState(prev => ({
        ...prev,
        furniture: (prev.furniture || []).filter(f => f.instanceId !== uniqueId),
      }));
    });
    setToastMessage(`${furnitureItem.name} placed!`);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const updateStructuralEdit = (entityId, transformType, axis, value) => {
    if (!entityId) return;
    if (transformType !== 'scale' && transformType !== 'offset' && transformType !== 'visible') return;
    
    setProjectState(prev => {
      const existingEdit = (prev.structural_edits || {})[entityId] || { scale: [1, 1, 1], offset: [0, 0, 0], visible: true };
      
      if (transformType === 'visible') {
          return {
            ...prev,
            structural_edits: {
              ...(prev.structural_edits || {}),
              [entityId]: { ...existingEdit, visible: value },
            },
          };
      }
      const defaultVector = transformType === 'scale' ? [1, 1, 1] : [0, 0, 0];
      const updatedVector = [...(existingEdit[transformType] || defaultVector)];
      if (axis !== null) updatedVector[axis] = value;
      return {
        ...prev,
        structural_edits: {
          ...(prev.structural_edits || {}),
          [entityId]: {
            ...existingEdit,
            [transformType]: updatedVector,
          },
        },
      };
    });
  };

  const adoptIsolatedAsset = (entityId, newInstanceId, fileUrl, assetName, position = [0, 0, 0]) => {
    setProjectState(prev => ({
      ...prev,
      furniture: [
        ...(prev.furniture || []),
        {
          id: entityId,
          instanceId: newInstanceId,
          name: assetName || 'Isolated Element',
          src: fileUrl,
          fileType: 'ifc',
          position,
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ],
    }));
  };

  return {
    projectState,
    projectStateRef,
    saveStatus,
    lastSavedTime,
    availableAssets,
    homeTemplates,
    toastMessage,
    customColor,
    applyMaterial,
    updateAsset,
    deleteAsset,
    spawnAsset,
    applyTemplate,
    adoptIsolatedAsset,
    updateStructuralEdit,
    setToastMessage,
    setCustomColor,
    saveNow,
  };
};