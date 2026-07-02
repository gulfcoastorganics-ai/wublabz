import { describe, expect, it } from 'vitest';
import {
  renderMasterChannelBuffer,
  applyMasterHeadroom,
  applyMasterSoftSaturation,
  applyMasterGlueCompression,
  applyMasterMakeupGain,
  monoLowBand,
  normalizeTruePeakSafe,
  getPeakAmplitude,
  softLimitChannel,
  dbToLinear
} from '../src/lib/audio/outputQuality.js';
import type { ChannelBuffer } from '../src/lib/producer-tools/mangler.js';

// Helper to generate a sine wave signal
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
  const duration = 0.5; // 500ms

  it('verifies length and non-NaN/non-Infinity outputs on standard stereo buffer', () => {
    const left = generateSineWave(440, sampleRate, duration, 0.5);
    const right = generateSineWave(880, sampleRate, duration, 0.4);
    const input: ChannelBuffer = {
      sampleRate,
      channels: [left, right]
    };

    const output = renderMasterChannelBuffer(input);

    expect(output.sampleRate).toBe(sampleRate);
    expect(output.channels).toHaveLength(2);
    expect(output.channels[0].length).toBe(left.length);
    expect(output.channels[1].length).toBe(right.length);

    for (let c = 0; c < output.channels.length; c++) {
      const channel = output.channels[c];
      for (let i = 0; i < channel.length; i++) {
        expect(Number.isNaN(channel[i])).toBe(false);
        expect(Number.isFinite(channel[i])).toBe(true);
      }
    }
  });

  it('asserts rendering output never exceeds the ceiling (-0.8 dBFS target)', () => {
    // Generate a hot signal that would definitely clip/clash
    const left = generateSineWave(100, sampleRate, duration, 2.5);
    const right = generateSineWave(100, sampleRate, duration, 2.5);
    const input: ChannelBuffer = {
      sampleRate,
      channels: [left, right]
    };

    const output = renderMasterChannelBuffer(input, -0.8);
    const peak = getPeakAmplitude(output);
    const targetPeak = dbToLinear(-0.8);

    // Peak should be extremely close to the target ceiling but not exceed it
    expect(peak).toBeLessThanOrEqual(targetPeak + 1e-4);
  });

  it('asserts makeup gain increases the volume of a quiet input', () => {
    // Generate a quiet signal
    const left = generateSineWave(440, sampleRate, duration, 0.05);
    const right = generateSineWave(440, sampleRate, duration, 0.05);
    const input: ChannelBuffer = {
      sampleRate,
      channels: [left, right]
    };

    const originalPeak = getPeakAmplitude(input);
    const output = applyMasterMakeupGain(input, 3.0); // +3dB makeup gain
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
    // Low sine (50Hz) and high sine (2000Hz) mix
    const lowLeft = generateSineWave(50, sampleRate, duration, 0.3);
    const lowRight = generateSineWave(50, sampleRate, duration, -0.3); // out of phase low-end
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

    // Verify no values are NaN or Infinity
    for (let c = 0; c < output.channels.length; c++) {
      const channel = output.channels[c];
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

  it('verifies low frequencies are centered (mono) and high frequencies stay stereo separated', () => {
    const cutoff = 120;
    // Hard-panned low frequency (50Hz)
    const lowLeft = generateSineWave(50, sampleRate, duration, 0.8);
    const lowRight = new Float32Array(lowLeft.length);

    // Hard-panned high frequency (3000Hz)
    const highLeft = generateSineWave(3000, sampleRate, duration, 0.8);
    const highRight = new Float32Array(highLeft.length);

    const input: ChannelBuffer = {
      sampleRate,
      channels: [
        new Float32Array(lowLeft.map((v, i) => v + highLeft[i])),
        new Float32Array(lowRight.map((v, i) => v + highRight[i]))
      ]
    };

    const output = monoLowBand(input, cutoff);

    // We filter boundaries due to FIR tap latency
    for (let i = 32; i < output.channels[0].length - 32; i++) {
      // Low frequency (50Hz) has been summed to mono: both channels carry ~0.4 * sine(50Hz)
      const lowLeftVal = output.channels[0][i] - highLeft[i]; // remove high portion
      const lowRightVal = output.channels[1][i];
      expect(Math.abs(lowLeftVal - lowRightVal)).toBeLessThan(0.05);
      expect(Math.abs(lowRightVal - lowLeft[i] * 0.5)).toBeLessThan(0.05);

      // High frequency (3000Hz) was only ever on the left channel and must not leak into the right
      const highLeak = output.channels[1][i] - lowLeft[i] * 0.5;
      expect(Math.abs(highLeak)).toBeLessThan(0.05);
    }
  });

  it('verifies crossover region does not show severe cancellation or distortion', () => {
    const cutoff = 120;
    // Mono sine wave exactly at crossover frequency (120Hz)
    const sineLeft = generateSineWave(cutoff, sampleRate, duration, 0.7);
    const sineRight = generateSineWave(cutoff, sampleRate, duration, 0.7);
    const input: ChannelBuffer = {
      sampleRate,
      channels: [sineLeft, sineRight]
    };

    const output = monoLowBand(input, cutoff);

    // For mono inputs, complementary FIR filter sums exactly to original with zero phase delay
    for (let i = 32; i < output.channels[0].length - 32; i++) {
      expect(output.channels[0][i]).toBeCloseTo(sineLeft[i], 3);
      expect(output.channels[1][i]).toBeCloseTo(sineRight[i], 3);
    }
  });
});
