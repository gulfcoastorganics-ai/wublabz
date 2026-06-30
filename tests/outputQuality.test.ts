import { describe, expect, it } from 'vitest';
import {
  renderMasterChannelBuffer,
  applyMasterMakeupGain,
  monoLowBand,
  getPeakAmplitude,
  softLimitChannel,
  dbToLinear
} from '../src/lib/audio/outputQuality.js';
import type { ChannelBuffer } from '../src/lib/producer-tools/mangler.js';

function generateSineWave(frequency: number, sampleRate: number, durationSeconds: number, amplitude: number): Float32Array {
  const length = Math.floor(sampleRate * durationSeconds);
  const data = new Float32Array(length);
  const omega = 2 * Math.PI * frequency;
  for (let i = 0; i < length; i++) {
    data[i] = Math.sin(omega * (i / sampleRate)) * amplitude;
  }
  return data;
}

describe('Mastering Chain & outputQuality', () => {
  const sampleRate = 44100;
  const duration = 0.5;

  it('verifies length and non-NaN/non-Infinity outputs on standard stereo buffer', () => {
    const left = generateSineWave(440, sampleRate, duration, 0.5);
    const right = generateSineWave(880, sampleRate, duration, 0.4);
    const input: ChannelBuffer = { sampleRate, channels: [left, right] };

    const output = renderMasterChannelBuffer(input);

    expect(output.sampleRate).toBe(sampleRate);
    expect(output.channels).toHaveLength(2);
    expect(output.channels[0].length).toBe(left.length);
    expect(output.channels[1].length).toBe(right.length);

    for (const channel of output.channels) {
      for (let i = 0; i < channel.length; i++) {
        expect(Number.isNaN(channel[i])).toBe(false);
        expect(Number.isFinite(channel[i])).toBe(true);
      }
    }
  });

  it('asserts rendering output never exceeds the ceiling (-0.8 dBFS target)', () => {
    const left = generateSineWave(100, sampleRate, duration, 2.5);
    const right = generateSineWave(100, sampleRate, duration, 2.5);
    const input: ChannelBuffer = { sampleRate, channels: [left, right] };

    const output = renderMasterChannelBuffer(input, -0.8);
    const peak = getPeakAmplitude(output);
    const targetPeak = dbToLinear(-0.8);

    expect(peak).toBeLessThanOrEqual(targetPeak + 1e-4);
  });

  it('asserts makeup gain increases the volume of a quiet input', () => {
    const left = generateSineWave(440, sampleRate, duration, 0.05);
    const right = generateSineWave(440, sampleRate, duration, 0.05);
    const input: ChannelBuffer = { sampleRate, channels: [left, right] };

    const originalPeak = getPeakAmplitude(input);
    const output = applyMasterMakeupGain(input, 3.0);
    const processedPeak = getPeakAmplitude(output);

    expect(processedPeak).toBeGreaterThan(originalPeak);
  });

  it('asserts the limiter reduces peak amplitudes on a hot buffer', () => {
    const left = generateSineWave(1000, sampleRate, duration, 1.8);
    const peakBefore = getPeakAmplitude({ sampleRate, channels: [left] });

    const limitedLeft = softLimitChannel(left, 1.5);
    const peakAfter = getPeakAmplitude({ sampleRate, channels: [limitedLeft] });

    expect(peakBefore).toBeCloseTo(1.8, 3);
    expect(peakAfter).toBeLessThan(peakBefore);
  });

  it('verifies mono low-band keeps lengths identical and behaves correctly', () => {
    const lowLeft = generateSineWave(50, sampleRate, duration, 0.3);
    const lowRight = generateSineWave(50, sampleRate, duration, -0.3);
    const highLeft = generateSineWave(2000, sampleRate, duration, 0.4);
    const highRight = generateSineWave(2000, sampleRate, duration, 0.4);

    const input: ChannelBuffer = {
      sampleRate,
      channels: [
        new Float32Array(lowLeft.map((v, i) => v + highLeft[i])),
        new Float32Array(lowRight.map((v, i) => v + highRight[i]))
      ]
    };

    const output = monoLowBand(input, 75);

    expect(output.channels[0].length).toBe(input.channels[0].length);
    expect(output.channels[1].length).toBe(input.channels[1].length);

    for (const channel of output.channels) {
      for (let i = 0; i < channel.length; i++) {
        expect(Number.isNaN(channel[i])).toBe(false);
        expect(Number.isFinite(channel[i])).toBe(true);
      }
    }
  });

  it('processes a full-band sine sweep without NaN, clipping, or length change', () => {
    const length = Math.floor(sampleRate * duration);
    const f0 = 20, f1 = 20000;
    const sweepL = new Float32Array(length);
    const sweepR = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const freq = f0 * Math.pow(f1 / f0, t / duration);
      const sample = Math.sin(2 * Math.PI * freq * t) * 0.7;
      sweepL[i] = sample;
      sweepR[i] = sample;
    }
    const input: ChannelBuffer = { sampleRate, channels: [sweepL, sweepR] };

    const output = renderMasterChannelBuffer(input);

    expect(output.channels[0].length).toBe(length);
    expect(output.channels[1].length).toBe(length);

    for (const channel of output.channels) {
      for (let i = 0; i < channel.length; i++) {
        expect(Number.isNaN(channel[i])).toBe(false);
        expect(Number.isFinite(channel[i])).toBe(true);
      }
    }

    const peak = getPeakAmplitude(output);
    expect(peak).toBeLessThanOrEqual(dbToLinear(-0.8) + 1e-4);
  });
});
