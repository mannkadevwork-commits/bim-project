import { useState, useEffect, useRef } from 'react';
import { applyMaterialDefinitionToSceneTarget as applySceneMaterial, applyMaterialDefinitionToObjects as applySceneMaterials, normalizeMaterialDefinition } from '../utils/materialScene';
import { generateGlbThumbnail } from '../utils/glbThumbnail';
import { perfFetch, perfLog, perfTimer } from '../utils/perfLogger';
import {
  HISTORY_COALESCE_MS,
  HISTORY_LIMIT,
  cloneProjectState,
  createInitialProjectState,
  projectStatesEqual,
} from './projectHistory';
import { applyGLBPlacementTransform, getGLBPlacementTarget, getGLBRotation, getGLBScale, isGLBModel } from '../engine/assets/GLBAssetTransform';
import { markAssetTransformApplied } from '../engine/assets/assetTransformIdentity';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const projectRecoveryKey = (jobId) => `hci_recovery_${jobId}`;

const readProjectRecovery = (jobId) => {
  if (!jobId) return null;
  try {
    const raw = localStorage.getItem(projectRecoveryKey(jobId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.version === 1 && parsed?.state && typeof parsed.state === 'object'
      ? parsed
      : null;
  } catch (error) {
    console.warn('[ProjectSync] Could not read the local project recovery journal:', error);
    return null;
  }
};

const writeProjectRecovery = (jobId, state, error) => {
  if (!jobId || !state) return false;
  try {
    localStorage.setItem(projectRecoveryKey(jobId), JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      state: cloneProjectState(state),
      error: error?.message || String(error || 'Project save was not confirmed.'),
    }));
    return true;
  } catch (storageError) {
    console.error('[ProjectSync] Unable to write a local recovery journal:', storageError);
    return false;
  }
};

const clearProjectRecoveryIfMatches = (jobId, savedState) => {
  const recovery = readProjectRecovery(jobId);
  if (!recovery) return;
  if (!projectStatesEqual(recovery.state, savedState)) return;
  try { localStorage.removeItem(projectRecoveryKey(jobId)); }
  catch (error) { console.warn('[ProjectSync] Could not clear confirmed recovery journal:', error); }
};

const normalizeProjectStatePayload = (value) => ({
  materials: value?.materials || {},
  furniture: sanitizePersistedFurniture(value?.furniture || []),
  structural_edits: value?.structural_edits || {},
  scene_calibration: value?.scene_calibration || { scaleFactor: { x: 1, y: 1, z: 1 } },
});

const inferFileType = (url, explicitType) => {
  if (explicitType) return String(explicitType).toLowerCase();
  const clean = String(url || '').split('?')[0].split('#')[0];
  const ext = clean.split('.').pop()?.toLowerCase();
  return ['ifc', 'glb', 'gltf', 'xkt'].includes(ext) ? ext : 'ifc';
};

