import React, { useEffect, useMemo, useRef, useState } from 'react';
import { decodeProducerAudio, toChannelBuffer } from '../lib/audio/ProducerAudioEngine';
import { renderBufferToWav } from '../lib/export/AudioRenderExport';
import { playRenderedBuffer, stopRenderedBuffer } from '../lib/playback/ProducerPlayback';
import { renderMangledBuffer, type ChannelBuffer, type SliceOverride } from '../lib/producer-tools/mangler';

export function SampleManglerView() {
  const [source, setSource] = useState<ChannelBuffer | null>(null);
  const [rendered, setRendered] = useState<ChannelBuffer | null>(null);
  const [fileName, setFileName] = useState('');
  const [slices, setSlices] = useState(12);
  const [glitch, setGlitch] = useState(0.45);
  const [pitch, setPitch] = useState(0);
  const [crossfadeMs, setCrossfadeMs] = useState(5);
  const [gain, setGain] = useState(0.95);
  const [seed, setSeed] = useState('wublabz');
  const [bitcrush, setBitcrush] = useState(0);
  const [filterSweep, setFilterSweep] = useState(0.35);
  const [reverseChance, setReverseChance] = useState(0.15);
  const [gate, setGate] = useState(0.1);
  const [stutter, setStutter] = useState(0.2);
  const [tapeStop, setTapeStop] = useState(0);
  const [selectedSlice, setSelectedSlice] = useState(0);
  const [sliceOrder, setSliceOrder] = useState<number[]>(() => createNaturalOrder(12));
  const [sliceOverrides, setSliceOverrides] = useState<Record<number, SliceOverride>>({});
  const [loadingAction, setLoadingAction] = useState<'load' | 'export' | null>(null);
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const active = rendered ?? source;
  useMemo(() => drawWaveform(canvasRef.current, active, slices, selectedSlice), [active, slices, selectedSlice]);

  useEffect(() => {
    setSliceOrder((current) => reconcileOrder(current, slices));
    setSelectedSlice((current) => Math.min(current, Math.max(0, slices - 1)));
    setSliceOverrides((current) => {
      const next: Record<number, SliceOverride> = {};
      for (const [key, value] of Object.entries(current)) {
        const index = Number(key);
        if (Number.isInteger(index) && index >= 0 && index < slices) next[index] = value;
      }
      return next;
    });
  }, [slices]);

  async function load(file?: File) {
    if (!file) return;
    setLoadingAction('load');
    setStatus(null);
    try {
      const decoded = await decodeProducerAudio(await file.arrayBuffer());
      setSource(toChannelBuffer(decoded));
      setRendered(null);
      setFileName(file.name);
      setSliceOrder(createNaturalOrder(slices));
      setSliceOverrides({});
      setSelectedSlice(0);
      setStatus({ tone: 'success', message: `Loaded ${file.name}` });
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : 'Audio load failed' });
    } finally {
      setLoadingAction(null);
    }
  }

  function mangle(nextSeed = seed) {
    if (!source) return;
    setRendered(renderMangledBuffer(source, renderOptions(nextSeed)));
    setStatus({ tone: 'success', message: 'Mangled buffer ready' });
  }

  function renderOptions(nextSeed = seed) {
    return {
      slices,
      glitch,
      pitchSemitones: pitch,
      crossfadeMs,
      gain,
      seed: nextSeed,
      bitcrush,
      filterSweep,
      reverseChance,
      gate,
      stutter,
      tapeStop,
      order: sliceOrder,
      sliceOverrides
    };
  }

  function patchSelectedSlice(change: SliceOverride) {
    setSliceOverrides((current) => ({
      ...current,
      [selectedSlice]: {
        ...current[selectedSlice],
        ...change
      }
    }));
  }

  function moveSelectedSlice(delta: number) {
    setSliceOrder((current) => {
      const position = current.indexOf(selectedSlice);
      if (position < 0) return current;
      const nextPosition = Math.max(0, Math.min(current.length - 1, position + delta));
      if (nextPosition === position) return current;
      const next = [...current];
      const [item] = next.splice(position, 1);
      next.splice(nextPosition, 0, item);
      return next;
    });
  }

  function reroll() {
    const nextSeed = `${seed}-${Date.now().toString(36)}`;
    setSeed(nextSeed);
    mangle(nextSeed);
  }

  async function exportWav() {
    if (!active) return;
    setLoadingAction('export');
    setStatus(null);
    try {
      const stem = fileName.replace(/\.[^.]+$/, '') || 'loop';
      const wav = renderBufferToWav(`${stem}-mangled.wav`, active);
      downloadBytes(wav.bytes, wav.fileName, wav.mimeType);
      setStatus({ tone: 'success', message: `Exported ${wav.fileName}` });
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : 'Export failed' });
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <ToolPanel title="Sample Mangler" tone="#00ff99">
      <label style={styles.dropZone}>
        <input type="file" accept="audio/*" disabled={loadingAction === 'load'} onChange={(event) => void load(event.target.files?.[0])} style={{ display: 'none' }} />
        <canvas
          ref={canvasRef}
          style={styles.waveform}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            setSelectedSlice(Math.max(0, Math.min(slices - 1, Math.floor((x / Math.max(1, rect.width)) * slices))));
          }}
        />
        <span style={styles.dropText}>{loadingAction === 'load' ? 'Loading audio...' : fileName || 'Drop in an audio loop'}</span>
      </label>
      <div style={styles.grid}>
        <Range label="GLITCH" value={glitch} min={0} max={1} step={0.01} onChange={setGlitch} />
        <Range label="SLICES" value={slices} min={2} max={32} step={1} onChange={setSlices} />
        <Range label="PITCH" value={pitch} min={-12} max={12} step={1} onChange={setPitch} />
        <Range label="CROSSFADE MS" value={crossfadeMs} min={0} max={20} step={1} onChange={setCrossfadeMs} />
        <Range label="GAIN" value={gain} min={0.1} max={1.5} step={0.01} onChange={setGain} />
        <Range label="BITCRUSH" value={bitcrush} min={0} max={1} step={0.01} onChange={setBitcrush} />
        <Range label="FILTER SWEEP" value={filterSweep} min={0} max={1} step={0.01} onChange={setFilterSweep} />
        <Range label="REVERSE" value={reverseChance} min={0} max={1} step={0.01} onChange={setReverseChance} />
        <Range label="GATE" value={gate} min={0} max={1} step={0.01} onChange={setGate} />
        <Range label="STUTTER" value={stutter} min={0} max={1} step={0.01} onChange={setStutter} />
        <Range label="TAPE STOP" value={tapeStop} min={0} max={1} step={0.01} onChange={setTapeStop} />
        <label style={styles.control}>
          <span>SEED</span>
          <input className="wub-control-input" value={seed} onChange={(event) => setSeed(event.target.value)} style={styles.input} />
        </label>
      </div>
      <div style={styles.grid}>
        <div style={styles.control}>
          <span>SELECTED SLICE</span>
          <strong>{selectedSlice + 1}/{slices}</strong>
          <input className="wub-slider" type="range" value={selectedSlice} min={0} max={Math.max(0, slices - 1)} step={1} onChange={(event) => setSelectedSlice(Number(event.target.value))} />
        </div>
        <Range label="SLICE GAIN" value={sliceOverrides[selectedSlice]?.gain ?? 1} min={0} max={1.5} step={0.01} onChange={(value) => patchSelectedSlice({ gain: value })} />
        <Range label="SLICE REPEATS" value={sliceOverrides[selectedSlice]?.repeats ?? 1} min={1} max={8} step={1} onChange={(value) => patchSelectedSlice({ repeats: Math.round(value) })} />
        <label style={styles.control}>
          <span>SLICE FLAGS</span>
          <label><input type="checkbox" checked={sliceOverrides[selectedSlice]?.reversed ?? false} onChange={(event) => patchSelectedSlice({ reversed: event.target.checked })} /> Reverse selected</label>
          <label><input type="checkbox" checked={sliceOverrides[selectedSlice]?.muted ?? false} onChange={(event) => patchSelectedSlice({ muted: event.target.checked })} /> Mute selected</label>
        </label>
      </div>
      <div style={styles.actions}>
        <ActionButton disabled={selectedSlice <= 0} onClick={() => moveSelectedSlice(-1)}>Move Slice Left</ActionButton>
        <ActionButton disabled={selectedSlice >= slices - 1} onClick={() => moveSelectedSlice(1)}>Move Slice Right</ActionButton>
        <ActionButton onClick={() => {
          setSliceOrder(createNaturalOrder(slices));
          setSliceOverrides({});
          setStatus({ tone: 'success', message: 'Slice edits reset' });
        }}>Reset Slice Edits</ActionButton>
      </div>
      <div style={styles.actions}>
        <ActionButton variant="primary" disabled={!source} onClick={() => mangle()}>Mangle</ActionButton>
        <ActionButton disabled={!source} onClick={reroll}>Reroll</ActionButton>
        <ActionButton disabled={!active} onClick={() => active && playRenderedBuffer(active)}>Play</ActionButton>
        <ActionButton onClick={stopRenderedBuffer}>Stop</ActionButton>
        <ActionButton disabled={!active} loading={loadingAction === 'export'} onClick={() => void exportWav()}>Export WAV</ActionButton>
      </div>
      {status && <StatusMessage tone={status.tone}>{status.message}</StatusMessage>}
    </ToolPanel>
  );
}

