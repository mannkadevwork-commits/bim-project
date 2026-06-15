import { useState } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const useCloudRender = (file, projectStateRef) => {
  const [isRendering, setIsRendering] = useState(false);
  const [renderResult, setRenderResult] = useState(null);
  const [renderTime, setRenderTime] = useState(null);
  const [renderError, setRenderError] = useState(null);
  const [renderConfig, setRenderConfig] = useState({ type: '360', quality: 'high', lighting: 'daylight' });

  const executeRender = async () => {
    if (!file) return;
    setIsRendering(true);
    setRenderError(null);
    setRenderResult(null);
    const startTime = Date.now();

    const formData = new FormData();
    formData.append('ifcFile', file);
    
    const actualAngle = renderConfig.type === 'static' ? 'top-front-right' : renderConfig.type;
    formData.append('angle', actualAngle);
    formData.append('lighting', renderConfig.lighting);
    formData.append('quality', renderConfig.quality);
    formData.append('projectState', JSON.stringify(projectStateRef.current));

    try {
      const response = await fetch(`${API_BASE_URL}/api/render`, { method: 'POST', body: formData });
      if (!response.ok) throw new Error('Render failed. Server returned ' + response.status);

      const data = await response.json();
      setRenderResult(data);
      setRenderTime(((Date.now() - startTime) / 1000).toFixed(1));
    } catch (error) {
      setRenderError(error.message || 'An error occurred during rendering.');
    } finally {
      setIsRendering(false);
    }
  };

  return {
    state: { isRendering, renderResult, renderTime, renderError },
    config: renderConfig,
    setRenderConfig,
    executeRender,
    setRenderResult,
    setRenderError
  };
};