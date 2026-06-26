import { useState, useEffect, useRef } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const useProjectSync = (file) => {
  const [projectState, setProjectState] = useState({ materials: {}, furniture: [] });
  const projectStateRef = useRef(projectState);
  
  const [availableAssets, setAvailableAssets] = useState([]);
  const [saveStatus, setSaveStatus] = useState('saved'); 
  const [lastSavedTime, setLastSavedTime] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);
  const activeJobId = useRef('job_default_01'); 
  const [customColor, setCustomColor] = useState('#ffffff'); 

  useEffect(() => { projectStateRef.current = projectState; }, [projectState]);

  // Load Initial State & Assets
  useEffect(() => {
    if (file) {
      activeJobId.current = `job_${file.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const localState = localStorage.getItem(`hci_state_${activeJobId.current}`);
      
      if (localState) {
        setProjectState(JSON.parse(localState));
      } else {
        fetch(`${API_BASE_URL}/api/projects/${activeJobId.current}/load`)
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data && (Object.keys(data.materials).length > 0 || data.furniture.length > 0)) {
              setProjectState(data);
            }
          })
          .catch(() => console.warn("No previous cloud state found."));
      }
    }

    fetch(`${API_BASE_URL}/api/assets`)
      .then(res => res.json())
      .then(data => setAvailableAssets(data))
      .catch(err => console.error("Failed to load asset catalog", err));
  }, [file]);

  // Auto-Save
  useEffect(() => {
    if (Object.keys(projectState.materials).length === 0 && projectState.furniture.length === 0) return;

    setSaveStatus('unsaved');
    localStorage.setItem(`hci_state_${activeJobId.current}`, JSON.stringify(projectState));

    const delayCloudSave = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await fetch(`${API_BASE_URL}/api/projects/${activeJobId.current}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(projectState)
        });
        setSaveStatus('saved');
        setLastSavedTime(new Date()); 
      } catch (err) {
        console.error("Cloud Auto-Save failed", err);
        setSaveStatus('error');
      }
    }, 1500);

    return () => clearTimeout(delayCloudSave);
  }, [projectState]);

  const applyMaterial = (viewerRef, selectedObject, hexColor, rgbArray) => {
    if (!selectedObject || !viewerRef.current) return;
    const entity = viewerRef.current.scene.objects[selectedObject.id];
    if (entity) entity.colorize = rgbArray; 
    setCustomColor(hexColor);
    setProjectState(prev => ({ ...prev, materials: { ...prev.materials, [selectedObject.id]: { color: hexColor, rgb: rgbArray } } }));
  };



  const deleteAsset = (viewerRef, selectedAssetId) => {
    if (!selectedAssetId || !viewerRef.current) return;
    const assetModel = viewerRef.current.scene.models[selectedAssetId];
    if (assetModel) {
      assetModel.destroy();
      setProjectState(prev => ({ ...prev, furniture: prev.furniture.filter(f => f.instanceId !== selectedAssetId) }));
    }
    setToastMessage("Asset removed.");
    setTimeout(() => setToastMessage(null), 3000);
  };

 const spawnAsset = (asset, coordinates, loadIFCAssetIntoScene) => {
    const uniqueId = `${asset.id}_${Date.now()}`;
   
    const assetPath = asset.url || asset.src || asset.file || '';
    const fullAssetUrl = assetPath.startsWith('http') 
        ? assetPath 
        : `${API_BASE_URL}${assetPath.startsWith('/') ? '' : '/'}${assetPath}`;

    setProjectState(prev => ({ 
      ...prev, 
      furniture: [...prev.furniture, { 
        id: asset.id, 
        instanceId: uniqueId, 
        name: asset.name, 
        src: fullAssetUrl, 
        position: coordinates, 
        rotation: [0, 0, 0],
        scale: [1, 1, 1] // Track scale in the state
      }] 
    }));
    
    loadIFCAssetIntoScene(uniqueId, fullAssetUrl, coordinates, [0, 0, 0], [1, 1, 1]);
    setToastMessage(`${asset.name} placed!`);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const updateAsset = (viewerRef, selectedAssetId, axis, value, transformType = 'position') => {
    if (!selectedAssetId || !viewerRef.current) return;
    const assetModel = viewerRef.current.scene.models[selectedAssetId];
    if (!assetModel) return;

    const numValue = parseFloat(value);
    if (isNaN(numValue)) return; // Prevent breaking the 3D matrix

    let updatedState = {};

    // Apply the correct transformation to the Xeokit Model natively
    if (transformType === 'rotation') {
      const rot = [...(assetModel.rotation || [0, 0, 0])];
      rot[axis] = numValue;
      assetModel.rotation = rot;
      updatedState.rotation = rot;
    } else if (transformType === 'scale') {
      const scl = [...(assetModel.scale || [1, 1, 1])];
      scl[axis] = numValue;
      assetModel.scale = scl;
      updatedState.scale = scl;
    } else { // position
      const pos = [...(assetModel.position || [0, 0, 0])];
      pos[axis] = numValue;
      assetModel.position = pos;
      updatedState.position = pos;
    }

    // Sync with React State for saving
    setProjectState(prev => ({ 
      ...prev, 
      furniture: prev.furniture.map(f => 
        f.instanceId === selectedAssetId ? { ...f, ...updatedState } : f
      ) 
    }));
  };

  return { 
    projectState, projectStateRef, saveStatus, lastSavedTime, availableAssets, toastMessage, customColor,
    applyMaterial, updateAsset, deleteAsset, spawnAsset, setToastMessage, setCustomColor
  };
};