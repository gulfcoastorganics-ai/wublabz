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
          <input value={seed} onChange={(event) => setSeed(event.target.value)} style={styles.input} />
        </label>
      </div>
      <div style={styles.grid}>
        <div style={styles.control}>
          <span>SELECTED SLICE</span>
          <strong>{selectedSlice + 1}/{slices}</strong>
          <input type="range" value={selectedSlice} min={0} max={Math.max(0, slices - 1)} step={1} onChange={(event) => setSelectedSlice(Number(event.target.value))} />
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
      <input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
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
    <section style={styles.panel}>
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
  panel: { padding: '1rem', color: '#f6f6f6', display: 'grid', gap: '1rem' },
  panelTitle: { margin: 0, fontSize: '1rem', letterSpacing: 0 },
  dropZone: { display: 'block', position: 'relative', height: '180px', border: '1px solid #333', borderRadius: '4px', overflow: 'hidden', cursor: 'pointer', background: '#181818' },
  waveform: { width: '100%', height: '180px', display: 'block' },
  dropText: { position: 'absolute', left: '0.75rem', top: '0.75rem', color: '#d8d8d8', fontSize: '0.8rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' },
  control: { display: 'grid', gap: '0.35rem', padding: '0.75rem', border: '1px solid #2b2b2b', borderRadius: '4px', background: '#151515', fontSize: '0.75rem', color: '#bdbdbd' },
  input: { minHeight: '32px', borderRadius: '4px', border: '1px solid #333', background: '#0d0d0d', color: '#fff', padding: '0 0.5rem' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' },
  button: { minHeight: '38px', padding: '0 0.85rem', borderRadius: '4px', border: '1px solid #4f4f4f', background: '#1c1c1c', color: '#f2f2f2', cursor: 'pointer', fontWeight: 700, transition: 'background 120ms ease, border-color 120ms ease, transform 80ms ease, opacity 120ms ease' },
  primaryButton: { minHeight: '40px', padding: '0 1rem', borderRadius: '4px', border: '1px solid #00ff99', background: '#10261d', color: '#00ff99', cursor: 'pointer', fontWeight: 800, transition: 'background 120ms ease, border-color 120ms ease, transform 80ms ease, opacity 120ms ease' },
  dangerButton: { minHeight: '40px', padding: '0 1rem', borderRadius: '4px', border: '1px solid #ff6b6b', background: '#2a1010', color: '#ff9a9a', cursor: 'pointer', fontWeight: 800, transition: 'background 120ms ease, border-color 120ms ease, transform 80ms ease, opacity 120ms ease' },
  buttonHover: { background: '#282828', border: '1px solid #777' },
  buttonActive: { transform: 'translateY(1px)', background: '#0f0f0f' },
  buttonDisabled: { opacity: 0.45, cursor: 'not-allowed', transform: 'none' },
  statusSuccess: { padding: '0.65rem 0.75rem', border: '1px solid #1f6f55', borderRadius: '4px', background: '#0d211a', color: '#9fffd8', fontSize: '0.8rem' },
  statusError: { padding: '0.65rem 0.75rem', border: '1px solid #7a3333', borderRadius: '4px', background: '#2a1010', color: '#ffb3b3', fontSize: '0.8rem' },
  statusInfo: { padding: '0.65rem 0.75rem', border: '1px solid #34566f', borderRadius: '4px', background: '#0f1b24', color: '#b9e6ff', fontSize: '0.8rem' }
};
