import React, { useEffect, useRef, useState } from 'react';
import { createGrowlVoice } from '../lib/audio/GrowlVoiceGraph';
import { getProducerAnalyser, getProducerAudioContext, toChannelBuffer } from '../lib/audio/ProducerAudioEngine';
import { renderBufferToWav } from '../lib/export/AudioRenderExport';
import { saveProducerPreset, loadProducerPreset } from '../lib/persistence/ProducerPresetPersistence';
import { DEFAULT_GROWL_PRESET, MAX_GROWL_VOICES, STARTER_GROWL_PRESETS, normalizeGrowlPreset, randomGrowlPreset, resolveLfoHz, type DriveType, type GrowlPreset, type LfoShape, type SyncDivision } from '../lib/producer-tools/synth';
import { WubLabzEngine } from '../lib/WubLabzEngine';
import { ActionButton, StatusMessage, styles, toArrayBuffer, ToolPanel } from './SampleManglerView';

const PRESET_KEY = 'wublabz:bass-synth:preset';
const NOTES = [
  ['A', 55], ['W', 58.27], ['S', 61.74], ['E', 65.41], ['D', 73.42], ['F', 82.41],
  ['T', 87.31], ['G', 98], ['Y', 103.83], ['H', 110], ['U', 116.54], ['J', 123.47]
] as const;
const MAX_LATCHED_WOBBLES = 3;
const DOUBLE_TAP_MS = 320;
const QUICK_HIT_SECONDS = 0.18;

type ActiveVoice = {
  voice: ReturnType<typeof createGrowlVoice>;
  latched: boolean;
};

type PressState = {
  key: string;
  freq: number;
  startedAt: number;
  latched: boolean;
  timer: ReturnType<typeof setTimeout>;
};

