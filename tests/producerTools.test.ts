import { describe, expect, it } from 'vitest';
import {
  areEventsTempoLocked,
  arrangementDurationSeconds,
  createDubstepSections,
  generateRemixArrangement,
  isMidiInKey,
  regenerateArrangementElement,
  renderArrangementGuideMaster,
  type RemixArrangement
} from '../src/lib/producer-tools/arranger.js';
import { decodeWavHeader, encodeWav } from '../src/lib/export/wav.js';
import { getPeakAmplitude, normalizeChannelBuffer } from '../src/lib/audio/outputQuality.js';
import { applyEqualPowerFade, createSlicePlan, renderMangledBuffer, softLimitSample, type ChannelBuffer } from '../src/lib/producer-tools/mangler.js';
import { lfoSyncHz, resolveAdsrStageTimes, SPLIT_CROSSOVER_HZ } from '../src/lib/producer-tools/synth.js';

function sourceBuffer(length = 32): ChannelBuffer {
  const channel = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    channel[i] = i % 2 === 0 ? 0.9 : -0.9;
  }
  return { sampleRate: 44100, channels: [channel] };
}

describe('producer tool DSP logic', () => {
  it('creates reproducible slice plans from a seed', () => {
    const first = createSlicePlan(8, 0.7, 'drop-seed');
    const second = createSlicePlan(8, 0.7, 'drop-seed');
    const other = createSlicePlan(8, 0.7, 'other-seed');

    expect(first).toEqual(second);
    expect(first.order).not.toEqual(other.order);
    expect(first.order).toHaveLength(8);
  });

  it('renders the requested slice count through fade and soft-limit stages', () => {
    const rendered = renderMangledBuffer(sourceBuffer(), {
      slices: 8,
      glitch: 0,
      pitchSemitones: 0,
      crossfadeMs: 5,
      gain: 2,
      seed: 'stable'
    });

    expect(rendered.channels).toHaveLength(1);
    expect(rendered.channels[0].length).toBeLessThan(32);
    expect(rendered.channels[0].length).toBeGreaterThan(0);
    expect(Math.max(...rendered.channels[0])).toBeLessThanOrEqual(1);
    expect(Math.min(...rendered.channels[0])).toBeGreaterThanOrEqual(-1);
  });

  it('uses equal-power fades at slice edges', () => {
    expect(applyEqualPowerFade(1, 0, 10, true)).toBeCloseTo(0);
    expect(applyEqualPowerFade(1, 10, 10, true)).toBeCloseTo(1);
    expect(applyEqualPowerFade(1, 0, 10, false)).toBeCloseTo(1);
    expect(applyEqualPowerFade(1, 10, 10, false)).toBeCloseTo(0);
    expect(Math.abs(softLimitSample(10))).toBeLessThanOrEqual(1);
  });

  it('normalizes exports to the requested peak target', () => {
    const normalized = normalizeChannelBuffer({
      sampleRate: 44100,
      channels: [new Float32Array([0.25, -0.5, 0.1])]
    }, -1);

    expect(getPeakAmplitude(normalized)).toBeCloseTo(0.891, 2);
  });

  it('keeps the bass synth split crossover below sub fundamentals', () => {
    expect(SPLIT_CROSSOVER_HZ).toBe(180);
  });

  it('round-trips WAV metadata for rendered buffers', () => {
    const wav = encodeWav({ sampleRate: 48000, channels: [new Float32Array(12), new Float32Array(12)] });
    expect(decodeWavHeader(wav)).toEqual({ sampleRate: 48000, channels: 2, frames: 12 });
  });

  it('calculates tempo-synced LFO rates', () => {
    expect(lfoSyncHz(120, '1/4')).toBeCloseTo(2);
    expect(lfoSyncHz(120, '1/8')).toBeCloseTo(4);
    expect(lfoSyncHz(120, '1/16')).toBeCloseTo(8);
    expect(lfoSyncHz(120, '1/8.')).toBeCloseTo(2.666, 2);
  });

  it('resolves ADSR envelope stage timing', () => {
    const times = resolveAdsrStageTimes(1, 0.05, 0.2, 0.3, 2);
    expect(times.attackEnd).toBeCloseTo(1.05);
    expect(times.decayEnd).toBeCloseTo(1.25);
    expect(times.releaseEnd).toBeCloseTo(2.3);
  });
});