function drawWaveform(canvas: HTMLCanvasElement | null, buffer: ChannelBuffer | null, slices: number, selectedSlice: number) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, rect.width, rect.height);
  if (!buffer) return;
  const data = buffer.channels[0];
  const step = Math.max(1, Math.floor(data.length / rect.width));
  const mid = rect.height / 2;
  ctx.fillStyle = '#00ff99';
  for (let x = 0; x < rect.width; x++) {
    let min = 1;
    let max = -1;
    for (let i = 0; i < step; i++) {
      const value = data[x * step + i] ?? 0;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    ctx.fillRect(x, mid + min * mid, 1, Math.max(1, (max - min) * mid));
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i <= slices; i++) {
    const x = (rect.width / slices) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, rect.height);
    ctx.stroke();
  }
  const selectedX = (rect.width / slices) * selectedSlice;
  const selectedWidth = rect.width / slices;
  ctx.fillStyle = 'rgba(0, 255, 153, 0.12)';
  ctx.fillRect(selectedX, 0, selectedWidth, rect.height);
  ctx.strokeStyle = '#ffcc33';
  ctx.lineWidth = 2;
  ctx.strokeRect(selectedX + 1, 1, Math.max(1, selectedWidth - 2), Math.max(1, rect.height - 2));
  ctx.fillStyle = '#ffcc33';
  ctx.font = '11px sans-serif';
  ctx.fillText(`Slice ${selectedSlice + 1}`, selectedX + 6, 16);
}

