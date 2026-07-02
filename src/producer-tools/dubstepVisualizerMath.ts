// Pure signal-processing and rendering logic for DubstepVisualizer, kept out
// of the .tsx file so it can be unit tested under the plain-.ts tsconfig
// (tests/*.ts type-checks without JSX configured).

// Target ~30fps on CPU-only hardware instead of riding every display refresh
// (rAF can fire at 60-120Hz) — halves canvas work with no perceptible loss
// of smoothness for this kind of pulse/glow animation.
export const FRAME_INTERVAL_MS = 1000 / 30;

// Envelope smoothing per band: fast attack so hits feel immediate, slower
// release so the sub-bass pulse reads as weight rather than flicker.
const SUB_ATTACK = 0.6;
const SUB_RELEASE = 0.12;
const MID_ATTACK = 0.5;
const MID_RELEASE = 0.2;
const BROADBAND_ATTACK = 0.7;
const BROADBAND_RELEASE = 0.25;
export const TRANSIENT_THRESHOLD = 0.09;
export const SHOCKWAVE_LIFETIME_MS = 500;

export interface BandState {
  sub: number;
  mid: number;
  broadband: number;
  broadbandPrev: number;
  transient: number;
  shockwaves: Array<{ bornAt: number; strength: number }>;
}

export function freshBandState(): BandState {
  return { sub: 0, mid: 0, broadband: 0, broadbandPrev: 0, transient: 0, shockwaves: [] };
}

export function updateBandState(state: BandState, bins: Uint8Array, sampleRate: number, now: number, active: boolean): void {
  const binHz = sampleRate / (bins.length * 2);
  const subBand = bandAverage(bins, binHz, 30, 90);
  const midBand = bandAverage(bins, binHz, 90, 250);
  const broadband = bandAverage(bins, binHz, 250, sampleRate / 2);

  state.sub = envelope(state.sub, subBand, SUB_ATTACK, SUB_RELEASE);
  state.mid = envelope(state.mid, midBand, MID_ATTACK, MID_RELEASE);
  state.broadbandPrev = state.broadband;
  state.broadband = envelope(state.broadband, broadband, BROADBAND_ATTACK, BROADBAND_RELEASE);

  const delta = Math.max(0, state.broadband - state.broadbandPrev);
  state.transient = delta;
  if (active && delta > TRANSIENT_THRESHOLD) {
    state.shockwaves.push({ bornAt: now, strength: Math.min(1, delta * 3) });
  }
  state.shockwaves = state.shockwaves.filter((wave) => now - wave.bornAt < SHOCKWAVE_LIFETIME_MS);
}

export function bandAverage(bins: Uint8Array, binHz: number, fromHz: number, toHz: number): number {
  const fromIndex = Math.max(1, Math.floor(fromHz / binHz));
  const toIndex = Math.min(bins.length - 1, Math.ceil(toHz / binHz));
  if (toIndex <= fromIndex) return 0;
  let sum = 0;
  for (let i = fromIndex; i < toIndex; i++) sum += bins[i];
  return sum / (toIndex - fromIndex) / 255;
}

export function envelope(current: number, target: number, attack: number, release: number): number {
  const rate = target > current ? attack : release;
  return current + (target - current) * rate;
}
