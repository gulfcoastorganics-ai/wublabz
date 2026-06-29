/**
 * Safe environment variable resolution for WubPad.
 * Derives defaults from window.location if VITE_ variables are missing.
 */

export const getWubLabzHttpUrl = () => {
  const importMetaEnv = getImportMetaEnv();
  if (importMetaEnv?.VITE_WUBLABZ_HTTP_URL) {
    return alignLoopbackUrlWithPageHost(importMetaEnv.VITE_WUBLABZ_HTTP_URL);
  }
  
  const processEnv = getProcessEnv();
  if (processEnv?.VITE_WUBLABZ_HTTP_URL) {
    return alignLoopbackUrlWithPageHost(processEnv.VITE_WUBLABZ_HTTP_URL);
  }
  
  // Fallback to same host, port 3001.
  const win = (globalThis as any).window;
  if (typeof win !== 'undefined') {
    const { protocol, hostname } = win.location;
    return `${protocol}//${hostname}:3001`;
  }
  
  return 'http://localhost:3001';
};

export const getWubLabzWsUrl = () => {
  const importMetaEnv = getImportMetaEnv();
  if (importMetaEnv?.VITE_WUBLABZ_WS_URL) {
    return alignLoopbackUrlWithPageHost(importMetaEnv.VITE_WUBLABZ_WS_URL);
  }
  
  const processEnv = getProcessEnv();
  if (processEnv?.VITE_WUBLABZ_WS_URL) {
    return alignLoopbackUrlWithPageHost(processEnv.VITE_WUBLABZ_WS_URL);
  }
  
  // Fallback to same host, port 3001.
  const win = (globalThis as any).window;
  if (typeof win !== 'undefined') {
    const { hostname } = win.location;
    const protocol = win.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${hostname}:3001`;
  }
  
  return 'ws://localhost:3001';
};

export const isMockMode = () => {
  return getImportMetaEnv()?.VITE_WUBLABZ_MOCK === 'true' || getProcessEnv()?.VITE_WUBLABZ_MOCK === 'true';
};

function getImportMetaEnv(): Record<string, string | undefined> | undefined {
  try {
    return (import.meta as any).env;
  } catch {
    return undefined;
  }
}

function getProcessEnv(): NodeJS.ProcessEnv | undefined {
  return typeof process !== 'undefined' ? process.env : undefined;
}

function alignLoopbackUrlWithPageHost(value: string): string {
  const win = (globalThis as any).window;
  if (typeof win === 'undefined') return value;

  try {
    const url = new URL(value);
    const pageHost = win.location?.hostname;
    if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && (pageHost === '127.0.0.1' || pageHost === 'localhost')) {
      url.hostname = pageHost;
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    return value;
  }

  return value;
}
