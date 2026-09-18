const PERF_ENABLED = String(import.meta.env.VITE_PERF_LOGS ?? 'true').toLowerCase() !== 'false';

const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? performance.now()
  : Date.now());

const cleanMeta = (meta) => {
  if (!meta || typeof meta !== 'object') return meta;
  try {
    return JSON.parse(JSON.stringify(meta, (_key, value) => {
      if (typeof File !== 'undefined' && value instanceof File) return { name: value.name, size: value.size, type: value.type };
      if (typeof Blob !== 'undefined' && value instanceof Blob) return { size: value.size, type: value.type };
      if (value instanceof Error) return { name: value.name, message: value.message };
      return value;
    }));
  } catch {
    return undefined;
  }
};

export const perfLog = (scope, event, meta = {}) => {
  if (!PERF_ENABLED) return;
  const timestamp = new Date().toISOString();
  const safeMeta = cleanMeta(meta);
  if (safeMeta && Object.keys(safeMeta).length) {
    console.info(`[PERF][${scope}] ${timestamp} ${event}`, safeMeta);
  } else {
    console.info(`[PERF][${scope}] ${timestamp} ${event}`);
  }
};

export const perfTimer = (scope, label, startMeta = {}) => {
  const startedAt = now();
  perfLog(scope, `START ${label}`, startMeta);

  return (endMeta = {}) => {
    const durationMs = Number((now() - startedAt).toFixed(1));
    perfLog(scope, `END ${label}`, { durationMs, ...endMeta });
    return durationMs;
  };
};

export const perfFetch = async (scope, label, url, options = {}) => {
  const end = perfTimer(scope, `fetch ${label}`, { url, method: options.method || 'GET' });
  try {
    const response = await fetch(url, options);
    end({
      status: response.status,
      ok: response.ok,
      contentLength: response.headers.get('content-length'),
      contentType: response.headers.get('content-type'),
    });
    return response;
  } catch (error) {
    end({ error: error?.message || String(error) });
    throw error;
  }
};

export const isPerfEnabled = () => PERF_ENABLED;
