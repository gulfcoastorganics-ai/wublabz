import { describe, expect, it, vi } from 'vitest';
import { getFlipPrepApiUrl, getFlipPrepMaxClipSeconds, getWubLabzHttpUrl, getWubLabzWsUrl, isMockMode } from '../src/wubpad-integration/env.js';

describe('WubPad Integration Env', () => {
  it('should return default URLs when environment is missing', () => {
    // Clear env
    vi.stubGlobal('window', undefined);
    delete process.env.VITE_WUBLABZ_HTTP_URL;
    delete process.env.VITE_WUBLABZ_WS_URL;
    delete process.env.VITE_FLIP_PREP_MAX_CLIP_SECONDS;

    expect(getWubLabzHttpUrl()).toBe('http://localhost:3001');
    expect(getWubLabzWsUrl()).toBe('ws://localhost:3001');
    expect(getFlipPrepMaxClipSeconds()).toBe(60);
  });

  it('should derive URLs from window.location when possible', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'http:',
        hostname: '192.168.1.5',
      }
    });

    expect(getWubLabzHttpUrl()).toBe('http://192.168.1.5:3001');
    expect(getWubLabzWsUrl()).toBe('ws://192.168.1.5:3001');
  });

  it('keeps localhost as localhost when the dev UI is served from localhost', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'http:',
        hostname: 'localhost',
      }
    });

    expect(getWubLabzHttpUrl()).toBe('http://localhost:3001');
    expect(getWubLabzWsUrl()).toBe('ws://localhost:3001');
  });

  it('should use VITE_ variables when present', () => {
    vi.stubGlobal('window', undefined);
    process.env.VITE_WUBLABZ_HTTP_URL = 'https://api.wub.ai';
    process.env.VITE_WUBLABZ_WS_URL = 'wss://ws.wub.ai';

    expect(getWubLabzHttpUrl()).toBe('https://api.wub.ai');
    expect(getWubLabzWsUrl()).toBe('wss://ws.wub.ai');
  });

  it('aligns loopback VITE_ URLs with the page host to avoid localhost and 127.0.0.1 origin splits', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'http:',
        hostname: 'localhost',
      }
    });
    process.env.VITE_WUBLABZ_HTTP_URL = 'http://127.0.0.1:3001';
    process.env.VITE_WUBLABZ_WS_URL = 'ws://127.0.0.1:3001';

    expect(getWubLabzHttpUrl()).toBe('http://localhost:3001');
    expect(getWubLabzWsUrl()).toBe('ws://localhost:3001');
  });

  it('resolves browser Flip Prep calls to the WubLabz API instead of the worker port', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'http:',
        hostname: 'localhost',
      }
    });
    process.env.VITE_FLIP_PREP_API_URL = 'http://127.0.0.1:3002';

    expect(getFlipPrepApiUrl()).toBe('http://localhost:3001');
  });

  it('allows the Flip Prep max clip duration to be configured', () => {
    vi.stubGlobal('window', undefined);
    process.env.VITE_FLIP_PREP_MAX_CLIP_SECONDS = '45';

    expect(getFlipPrepMaxClipSeconds()).toBe(45);
  });

  it('does not require process global for mock mode checks', () => {
    const originalProcess = globalThis.process;

    try {
      vi.stubGlobal('process', undefined);

      expect(() => isMockMode()).not.toThrow();
      expect(isMockMode()).toBe(false);
    } finally {
      vi.stubGlobal('process', originalProcess);
    }
  });
});
