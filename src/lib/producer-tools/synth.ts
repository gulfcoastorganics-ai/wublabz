export type LfoShape = 'sine' | 'tri' | 'square' | 'saw';
export type WobbleMode = 'sync' | 'free';
export type SyncDivision = '1/4' | '1/8' | '1/8.' | '1/16';
export type DriveType = 'soft' | 'hard' | 'foldback';
export type ProducerOscillatorType = 'sine' | 'square' | 'sawtooth' | 'triangle';

export const SPLIT_CROSSOVER_HZ = 180;
export const MAX_GROWL_VOICES = 6;

export interface GrowlPreset {
  osc1: ProducerOscillatorType;
  osc2: ProducerOscillatorType;
  detuneCents: number;
  cutoffHz: number;
  resonance: number;
  lfoShape: LfoShape;
  wobbleMode: WobbleMode;
  syncDivision: SyncDivision;
  freeHz: number;
  lfoDepth: number;
  drive: number;
  driveType: DriveType;
  subLevel: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  filterAttack: number;
  filterDecay: number;
  filterSustain: number;
  filterRelease: number;
  bpm: number;
}

export const DEFAULT_GROWL_PRESET: GrowlPreset = {
  osc1: 'sawtooth',
  osc2: 'square',
  detuneCents: 12,
  cutoffHz: 520,
  resonance: 14,
  lfoShape: 'sine',
  wobbleMode: 'sync',
  syncDivision: '1/8',
  freeHz: 4,
  lfoDepth: 0.7,
  drive: 0.45,
  driveType: 'soft',
  subLevel: 0.7,
  attack: 0.01,
  decay: 0.18,
  sustain: 0.58,
  release: 0.16,
  filterAttack: 0.04,
  filterDecay: 0.2,
  filterSustain: 0.35,
  filterRelease: 0.12,
  bpm: 140
};

const DIVISION_BEATS: Record<SyncDivision, number> = {
  '1/4': 1,
  '1/8': 0.5,
  '1/8.': 0.75,
  '1/16': 0.25
};

export function lfoSyncHz(bpm: number, division: SyncDivision): number {
  const beats = DIVISION_BEATS[division];
  return bpm > 0 ? 1 / ((60 / bpm) * beats) : 0;
}

export function resolveLfoHz(preset: GrowlPreset, engineBpm?: number): number {
  if (preset.wobbleMode === 'free') {
    return Math.max(0.01, preset.freeHz);
  }
  return lfoSyncHz(engineBpm ?? preset.bpm, preset.syncDivision);
}

export interface AdsrStageTimes {
  attackEnd: number;
  decayEnd: number;
  releaseEnd: number;
}

export function resolveAdsrStageTimes(startTime: number, attack: number, decay: number, release: number, noteOffTime = startTime): AdsrStageTimes {
  const attackEnd = startTime + Math.max(0, attack);
  const decayEnd = attackEnd + Math.max(0, decay);
  return {
    attackEnd,
    decayEnd,
    releaseEnd: noteOffTime + Math.max(0, release)
  };
}

export function createDriveCurve(type: DriveType, amount: number, samples = 2048): Float32Array {
  const drive = Math.max(0, amount);
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = applyDrive(x, type, drive);
  }
  return curve;
}

export function applyDrive(sample: number, type: DriveType, amount: number): number {
  const k = 1 + amount * 24;
  if (type === 'hard') {
    const limit = Math.max(0.05, 1 - amount * 0.75);
    return Math.max(-limit, Math.min(limit, sample * k)) / limit;
  }
  if (type === 'foldback') {
    const threshold = Math.max(0.08, 1 - amount * 0.82);
    let x = sample * k;
    if (Math.abs(x) > threshold) {
      x = Math.abs(Math.abs((x - threshold) % (threshold * 4)) - threshold * 2) - threshold;
    }
    return Math.max(-1, Math.min(1, x / threshold));
  }
  return Math.tanh(sample * k);
}

export function randomGrowlPreset(seed: string | number, base: GrowlPreset = DEFAULT_GROWL_PRESET): GrowlPreset {
  const rng = createPresetRng(seed);
  const waves: ProducerOscillatorType[] = ['sawtooth', 'square', 'triangle'];
  const divisions: SyncDivision[] = ['1/4', '1/8', '1/8.', '1/16'];
  const drives: DriveType[] = ['soft', 'hard', 'foldback'];
  return {
    ...base,
    osc1: waves[Math.floor(rng() * waves.length)],
    osc2: waves[Math.floor(rng() * waves.length)],
    detuneCents: Math.round(2 + rng() * 34),
    cutoffHz: Math.round(180 + rng() * 1420),
    resonance: Math.round(4 + rng() * 24),
    lfoShape: (['sine', 'tri', 'square', 'saw'] as LfoShape[])[Math.floor(rng() * 4)],
    syncDivision: divisions[Math.floor(rng() * divisions.length)],
    freeHz: Number((0.5 + rng() * 11).toFixed(2)),
    lfoDepth: Number((0.35 + rng() * 0.6).toFixed(2)),
    drive: Number((0.2 + rng() * 0.75).toFixed(2)),
    driveType: drives[Math.floor(rng() * drives.length)],
    subLevel: Number((0.45 + rng() * 0.5).toFixed(2)),
    attack: Number((0.005 + rng() * 0.08).toFixed(3)),
    decay: Number((0.08 + rng() * 0.35).toFixed(3)),
    sustain: Number((0.35 + rng() * 0.45).toFixed(2)),
    release: Number((0.08 + rng() * 0.35).toFixed(3)),
    filterAttack: Number((0.015 + rng() * 0.1).toFixed(3)),
    filterDecay: Number((0.08 + rng() * 0.35).toFixed(3)),
    filterSustain: Number((0.25 + rng() * 0.5).toFixed(2)),
    filterRelease: Number((0.06 + rng() * 0.28).toFixed(3))
  };
}

function createPresetRng(seed: string | number): () => number {
  let x = 0;
  for (const char of String(seed)) {
    x = Math.imul(31, x) + char.charCodeAt(0) | 0;
  }
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 4294967296);
  };
}
