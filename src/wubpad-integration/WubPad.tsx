import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getWubLabzWsUrl, isMockMode } from './env.js';
import { WubWebSocketClient, type WubConnectionStatus } from './WebSocketClient.js';
import {
  readStorageJson,
  readStorageValue,
  removeStorageValue,
  writeStorageJson,
  writeStorageValue
} from './safeStorage.js';

// --- Constants & Defaults ---
const STORAGE_KEYS = {
  WS_URL: 'wubpad_ws_url',
  URL_HISTORY: 'wubpad_url_history',
  MIDI_MAPPINGS: 'wubpad_midi_mappings',
  CONFIRMATIONS: 'wubpad_confirmations_enabled'
};

const DEFAULT_STEMS = [
    { id: 'kick', label: 'Kick', bus: 'drum' },
    { id: 'snare', label: 'Snare', bus: 'drum' },
    { id: 'drums', label: 'Drums', bus: 'drum' },
    { id: 'bass', label: 'Bass', bus: 'bass' },
    { id: 'lead', label: 'Lead', bus: 'melody' },
    { id: 'vocal', label: 'Vocal', bus: 'vocal' },
    { id: 'fx', label: 'FX', bus: 'fx' },
    { id: 'atmos', label: 'Atmos', bus: 'fx' }
];

const DEFAULT_MACROS = [
  { id: 'tension', label: 'Build Tension' },
  { id: 'fakeout', label: 'Fakeout' },
  { id: 'dropnow', label: 'Drop Now' },
  { id: 'evolve', label: 'Bass Evolve' },
  { id: 'sweep', label: 'Filter Sweep' },
  { id: 'reverb', label: 'Reverb Throw' },
  { id: 'glitch', label: 'Glitch Fill' },
  { id: 'reset', label: 'Reset FX' }
];

const DEFAULT_SCENES = ['Intro', 'Build', 'Pre-drop', 'Drop', 'Breakdown', 'Final Drop', 'Outro'];

type MidiMappingPayload = {
  macroId?: string;
  sceneId?: string;
  [key: string]: unknown;
};

type MidiMapping = {
  type: string;
  payload: MidiMappingPayload;
};

type MidiMappings = Record<string, MidiMapping>;
type MidiStatus = 'unavailable' | 'requesting' | 'ready' | 'blocked';

// --- Styles ---
const COLORS = {
  bg: '#0a0a0a',
  surface: '#1a1a1a',
  primary: '#00ffcc',
  secondary: '#ff00ff',
  danger: '#ff3333',
  text: '#ffffff',
  textMuted: '#888888',
  border: '#333333',
  meter: '#00ffcc'
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    backgroundColor: COLORS.bg,
    color: COLORS.text,
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
    maxWidth: '600px',
    margin: '0 auto',
    boxSizing: 'border-box'
  },
  header: {
    padding: '1rem',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: `1px solid ${COLORS.border}`,
    backgroundColor: COLORS.surface
  },
  section: {
    padding: '1rem',
    borderBottom: `1px solid ${COLORS.border}`
  },
  sectionTitle: {
    fontSize: '0.75rem',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    marginBottom: '0.75rem',
    display: 'flex',
    justifyContent: 'space-between'
  },
  grid: {
    display: 'grid',
    gap: '0.5rem'
  },
  button: {
    backgroundColor: COLORS.surface,
    color: COLORS.text,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '4px',
    padding: '0.75rem',
    fontSize: '0.9rem',
    fontWeight: 'bold',
    cursor: 'pointer',
    touchAction: 'manipulation',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '44px'
  },
  primaryButton: { borderColor: COLORS.primary, color: COLORS.primary },
  dangerButton: { backgroundColor: COLORS.danger, borderColor: COLORS.danger, color: '#fff' },
  activeButton: { backgroundColor: COLORS.primary, color: COLORS.bg },
  slider: { width: '100%', accentColor: COLORS.primary, margin: '0.5rem 0' },
  statusIndicator: { width: '8px', height: '8px', borderRadius: '50%', marginRight: '0.5rem', display: 'inline-block' },
  connectionPanel: {
    padding: '0.75rem 1rem',
    borderBottom: `1px solid ${COLORS.border}`,
    backgroundColor: '#101010',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    flexWrap: 'wrap',
    fontSize: '0.75rem'
  },
  connectionBadge: {
    border: `1px solid ${COLORS.border}`,
    borderRadius: '4px',
    padding: '0.35rem 0.5rem',
    fontWeight: 800,
    letterSpacing: '0.04em'
  },
  meter: { height: '4px', backgroundColor: '#222', borderRadius: '2px', overflow: 'hidden', marginTop: '2px' },
  meterFill: { height: '100%', backgroundColor: COLORS.meter, transition: 'width 0.05s ease-out' },
  input: {
    backgroundColor: '#000',
    color: COLORS.text,
    border: `1px solid ${COLORS.border}`,
    padding: '0.5rem',
    borderRadius: '4px',
    fontSize: '0.8rem',
    width: '100%',
    boxSizing: 'border-box'
  }
};

