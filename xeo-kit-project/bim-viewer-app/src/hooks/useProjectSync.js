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

  // Some GLB files expose no named child entities. Keep the model-level
  // reference marked so the state remains associated with the asset.
  return changed;
};


// ── PREDEFINED ROOM LAYOUTS ─────────────────────────────
// Users can inject these specific room setups into their 1 BHK / 3 BHK empty structures
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

export const useProjectSync = (file) => {
  const [projectState, setProjectState] = useState({ materials: {}, furniture: [], structural_edits: {} });
  const projectStateRef = useRef(projectState);

  const [availableAssets, setAvailableAssets] = useState([]);
  const [homeTemplates, setHomeTemplates] = useState(MOCK_ROOM_TEMPLATES); // Renamed conceptually
  const [saveStatus, setSaveStatus] = useState('saved');
  const [lastSavedTime, setLastSavedTime] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);
  const activeJobId = useRef('job_default_01');
  const [customColor, setCustomColor] = useState('#ffffff');

  useEffect(() => { projectStateRef.current = projectState; }, [projectState]);

  // ─────────────────────────────────────────────────────────────
  // LOAD: Fetch initial project state & asset catalog on startup
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (file) {
      // Reset memory completely before reading the new file's state
      setProjectState({ materials: {}, furniture: [], structural_edits: {} });

      activeJobId.current = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const localState = localStorage.getItem(`hci_state_${activeJobId.current}`);

      if (localState) {
        try {
          const parsed = JSON.parse(localState);
          // Backfill structural_edits for state saved before this key existed
          setProjectState({ structural_edits: {}, ...parsed });
        } catch (e) {
          console.warn('[ProjectSync] Failed to parse local state, starting fresh.');
        }
      } else {
        fetch(`${API_BASE_URL}/api/projects/${activeJobId.current}/load`)
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (
              data &&
              (Object.keys(data.materials || {}).length > 0 ||
                (data.furniture || []).length > 0 ||
                Object.keys(data.structural_edits || {}).length > 0)
            ) {
              // Backfill structural_edits for state saved before this key existed
              setProjectState({ structural_edits: {}, ...data });
            }
          })
          .catch(() => console.warn('[ProjectSync] No previous cloud state found, starting fresh.'));
      }
    } else {
      // Wipes memory when file is deleted
      setProjectState({ materials: {}, furniture: [], structural_edits: {} });
    }

    // Fetch the asset catalog from the backend
    fetch(`${API_BASE_URL}/api/assets`)
      .then(res => res.json())
      .then(data => setAvailableAssets(data))
      .catch(err => console.error('[ProjectSync] Failed to load asset catalog:', err));
  }, [file]);

  // ─────────────────────────────────────────────────────────────
  // AUTO-SAVE: Debounced save to localStorage + cloud
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    // If state is completely empty, do not overwrite valid saves (prevents wiping on boot)
    if (
      Object.keys(projectState.materials).length === 0 &&
      projectState.furniture.length === 0 &&
      Object.keys(projectState.structural_edits || {}).length === 0
    ) return;

    setSaveStatus('unsaved');
    localStorage.setItem(`hci_state_${activeJobId.current}`, JSON.stringify(projectState));

    const delayCloudSave = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await fetch(`${API_BASE_URL}/api/projects/${activeJobId.current}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(projectState),
        });
        setSaveStatus('saved');
        setLastSavedTime(new Date());
      } catch (err) {
        console.error('[ProjectSync] Cloud auto-save failed:', err);
        setSaveStatus('error');
      }
    }, 1500);

    return () => clearTimeout(delayCloudSave);
  }, [projectState]);

  // ─────────────────────────────────────────────────────────────
  // ACTION: Apply material color to a selected building element
  // ─────────────────────────────────────────────────────────────
  const applyMaterial = (viewerRef, selectedObject, hexColor, rgbArray) => {
    if (!selectedObject || !viewerRef.current) return;

    applyColorToSceneTarget(viewerRef.current, selectedObject.id, rgbArray);

    setCustomColor(hexColor);
    setProjectState(prev => ({
      ...prev,
      materials: {
        ...prev.materials,
        [selectedObject.id]: { color: hexColor, rgb: rgbArray },
      },
    }));
  };

  // ─────────────────────────────────────────────────────────────
  // ACTION: Update asset transform (Position, Scale, Rotation)
  // ─────────────────────────────────────────────────────────────
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
      furniture: prev.furniture.map(f =>
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

  // ─────────────────────────────────────────────────────────────
  // ACTION: Delete a furniture asset from the scene
  // ─────────────────────────────────────────────────────────────
  const deleteAsset = (viewerRef, selectedAssetId) => {
    if (!selectedAssetId || !viewerRef.current) return;
    const assetModel = viewerRef.current.scene.models[selectedAssetId];
    if (assetModel) {
      assetModel.destroy();
      setProjectState(prev => ({
        ...prev,
        furniture: prev.furniture.filter(f => f.instanceId !== selectedAssetId),
      }));
    }
    setToastMessage('Asset removed.');
    setTimeout(() => setToastMessage(null), 3000);
  };

  // ─────────────────────────────────────────────────────────────
  // ACTION: Apply Predefined Room Layout (Batch load furniture)
  // ─────────────────────────────────────────────────────────────
  const applyTemplate = (templateId, loadIFCAssetIntoScene) => {
    const template = homeTemplates.find(t => t.id === templateId);
    if (!template) return;

    const newFurnitureItems = template.items.map(item => {
      // Generate unique ID for the instanced asset
      const uniqueId = `${item.id}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const fullAssetUrl = item.url.startsWith('http') ? item.url : `${API_BASE_URL}${item.url}`;

      // Trigger the 3D Engine to load the asset at the predefined coordinates
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

    // Save batch into project state
    setProjectState(prev => ({
      ...prev,
      furniture: [...prev.furniture, ...newFurnitureItems],
    }));

    setToastMessage(`${template.name} Applied!`);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // ─────────────────────────────────────────────────────────────
  // ACTION: Spawn a single asset (Drag & Drop or Click)
  // ─────────────────────────────────────────────────────────────
  const spawnAsset = (asset, coordinates, loadIFCAssetIntoScene, rotation = [0, 0, 0]) => {
    const uniqueId = `${asset.id}_${Date.now()}`;
    const urlPath = asset.url || asset.src || `/assets/${asset.id}.ifc`;
    const fullAssetUrl = urlPath.startsWith('http')
      ? urlPath
      : `${API_BASE_URL}${urlPath}`;

    const fileType = inferFileType(urlPath, asset.file_type || asset.fileType);
    const scale = Array.isArray(asset.scale) ? asset.scale : [1, 1, 1];
    const position = Array.isArray(coordinates) ? coordinates : [0, 0, 0];
    const safeRotation = Array.isArray(rotation) ? rotation : [0, 0, 0];

    console.log('[ProjectSync] Spawning asset:', {
      instanceId: uniqueId,
      fileType,
      src: fullAssetUrl,
      position,
      rotation: safeRotation,
      scale,
    });

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
      furniture: [...prev.furniture, furnitureItem],
    }));

    loadIFCAssetIntoScene(
      uniqueId,
      fullAssetUrl,
      position,
      safeRotation,
      { fileType, scale }
    ).catch(error => {
      console.error('[ProjectSync] Failed to load placed asset:', error);
      setProjectState(prev => ({
        ...prev,
        furniture: prev.furniture.filter(f => f.instanceId !== uniqueId),
      }));
    });

    setToastMessage(`${furnitureItem.name} placed!`);
    setTimeout(() => setToastMessage(null), 3000);
  };


  // ─────────────────────────────────────────────────────────────
  // ACTION: Record a structural (parametric resize) edit for a native
  // IFC element. This is Delta-Based State Management — input.ifc is
  // never rewritten. We only ever persist a scale ratio / offset delta
  // per element, and re-apply it visually on load.
  // ─────────────────────────────────────────────────────────────
  // const updateStructuralEdit = (entityId, transformType, axis, value) => {
  //   if (!entityId) return;
  //   if (transformType !== 'scale' && transformType !== 'offset') {
  //     console.warn(`[ProjectSync] Unknown structural edit type: ${transformType}`);
  //     return;
  //   }

  //   setProjectState(prev => {
  //     const existingEdit = prev.structural_edits[entityId] || { scale: [1, 1, 1], offset: [0, 0, 0] };
  //     const defaultVector = transformType === 'scale' ? [1, 1, 1] : [0, 0, 0];
  //     const updatedVector = [...(existingEdit[transformType] || defaultVector)];
  //     updatedVector[axis] = value;

  //     return {
  //       ...prev,
  //       structural_edits: {
  //         ...prev.structural_edits,
  //         [entityId]: {
  //           ...existingEdit,
  //           [transformType]: updatedVector,
  //         },
  //       },
  //     };
  //   });
  // };


  const updateStructuralEdit = (entityId, transformType, axis, value) => {
    if (!entityId) return;
    if (transformType !== 'scale' && transformType !== 'offset' && transformType !== 'visible') {
      console.warn(`[ProjectSync] Unknown structural edit type: ${transformType}`);
      return;
    }

    setProjectState(prev => {
      const existingEdit = prev.structural_edits[entityId] || { scale: [1, 1, 1], offset: [0, 0, 0], visible: true };
      
      // Handle direct visibility overrides
      if (transformType === 'visible') {
          return {
            ...prev,
            structural_edits: {
              ...prev.structural_edits,
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
          ...prev.structural_edits,
          [entityId]: {
            ...existingEdit,
            [transformType]: updatedVector,
          },
        },
      };
    });
  };

  // ─────────────────────────────────────────────────────────────
// ACTION: Adopt a freshly-isolated native IFC element into furniture state
// ─────────────────────────────────────────────────────────────
const adoptIsolatedAsset = (entityId, newInstanceId, fileUrl, assetName) => {
  setProjectState(prev => ({
    ...prev,
    furniture: [
      ...prev.furniture,
      {
        id: entityId,
        instanceId: newInstanceId,
        name: assetName || 'Isolated Element',
        src: fileUrl,
        fileType: 'ifc',
        position: [0, 0, 0],
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
    homeTemplates, // Bound to the "Layouts" tab in LeftPanel
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
  };
};