function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function Range({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label style={styles.control}>
      <span>{label}</span>
      <strong>{Number.isInteger(value) ? value : value.toFixed(2)}</strong>
      <input className="wub-slider" type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function createNaturalOrder(slices: number): number[] {
  return Array.from({ length: Math.max(1, Math.floor(slices)) }, (_, index) => index);
}

function reconcileOrder(current: number[], slices: number): number[] {
  const natural = createNaturalOrder(slices);
  const kept = current.filter((index) => natural.includes(index));
  return [...kept, ...natural.filter((index) => !kept.includes(index))];
}

export function ToolPanel({ title, tone, children }: { title: string; tone: string; children: React.ReactNode }) {
  return (
    <section className="wub-glass-panel wub-view-mount" style={styles.panel}>
      <h2 style={{ ...styles.panelTitle, color: tone }}>{title}</h2>
      {children}
    </section>
  );
}

export function StatusMessage({ tone, children }: { tone: 'success' | 'error' | 'info'; children: React.ReactNode }) {
  return (
    <div style={tone === 'error' ? styles.statusError : tone === 'success' ? styles.statusSuccess : styles.statusInfo}>
      {children}
    </div>
  );
}

type ActionButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger';
  loading?: boolean;
};

export function ActionButton({ variant = 'default', loading = false, disabled, style, children, onMouseEnter, onMouseLeave, onMouseDown, onMouseUp, onBlur, ...props }: ActionButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const isDisabled = Boolean(disabled || loading);
  const base = variant === 'primary' ? styles.primaryButton : variant === 'danger' ? styles.dangerButton : styles.button;
  return (
    <button
      type="button"
      {...props}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      style={{
        ...base,
        ...(hovered && !isDisabled ? styles.buttonHover : {}),
        ...(pressed && !isDisabled ? styles.buttonActive : {}),
        ...(isDisabled ? styles.buttonDisabled : {}),
        ...style
      }}
      onMouseEnter={(event) => {
        setHovered(true);
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        setHovered(false);
        setPressed(false);
        onMouseLeave?.(event);
      }}
      onMouseDown={(event) => {
        setPressed(true);
        onMouseDown?.(event);
      }}
      onMouseUp={(event) => {
        setPressed(false);
        onMouseUp?.(event);
      }}
      onBlur={(event) => {
        setPressed(false);
        onBlur?.(event);
      }}
    >
      {loading ? 'Working...' : children}
    </button>
  );
}

export const styles: Record<string, React.CSSProperties> = {
  panel: {
    padding: '1.15rem',
    color: '#f5f8ff',
    display: 'grid',
    gap: '1rem',
    border: '1px solid rgba(210, 236, 255, 0.16)',
    borderTop: '1px solid rgba(255, 255, 255, 0.24)',
    borderRadius: '18px',
    background: 'linear-gradient(145deg, rgba(16, 22, 34, 0.78), rgba(11, 17, 28, 0.58))',
    boxShadow: '0 22px 60px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.14)'
  },
  panelTitle: { margin: 0, fontSize: '1.05rem', letterSpacing: 0, fontWeight: 850, textShadow: '0 0 18px currentColor' },
  dropZone: {
    display: 'block',
    position: 'relative',
    height: '190px',
    border: '1px solid rgba(210, 236, 255, 0.16)',
    borderTop: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: '14px',
    overflow: 'hidden',
    cursor: 'pointer',
    background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(110, 231, 255, 0.05)), rgba(9, 14, 23, 0.74)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 14px 34px rgba(0, 0, 0, 0.28)'
  },
  waveform: { width: '100%', height: '180px', display: 'block', borderRadius: '12px' },
  dropText: { position: 'absolute', left: '0.85rem', top: '0.8rem', color: '#e5ecfa', fontSize: '0.78rem', fontWeight: 760, textShadow: '0 1px 8px rgba(0, 0, 0, 0.44)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.85rem' },
  control: {
    display: 'grid',
    gap: '0.45rem',
    padding: '0.8rem',
    border: '1px solid rgba(210, 236, 255, 0.13)',
    borderTop: '1px solid rgba(255, 255, 255, 0.16)',
    borderRadius: '12px',
    background: 'linear-gradient(145deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.035))',
    boxShadow: '0 10px 24px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
    fontSize: '0.75rem',
    color: '#b9c5d8'
  },
  input: { minHeight: '36px', borderRadius: '10px', border: '1px solid rgba(210, 236, 255, 0.16)', background: 'rgba(3, 7, 13, 0.68)', color: '#f5f8ff', padding: '0 0.65rem', boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.06)' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '0.6rem', alignItems: 'center' },
  button: {
    minHeight: '40px',
    padding: '0 0.9rem',
    borderRadius: '11px',
    border: '1px solid rgba(210, 236, 255, 0.16)',
    background: 'linear-gradient(145deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.045))',
    color: '#eef4ff',
    cursor: 'pointer',
    fontWeight: 760,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 10px 22px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.12)',
    transition: 'background 140ms ease, border-color 140ms ease, transform 90ms ease, opacity 120ms ease, box-shadow 140ms ease, color 140ms ease'
  },
  primaryButton: {
    minHeight: '42px',
    padding: '0 1rem',
    borderRadius: '11px',
    border: '1px solid rgba(110, 231, 255, 0.62)',
    background: 'linear-gradient(135deg, rgba(110, 231, 255, 0.23), rgba(124, 255, 201, 0.13))',
    color: '#dffcff',
    cursor: 'pointer',
    fontWeight: 850,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 14px 32px rgba(110, 231, 255, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.18)',
    transition: 'background 140ms ease, border-color 140ms ease, transform 90ms ease, opacity 120ms ease, box-shadow 140ms ease'
  },
  dangerButton: {
    minHeight: '42px',
    padding: '0 1rem',
    borderRadius: '11px',
    border: '1px solid rgba(255, 107, 122, 0.62)',
    background: 'linear-gradient(135deg, rgba(255, 107, 122, 0.24), rgba(255, 111, 207, 0.1))',
    color: '#ffd9de',
    cursor: 'pointer',
    fontWeight: 850,
    boxShadow: '0 14px 32px rgba(255, 107, 122, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.18)',
    transition: 'background 140ms ease, border-color 140ms ease, transform 90ms ease, opacity 120ms ease, box-shadow 140ms ease'
  },
  buttonHover: { background: 'linear-gradient(145deg, rgba(255, 255, 255, 0.14), rgba(110, 231, 255, 0.08))', border: '1px solid rgba(210, 236, 255, 0.34)', boxShadow: '0 14px 28px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.16)' },
  buttonActive: { transform: 'translateY(1px) scale(0.99)', background: 'rgba(255, 255, 255, 0.065)' },
  buttonDisabled: { opacity: 0.45, cursor: 'not-allowed', transform: 'none' },
  statusSuccess: { padding: '0.7rem 0.85rem', border: '1px solid rgba(124, 255, 201, 0.42)', borderRadius: '12px', background: 'rgba(19, 63, 48, 0.58)', color: '#b7ffe3', fontSize: '0.82rem', boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.1)' },
  statusError: { padding: '0.7rem 0.85rem', border: '1px solid rgba(255, 107, 122, 0.48)', borderRadius: '12px', background: 'rgba(70, 18, 28, 0.6)', color: '#ffd3d8', fontSize: '0.82rem', boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.1)' },
  statusInfo: { padding: '0.7rem 0.85rem', border: '1px solid rgba(110, 231, 255, 0.38)', borderRadius: '12px', background: 'rgba(20, 48, 70, 0.56)', color: '#c9f6ff', fontSize: '0.82rem', boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.1)' }
};