export function BassSynthView() {
  const [preset, setPreset] = useState<GrowlPreset>(() => normalizeGrowlPreset(loadProducerPreset(PRESET_KEY, DEFAULT_GROWL_PRESET)));
  const [latchThresholdMs, setLatchThresholdMs] = useState(300);
  const [latchedNotes, setLatchedNotes] = useState<number[]>([]);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [engine] = useState(() => new WubLabzEngine());
  const voicesRef = useRef(new Map<number, ActiveVoice>());
  const pressesRef = useRef(new Map<string, PressState>());
  const lastTapRef = useRef(new Map<string, number>());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const presetRef = useRef(preset);
  const activeCountRef = useRef(0);

  presetRef.current = preset;
  activeCountRef.current = voicesRef.current.size;

  useEffect(() => {
    engine.setBpm(preset.bpm);
    updateRunningVoices(preset);
  }, [engine, preset.bpm]);

  useEffect(() => {
    updateRunningVoices(preset);
  }, [preset]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || event.repeat) return;
      const note = NOTES.find(([key]) => key.toLowerCase() === event.key.toLowerCase());
      if (!note) return;
      event.preventDefault();
      beginPress(note[0], note[1]);
    };
    const up = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const note = NOTES.find(([key]) => key.toLowerCase() === event.key.toLowerCase());
      if (!note) return;
      event.preventDefault();
      endPress(note[0]);
    };
    const blur = () => {
      cancelPresses();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  });

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      drawSpectrum(canvasRef.current, getProducerAnalyser(), presetRef.current, engine.getBpm(), activeCountRef.current > 0);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, []);

  function patch(change: Partial<GrowlPreset>) {
    setPreset((current) => normalizeGrowlPreset({ ...current, ...change }));
  }

  function updateRunningVoices(nextPreset: GrowlPreset) {
    for (const active of voicesRef.current.values()) {
      active.voice.updatePreset(nextPreset, engine.getBpm());
    }
  }

  function startVoice(freq: number, latched: boolean) {
    stop(freq);
    const context = getProducerAudioContext();
    const previousLatchedFreq = latched ? latchedNotes.at(-1) : undefined;
    const voice = createGrowlVoice(context, preset, freq, getProducerAnalyser(), engine.getBpm(), {
      startFrequencyHz: previousLatchedFreq
    });
    voice.start();
    voicesRef.current.set(freq, { voice, latched });
    syncLatchedNotes();
    limitVoices();
  }

  function beginPress(key: string, freq: number) {
    if (pressesRef.current.has(key)) return;
    const now = Date.now();
    const lastTap = lastTapRef.current.get(key) ?? 0;
    const active = voicesRef.current.get(freq);
    lastTapRef.current.set(key, now);
    if (active?.latched) {
      if (now - lastTap <= DOUBLE_TAP_MS) {
        stop(freq);
      }
      return;
    }
    if (now - lastTap <= DOUBLE_TAP_MS) {
      stop(freq);
      return;
    }

    startVoice(freq, false);
    const press: PressState = {
      key,
      freq,
      startedAt: now,
      latched: false,
      timer: setTimeout(() => latchNote(key, freq), latchThresholdMs)
    };
    pressesRef.current.set(key, press);
  }

  function endPress(key: string) {
    const press = pressesRef.current.get(key);
    if (!press) return;
    clearTimeout(press.timer);
    pressesRef.current.delete(key);
    if (press.latched) return;
    const heldMs = Date.now() - press.startedAt;
    const releaseDelayMs = Math.max(0, QUICK_HIT_SECONDS * 1000 - heldMs);
    setTimeout(() => {
      if (!voicesRef.current.get(press.freq)?.latched) stop(press.freq);
    }, releaseDelayMs);
  }

  function latchNote(key: string, freq: number) {
    const press = pressesRef.current.get(key);
    if (!press) return;
    press.latched = true;
    const previousLatchedFreq = latchedNotes.at(-1);
    if (previousLatchedFreq && preset.glideSeconds > 0) {
      stop(freq, 0.01);
      const voice = createGrowlVoice(getProducerAudioContext(), preset, freq, getProducerAnalyser(), engine.getBpm(), {
        startFrequencyHz: previousLatchedFreq
      });
      voice.start();
      voicesRef.current.set(freq, { voice, latched: true });
    } else {
      voicesRef.current.set(freq, { voice: voicesRef.current.get(freq)?.voice ?? createAndStartVoice(freq), latched: true });
    }
    syncLatchedNotes();
    limitVoices();
  }

  function createAndStartVoice(freq: number) {
    const context = getProducerAudioContext();
    const voice = createGrowlVoice(context, preset, freq, getProducerAnalyser(), engine.getBpm(), {
      startFrequencyHz: latchedNotes.at(-1)
    });
    voice.start();
    return voice;
  }

  function limitVoices() {
    const latched = [...voicesRef.current.entries()].filter(([, active]) => active.latched);
    while (latched.length > MAX_LATCHED_WOBBLES) {
      const [oldestFreq] = latched.shift()!;
      stop(oldestFreq);
    }
    while (voicesRef.current.size > MAX_GROWL_VOICES) {
      const oldest = [...voicesRef.current.entries()].find(([, active]) => !active.latched)?.[0] ?? voicesRef.current.keys().next().value;
      if (typeof oldest === 'number') stop(oldest);
      else break;
    }
  }

  function stop(freq?: number, releaseSeconds?: number) {
    if (freq === undefined) {
      for (const [activeFreq, voice] of voicesRef.current) {
        voice.voice.stop(undefined, releaseSeconds);
        voicesRef.current.delete(activeFreq);
      }
      syncLatchedNotes();
      return;
    }

    const active = voicesRef.current.get(freq);
    active?.voice.stop(undefined, releaseSeconds);
    voicesRef.current.delete(freq);
    syncLatchedNotes();
  }

  function cancelPresses() {
    for (const press of pressesRef.current.values()) {
      clearTimeout(press.timer);
      if (!press.latched) stop(press.freq);
    }
    pressesRef.current.clear();
  }

  function panicStop() {
    cancelPresses();
    stop(undefined, 0.015);
    setStatus({ tone: 'info', message: 'All latched notes stopped.' });
  }

  function syncLatchedNotes() {
    setLatchedNotes([...voicesRef.current.entries()].filter(([, active]) => active.latched).map(([freq]) => freq));
  }

  async function exportOneShot() {
    setExporting(true);
    const OfflineCtor = (globalThis as any).OfflineAudioContext;
    try {
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
      setStatus({ tone: 'success', message: `Exported ${wav.fileName}` });
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : 'Export failed' });
    } finally {
      setExporting(false);
    }
  }

  return (
    <ToolPanel title="Bass Synth" tone="#ff2b3d">
      <canvas ref={canvasRef} className="wub-canvas-frame" style={{ ...styles.waveform, height: 150, background: 'rgba(13, 8, 9, 0.86)', border: '1px solid rgba(255, 214, 219, 0.14)', borderRadius: '14px' }} />
      <div style={styles.actions}>
        <ActionButton variant="danger" onClick={panicStop}>STOP ALL</ActionButton>
        <span style={{ ...styles.control, minWidth: 150 }}>LFO HZ <strong>{resolveLfoHz(preset, engine.getBpm()).toFixed(2)}</strong></span>
        <span style={{ ...styles.control, minWidth: 150 }}>LATCHED <strong>{latchedNotes.length}/{MAX_LATCHED_WOBBLES}</strong></span>
      </div>

      <div style={styles.grid}>
        <Range label="HOLD MS" value={latchThresholdMs} min={100} max={1000} step={50} onChange={(value) => setLatchThresholdMs(Math.round(value))} />
        <Range label="GLIDE MS" value={(preset.glideSeconds ?? DEFAULT_GROWL_PRESET.glideSeconds) * 1000} min={0} max={350} step={5} onChange={(glideMs) => patch({ glideSeconds: glideMs / 1000 })} />
        <Range label="CUTOFF" value={preset.cutoffHz} min={120} max={2200} step={10} onChange={(cutoffHz) => patch({ cutoffHz })} />
        <Range label="RESONANCE" value={preset.resonance} min={1} max={30} step={1} onChange={(resonance) => patch({ resonance })} />
        <Range label="ENV AMT" value={preset.filterEnvelopeAmount ?? DEFAULT_GROWL_PRESET.filterEnvelopeAmount} min={0} max={1} step={0.01} onChange={(filterEnvelopeAmount) => patch({ filterEnvelopeAmount })} />
        <Range label="KEY TRACK" value={preset.keyTrack ?? DEFAULT_GROWL_PRESET.keyTrack} min={0} max={1} step={0.01} onChange={(keyTrack) => patch({ keyTrack })} />
        <Range label="FORMANT" value={preset.formantAmount ?? DEFAULT_GROWL_PRESET.formantAmount} min={0} max={1} step={0.01} onChange={(formantAmount) => patch({ formantAmount })} />
        <Range label="LFO DEPTH" value={preset.lfoDepth} min={0} max={1} step={0.01} onChange={(lfoDepth) => patch({ lfoDepth })} />
        <Range label="LFO 2" value={preset.secondLfoDepth ?? DEFAULT_GROWL_PRESET.secondLfoDepth} min={0} max={0.6} step={0.01} onChange={(secondLfoDepth) => patch({ secondLfoDepth })} />
        <Range label="LFO 2 HZ" value={preset.secondLfoHz ?? DEFAULT_GROWL_PRESET.secondLfoHz} min={0.05} max={3} step={0.01} onChange={(secondLfoHz) => patch({ secondLfoHz })} />
        <Range label="DRIVE" value={preset.drive} min={0} max={1} step={0.01} onChange={(drive) => patch({ drive })} />
        <Range label="SUB" value={preset.subLevel} min={0} max={1} step={0.01} onChange={(subLevel) => patch({ subLevel })} />
        <Range label="SPREAD" value={preset.detuneSpreadCents ?? DEFAULT_GROWL_PRESET.detuneSpreadCents} min={0} max={24} step={1} onChange={(detuneSpreadCents) => patch({ detuneSpreadCents })} />
        <Range label="UNISON" value={preset.unisonVoices ?? DEFAULT_GROWL_PRESET.unisonVoices} min={1} max={4} step={1} onChange={(unisonVoices) => patch({ unisonVoices: Math.round(unisonVoices) })} />
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
        <Select label="LFO" value={preset.lfoShape === 'saw' ? 'ramp' : preset.lfoShape} values={['sine', 'tri', 'square', 'ramp', 'pulse', 'talk']} onChange={(lfoShape) => patch({ lfoShape })} />
        <Select label="SYNC" value={preset.syncDivision} values={['1/4', '1/8', '1/8.', '1/8T', '1/16', '1/16T']} onChange={(syncDivision) => patch({ syncDivision })} />
        <Select label="DRIVE TYPE" value={preset.driveType} values={['soft', 'hard', 'foldback']} onChange={(driveType) => patch({ driveType })} />
      </div>
      <div style={styles.actions}>
        {NOTES.map(([key, freq]) => (
          <ActionButton
            key={key}
            style={{
              minWidth: 54,
              minHeight: 50,
              border: latchedNotes.includes(freq) ? '1px solid rgba(255, 43, 61, 0.78)' : undefined,
              color: latchedNotes.includes(freq) ? '#fff4f5' : undefined,
              background: latchedNotes.includes(freq) ? 'linear-gradient(135deg, rgba(224, 16, 48, 0.34), rgba(255, 43, 61, 0.16))' : undefined,
              boxShadow: latchedNotes.includes(freq) ? '0 0 0 1px rgba(255, 43, 61, 0.14), 0 0 24px rgba(255, 43, 61, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.2)' : undefined
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture?.(event.pointerId);
              beginPress(key, freq);
            }}
            onPointerUp={() => endPress(key)}
            onPointerCancel={() => endPress(key)}
            onDoubleClick={() => stop(freq)}
          >
            {key}
          </ActionButton>
        ))}
      </div>
      <div style={styles.actions}>
        {STARTER_GROWL_PRESETS.map((entry) => (
          <ActionButton key={entry.name} onClick={() => {
            setPreset(normalizeGrowlPreset(entry.preset));
            setStatus({ tone: 'success', message: `Loaded starter preset: ${entry.name}.` });
          }}>{entry.name}</ActionButton>
        ))}
      </div>
      <div style={styles.actions}>
        <ActionButton variant="primary" onClick={() => {
          setPreset(normalizeGrowlPreset(randomGrowlPreset(Date.now(), preset)));
          setStatus({ tone: 'success', message: 'Randomized growl preset.' });
        }}>Randomize Growl</ActionButton>
        <ActionButton onClick={() => {
          const saved = saveProducerPreset(PRESET_KEY, normalizeGrowlPreset(preset));
          setStatus(saved
            ? { tone: 'success', message: 'Preset saved to localStorage.' }
            : { tone: 'error', message: 'Preset storage is unavailable in this browser context.' });
        }}>Save Preset</ActionButton>
        <ActionButton onClick={() => {
          setPreset(normalizeGrowlPreset(loadProducerPreset(PRESET_KEY, DEFAULT_GROWL_PRESET)));
          setStatus({ tone: 'success', message: 'Preset loaded.' });
        }}>Load Preset</ActionButton>
        <ActionButton loading={exporting} onClick={() => void exportOneShot()}>Export One-Shot</ActionButton>
      </div>
      {status && <StatusMessage tone={status.tone}>{status.message}</StatusMessage>}
    </ToolPanel>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function Range({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label style={styles.control}>
      <span>{label}</span>
      <strong>{value < 10 ? value.toFixed(2) : Math.round(value)}</strong>
      <input className="wub-slider" type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Select<T extends string>({ label, value, values, onChange }: { label: string; value: T; values: readonly T[]; onChange: (value: T) => void }) {
  return (
    <label style={styles.control}>
      <span>{label}</span>
      <select className="wub-control-select" value={value} onChange={(event) => onChange(event.target.value as T)} style={styles.input}>
        {values.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
      </select>
    </label>
  );
}

function drawSpectrum(canvas: HTMLCanvasElement | null, analyser: AnalyserNode, preset: GrowlPreset, bpm: number, active: boolean) {
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
  ctx.fillStyle = '#12070b';
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = '#ff2b3d';
  const bars = 72;
  for (let i = 0; i < bars; i++) {
    const value = bins[Math.floor((i / bars) * bins.length)] / 255;
    ctx.fillRect(i * (rect.width / bars), rect.height - value * rect.height, rect.width / bars - 1, value * rect.height);
  }
  const lfoHz = resolveLfoHz(preset, bpm);
  const phase = (performance.now() / 1000 * lfoHz) % 1;
  const lfoValue = lfoShapeValue(preset.lfoShape, phase);
  const x = phase * rect.width;
  const y = rect.height - lfoValue * rect.height;
  ctx.strokeStyle = active ? '#ffcc33' : 'rgba(255, 204, 51, 0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, rect.height);
  ctx.stroke();
  ctx.fillStyle = active ? '#ffcc33' : 'rgba(255, 204, 51, 0.45)';
  ctx.beginPath();
  ctx.arc(x, y, active ? 5 : 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d8d8d8';
  ctx.font = '11px sans-serif';
  ctx.fillText(`LFO ${preset.lfoShape} ${lfoHz.toFixed(2)}Hz`, 10, rect.height - 12);
}

function lfoShapeValue(shape: LfoShape, phase: number): number {
  if (shape === 'square' || shape === 'pulse') return phase < (shape === 'pulse' ? 0.35 : 0.5) ? 1 : 0.08;
  if (shape === 'tri') return phase < 0.5 ? phase * 2 : 2 - phase * 2;
  if (shape === 'ramp' || shape === 'saw') return phase;
  if (shape === 'talk') {
    if (phase < 0.25) return 0.2;
    if (phase < 0.5) return 0.72;
    if (phase < 0.75) return 0.38;
    return 1;
  }
  return 0.5 + Math.sin(phase * Math.PI * 2) * 0.5;
}
