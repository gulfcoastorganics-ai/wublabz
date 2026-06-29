import React, { useEffect, useState } from 'react';
import { getWubLabzHttpUrl, getWubLabzWsUrl, isMockMode } from './env.js';
import { WubWebSocketClient, type WubConnectionStatus } from './WebSocketClient.js';

export const EngineMonitor: React.FC = () => {
  const [status, setStatus] = useState<WubConnectionStatus>('idle');
  const [latency, setLatency] = useState(0);
  const [engineReady, setEngineReady] = useState(false);
  const [emergencyStopped, setEmergencyStopped] = useState(false);
  const [health, setHealth] = useState<any>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  useEffect(() => {
    let client: WubWebSocketClient | null = null;
    let unbindStatus: () => void = () => undefined;
    let unbindEvent: () => void = () => undefined;

    try {
      client = new WubWebSocketClient();
    
      unbindStatus = client.onStatusChange((s, err) => {
        setStatus(s);
        setReconnectAttempts(client?.getReconnectAttempts() ?? 0);
        if (s === 'connected') setLastError(null);
        if (err) setLastError(err);
      });

      unbindEvent = client.onEvent((event) => {
        if (event.type === 'ENGINE_STATUS') {
          setEngineReady(Boolean(event.payload?.engineReady));
          setEmergencyStopped(Boolean(event.payload?.emergencyStopped));
          setDiagnostics(event.payload ?? null);
        }
        if (event.type === 'HEARTBEAT') {
          setLatency(client?.getLatency() ?? 0);
        }
      });

      client.connect();
    } catch (err) {
      setStatus('error');
      setLastError(`WebSocket setup failed: ${toErrorMessage(err)}`);
    }

    // Check health endpoint
    const checkHealth = async () => {
      if (typeof fetch !== 'function') {
        setHealth({ ok: false, error: 'Fetch API is unavailable' });
        setLastError('HTTP Connection Failed: Fetch API is unavailable');
        return;
      }

      try {
        const resp = await fetch(`${getWubLabzHttpUrl()}/health`);
        const data = await resp.json();
        setHealth(data);
        if (isHealthOk(data)) setLastError(null);
      } catch (err: any) {
        setHealth({ ok: false, error: toErrorMessage(err) });
        setLastError(`HTTP Connection Failed: ${toErrorMessage(err)}`);
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 10000);

    return () => {
      unbindStatus();
      unbindEvent();
      client?.disconnect();
      clearInterval(interval);
    };
  }, []);

  const healthOk = isHealthOk(health);
  const healthLabel = health ? (healthOk ? 'OK' : 'FAILED') : 'CHECKING';

  return (
    <div className="wub-glass-panel wub-view-mount" style={{
      padding: '1.15rem',
      border: '1px solid rgba(210, 236, 255, 0.16)',
      borderTop: '1px solid rgba(255, 255, 255, 0.24)',
      borderRadius: '18px',
      background: 'linear-gradient(145deg, rgba(16, 22, 34, 0.78), rgba(11, 17, 28, 0.58))',
      boxShadow: '0 22px 60px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.14)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '0.85rem',
      color: '#f5f8ff'
    }}>
      <h3 style={{ margin: '0 0 1rem 0', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', fontSize: '1.05rem' }}>Engine Monitor {isMockMode() && <span style={{ color: '#ffd166' }}>(MOCK MODE)</span>}</h3>
      
      <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '0.65rem', padding: '0.9rem', border: '1px solid rgba(210, 236, 255, 0.12)', borderRadius: '14px', background: 'rgba(255, 255, 255, 0.045)' }}>
        <strong>Frontend URL:</strong> <span>{getCurrentHref()}</span>
        <strong>HTTP URL:</strong> <span>{getWubLabzHttpUrl()}</span>
        <strong>WS URL:</strong> <span>{getWubLabzWsUrl()}</span>
        
        <strong>Socket Status:</strong> 
        <span style={{ color: status === 'connected' ? '#7cffc9' : status === 'tripped' ? '#ff6b7a' : '#ffd166', fontWeight: 'bold' }}>
          {status.toUpperCase()}
        </span>

        <strong>Reconnects:</strong> <span>{reconnectAttempts}</span>

        <strong>Health Check:</strong>
        <span style={{ color: healthOk ? '#7cffc9' : health ? '#ff6b7a' : '#a8b3c7' }}>
          {healthLabel}
        </span>

        <strong>Latency:</strong> <span>{latency}ms</span>
        <strong>Engine Ready:</strong> <span>{engineReady ? 'YES' : 'NO'}</span>
        <strong>Connections:</strong> <span>{getFiniteNumber(diagnostics?.activeConnectionCount, 0)}</span>
        <strong>Transport:</strong> <span>{formatUpper(diagnostics?.transportState, 'STOPPED')}</span>
        <strong>Scene:</strong> <span>{getString(diagnostics?.currentScene, '---')}</span>
        <strong>E-Stop:</strong> <span style={{ color: emergencyStopped ? '#ff6b7a' : 'inherit' }}>{emergencyStopped ? 'STOPPED' : 'CLEAR'}</span>
      </div>

      <div style={{ marginTop: '1rem', border: '1px solid rgba(210, 236, 255, 0.12)', borderRadius: '14px', padding: '0.9rem', background: 'rgba(255, 255, 255, 0.04)' }}>
          <strong>WubPad Pairing Instructions:</strong>
          <div style={{ fontSize: '0.75rem', marginTop: '0.35rem', color: '#a8b3c7', lineHeight: 1.55 }}>
              1. Open WubPad UI in a mobile or tablet browser.<br/>
              2. Go to SETTINGS.<br/>
              3. Enter Engine URL: <code>{getWubLabzWsUrl()}</code><br/>
              4. Tap CONNECT.
          </div>
      </div>

      {lastError && (
        <div style={{ marginTop: '1rem', padding: '0.8rem', background: 'rgba(70, 18, 28, 0.6)', border: '1px solid rgba(255, 107, 122, 0.48)', borderRadius: '12px', color: '#ffd3d8' }}>
          <strong>Error:</strong> {lastError}
          <div style={{ fontSize: '0.75rem', marginTop: '0.5rem', color: '#f3b6bf' }}>
            Ensure WubLabz backend is running: <code>npm run server</code>
          </div>
        </div>
      )}
    </div>
  );
};

function isHealthOk(health: any): boolean {
  return health?.status === 'ok' || health?.ok === true;
}

function getCurrentHref(): string {
  try {
    return (globalThis as { location?: { href?: string } }).location?.href ?? 'N/A';
  } catch {
    return 'N/A';
  }
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function formatUpper(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value.toUpperCase() : fallback;
}
