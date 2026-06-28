import React, { useEffect, useRef, useState } from 'react';
import { createGrowlVoice } from '../lib/audio/GrowlVoiceGraph';
import { getProducerAnalyser, getProducerAudioContext, toChannelBuffer } from '../lib/audio/ProducerAudioEngine';
import { renderBufferToWav } from '../lib/export/AudioRenderExport';
import { saveProducerPreset, loadProducerPreset } from '../lib/persistence/ProducerPresetPersistence';
import { DEFAULT_GROWL_PRESET, MAX_GROWL_VOICES, randomGrowlPreset, resolveLfoHz, type DriveType, type GrowlPreset, type LfoShape, type SyncDivision } from '../lib/producer-tools/synth';
import { WubLabzEngine } from '../lib/WubLabzEngine';
import { styles, toArrayBuffer, ToolPanel } from './SampleManglerView';

const PRESET_KEY = 'wublabz:bass-synth:preset';
const NOTES = [
  ['A', 55], ['W', 58.27], ['S', 61.74], ['E', 65.41], ['D', 73.42], ['F', 82.41],
  ['T', 87.31], ['G', 98], ['Y', 103.83], ['H', 110], ['U', 116.54], ['J', 123.47]
] as const;

export function BassSynthView() {
  const [preset, setPreset] = useState<GrowlPreset>(() => loadProducerPreset(PRESET_KEY, DEFAULT_GROWL_PRESET));
  const [engine] = useState(() => new WubLabzEngine());
  const voicesRef = useRef(new Map<number, ReturnType<typeof createGrowlVoice>>());
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    engine.setBpm(preset.bpm);
  }, [engine, preset.bpm]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const note = NOTES.find(([key]) => key.toLowerCase() === event.key.toLowerCase());
      if (note && !event.repeat) play(note[1]);
    };
    const up = (event: KeyboardEvent) => {
      const note = NOTES.find(([key]) => key.toLowerCase() === event.key.toLowerCase());
      if (note) stop(note[1]);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      drawSpectrum(canvasRef.current, getProducerAnalyser());
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, []);

  function patch(change: Partial<GrowlPreset>) {
    setPreset((current) => ({ ...current, ...change }));
  }

  function play(freq: number) {
    stop(freq);
    const context = getProducerAudioContext();
    const voice = createGrowlVoice(context, preset, freq, getProducerAnalyser(), engine.getBpm());
    voice.start();
    voicesRef.current.set(freq, voice);
    while (voicesRef.current.size > MAX_GROWL_VOICES) {
      const oldest = voicesRef.current.keys().next().value;
      if (typeof oldest === 'number') stop(oldest);
      else break;
    }
  }

  function stop(freq?: number) {
    if (freq === undefined) {
      for (const [activeFreq, voice] of voicesRef.current) {
        voice.stop();
        voicesRef.current.delete(activeFreq);
      }
      return;
    }

    const voice = voicesRef.current.get(freq);
    voice?.stop();
    voicesRef.current.delete(freq);
  }

  async function exportOneShot() {
    const OfflineCtor = (globalThis as any).OfflineAudioContext;
    const holdSeconds = 2;
    const tailSeconds = Math.max(preset.release, preset.filterRelease) + 0.25;
    const offline = new OfflineCtor(2, Math.ceil(44100 * (holdSeconds + tailSeconds)), 44100);
    const voice = createGrowlVoice(offline, preset, 55, offline.destination, engine.getBpm());
    voice.start(0);
    voice.stop(holdSeconds);
    const audioBuffer = await offline.startRendering();
    const wav = renderBufferToWav('wublabz-growl.wav', toChannelBuffer(audioBuffer));
    const url = URL.createObjectURL(new Blob([toArrayBuffer(wav.bytes)], { type: wav.mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = wav.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <ToolPanel title="Bass Synth" tone="#00cfff">
      <canvas ref={canvasRef} style={{ ...styles.waveform, height: 150, background: '#111', border: '1px solid #333', borderRadius: '4px' }} />
      <div style={styles.grid}>
        <Range label="CUTOFF" value={preset.cutoffHz} min={120} max={2200} step={10} onChange={(cutoffHz) => patch({ cutoffHz })} />
        <Range label="RESONANCE" value={preset.resonance} min={1} max={30} step={1} onChange={(resonance) => patch({ resonance })} />
        <Range label="LFO DEPTH" value={preset.lfoDepth} min={0} max={1} step={0.01} onChange={(lfoDepth) => patch({ lfoDepth })} />
        <Range label="DRIVE" value={preset.drive} min={0} max={1} step={0.01} onChange={(drive) => patch({ drive })} />
        <Range label="SUB" value={preset.subLevel} min={0} max={1} step={0.01} onChange={(subLevel) => patch({ subLevel })} />
        <Range label="BPM" value={preset.bpm} min={70} max={180} step={1} onChange={(bpm) => patch({ bpm })} />
        <Range label="FREE HZ" value={preset.freeHz} min={0.1} max={14} step={0.1} onChange={(freeHz) => patch({ freeHz })} />
        <Range label="A" value={preset.attack} min={0.001} max={0.3} step={0.001} onChange={(attack) => patch({ attack })} />
        <Range label="D" value={preset.decay} min={0.01} max={0.8} step={0.01} onChange={(decay) => patch({ decay })} />
        <Range label="S" value={preset.sustain} min={0.05} max={1} step={0.01} onChange={(sustain) => patch({ sustain })} />
        <Range label="R" value={preset.release} min={0.02} max={1} step={0.01} onChange={(release) => patch({ release })} />
        <Range label="FILTER A" value={preset.filterAttack} min={0.001} max={0.4} step={0.001} onChange={(filterAttack) => patch({ filterAttack })} />
        <Range label="FILTER D" value={preset.filterDecay} min={0.01} max={1} step={0.01} onChange={(filterDecay) => patch({ filterDecay })} />
        <Range label="FILTER S" value={preset.filterSustain} min={0.05} max={1} step={0.01} onChange={(filterSustain) => patch({ filterSustain })} />
        <Range label="FILTER R" value={preset.filterRelease} min={0.02} max={1} step={0.01} onChange={(filterRelease) => patch({ filterRelease })} />
      </div>
      <div style={styles.actions}>
        <Select label="MODE" value={preset.wobbleMode} values={['sync', 'free']} onChange={(wobbleMode) => patch({ wobbleMode })} />
        <Select label="LFO" value={preset.lfoShape} values={['sine', 'tri', 'square', 'saw']} onChange={(lfoShape) => patch({ lfoShape })} />
        <Select label="SYNC" value={preset.syncDivision} values={['1/4', '1/8', '1/8.', '1/16']} onChange={(syncDivision) => patch({ syncDivision })} />
        <Select label="DRIVE TYPE" value={preset.driveType} values={['soft', 'hard', 'foldback']} onChange={(driveType) => patch({ driveType })} />
        <span style={{ ...styles.control, minWidth: 150 }}>LFO HZ <strong>{resolveLfoHz(preset, engine.getBpm()).toFixed(2)}</strong></span>
      </div>
      <div style={styles.actions}>
        {NOTES.map(([key, freq]) => <button key={key} style={styles.button} onMouseDown={() => play(freq)} onMouseUp={() => stop(freq)}>{key}</button>)}
      </div>
      <div style={styles.actions}>
        <button style={styles.primaryButton} onClick={() => setPreset(randomGrowlPreset(Date.now(), preset))}>Randomize Growl</button>
        <button style={styles.button} onClick={() => saveProducerPreset(PRESET_KEY, preset)}>Save Preset</button>
        <button style={styles.button} onClick={() => setPreset(loadProducerPreset(PRESET_KEY, DEFAULT_GROWL_PRESET))}>Load Preset</button>
        <button style={styles.button} onClick={() => void exportOneShot()}>Export One-Shot</button>
      </div>
    </ToolPanel>
  );
}

function Range({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label style={styles.control}>
      <span>{label}</span>
      <strong>{value < 10 ? value.toFixed(2) : Math.round(value)}</strong>
      <input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Select<T extends string>({ label, value, values, onChange }: { label: string; value: T; values: readonly T[]; onChange: (value: T) => void }) {
  return (
    <label style={styles.control}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)} style={styles.input}>
        {values.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
      </select>
    </label>
  );
}

function drawSpectrum(canvas: HTMLCanvasElement | null, analyser: AnalyserNode) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(bins);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = '#101010';
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = '#00cfff';
  const bars = 72;
  for (let i = 0; i < bars; i++) {
    const value = bins[Math.floor((i / bars) * bins.length)] / 255;
    ctx.fillRect(i * (rect.width / bars), rect.height - value * rect.height, rect.width / bars - 1, value * rect.height);
  }
}