describe('remix arranger logic', () => {
  const flipPrep = {
    key: 'A minor',
    bpm: 92,
    stems: [
      { name: 'drums' as const, url: '/drums.mp3' },
      { name: 'bass' as const, url: '/bass.mp3' },
      { name: 'vocals' as const, url: '/vocals.mp3' },
      { name: 'other' as const, url: '/other.mp3' }
    ],
    acapella140Url: '/acapella_140.wav'
  };

  it('creates typical dubstep sections with deterministic bar math', () => {
    const sections = createDubstepSections();
    expect(sections.map((section) => [section.kind, section.startBar, section.bars])).toEqual([
      ['intro', 0, 8],
      ['buildup', 8, 16],
      ['drop', 24, 16],
      ['breakdown', 40, 8],
      ['second-drop', 48, 16],
      ['outro', 64, 8]
    ]);
  });

  it('generates an editable arrangement data shape at 140 BPM', () => {
    const arrangement = generateRemixArrangement({ flipPrep, seed: 'shape' });
    expect(arrangement.targetBpm).toBe(140);
    expect(arrangement.sourceBpm).toBe(92);
    expect(arrangement.sections).toHaveLength(6);
    expect(arrangement.tracks.map((track) => track.type)).toEqual(['acapella', 'drums', 'bass', 'fills']);
    expect(arrangementDurationSeconds(arrangement)).toBeCloseTo(123.42, 1);
  });

  it('keeps generated bass notes inside the detected key', () => {
    const arrangement = generateRemixArrangement({ flipPrep, seed: 'key-test' });
    const bassTrack = arrangement.tracks.find((track) => track.type === 'bass');
    expect(bassTrack?.clips.length).toBeGreaterThan(0);
    for (const clip of bassTrack?.clips ?? []) {
      expect(isMidiInKey(Number(clip.payload.midi), arrangement.detectedKey)).toBe(true);
    }
  });

  it('locks all clips to the 140 BPM grid', () => {
    const arrangement = generateRemixArrangement({ flipPrep, seed: 'grid-test' });
    expect(areEventsTempoLocked(arrangement)).toBe(true);
  });

  it('regenerates elements deterministically from a seed', () => {
    const arrangement = generateRemixArrangement({ flipPrep, seed: 'regen' });
    const first = regenerateArrangementElement(arrangement, 'drums', 'drum-seed');
    const second = regenerateArrangementElement(arrangement, 'drums', 'drum-seed');
    const other = regenerateArrangementElement(arrangement, 'drums', 'other-drum-seed');

    expect(trackClipPayloads(first, 'drums')).toEqual(trackClipPayloads(second, 'drums'));
    expect(trackClipPayloads(first, 'drums')).not.toEqual(trackClipPayloads(other, 'drums'));
  });

  it('renders guide audio buffers for mocked export paths', () => {
    const arrangement = generateRemixArrangement({ flipPrep, seed: 'render' });
    const buffer = renderArrangementGuideMaster(arrangement, 8000);
    expect(buffer.sampleRate).toBe(8000);
    expect(buffer.channels).toHaveLength(2);
    expect(buffer.channels[0].length).toBeGreaterThan(0);
    expect(peak(buffer.channels[0])).toBeGreaterThan(0);
  });
});

function trackClipPayloads(arrangement: RemixArrangement, type: string): unknown[] {
  return arrangement.tracks.find((track) => track.type === type)?.clips.map((clip) => clip.payload) ?? [];
}

function peak(channel: Float32Array): number {
  let value = 0;
  for (let i = 0; i < channel.length; i++) {
    value = Math.max(value, Math.abs(channel[i]));
  }
  return value;
}