// --- Components ---

const Meter: React.FC<{ value: number }> = ({ value }) => {
  // value is expected to be normalized 0-1 or dB (if dB, we convert)
  const normalized = Math.max(0, Math.min(1, value)); // Simplistic
  return (
    <div style={styles.meter}>
      <div style={{ ...styles.meterFill, width: `${normalized * 100}%` }} />
    </div>
  );
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isMidiMappings(value: unknown): value is MidiMappings {
  if (!isRecord(value)) return false;

  return Object.values(value).every((candidate) => {
    if (!isRecord(candidate)) return false;
    return typeof candidate.type === 'string' && isRecord(candidate.payload);
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRequestMIDIAccess(): (() => Promise<any>) | null {
  try {
    const navigatorRef = (globalThis as { navigator?: { requestMIDIAccess?: () => Promise<any> } }).navigator;
    return typeof navigatorRef?.requestMIDIAccess === 'function'
      ? navigatorRef.requestMIDIAccess.bind(navigatorRef)
      : null;
  } catch {
    return null;
  }
}

function collectMidiInputNames(access: any): string[] {
  const names: string[] = [];
  forEachMidiInput(access, (input: any) => {
    if (typeof input?.name === 'string' && input.name.length > 0) {
      names.push(input.name);
    }
  });

  return names;
}

function forEachMidiInput(access: any, callback: (input: any) => void): void {
  const inputs = access?.inputs;
  if (!inputs) return;

  if (typeof inputs.forEach === 'function') {
    inputs.forEach(callback);
    return;
  }

  if (typeof inputs[Symbol.iterator] === 'function') {
    for (const input of inputs) {
      callback(Array.isArray(input) ? input[1] : input);
    }
  }
}

function readMidiMessageData(message: any): number[] {
  try {
    return Array.from(message?.data ?? []) as number[];
  } catch {
    return [];
  }
}

function confirmAction(message: string): boolean {
  try {
    const confirmFn = (globalThis as { confirm?: (message: string) => boolean }).confirm;
    return typeof confirmFn === 'function' ? confirmFn(message) : true;
  } catch {
    return true;
  }
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getOptionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function formatUpper(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value.toUpperCase() : fallback;
}

function hasMidiMappingForMacro(mappings: MidiMappings, macroId: string): boolean {
  return Object.values(mappings).some((mapping) => mapping.payload.macroId === macroId);
}

function formatMidiStatus(status: MidiStatus): string {
  switch (status) {
    case 'requesting':
      return 'REQUESTING ACCESS';
    case 'ready':
      return 'READY';
    case 'blocked':
      return 'BLOCKED';
    case 'unavailable':
    default:
      return 'UNAVAILABLE';
  }
}

function formatConnectionStatus(status: WubConnectionStatus): 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'TRIPPED' {
  switch (status) {
    case 'connected':
      return 'CONNECTED';
    case 'connecting':
    case 'reconnecting':
      return 'CONNECTING';
    case 'error':
      return 'ERROR';
    case 'tripped':
      return 'TRIPPED';
    case 'idle':
    case 'disconnected':
    default:
      return 'DISCONNECTED';
  }
}

export const WubPad: React.FC = () => {
  // --- Connection State ---
  const [wsUrl, setWsUrl] = useState(() => {
    return readStorageValue(STORAGE_KEYS.WS_URL) || getWubLabzWsUrl();
  });

  const [urlHistory, setUrlHistory] = useState<string[]>(() => {
    return readStorageJson(STORAGE_KEYS.URL_HISTORY, [], isStringArray);
  });

  const [status, setStatus] = useState<WubConnectionStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const [closeDetails, setCloseDetails] = useState<{ code: number | null, reason: string | null } | null>(null);
  const [latency, setLatency] = useState(0);
  const [engineDiagnostics, setEngineDiagnostics] = useState<any>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  // --- MIDI State ---
  const [midiDevices, setMidiDevices] = useState<string[]>([]);
  const [lastMidiEvent, setLastMidiEvent] = useState<{ status: number, data1: number, data2: number } | null>(null);
  const [midiMappings, setMidiMappings] = useState<MidiMappings>(() =>
    readStorageJson(STORAGE_KEYS.MIDI_MAPPINGS, {}, isMidiMappings)
  );
  const [midiStatus, setMidiStatus] = useState<MidiStatus>('unavailable');
  const [midiError, setMidiError] = useState<string | null>(null);
  const [learningTarget, setLearningTarget] = useState<{ id: string, label: string } | null>(null);

  // --- Settings State ---
  const [confirmationsEnabled, setConfirmationsEnabled] = useState(() => readStorageValue(STORAGE_KEYS.CONFIRMATIONS) === 'true');
  const [showSettings, setShowSettings] = useState(false);

  const clientRef = useRef<WubWebSocketClient | null>(null);
  const learningTargetRef = useRef(learningTarget);
  const midiMappingsRef = useRef(midiMappings);
  const handleIntentRef = useRef<((type: string, payload?: any, force?: boolean) => void) | null>(null);

  // --- Handlers ---
  const clearPairing = useCallback(() => {
    if (confirmAction('Clear saved connection settings and reset to defaults?')) {
        removeStorageValue(STORAGE_KEYS.WS_URL);
        removeStorageValue(STORAGE_KEYS.URL_HISTORY);
        const defaultUrl = getWubLabzWsUrl();
        setWsUrl(defaultUrl);
        setUrlHistory([]);
        
        if (clientRef.current) {
            clientRef.current.disconnect();
            clientRef.current = null;
        }
        setStatus('idle');
        setLastError(null);
        setCloseDetails(null);
        setReconnectAttempts(0);
    }
  }, []);

  const connect = useCallback((targetUrl?: string) => {
    const url = targetUrl || wsUrl;
    if (clientRef.current) {
        clientRef.current.disconnect();
    }

    try {
      clientRef.current = new WubWebSocketClient({ url });
    } catch (err) {
      setStatus('error');
      setLastError(`WebSocket setup failed: ${toErrorMessage(err)}`);
      return;
    }
    
    clientRef.current.onStatusChange((s, err) => {
      setStatus(s);
      setReconnectAttempts(clientRef.current?.getReconnectAttempts() ?? 0);
      if (s === 'connected') {
        setLastError(null);
        setCloseDetails(null);
      }
      if (err) {
        setLastError(err);
        setCloseDetails({
          code: clientRef.current?.getLastCloseCode() ?? null,
          reason: clientRef.current?.getLastCloseReason() ?? null
        });
      }
      if (s === 'connected') {
        writeStorageValue(STORAGE_KEYS.WS_URL, url);
        setUrlHistory(prev => {
            const next = [url, ...prev.filter(u => u !== url)].slice(0, 5);
            writeStorageJson(STORAGE_KEYS.URL_HISTORY, next);
            return next;
        });
      }
    });

    clientRef.current.onEvent((event) => {
      if (event.type === 'ENGINE_STATUS') {
        setEngineDiagnostics(event.payload);
      }
      if (event.type === 'HEARTBEAT') {
        setLatency(clientRef.current?.getLatency() ?? 0);
      }
    });

    clientRef.current.connect();
  }, [wsUrl]);

  const resetCircuitBreaker = useCallback(() => {
    if (clientRef.current) {
        clientRef.current.resetCircuitBreaker();
    } else {
        connect();
    }
  }, [connect]);

  const handleIntent = useCallback((type: string, payload: any = {}, force: boolean = false) => {
    if (confirmationsEnabled && !force) {
        const needsConfirm = ['EMERGENCY_STOP', 'SCENE_TRIGGER', 'TRANSPORT_STOP'].includes(type) || 
                           (type === 'MACRO_TRIGGER' && payload.macroId === 'reset');
        
        if (needsConfirm && type !== 'EMERGENCY_STOP') {
            if (!confirmAction(`Trigger ${type}?`)) return;
        }
    }
    const sent = clientRef.current?.send(type as any, payload) ?? false;
    if (!sent && status !== 'connected') {
      setLastError('WebSocket is not connected. Start WubLabz or reconnect before sending controls.');
    }
  }, [confirmationsEnabled, status]);

  const resetMidiMappings = () => {
    if (confirmAction('Reset all MIDI mappings?')) {
        setMidiMappings({});
        midiMappingsRef.current = {};
        removeStorageValue(STORAGE_KEYS.MIDI_MAPPINGS);
    }
  };

  // --- Effects ---
  useEffect(() => {
    connect();

    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    learningTargetRef.current = learningTarget;
  }, [learningTarget]);

  useEffect(() => {
    midiMappingsRef.current = midiMappings;
  }, [midiMappings]);

  useEffect(() => {
    handleIntentRef.current = handleIntent;
  }, [handleIntent]);

  useEffect(() => {
    let cancelled = false;
    let midiAccess: any = null;
    const requestMIDIAccess = getRequestMIDIAccess();

    if (!requestMIDIAccess) {
      setMidiStatus('unavailable');
      setMidiDevices([]);
      return;
    }

    setMidiStatus('requesting');
    setMidiError(null);

    requestMIDIAccess()
      .then((access: any) => {
        if (cancelled) return;
        midiAccess = access;
        const updateDevices = () => {
          const devices = collectMidiInputNames(access);
          setMidiDevices(devices);
        };
        updateDevices();
        setMidiStatus('ready');

        if ('onstatechange' in access) {
          access.onstatechange = updateDevices;
        }
        
        forEachMidiInput(access, (input: any) => {
          input.onmidimessage = (message: any) => {
            const [s, d1, d2] = readMidiMessageData(message);
            if (!Number.isFinite(s) || !Number.isFinite(d1) || !Number.isFinite(d2)) return;

            setLastMidiEvent({ status: s, data1: d1, data2: d2 });
            const currentLearningTarget = learningTargetRef.current;
            
            // Learning mode
            if (currentLearningTarget) {
                if (s === 144 && d2 > 0) { // Note on
                    const key = `note-${d1}`;
                    setMidiMappings(prev => {
                        const next = {
                          ...prev,
                          [key]: {
                            type: currentLearningTarget.id.startsWith('SCENE') ? 'SCENE_TRIGGER' : 'MACRO_TRIGGER',
                            payload: { macroId: currentLearningTarget.id, sceneId: currentLearningTarget.label }
                          }
                        };
                        midiMappingsRef.current = next;
                        writeStorageJson(STORAGE_KEYS.MIDI_MAPPINGS, next);
                        return next;
                    });
                    learningTargetRef.current = null;
                    setLearningTarget(null);
                }
                return;
            }

            // Normal MIDI trigger
            if (s === 144 && d2 > 0) {
                const mapping = midiMappingsRef.current[`note-${d1}`];
                if (mapping) {
                    handleIntentRef.current?.(mapping.type, mapping.payload);
                }
            }
          };
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMidiStatus('blocked');
        setMidiDevices([]);
        setMidiError(toErrorMessage(err));
      });

    return () => {
      cancelled = true;
      if (midiAccess) {
          midiAccess.onstatechange = null;
          forEachMidiInput(midiAccess, (input: any) => {
              input.onmidimessage = null;
          });
      }
    };
  }, []);

  // --- Rendering Helpers ---
  const getStatusColor = () => {
    switch (status) {
      case 'connected': return '#00ff00';
      case 'connecting':
      case 'reconnecting': return 'orange';
      case 'error': return 'red';
      case 'tripped': return '#ff3333';
      default: return '#555';
    }
  };

  const getLevel = (bus: string) => {
      const raw = engineDiagnostics?.busLevels?.[bus];
      if (!Number.isFinite(raw) || raw === -Infinity) return 0;
      // Convert linear to normalized for display
      return raw; 
  };

  const transportState = formatUpper(engineDiagnostics?.transportState, 'STOPPED');
  const currentScene = getString(engineDiagnostics?.currentScene, '---');
  const currentBar = getFiniteNumber(engineDiagnostics?.currentBar, 0);
  const currentBeat = getFiniteNumber(engineDiagnostics?.currentBeat, 1);
  const currentPhrase = getFiniteNumber(engineDiagnostics?.currentPhrase, 1);
  const bpm = getOptionalFiniteNumber(engineDiagnostics?.bpm);
  const connectionStatus = formatConnectionStatus(status);

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center' }} onClick={() => setShowSettings(!showSettings)}>
          <div style={{ ...styles.statusIndicator, backgroundColor: getStatusColor() }} />
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 'bold' }}>WubPad</div>
            <div style={{ fontSize: '0.65rem', color: COLORS.textMuted }}>
              {status.toUpperCase()} {latency > 0 && `(${latency}ms)`}
              {isMockMode() && ' [MOCK]'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button style={{ ...styles.button, padding: '0.5rem' }} onClick={() => setShowSettings(!showSettings)}>SETTINGS</button>
          <button 
            style={{ ...styles.button, ...styles.dangerButton, padding: '0.5rem' }} 
            onClick={() => handleIntent('EMERGENCY_STOP', {}, true)}
          >
            E-STOP
          </button>
        </div>
      </header>

      <section style={styles.connectionPanel} aria-live="polite">
        <div>
          <div style={{ color: COLORS.textMuted, marginBottom: '0.2rem' }}>CONNECTION</div>
          <div style={{ color: COLORS.text }}>{wsUrl}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {status === 'tripped' && (
                <button 
                    style={{ ...styles.button, padding: '0.35rem 0.5rem', fontSize: '0.7rem', borderColor: COLORS.primary, color: COLORS.primary }}
                    onClick={resetCircuitBreaker}
                >
                    RETRY
                </button>
            )}
            <div style={{ ...styles.connectionBadge, color: getStatusColor(), borderColor: getStatusColor() }}>
                {connectionStatus}
            </div>
        </div>
      </section>

      {showSettings && (
        <section style={{ ...styles.section, backgroundColor: COLORS.surface }}>
            <div style={styles.sectionTitle}>
                Pairing & URLs
                <span style={{ color: COLORS.primary, cursor: 'pointer', fontSize: '0.65rem' }} onClick={clearPairing}>RESET PAIRING</span>
            </div>
            <div style={{ marginBottom: '1rem' }}>
                <input 
                    style={styles.input} 
                    value={wsUrl} 
                    onChange={(e) => setWsUrl(e.target.value)}
                    placeholder="ws://ip:port"
                />
                <button style={{ ...styles.button, width: '100%', marginTop: '0.5rem' }} onClick={() => connect()}>CONNECT</button>
            </div>
            {urlHistory.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                    <div style={{ fontSize: '0.6rem', color: COLORS.textMuted, marginBottom: '0.25rem' }}>RECENT</div>
                    {urlHistory.map(url => (
                        <div key={url} style={{ fontSize: '0.8rem', padding: '0.25rem 0', color: COLORS.primary, cursor: 'pointer' }} onClick={() => { setWsUrl(url); connect(url); }}>
                            {url}
                        </div>
                    ))}
                </div>
            )}
            <div style={styles.sectionTitle}>Safety</div>
            <label style={{ display: 'flex', alignItems: 'center', fontSize: '0.8rem', gap: '0.5rem' }}>
                <input 
                    type="checkbox" 
                    checked={confirmationsEnabled} 
                    onChange={(e) => {
                        setConfirmationsEnabled(e.target.checked);
                        writeStorageValue(STORAGE_KEYS.CONFIRMATIONS, e.target.checked.toString());
                    }} 
                />
                Enable Confirmations
            </label>
            <div style={{ ...styles.sectionTitle, marginTop: '1rem' }}>MIDI Mapping</div>
            <button style={{ ...styles.button, width: '100%', fontSize: '0.75rem' }} onClick={resetMidiMappings}>RESET MAPPINGS</button>
        </section>
      )}

      {/* Transport */}
      <section style={styles.section}>
        <div style={styles.sectionTitle}>
            Transport 
            <span>{transportState}</span>
        </div>
        <div style={{ ...styles.grid, gridTemplateColumns: '1fr 1fr 1fr' }}>
          <button style={styles.button} onClick={() => handleIntent('TRANSPORT_PLAY')}>PLAY</button>
          <button style={styles.button} onClick={() => handleIntent('TRANSPORT_PAUSE')}>PAUSE</button>
          <button style={styles.button} onClick={() => handleIntent('TRANSPORT_STOP')}>STOP</button>
        </div>
        <div style={{ marginTop: '1rem' }}>
          <div style={{ fontSize: '0.65rem', color: COLORS.textMuted, marginBottom: '0.25rem' }}>SEEK / SCRUB</div>
          <input 
            type="range" 
            style={styles.slider} 
            min="0" max="600" step="1" 
            value={currentBar * 2} // Dummy progress
            onChange={(e) => handleIntent('TRANSPORT_SEEK', { positionSeconds: parseFloat(e.target.value) })}
          />
        </div>
      </section>

      {/* Stems */}
      <section style={styles.section}>
        <div style={styles.sectionTitle}>Stem Matrix</div>
        <div style={{ ...styles.grid, gap: '1rem' }}>
          {DEFAULT_STEMS.map(stem => (
            <div key={stem.id} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 50px 50px', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ fontSize: '0.85rem' }}>
                {stem.label}
                <Meter value={getLevel(stem.bus)} />
              </div>
              <input 
                type="range" 
                style={styles.slider} 
                min="0" max="1" step="0.01" 
                value={getFiniteNumber(engineDiagnostics?.busLevels?.[`${stem.bus}_gain`], 0.85)} // Assuming gain feedback exists
                onChange={(e) => handleIntent('STEM_GAIN', { stemId: stem.bus, value: parseFloat(e.target.value) })}
              />
              <button 
                style={{ ...styles.button, fontSize: '0.7rem', padding: '0.25rem' }} 
                onClick={() => handleIntent('STEM_MUTE', { stemId: stem.bus })}
              >
                MUTE
              </button>
              <button 
                style={{ ...styles.button, fontSize: '0.7rem', padding: '0.25rem' }} 
                onClick={() => handleIntent('STEM_SOLO', { stemId: stem.bus })}
              >
                SOLO
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Macros */}
      <section style={styles.section}>
        <div style={styles.sectionTitle}>
            Performance Macros
            {learningTarget && <span style={{ color: COLORS.secondary }}>LEARNING: {learningTarget.label}...</span>}
        </div>
        <div style={{ ...styles.grid, gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          {DEFAULT_MACROS.map(macro => (
            <button 
              key={macro.id} 
              style={{ ...styles.button, ...styles.primaryButton, height: '60px', position: 'relative' }}
              onClick={() => handleIntent('MACRO_TRIGGER', { macroId: macro.id })}
              onContextMenu={(e) => { e.preventDefault(); setLearningTarget(macro); }}
            >
              {macro.label}
              {hasMidiMappingForMacro(midiMappings, macro.id) && (
                  <div style={{ position: 'absolute', top: 2, right: 4, fontSize: '0.5rem', color: COLORS.textMuted }}>MIDI</div>
              )}
            </button>
          ))}
        </div>
      </section>

      {/* Scenes */}
      <section style={styles.section}>
        <div style={styles.sectionTitle}>
            Scene Trigger
            <span style={{ color: COLORS.primary }}>{currentScene}</span>
        </div>
        <div style={{ overflowX: 'auto', display: 'flex', gap: '0.5rem', paddingBottom: '0.5rem' }}>
          {DEFAULT_SCENES.map(scene => (
            <button 
                key={scene} 
                style={{ 
                    ...styles.button, 
                    minWidth: '100px',
                    borderColor: currentScene === scene ? COLORS.primary : COLORS.border
                }}
                onClick={() => handleIntent('SCENE_TRIGGER', { sceneId: scene })}
                onContextMenu={(e) => { e.preventDefault(); setLearningTarget({ id: `SCENE_${scene}`, label: scene }); }}
            >
                {scene}
            </button>
          ))}
        </div>
      </section>

      {/* MIDI & Info */}
      <section style={{ ...styles.section, borderBottom: 'none', flex: 1 }}>
        <div style={styles.sectionTitle}>MIDI & Diagnostics</div>
        <div style={{ fontSize: '0.75rem', color: COLORS.textMuted }}>
          <div>MIDI Status: {formatMidiStatus(midiStatus)}{midiError ? ` (${midiError})` : ''}</div>
          <div>MIDI Devices: {midiDevices.length > 0 ? midiDevices.join(', ') : 'None detected'}</div>
          {lastMidiEvent && <div style={{ marginTop: '0.25rem', color: COLORS.primary }}>
            LAST MIDI: {lastMidiEvent.status}, {lastMidiEvent.data1}, {lastMidiEvent.data2}
          </div>}
          <div style={{ marginTop: '0.5rem' }}>
            BPM: {bpm === null ? '---' : bpm.toFixed(1)} | 
            Pos: {currentBar || 1}.{currentBeat} |
            Phrase: {currentPhrase} |
            Attempts: {reconnectAttempts}
          </div>
          {status === 'tripped' && (
            <div style={{ color: COLORS.danger, marginTop: '0.5rem', borderTop: `1px solid ${COLORS.border}`, paddingTop: '0.5rem' }}>
                <div style={{ fontWeight: 'bold' }}>Circuit Breaker Tripped</div>
                <div style={{ fontSize: '0.75rem', marginTop: '0.2rem' }}>Too many failed connection attempts. Please check if WubLabz is running and click RETRY.</div>
                <button 
                    style={{ ...styles.button, width: '100%', marginTop: '0.75rem', backgroundColor: COLORS.primary, color: COLORS.bg }}
                    onClick={resetCircuitBreaker}
                >
                    RESET & RETRY CONNECTION
                </button>
            </div>
          )}
          {lastError && status !== 'tripped' && (
            <div style={{ color: COLORS.danger, marginTop: '0.5rem', borderTop: `1px solid ${COLORS.border}`, paddingTop: '0.5rem' }}>
              <div style={{ fontWeight: 'bold' }}>Error: {lastError}</div>
              <div style={{ fontSize: '0.65rem', opacity: 0.8, marginTop: '0.2rem' }}>URL: {wsUrl}</div>
              {closeDetails && (closeDetails.code !== null || closeDetails.reason) && (
                <div style={{ fontSize: '0.65rem', opacity: 0.8 }}>
                  Code: {closeDetails.code ?? 'unknown'} | Reason: {closeDetails.reason || 'none'}
                </div>
              )}
              <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: COLORS.text }}>
                💡 Try <strong>ws://localhost:3001</strong> and confirm <strong>http://localhost:3001/health</strong> works.
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
