import React, { useMemo, useRef, useState } from 'react';
import { decodeProducerAudio, toChannelBuffer } from '../lib/audio/ProducerAudioEngine';
import { renderBufferToWav } from '../lib/export/AudioRenderExport';
import { playRenderedBuffer, stopRenderedBuffer } from '../lib/playback/ProducerPlayback';
import { renderMangledBuffer, type ChannelBuffer } from '../lib/producer-tools/mangler';

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
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const active = rendered ?? source;
  useMemo(() => drawWaveform(canvasRef.current, active, slices), [active, slices]);

  async function load(file?: File) {
    if (!file) return;
    const decoded = await decodeProducerAudio(await file.arrayBuffer());
    setSource(toChannelBuffer(decoded));
    setRendered(null);
    setFileName(file.name);
  }

  function mangle(nextSeed = seed) {
    if (!source) return;
    setRendered(renderMangledBuffer(source, { slices, glitch, pitchSemitones: pitch, crossfadeMs, gain, seed: nextSeed }));
  }

  function reroll() {
    const nextSeed = `${seed}-${Date.now().toString(36)}`;
    setSeed(nextSeed);
    mangle(nextSeed);
  }

  function exportWav() {
    if (!active) return;
    const stem = fileName.replace(/\.[^.]+$/, '') || 'loop';
    const wav = renderBufferToWav(`${stem}-mangled.wav`, active);
    downloadBytes(wav.bytes, wav.fileName, wav.mimeType);
  }

  return (
    <ToolPanel title="Sample Mangler" tone="#00ff99">
      <label style={styles.dropZone}>
        <input type="file" accept="audio/*" onChange={(event) => void load(event.target.files?.[0])} style={{ display: 'none' }} />
        <canvas ref={canvasRef} style={styles.waveform} />
        <span style={styles.dropText}>{fileName || 'Drop in an audio loop'}</span>
      </label>
      <div style={styles.grid}>
        <Range label="GLITCH" value={glitch} min={0} max={1} step={0.01} onChange={setGlitch} />
        <Range label="SLICES" value={slices} min={2} max={32} step={1} onChange={setSlices} />
        <Range label="PITCH" value={pitch} min={-12} max={12} step={1} onChange={setPitch} />
        <Range label="CROSSFADE MS" value={crossfadeMs} min={0} max={20} step={1} onChange={setCrossfadeMs} />
        <Range label="GAIN" value={gain} min={0.1} max={1.5} step={0.01} onChange={setGain} />
        <label style={styles.control}>
          <span>SEED</span>
          <input value={seed} onChange={(event) => setSeed(event.target.value)} style={styles.input} />
        </label>
      </div>
      <div style={styles.actions}>
        <button style={styles.primaryButton} disabled={!source} onClick={() => mangle()}>Mangle</button>
        <button style={styles.button} disabled={!source} onClick={reroll}>Reroll</button>
        <button style={styles.button} disabled={!active} onClick={() => active && playRenderedBuffer(active)}>Play</button>
        <button style={styles.button} onClick={stopRenderedBuffer}>Stop</button>
        <button style={styles.button} disabled={!active} onClick={exportWav}>Export WAV</button>
      </div>
    </ToolPanel>
  );
}

function drawWaveform(canvas: HTMLCanvasElement | null, buffer: ChannelBuffer | null, slices: number) {
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
  for (let i = 1; i < slices; i++) {
    const x = (rect.width / slices) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, rect.height);
    ctx.stroke();
  }
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

export function ToolPanel({ title, tone, children }: { title: string; tone: string; children: React.ReactNode }) {
  return (
    <section style={styles.panel}>
      <h2 style={{ ...styles.panelTitle, color: tone }}>{title}</h2>
      {children}
    </section>
  );
}

export const styles: Record<string, React.CSSProperties> = {
  panel: { padding: '1rem', color: '#f6f6f6' },
  panelTitle: { margin: '0 0 1rem', fontSize: '1rem', letterSpacing: 0 },
  dropZone: { display: 'block', position: 'relative', height: '180px', border: '1px solid #333', borderRadius: '4px', overflow: 'hidden', cursor: 'pointer', background: '#181818' },
  waveform: { width: '100%', height: '180px', display: 'block' },
  dropText: { position: 'absolute', left: '0.75rem', top: '0.75rem', color: '#d8d8d8', fontSize: '0.8rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginTop: '1rem' },
  control: { display: 'grid', gap: '0.35rem', padding: '0.75rem', border: '1px solid #2b2b2b', borderRadius: '4px', background: '#151515', fontSize: '0.75rem', color: '#bdbdbd' },
  input: { minHeight: '32px', borderRadius: '4px', border: '1px solid #333', background: '#0d0d0d', color: '#fff', padding: '0 0.5rem' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '1rem' },
  button: { minHeight: '38px', padding: '0 0.75rem', borderRadius: '4px', border: '1px solid #444', background: '#1c1c1c', color: '#f2f2f2', cursor: 'pointer' },
  primaryButton: { minHeight: '38px', padding: '0 0.75rem', borderRadius: '4px', border: '1px solid #00ff99', background: '#10261d', color: '#00ff99', cursor: 'pointer' }
};
