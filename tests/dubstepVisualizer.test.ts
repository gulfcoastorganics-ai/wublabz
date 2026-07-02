import { describe, expect, it } from 'vitest';
import { bandAverage, envelope, updateBandState, freshBandState as freshState, TRANSIENT_THRESHOLD } from '../src/producer-tools/dubstepVisualizerMath.js';

function binsWithEnergy(length: number, fromIndex: number, toIndex: number, value: number): Uint8Array {
  const bins = new Uint8Array(length);
  for (let i = fromIndex; i < toIndex; i++) bins[i] = value;
  return bins;
}

describe('bandAverage', () => {
  it('averages only bins within the requested Hz range', () => {
    const sampleRate = 44100;
    const fftSize = 2048;
    const binHz = sampleRate / fftSize;
    const bins = new Uint8Array(fftSize / 2);
    bins[2] = 255; // ~43Hz, inside 30-90Hz sub range
    bins[50] = 255; // ~1076Hz, outside sub range
    const sub = bandAverage(bins, binHz, 30, 90);
    expect(sub).toBeGreaterThan(0);
    expect(sub).toBeLessThanOrEqual(1);
    const highBand = bandAverage(bins, binHz, 30, 90);
    expect(highBand).toBe(sub); // sanity: deterministic for same input
  });

  it('returns 0 for an empty or inverted range', () => {
    const bins = binsWithEnergy(64, 0, 64, 200);
    expect(bandAverage(bins, 21.5, 0, 0)).toBe(0);
    expect(bandAverage(bins, 21.5, 500, 100)).toBe(0);
  });

  it('normalizes to 0..1 regardless of input scale', () => {
    const bins = binsWithEnergy(64, 1, 10, 255);
    const value = bandAverage(bins, 21.5, 20, 200);
    expect(value).toBeLessThanOrEqual(1);
    expect(value).toBeGreaterThan(0.9);
  });
});

describe('envelope', () => {
  it('rises toward a higher target using the attack rate', () => {
    const next = envelope(0, 1, 0.5, 0.1);
    expect(next).toBeCloseTo(0.5, 5);
  });

  it('falls toward a lower target using the release rate', () => {
    const next = envelope(1, 0, 0.5, 0.1);
    expect(next).toBeCloseTo(0.9, 5);
  });

  it('attack is faster than release for a hit-then-decay feel', () => {
    const rise = envelope(0, 1, 0.6, 0.12);
    const afterRise = envelope(rise, 0, 0.6, 0.12);
    // Release step should move less than the attack step moved, given the smaller rate.
    expect(1 - afterRise).toBeLessThan(rise);
  });
});

describe('updateBandState', () => {
  it('distinguishes sub-bass energy from mid-bass energy', () => {
    const sampleRate = 44100;
    const fftSize = 2048;
    const binHz = sampleRate / (fftSize);
    const bins = new Uint8Array(fftSize / 2);
    // Fill only the sub-bass range (30-90Hz) with strong energy.
    for (let hz = 30; hz < 90; hz += binHz) bins[Math.floor(hz / binHz)] = 255;

    const state = freshState();
    updateBandState(state, bins, sampleRate, 1000, true);

    expect(state.sub).toBeGreaterThan(0.3);
    expect(state.mid).toBeCloseTo(0, 2);
  });

  it('registers a shockwave when broadband energy spikes above the transient threshold while active', () => {
    const sampleRate = 44100;
    const bins = new Uint8Array(1024);
    const state = freshState();

    // Quiet frame first so there is a baseline to jump from.
    updateBandState(state, bins, sampleRate, 0, true);

    // Sudden loud broadband hit.
    const loudBins = binsWithEnergy(1024, 20, 1024, 255);
    updateBandState(state, loudBins, sampleRate, 16, true);

    expect(state.transient).toBeGreaterThan(TRANSIENT_THRESHOLD);
    expect(state.shockwaves.length).toBeGreaterThan(0);
  });

  it('does not register shockwaves when inactive, even on a broadband spike', () => {
    const sampleRate = 44100;
    const state = freshState();
    updateBandState(state, new Uint8Array(1024), sampleRate, 0, false);
    const loudBins = binsWithEnergy(1024, 20, 1024, 255);
    updateBandState(state, loudBins, sampleRate, 16, false);

    expect(state.shockwaves.length).toBe(0);
  });

  it('expires shockwaves after their lifetime', () => {
    const sampleRate = 44100;
    const state = freshState();
    state.shockwaves.push({ bornAt: 0, strength: 1 });
    updateBandState(state, new Uint8Array(1024), sampleRate, 1000, true);
    expect(state.shockwaves.length).toBe(0);
  });
});
