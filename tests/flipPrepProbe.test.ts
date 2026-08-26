import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeAudioDuration, analyzeStemQuality } from '../src/flip-worker/probe.js';
import { encodeWav } from '../src/lib/export/wav.js';
import type { ChannelBuffer } from '../src/lib/producer-tools/mangler.js';
import type { StemPaths } from '../src/flip-worker/types.js';

function sineWave(seconds: number, amplitude: number, sampleRate = 44100): ChannelBuffer {
  const length = Math.floor(seconds * sampleRate);
  const channel = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    channel[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amplitude;
  }
  return { sampleRate, channels: [channel, channel] };
}

async function writeWav(buffer: ChannelBuffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flip-prep-probe-test-'));
  const filePath = path.join(dir, 'audio.wav');
  await writeFile(filePath, encodeWav(buffer));
  return filePath;
}

describe('probeAudioDuration', () => {
  it('reads the real duration of a valid audio file', async () => {
    const fixture = await writeWav(sineWave(2.5, 0.25));
    const result = await probeAudioDuration(fixture, 10_000);
    expect(result.durationSeconds).toBeGreaterThan(2.45);
    expect(result.durationSeconds).toBeLessThan(2.55);
  });

  it('throws a clear, actionable error for corrupt/unreadable input instead of a raw subprocess dump', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'flip-prep-probe-corrupt-'));
    const corruptPath = path.join(dir, 'corrupt.mp3');
    await writeFile(corruptPath, Buffer.from('this is not audio data'));

    await expect(probeAudioDuration(corruptPath, 10_000)).rejects.toThrow('could not be read');
  });
});

describe('analyzeStemQuality', () => {
  it('flags a near-silent stem', async () => {
    const silentPath = await writeWav(sineWave(2, 0.0005));
    const [report] = await analyzeStemQuality({ vocals: silentPath }, 10_000);
    expect(report.isSilent).toBe(true);
    expect(report.isClipped).toBe(false);
  });

  it('flags a stem that is pinned near 0dBFS as clipped', async () => {
    const loudPath = await writeWav(sineWave(2, 0.999));
    const [report] = await analyzeStemQuality({ vocals: loudPath }, 10_000);
    expect(report.isClipped).toBe(true);
  });

  it('does not flag a normal, moderately-leveled stem', async () => {
    const normalPath = await writeWav(sineWave(2, 0.3));
    const [report] = await analyzeStemQuality({ vocals: normalPath }, 10_000);
    expect(report.isSilent).toBe(false);
    expect(report.isClipped).toBe(false);
  });

  it('reports an error instead of throwing when a stem cannot be decoded', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'flip-prep-quality-corrupt-'));
    const corruptPath = path.join(dir, 'corrupt.mp3');
    await writeFile(corruptPath, Buffer.from('not audio'));

    const [report] = await analyzeStemQuality({ vocals: corruptPath }, 10_000);
    expect(report.error).toBeTruthy();
    expect(report.isSilent).toBe(false);
    expect(report.isClipped).toBe(false);
  });

  it('skips stems that are undefined without erroring', async () => {
    const reports = await analyzeStemQuality({ vocals: undefined, drums: undefined } as unknown as StemPaths, 10_000);
    expect(reports).toEqual([]);
  });
});