const sanitizePersistedFurniture = (items) => (Array.isArray(items) ? items : []).map((item) => {
  if (!item || typeof item !== 'object') return item;
  const type = inferFileType(item.src || item.url, item.fileType || item.file_type);
  if (type === 'glb' || type === 'gltf' || item.isNativeIsolation) return item;
  // Standalone catalogue IFCs keep their semantic position/rotation/scale
  // contract. Drop only obsolete raw matrices from those items.
  const { matrix: _legacyMatrix, ...semanticItem } = item;
  return semanticItem;
});



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
  const [projectState, setProjectState] = useState(createInitialProjectState);

  // Bounded in-memory editor history. The current project state is still persisted
  // through the existing save pipeline; history is only the undo/redo command stack.
  const historyPastRef = useRef([]);
  const historyFutureRef = useRef([]);
  const historyTransactionRef = useRef(null);
  const lastHistoryMutationRef = useRef(null);
  const historyApplyingRef = useRef(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const projectStateRef = useRef(projectState);
  const projectStateLoadCommitPerfRef = useRef(null);
  const projectStateHydratedRef = useRef(false);
  
  const [availableAssets, setAvailableAssets] = useState([]);
  const [availableLayouts, setAvailableLayouts] = useState([]);
  const [savedLayouts, setSavedLayouts] = useState([]);
  const [savedLayoutsLoading, setSavedLayoutsLoading] = useState(false);
  const [savedLayoutsError, setSavedLayoutsError] = useState(null);
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


  const bumpHistoryRevision = () => setHistoryRevision(value => value + 1);

  const resetHistory = () => {
    historyPastRef.current = [];
    historyFutureRef.current = [];
    historyTransactionRef.current = null;
    lastHistoryMutationRef.current = null;
    bumpHistoryRevision();
  };

  const commitHistoryState = (previousState, coalesceKey = null) => {
    if (projectStatesEqual(previousState, projectStateRef.current)) return;

    const now = performance.now();
    const last = lastHistoryMutationRef.current;
    const shouldCoalesce = Boolean(
      coalesceKey &&
      last?.key === coalesceKey &&
      now - last.at <= HISTORY_COALESCE_MS &&
      historyPastRef.current.length > 0
    );

    if (!shouldCoalesce) {
      historyPastRef.current.push(cloneProjectState(previousState));
      if (historyPastRef.current.length > HISTORY_LIMIT) {
        historyPastRef.current.splice(0, historyPastRef.current.length - HISTORY_LIMIT);
      }
    }

    historyFutureRef.current = [];
    lastHistoryMutationRef.current = { key: coalesceKey, at: now };
    bumpHistoryRevision();
  };

  const setProjectStateTracked = (nextOrUpdater, options = {}) => {
    const { history = true, coalesceKey = null } = options;
    const previousState = projectStateRef.current;
    const nextState = typeof nextOrUpdater === 'function'
      ? nextOrUpdater(previousState)
      : nextOrUpdater;

    if (nextState === undefined || projectStatesEqual(previousState, nextState)) {
      return false;
    }

    projectStateRef.current = nextState;
    setProjectState(nextState);

    if (!history) {
      lastHistoryMutationRef.current = null;
      return true;
    }

    if (history && !historyApplyingRef.current) {
      if (historyTransactionRef.current) {
        historyTransactionRef.current.changed = true;
        lastHistoryMutationRef.current = null;
      } else {
        commitHistoryState(previousState, coalesceKey);
      }
    }

    return true;
  };

  const beginHistoryTransaction = (label = 'edit') => {
    const active = historyTransactionRef.current;
    if (active) {
      active.depth += 1;
      return;
    }

    historyTransactionRef.current = {
      label,
      depth: 1,
      changed: false,
      before: cloneProjectState(projectStateRef.current),
    };
    lastHistoryMutationRef.current = null;
    // Re-render toolbar consumers so Undo/Redo are visibly disabled for the
    // duration of an async composite edit (door insertion, grouped deletion, etc.).
    bumpHistoryRevision();
  };

  const endHistoryTransaction = () => {
    const active = historyTransactionRef.current;
    if (!active) return false;

    active.depth -= 1;
    if (active.depth > 0) return active.changed;

    historyTransactionRef.current = null;
    bumpHistoryRevision();
    if (!active.changed || projectStatesEqual(active.before, projectStateRef.current)) {
      return false;
    }

    historyPastRef.current.push(cloneProjectState(active.before));
    if (historyPastRef.current.length > HISTORY_LIMIT) {
      historyPastRef.current.splice(0, historyPastRef.current.length - HISTORY_LIMIT);
    }
    historyFutureRef.current = [];
    lastHistoryMutationRef.current = null;
    return true;
  };

  // Abort an in-flight composite action without polluting the undo stack.
  // This is used by asynchronous operations such as Door Insert/Unlock, where
  // several scene/state mutations may happen before the backend operation finishes.
  const cancelHistoryTransaction = () => {
    const active = historyTransactionRef.current;
    if (!active) return false;

    const shouldRestore = !projectStatesEqual(active.before, projectStateRef.current);
    historyApplyingRef.current = true;
    historyTransactionRef.current = null;
    lastHistoryMutationRef.current = null;
    if (shouldRestore) {
      const restoredState = cloneProjectState(active.before);
      projectStateRef.current = restoredState;
      setProjectState(restoredState);
    }
    historyApplyingRef.current = false;
    bumpHistoryRevision();
    return shouldRestore;
  };

  const undo = () => {
    if (historyApplyingRef.current || historyTransactionRef.current || !historyPastRef.current.length) {
      return false;
    }

    const previousState = historyPastRef.current.pop();
    const currentState = cloneProjectState(projectStateRef.current);
    historyFutureRef.current.push(currentState);
    historyApplyingRef.current = true;
    historyTransactionRef.current = null;
    lastHistoryMutationRef.current = null;
    projectStateRef.current = previousState;
    setProjectState(previousState);
    historyApplyingRef.current = false;
    bumpHistoryRevision();
    return true;
  };

  const redo = () => {
    if (historyApplyingRef.current || historyTransactionRef.current || !historyFutureRef.current.length) {
      return false;
    }

    const nextState = historyFutureRef.current.pop();
    const currentState = cloneProjectState(projectStateRef.current);
    historyPastRef.current.push(currentState);
    if (historyPastRef.current.length > HISTORY_LIMIT) {
      historyPastRef.current.splice(0, historyPastRef.current.length - HISTORY_LIMIT);
    }
    historyApplyingRef.current = true;
    historyTransactionRef.current = null;
    lastHistoryMutationRef.current = null;
    projectStateRef.current = nextState;
    setProjectState(nextState);
    historyApplyingRef.current = false;
    bumpHistoryRevision();
    return true;
  };

  useEffect(() => {
    if (projectStateLoadCommitPerfRef.current == null || !jobId) return;
    const startedAt = projectStateLoadCommitPerfRef.current;
    projectStateLoadCommitPerfRef.current = null;
    perfLog('PROJECT_SYNC', 'PROJECT_STATE_REACT_COMMITTED', {
      jobId,
      durationMs: Number((performance.now() - startedAt).toFixed(1)),
      materials: Object.keys(projectState.materials || {}).length,
      furniture: Array.isArray(projectState.furniture) ? projectState.furniture.length : 0,
    });
  }, [projectState, jobId]);

  // 1. LOAD: Fetch initial project state & asset catalog on startup
  useEffect(() => {
    const syncEnd = perfTimer('PROJECT_SYNC', 'schedule project/layout data loads', {
      jobId: jobId || null,
      fileName: file?.name || null,
    });
    resetHistory();
    projectStateHydratedRef.current = false;
    if (file && jobId) {
      setProjectStateTracked(createInitialProjectState(), { history: false });

      const loadStateStartedAt = performance.now();
      perfLog('PROJECT_SYNC', 'START project state load', { jobId });
      perfFetch('PROJECT_SYNC', 'project state', `${API_BASE_URL}/api/projects/${jobId}/load`)
        .then(res => {
          if (!res.ok) throw new Error('Failed to load from server');
          const status = res.status;
          return res.json().then(data => ({ status, data }));
        })
        .then(({ status, data }) => {
          perfLog('PROJECT_SYNC', 'END project state load', {
            jobId,
            status,
            durationMs: Number((performance.now() - loadStateStartedAt).toFixed(1)),
            materials: Object.keys(data?.materials || {}).length,
            furniture: Array.isArray(data?.furniture) ? data.furniture.length : 0,
            structuralEdits: Object.keys(data?.structural_edits || {}).length,
          });
          if (data) {
            const serverState = normalizeProjectStatePayload(data);
            const recovery = readProjectRecovery(jobId);
            let stateToHydrate = serverState;

            if (recovery?.state) {
              const recoveredState = normalizeProjectStatePayload(recovery.state);
              if (!projectStatesEqual(recoveredState, serverState)) {
                // A previous save was not acknowledged by the server. Prefer the
                // preserved local recovery snapshot instead of silently replacing
                // the user's latest edit with the older server snapshot.
                stateToHydrate = recoveredState;
                setToastMessage('Recovered your last unconfirmed local edits. Syncing them to the server again.');
              } else {
                try { localStorage.removeItem(projectRecoveryKey(jobId)); } catch (_) {}
              }
            }

            projectStateLoadCommitPerfRef.current = performance.now();
            setProjectStateTracked(stateToHydrate, { history: false });
            resetHistory();
            projectStateHydratedRef.current = true;
          }
        })
        .catch((loadError) => {
          console.error('[ProjectSync] Server project load failed; attempting local recovery:', loadError);
          const recovery = readProjectRecovery(jobId);
          let localState = null;
          if (!recovery?.state) {
            try {
              localState = localStorage.getItem(`hci_state_${jobId}`);
            } catch (storageError) {
              // Some browser privacy modes disable localStorage entirely. Do not
              // let a failed recovery read strand the editor in an unhydrated state.
              console.warn('[ProjectSync] Browser storage is unavailable during recovery:', storageError);
            }
          }

          if (recovery?.state || localState) {
            try {
              const parsed = recovery?.state ? recovery.state : JSON.parse(localState);
              setProjectStateTracked(normalizeProjectStatePayload(parsed), { history: false });
              if (recovery?.state) {
                setToastMessage('Restored your last local recovery snapshot because the server project could not be loaded.');
              } else {
                setToastMessage('Server project could not be loaded. Restored the last browser-saved project state.');
              }
              resetHistory();
              projectStateHydratedRef.current = true;
            } catch (e) {
              console.warn('[ProjectSync] Failed to parse local state, starting fresh:', e);
              projectStateHydratedRef.current = true;
            }
          } else {
            // Always allow the editor to hydrate even if both remote loading and
            // browser recovery fail. The UI can now expose the save error instead
            // of remaining indefinitely in a loading state.
            projectStateHydratedRef.current = true;
            setSaveStatus('error');
            setToastMessage('Could not load this project or access a local recovery snapshot. Check the backend before making new edits.');
          }
        });
    } else {
      setProjectStateTracked(createInitialProjectState(), { history: false });
      projectStateHydratedRef.current = false;
    }

    perfFetch('PROJECT_SYNC', 'asset catalog', `${API_BASE_URL}/api/assets`)
      .then(res => res.json())
      .then(data => {
        perfLog('PROJECT_SYNC', 'asset catalog populated', { count: Array.isArray(data) ? data.length : 0 });
        setAvailableAssets(data);
      })
      .catch(err => console.error('[ProjectSync] Failed to load asset catalog:', err));

    setLayoutsLoading(true);
    setLayoutsError(null);
    perfFetch('PROJECT_SYNC', 'predefined layouts', `${API_BASE_URL}/api/layouts`)
      .then(res => {
        if (!res.ok) throw new Error(`Failed to load layouts (${res.status})`);
        return res.json();
      })
      .then(data => {
        const layouts = Array.isArray(data?.layouts) ? data.layouts : [];
        perfLog('PROJECT_SYNC', 'predefined layouts populated', { count: layouts.length });
        setAvailableLayouts(layouts);
      })
      .catch(err => {
        console.error('[ProjectSync] Failed to load predefined layouts:', err);
        setLayoutsError(err.message);
        setAvailableLayouts([]);
      })
      .finally(() => setLayoutsLoading(false));

    if (jobId) {
      setSavedLayoutsLoading(true);
      setSavedLayoutsError(null);
      perfFetch('PROJECT_SYNC', 'saved layouts list', `${API_BASE_URL}/api/saved-layouts`, { cache: 'no-store' })
        .then(res => {
          if (!res.ok) throw new Error(`Failed to load saved layouts (${res.status})`);
          return res.json();
        })
        .then(data => {
          const layouts = Array.isArray(data?.layouts) ? data.layouts.map(normalizeSavedLayout) : [];
          perfLog('PROJECT_SYNC', 'saved layouts populated', { count: layouts.length });
          setSavedLayouts(layouts);
        })
        .catch(err => {
          console.error('[ProjectSync] Failed to load saved layouts:', err);
          setSavedLayoutsError(err.message);
        })
        .finally(() => setSavedLayoutsLoading(false));
    } else {
      setSavedLayouts([]);
      setSavedLayoutsLoading(false);
      setSavedLayoutsError(null);
    }
    syncEnd({ completed: true });
  }, [file, jobId]);

  // 2. AUTO-SAVE: Safe sequential queue
  const processSaveQueue = async () => {
    if (isSavingRef.current || !pendingSaveRef.current) return;

    const { state, targetJobId } = pendingSaveRef.current;
    pendingSaveRef.current = null;
    isSavingRef.current = true;
    setSaveStatus('saving');

    try {
      try {
        localStorage.setItem(`hci_state_${targetJobId}`, JSON.stringify(state));
      } catch (storageError) {
        // Local recovery is best-effort. Storage quota/private-mode errors must
        // not prevent the canonical server save from being attempted.
        console.warn('[ProjectSync] Local recovery snapshot could not be written:', storageError);
      }

      const response = await fetch(`${API_BASE_URL}/api/projects/${targetJobId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Project auto-save failed (${response.status})${detail ? `: ${detail}` : ''}`);
      }
      setSaveStatus('saved');
      setLastSavedTime(new Date());
      if (!pendingSaveRef.current && projectStatesEqual(state, projectStateRef.current)) {
        clearProjectRecoveryIfMatches(targetJobId, state);
      }
    } catch (err) {
      const recoveryState = pendingSaveRef.current?.targetJobId === targetJobId
        ? pendingSaveRef.current.state
        : state;
      writeProjectRecovery(targetJobId, recoveryState, err);
      console.error('[ProjectSync] Cloud auto-save failed; recovery snapshot preserved when browser storage permits:', err);
      setSaveStatus('error');
    } finally {
      isSavingRef.current = false;
      if (pendingSaveRef.current) {
        processSaveQueue();
      }
    }
  };

  useEffect(() => {
    if (!jobId || !projectStateHydratedRef.current) return;

    setSaveStatus('unsaved');
    pendingSaveRef.current = { state: projectState, targetJobId: jobId };
    processSaveQueue();
  }, [projectState, jobId]);

  const saveNow = async (stateOverride) => {
    if (!jobId) return;
    const stateToSave = stateOverride || projectStateRef.current;
    setSaveStatus('saving');
    try {
      try {
        localStorage.setItem(`hci_state_${jobId}`, JSON.stringify(stateToSave));
      } catch (storageError) {
        console.warn('[ProjectSync] Local recovery snapshot could not be written:', storageError);
      }
      const response = await fetch(`${API_BASE_URL}/api/projects/${jobId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stateToSave),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Manual project save failed (${response.status})${detail ? `: ${detail}` : ''}`);
      }
      setSaveStatus('saved');
      setLastSavedTime(new Date());
      if (projectStatesEqual(stateToSave, projectStateRef.current)) {
        clearProjectRecoveryIfMatches(jobId, stateToSave);
      }
    } catch (err) {
      writeProjectRecovery(jobId, projectStateRef.current || stateToSave, err);
      console.error('[ProjectSync] Manual save failed; local recovery snapshot preserved when possible:', err);
      setSaveStatus('error');
    }
  };


  const normalizeSavedLayout = (layout) => {
    if (!layout) return layout;
    const resolveUrl = (value) => {
      if (!value) return value;
      try { return new URL(value, API_BASE_URL).toString(); }
      catch { return value; }
    };
    // Asset URLs belong to the backend, but the walkthrough is a React route.
    // Resolving walkthroughUrl against API_BASE_URL would incorrectly navigate
    // to the Express server (for example /walkthrough/:jobId), which returns
    // `Cannot GET` because that route exists in the frontend router.
    const walkthroughUrl = layout.walkthroughUrl
      ? (String(layout.walkthroughUrl).startsWith('http')
        ? String(layout.walkthroughUrl)
        : `${window.location.origin}${String(layout.walkthroughUrl).startsWith('/') ? '' : '/'}${String(layout.walkthroughUrl)}`)
      : layout.walkthroughUrl;

    return {
      ...layout,
      thumbnailUrl: resolveUrl(layout.thumbnailUrl),
      modelUrl: resolveUrl(layout.modelUrl),
      walkthroughUrl,
    };
  };

  const refreshSavedLayouts = async () => {
    if (!jobId) return [];
    const response = await fetch(
      `${API_BASE_URL}/api/saved-layouts`,
      { cache: 'no-store' }
    );
    if (!response.ok) throw new Error(`Failed to refresh saved layouts (${response.status})`);
    const data = await response.json();
    const layouts = Array.isArray(data?.layouts) ? data.layouts.map(normalizeSavedLayout) : [];
    setSavedLayouts(layouts);
    return layouts;
  };

  const saveRenderedLayout = async (metadata, renderResult, renderConfig) => {
    if (!jobId) throw new Error('No active project is available.');

    const layoutMetadata = typeof metadata === 'string'
      ? { name: metadata }
      : (metadata || {});
    const trimmedName = String(layoutMetadata.name || '').trim();
    if (!trimmedName) throw new Error('Please enter a layout name.');
    if (!layoutMetadata.categoryType || !String(layoutMetadata.categoryName || '').trim()) {
      throw new Error('Please choose a layout category.');
    }
    if (!String(layoutMetadata.subCategory || '').trim()) {
      throw new Error('Please choose a sub-category.');
    }
    if (!renderResult?.jobId) throw new Error('The 360 render is not available to save.');

    const sourceModelUrl = renderResult.modelUrl ||
      `${API_BASE_URL}/jobs/${encodeURIComponent(renderResult.jobId)}/output.glb`;

    const modelResponse = await fetch(sourceModelUrl, { cache: 'no-store' });
    if (!modelResponse.ok) {
      throw new Error(`Could not read the final 360 model (${modelResponse.status}).`);
    }

    const modelBlob = await modelResponse.blob();
    let thumbnailBlob = null;

    try {
      const modelFile = new File(
        [modelBlob],
        `${renderResult.jobId}.glb`,
        { type: 'model/gltf-binary' }
      );
      thumbnailBlob = await generateGlbThumbnail(modelFile, 320);
    } catch (thumbnailError) {
      console.warn('[ProjectSync] Thumbnail generation failed; saving layout without thumbnail.', thumbnailError);
    }

    const formData = new FormData();
    formData.append('name', trimmedName);
    formData.append('categoryType', layoutMetadata.categoryType);
    formData.append('categoryName', String(layoutMetadata.categoryName || '').trim());
    formData.append('subCategory', String(layoutMetadata.subCategory || '').trim());
    formData.append('projectState', JSON.stringify(projectStateRef.current || {}));
    formData.append('renderConfig', JSON.stringify(renderConfig || {}));
    if (thumbnailBlob) formData.append('thumbnail', thumbnailBlob, 'thumbnail.jpg');

    const response = await fetch(
      `${API_BASE_URL}/api/projects/${encodeURIComponent(jobId)}/saved-layouts`,
      { method: 'POST', body: formData }
    );
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data?.success || !data?.layout) {
      throw new Error(data?.error || `Failed to save layout (${response.status})`);
    }

    const normalizedLayout = normalizeSavedLayout(data.layout);
    setSavedLayouts(prev => [
      normalizedLayout,
      ...prev.filter(item => item.id !== normalizedLayout.id),
    ]);

    return normalizedLayout;
  };

  const updateSavedLayout = async (layoutId, metadata) => {
    if (!layoutId) throw new Error('Saved layout id is required.');
    const response = await fetch(
      `${API_BASE_URL}/api/saved-layouts/${encodeURIComponent(layoutId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata || {}),
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success || !data?.layout) {
      throw new Error(data?.error || `Failed to update layout (${response.status})`);
    }

    const normalizedLayout = normalizeSavedLayout(data.layout);
    setSavedLayouts(prev => prev.map(item => (
      item.id === normalizedLayout.id ? normalizedLayout : item
    )));
    return normalizedLayout;
  };

  const updateSavedLayoutSnapshot = async (layoutId, renderResult, renderConfig) => {
    if (!layoutId) throw new Error('Saved layout id is required.');
    if (!jobId) throw new Error('No active project is available.');
    if (!renderResult?.jobId || renderResult.jobId != jobId) {
      throw new Error('Render the current project before updating the saved layout.');
    }

    let thumbnailBlob = null;
    const sourceModelUrl = renderResult.modelUrl ||
      `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/output.glb`;

    try {
      const modelResponse = await fetch(sourceModelUrl, { cache: 'no-store' });
      if (!modelResponse.ok) {
        throw new Error(`Could not read the final 360 model (${modelResponse.status}).`);
      }
      const modelBlob = await modelResponse.blob();
      const modelFile = new File(
        [modelBlob],
        `${jobId}.glb`,
        { type: 'model/gltf-binary' }
      );
      thumbnailBlob = await generateGlbThumbnail(modelFile, 320);
    } catch (thumbnailError) {
      console.warn('[ProjectSync] Updated-layout thumbnail generation failed; keeping previous thumbnail.', thumbnailError);
    }

    const formData = new FormData();
    formData.append('sourceJobId', jobId);
    formData.append('renderConfig', JSON.stringify(renderConfig || {}));
    if (thumbnailBlob) formData.append('thumbnail', thumbnailBlob, 'thumbnail.jpg');

    const response = await fetch(
      `${API_BASE_URL}/api/saved-layouts/${encodeURIComponent(layoutId)}/snapshot`,
      { method: 'PUT', body: formData }
    );
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data?.success || !data?.layout) {
      throw new Error(data?.error || `Failed to update saved layout (${response.status})`);
    }

    const normalizedLayout = normalizeSavedLayout(data.layout);
    setSavedLayouts(prev => prev.map(item => (
      item.id === normalizedLayout.id ? normalizedLayout : item
    )));
    return normalizedLayout;
  };

  const deleteSavedLayout = async (layoutId) => {
    if (!layoutId) throw new Error('Saved layout id is required.');
    const response = await fetch(
      `${API_BASE_URL}/api/saved-layouts/${encodeURIComponent(layoutId)}`,
      { method: 'DELETE' }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || `Failed to delete layout (${response.status})`);
    }
    setSavedLayouts(prev => prev.filter(item => item.id !== layoutId));
    return true;
  };

  const withWallSurfaceScope = (definition, surfaceScope) => ({
    ...definition,
    surfaceScope: ['interior', 'exterior', 'both'].includes(surfaceScope) ? surfaceScope : 'both',
  });

  // Convert both the current scoped state and legacy one-sided/full-wall entries
  // into a pair of side definitions. This prevents applying a finish to the
  // opposite side from silently discarding a finish saved by an older editor.
  const getExistingWallSurfaces = (previous) => {
    if (!previous || typeof previous !== 'object') {
      return { interior: null, exterior: null };
    }

    if (previous.surfaces && typeof previous.surfaces === 'object') {
      return {
        interior: previous.surfaces.interior || null,
        exterior: previous.surfaces.exterior || null,
      };
    }

    if (Object.prototype.hasOwnProperty.call(previous, 'interior') ||
        Object.prototype.hasOwnProperty.call(previous, 'exterior')) {
      return {
        interior: previous.interior || null,
        exterior: previous.exterior || null,
      };
    }

    const legacyDefinition = { ...previous, surfaceScope: null };
    if (previous.surfaceScope === 'interior') {
      return { interior: legacyDefinition, exterior: null };
    }
    if (previous.surfaceScope === 'exterior') {
      return { interior: null, exterior: legacyDefinition };
    }
    if (previous.surfaceScope === 'scoped') {
      return { interior: null, exterior: null };
    }

    // 'both' and legacy unscoped material definitions represented one finish
    // applied to the complete wall, so preserve it on both physical surfaces.
    return { interior: legacyDefinition, exterior: legacyDefinition };
  };

  const applyMaterial = (viewerRef, selectedObject, hexColor, rgbArray, surfaceScope = 'both', historyOptions = {}) => {
    if (!selectedObject || !viewerRef.current) return 0;
    const definition = withWallSurfaceScope({ kind: 'color', color: hexColor, rgb: rgbArray }, surfaceScope);
    applyMaterialDefinition(viewerRef, selectedObject, definition, historyOptions);
    return 1;
  };

  const applyMaterialDefinition = (viewerRef, selectedObject, definition, historyOptions = {}) => {
    if (!selectedObject || !viewerRef.current || !definition) return 0;
    const isWall = !!selectedObject.isWall || String(selectedObject.type || '').toLowerCase().includes('ifcwall');
    const normalized = normalizeMaterialDefinition(
      isWall ? { ...definition, surfaceScope: definition.surfaceScope || 'both' } : definition
    );
    const previous = projectStateRef.current?.materials?.[selectedObject.id];

    let sceneDefinition = normalized;
    let nextWallState = null;

    if (isWall && normalized.surfaceScope) {
      const { interior: currentInterior, exterior: currentExterior } = getExistingWallSurfaces(previous);
      const nextInterior = normalized.surfaceScope === 'exterior' ? currentInterior : { ...normalized, surfaceScope: null };
      const nextExterior = normalized.surfaceScope === 'interior' ? currentExterior : { ...normalized, surfaceScope: null };

      nextWallState = {
        ...normalized,
        surfaceScope: 'scoped',
        surfaces: { interior: nextInterior || null, exterior: nextExterior || null },
      };
      sceneDefinition = nextWallState;
    }

    // Render from the full side-aware state immediately. This prevents changing
    // the interior from accidentally clearing an already-customized exterior.
    void applySceneMaterial(viewerRef.current, selectedObject.id, sceneDefinition);
    if (normalized.color) setCustomColor(normalized.color);

    setProjectStateTracked(prev => {
      const nextMaterials = { ...(prev.materials || {}) };
      nextMaterials[selectedObject.id] = nextWallState || normalized;
      return { ...prev, materials: nextMaterials };
    }, historyOptions);
    return 1;
  };

  const applyMaterialToAllWalls = (viewerRef, hexColor, rgbArray, surfaceScope = 'both') => {
    return applyMaterialDefinitionToAllWalls(viewerRef, withWallSurfaceScope({ kind: 'color', color: hexColor, rgb: rgbArray }, surfaceScope));
  };

  const applyMaterialDefinitionToAllWalls = (viewerRef, definition) => {
    const viewer = viewerRef.current;
    if (!viewer || !definition) return 0;
    const normalized = normalizeMaterialDefinition({ ...definition, surfaceScope: definition.surfaceScope || 'both' });

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

    const stateBeforeApply = projectStateRef.current;
    wallIds.forEach(id => {
      const previous = stateBeforeApply?.materials?.[id];
      const { interior: currentInterior, exterior: currentExterior } = getExistingWallSurfaces(previous);
      const nextInterior = normalized.surfaceScope === 'exterior' ? currentInterior : { ...normalized, surfaceScope: null };
      const nextExterior = normalized.surfaceScope === 'interior' ? currentExterior : { ...normalized, surfaceScope: null };
      const sceneDefinition = {
        ...normalized,
        surfaceScope: 'scoped',
        surfaces: { interior: nextInterior || null, exterior: nextExterior || null },
      };
      void applySceneMaterial(viewer, id, sceneDefinition);
    });

    setCustomColor(normalized.color);
    setProjectStateTracked(prev => {
      const nextMaterials = { ...(prev.materials || {}) };
      wallIds.forEach(id => {
        const previous = nextMaterials[id];
        const { interior: currentInterior, exterior: currentExterior } = getExistingWallSurfaces(previous);
        nextMaterials[id] = {
          ...normalized,
          surfaceScope: 'scoped',
          surfaces: {
            interior: normalized.surfaceScope === 'exterior' ? currentInterior : { ...normalized, surfaceScope: null },
            exterior: normalized.surfaceScope === 'interior' ? currentExterior : { ...normalized, surfaceScope: null },
          },
        };
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
  const updateAsset = (viewerRef, selectedAssetId, axis, value, isRotation = false, isScale = false, transformOptions = {}) => {
    if (!selectedAssetId || !viewerRef.current) return;
    const assetModel = viewerRef.current.scene.models[selectedAssetId];
    if (!assetModel) return;
    const numValue = parseFloat(value);
    if (!Number.isFinite(numValue)) return;

    const isGLB = isGLBModel(assetModel);
    const isNativeIsolation = !!assetModel?._assetMeta?.isNativeIsolation;
    const currentGLBTarget = isGLB ? getGLBPlacementTarget(assetModel) : null;
    const currentGLBRotation = isGLB ? getGLBRotation(assetModel) : null;
    const currentGLBScale = isGLB ? getGLBScale(assetModel) : null;

    let updatedPos;
    let updatedRot;
    let updatedScale;

    if (isScale) {
      updatedScale = Array.isArray(transformOptions.scaleOverride) && transformOptions.scaleOverride.length === 3
        ? Array.from(transformOptions.scaleOverride, Number)
        : (isGLB
          ? [...currentGLBScale]
          : [...(assetModel.scale || [1, 1, 1])]);
      updatedScale[axis] = Math.max(0.001, numValue);
      if (isGLB) {
        applyGLBPlacementTransform(
          assetModel,
          currentGLBTarget,
          currentGLBRotation,
          updatedScale
        );
      } else if (!transformOptions.preserveRuntimeTransform && !transformOptions.matrixOverride) {
        // Matrix-authored IFC gizmo resizes must not be overwritten by a TRS
        // setter immediately after their pivot-correct matrix was committed.
        assetModel.scale = updatedScale;
      }
    } else if (isRotation) {
      updatedRot = isGLB
        ? [...currentGLBRotation]
        : [...(assetModel.rotation || [0, 0, 0])];
      updatedRot[axis] = numValue;
      if (isGLB) {
        applyGLBPlacementTransform(
          assetModel,
          currentGLBTarget,
          updatedRot,
          currentGLBScale
        );
      } else if (!transformOptions.preserveRuntimeTransform) {
        // Normal property-panel rotation uses xeokit's TRS path. A live IFC gizmo
        // drag can opt out because it has already committed a pivot-correct matrix.
        assetModel.rotation = updatedRot;
      }
    } else {
      if (isGLB) {
        updatedPos = [...currentGLBTarget];
        updatedPos[axis] = numValue;
        applyGLBPlacementTransform(
          assetModel,
          updatedPos,
          currentGLBRotation,
          currentGLBScale
        );
      } else if (transformOptions.preserveRuntimeTransform || transformOptions.matrixOverride) {
        const overrideMatrix = normalizeMatrix(transformOptions.matrixOverride || assetModel.matrix);
        updatedPos = overrideMatrix
          ? [overrideMatrix[12], overrideMatrix[13], overrideMatrix[14]]
          : [...(assetModel.position || [0, 0, 0])];
      } else {
        updatedPos = [...(assetModel.position || [0, 0, 0])];
        updatedPos[axis] = numValue;
        assetModel.position = updatedPos;
      }
    }

    // Persist the position in the same coordinate contract that the runtime
    // transform path uses. This is critical because undo/redo/state restoration
    // can immediately reconcile an already-loaded model after this update.
    //
    // - GLB: semantic normalized pivot target.
    // - Native-isolated IFC: matrix translation when the runtime transform was
    //   authored by the IFC gizmo; otherwise raw model.position.
    // - Placed catalogue IFC: semantic floor/contact target derived from the
    //   current post-transform AABB. Persisting it on rotation/scale prevents
    //   restoreProjectStateToScene() from recomputing a new position from a
    //   stale pre-transform target and visibly jumping the model.
    // Only native-isolated IFCs use a persisted full matrix. Catalogue IFCs
    // and hosted doors use semantic AABB target + rotation + scale; persisting
    // their model-origin matrix mixes coordinate contracts and causes teleports.
    const hasRuntimeMatrixOverride = isNativeIsolation && (transformOptions.preserveRuntimeTransform || transformOptions.matrixOverride);
    const runtimeMatrix = hasRuntimeMatrixOverride
      ? normalizeMatrix(transformOptions.matrixOverride || assetModel.matrix)
      : null;
    const persistedPosition = isGLB
      ? (updatedPos || currentGLBTarget)
      : runtimeMatrix
        ? [runtimeMatrix[12], runtimeMatrix[13], runtimeMatrix[14]]
        : isNativeIsolation
          ? [...(assetModel.position || [0, 0, 0])]
          : assetModelToTargetPosition(assetModel);
    // Persist semantic transforms for normal assets. Native-isolated IFCs also
    // retain the exact runtime matrix because that matrix is the authoritative
    // pivot-correct transform produced by the gizmo.
    const glbNormalization = isGLB
      ? assetModel?._assetMeta?.glbNormalization
      : null;
    const persistedMatrix = runtimeMatrix;

    setProjectStateTracked(prev => ({
      ...prev,
      furniture: (prev.furniture || []).map(f => {
        if (f.instanceId !== selectedAssetId) return f;

        const nextItem = {
          ...f,
          position: persistedPosition || f.position || [0, 0, 0],
          rotation: updatedRot || f.rotation || [0, 0, 0],
          scale: updatedScale || f.scale || [1, 1, 1],
          ...(glbNormalization ? { glbNormalization } : {}),
        };

        if (persistedMatrix) {
          nextItem.matrix = persistedMatrix;
        } else if (!isGLB && !isNativeIsolation) {
          // Remove obsolete raw matrices from regular IFC items written by an
          // older editor version. These items must keep semantic target TRS.
          delete nextItem.matrix;
        }

        return nextItem;
      }),
    }), { coalesceKey: `asset-transform:${selectedAssetId}:${isScale ? 'scale' : isRotation ? 'rotation' : 'position'}` });
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
    setProjectStateTracked(prev => ({
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

      const templateFileType = inferFileType(item.url, item.file_type);
      const onPlaced = (instanceId, finalPosition, model) => {
        if (!isGLBModel(model)) return;
        // GLBs persist their semantic pivot transform; the runtime matrix is not
        // part of the persistence contract.
        const normalizedGLB = model?._assetMeta?.glbNormalization;
        const semanticPosition = getGLBPlacementTarget(model);
        setProjectState(prev => ({
          ...prev,
          furniture: (prev.furniture || []).map(existingItem =>
            existingItem.instanceId === instanceId
              ? {
                  ...existingItem,
                  position: existingItem.doorHostWallId ? existingItem.position : semanticPosition,
                  ...(normalizedGLB ? { glbNormalization: normalizedGLB } : {}),
                }
              : existingItem
          ),
        }));
      };

      loadIFCAssetIntoScene(
        uniqueId,
        fullAssetUrl,
        item.position,
        item.rotation,
        { fileType: templateFileType, scale: effectiveScale, onPlaced }
      );
      
      return {
        id: item.id,
        instanceId: uniqueId,
        name: item.name,
        src: fullAssetUrl,
        fileType: templateFileType,
        position: item.position || [0, 0, 0],
        rotation: item.rotation || [0, 0, 0],
        scale: effectiveScale,
        ...(item.glbNormalization ? { glbNormalization: item.glbNormalization } : {}),
        ...(item.doorHostWallId ? { doorHostWallId: item.doorHostWallId } : {}),
        ...(item.doorDimensions ? { doorDimensions: item.doorDimensions } : {}),
      };
    });

    setProjectStateTracked(prev => ({
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

  // Xeokit model AABBs are world-space bounds. The semantic target used by
  // placed IFC furniture/doors is therefore the world AABB's horizontal center
  // and bottom elevation directly. Adding model.position here double-counts
  // the model translation and causes a different location to be persisted after
  // a gizmo edit, undo/redo, or any later project-state reconciliation.
  const assetModelToTargetPosition = (assetModel) => {
    const aabb = assetModel?.aabb;
    const pos = Array.isArray(assetModel?.position) ? assetModel.position : [0, 0, 0];
    if (!aabb || aabb.length < 6 || !Array.from(aabb).slice(0, 6).every(Number.isFinite)) return [...pos];
    return [
      (aabb[0] + aabb[3]) / 2,
      aabb[1],
      (aabb[2] + aabb[5]) / 2,
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
    const doorDimensions = doorHostWallId && asset.doorDimensions && typeof asset.doorDimensions === 'object'
      ? {
          width: Number(asset.doorDimensions.width),
          height: Number(asset.doorDimensions.height),
          thickness: Number(asset.doorDimensions.thickness),
        }
      : null;

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
      ...(doorHostWallId && doorDimensions && Object.values(doorDimensions).every((value) => Number.isFinite(value) && value > 0)
        ? { doorDimensions }
        : {}),
    };

    setProjectStateTracked(prev => ({
      ...prev,
      furniture: [...(prev.furniture || []), furnitureItem],
    }));

    const onPlaced = (instanceId, finalPosition, model) => {
      const isGLB = isGLBModel(model);
      const normalizedGLB = isGLB
        ? model?._assetMeta?.glbNormalization
        : null;
      const semanticPosition = isGLB
        ? getGLBPlacementTarget(model)
        : (Array.isArray(finalPosition) ? [...finalPosition] : null);
      let persistedItemForModel = null;

      // Persist semantic transforms only; runtime IFC matrices are not part of
      // the durable state contract. The loader has already positioned the live
      // model before it calls onPlaced, so record which state that model now
      // represents. Without this marker, the first unrelated project-state edit
      // runs the scene reconciler against the already-placed door and applies the
      // same saved target a second time.
      setProjectStateTracked(prev => {
        let foundItem = false;
        const furniture = (prev.furniture || []).map(item => {
          if (item.instanceId !== instanceId) return item;
          foundItem = true;
          persistedItemForModel = {
            ...item,
            position: item.doorHostWallId ? item.position : (semanticPosition || item.position),
            ...(normalizedGLB ? { glbNormalization: normalizedGLB } : {}),
          };
          return persistedItemForModel;
        });
        return foundItem ? { ...prev, furniture } : prev;
      }, { history: false });

      if (persistedItemForModel) {
        markAssetTransformApplied(model, persistedItemForModel);
      } else {
        // An asset can finish loading after its placement was undone. Do not let
        // the completed asynchronous load leave an orphan in the live scene.
        try { model?.destroy?.(); } catch (_) {}
      }
    };

    const placementPromise = Promise.resolve()
      .then(() => loadIFCAssetIntoScene(
        uniqueId,
        fullAssetUrl,
        position,
        safeRotation,
        { fileType, scale: effectiveScale, doorHostWallId, onPlaced }
      ))
      .catch(error => {
        console.error('[ProjectSync] Failed to load placed asset:', error);
        setProjectStateTracked(prev => ({
          ...prev,
          furniture: (prev.furniture || []).filter(item => item.instanceId !== uniqueId),
        }), { history: false });
        throw error;
      });

    setToastMessage(`${furnitureItem.name} placed!`);
    setTimeout(() => setToastMessage(null), 3000);
    return placementPromise;
  };

  const updateStructuralEdit = (entityId, transformType, axis, value) => {
    if (!entityId) return;
    if (transformType !== 'scale' && transformType !== 'offset' && transformType !== 'visible') return;

    setProjectStateTracked(prev => {
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
    }, { coalesceKey: `structural:${entityId}:${transformType}` });
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
    setProjectStateTracked(prev => {
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
            nativeSourceId: metadata?.nativeSourceId || entityId,
            isNativeIsolation: metadata?.isNativeIsolation !== false,
            ...(normalizeMatrix(metadata?.matrix) ? { matrix: normalizeMatrix(metadata?.matrix) } : {}),
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

    setProjectStateTracked(nextState, { history: false });
    resetHistory();
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

    setProjectStateTracked(nextState, { history: false });
    resetHistory();
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
    savedLayouts,
    savedLayoutsLoading,
    savedLayoutsError,
    homeTemplates,
    toastMessage,
    customColor,
    applyMaterial,
    applyMaterialToAllWalls,
    applyMaterialDefinition,
    applyMaterialDefinitionToAllWalls,
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
    undo,
    redo,
    beginHistoryTransaction,
    endHistoryTransaction,
    resetHistory,
    cancelHistoryTransaction,
    canUndo: !historyApplyingRef.current && !historyTransactionRef.current && historyPastRef.current.length > 0,
    canRedo: !historyApplyingRef.current && !historyTransactionRef.current && historyFutureRef.current.length > 0,
    saveNow,
    refreshSavedLayouts,
    saveRenderedLayout,
    updateSavedLayout,
    updateSavedLayoutSnapshot,
    deleteSavedLayout,
  };
};