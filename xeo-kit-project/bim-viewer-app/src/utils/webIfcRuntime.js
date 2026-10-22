// Centralized WebIFC initialization for Vite-based builds.
// Importing the WASM as an asset lets Vite fingerprint and serve it from the
// correct production URL instead of assuming /web-ifc.wasm exists at site root.
import webIfcWasmUrl from 'web-ifc/web-ifc.wasm?url';

/**
 * Initialize an existing WebIFC IfcAPI instance using the WASM asset bundled
 * by Vite. Force the single-thread build so deployments do not also need the
 * mt WASM and worker assets (or cross-origin isolation headers).
 */
export async function initializeWebIFCApi(ifcAPI) {
  if (!ifcAPI || typeof ifcAPI.Init !== 'function') {
    throw new TypeError('initializeWebIFCApi requires a WebIFC IfcAPI instance.');
  }

  const locateFile = (path, prefix = '') => {
    // WebIFC requests this filename through Emscripten's locateFile callback.
    // The Vite ?url import returns the final URL for dev and production builds.
    if (typeof path === 'string' && /\.wasm(?:[?#].*)?$/i.test(path)) {
      return webIfcWasmUrl;
    }
    return `${prefix || ''}${path}`;
  };

  // The second argument disables the multithread path and avoids an additional
  // dependency on web-ifc-mt.wasm and web-ifc-mt.worker.js.
  await ifcAPI.Init(locateFile, true);
  return ifcAPI;
}
