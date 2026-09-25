import { useState } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const useCloudRender = (activeProject, projectStateRef) => {
  const { file, jobId } = activeProject || {};
  const [isRendering, setIsRendering] = useState(false);
  const [renderResult, setRenderResult] = useState(null);
  const [renderTime, setRenderTime] = useState(null);
  const [renderError, setRenderError] = useState(null);
  const [renderConfig, setRenderConfig] = useState({ type: '360', quality: 'high', lighting: 'daylight' });

  const executeRender = async ({ silent = false, typeOverride = null } = {}) => {
    if (!file || !jobId) {
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
    formData.append('ifcFile', file);
    formData.append('jobId', jobId);

    const effectiveRenderType = typeOverride || renderConfig.type;
    const actualAngle = effectiveRenderType === 'static' ? 'top-front-right' : effectiveRenderType;
    formData.append('angle', actualAngle);
    formData.append('lighting', renderConfig.lighting);
    formData.append('quality', renderConfig.quality);
    const renderedProjectState = JSON.parse(JSON.stringify(projectStateRef.current || {}));
    formData.append('projectState', JSON.stringify(renderedProjectState));

    try {
      const response = await fetch(`${API_BASE_URL}/api/render`, { method: 'POST', body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || `Render failed. Server returned ${response.status}`);
      }

      const result = {
        ...data,
        jobId,
        modelUrl: `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/output.glb`,
        walkthroughUrl: `${window.location.origin}/walkthrough/${encodeURIComponent(jobId)}`,
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
