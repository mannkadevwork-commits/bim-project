import { useState } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const useCloudRender = (activeProject, projectStateRef) => {
  const { jobId } = activeProject || {};
  const [isRendering, setIsRendering] = useState(false);
  const [renderResult, setRenderResult] = useState(null);
  const [renderTime, setRenderTime] = useState(null);
  const [renderError, setRenderError] = useState(null);
  const [renderConfig, setRenderConfig] = useState({ type: '360', quality: 'high', lighting: 'daylight' });

  const executeRender = async ({ silent = false, typeOverride = null } = {}) => {
    if (!jobId) {
      if (silent) throw new Error('No active project is available for rendering.');
      return null;
    }

    const startTime = Date.now();

    if (!silent) {
      setIsRendering(true);
      setRenderError(null);
      setRenderResult(null);
    }

    const formData = new FormData();
    // The backend job owns the canonical IFC. Never upload the browser's
    // original File during render: it may predate calibration or structural
    // edits and would silently replace the authoritative input.ifc.
    formData.append('jobId', jobId);

    const effectiveRenderType = typeOverride || renderConfig.type;
    const actualAngle = effectiveRenderType === 'static' ? 'top-front-right' : effectiveRenderType;
    formData.append('angle', actualAngle);
    formData.append('lighting', renderConfig.lighting);
    formData.append('quality', renderConfig.quality);
    const renderedProjectState = JSON.parse(JSON.stringify(projectStateRef.current || {}));
    formData.append('projectState', JSON.stringify(renderedProjectState));
    // Match the scene snapshot to the local project revision so an old render
    // request cannot overwrite a newer autosave on the backend.
    try {
      const stateMeta = JSON.parse(localStorage.getItem(`hci_state_meta_${jobId}`) || 'null');
      const renderRevision = Number(stateMeta?.updatedAt) || Number(stateMeta?.serverRevision) || 0;
      if (renderRevision > 0) {
        formData.append('projectRevision', String(renderRevision));
      }
    } catch (_) {
      // The render can still use the current in-memory state if storage is disabled.
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/render`, { method: 'POST', body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || `Render failed. Server returned ${response.status}`);
      }

      const walkthroughPath = data?.walkthroughPath || data?.url || `/walkthrough/${encodeURIComponent(jobId)}`;
      const resolvedWalkthroughUrl = walkthroughPath.startsWith('http')
        ? walkthroughPath
        : new URL(walkthroughPath, window.location.origin).toString();
      const resolvedModelUrl = data?.modelUrl || `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/output.glb`;

      const result = {
        ...data,
        jobId,
        modelUrl: resolvedModelUrl,
        walkthroughPath,
        walkthroughUrl: resolvedWalkthroughUrl,
        projectState: renderedProjectState,
        renderConfig: { ...renderConfig, type: effectiveRenderType },
      };

      if (!silent) {
        setRenderResult(result);
        setRenderTime(((Date.now() - startTime) / 1000).toFixed(1));
      }

      return result;
    } catch (error) {
      if (!silent) {
        setRenderError(error.message || 'An error occurred during rendering.');
      }
      throw error;
    } finally {
      if (!silent) {
        setIsRendering(false);
      }
    }
  };

  const renderCurrentProject = () => executeRender({ silent: true, typeOverride: '360' });

  return {
    state: { isRendering, renderResult, renderTime, renderError },
    config: renderConfig,
    setRenderConfig,
    executeRender,
    renderCurrentProject,
    setRenderResult,
    setRenderError,
  };
};
