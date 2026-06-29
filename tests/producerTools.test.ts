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
import { applyMasterGlueCompression, DEFAULT_LOW_MONO_HZ, DEFAULT_MASTER_CEILING_DB, DEFAULT_MASTER_GLUE_RATIO, DEFAULT_MASTER_GLUE_THRESHOLD_DB, DEFAULT_MASTER_HEADROOM_DB, DEFAULT_MASTER_MAKEUP_DB, getPeakAmplitude, monoLowBand, normalizeChannelBuffer, normalizeTruePeakSafe, renderMasterChannelBuffer } from '../src/lib/audio/outputQuality.js';
import { applyEqualPowerFade, createSlicePlan, renderMangledBuffer, softLimitSample, type ChannelBuffer } from '../src/lib/producer-tools/mangler.js';
import { clampFlipPrepClipSelection, estimateFlipPrepTotalSeconds, trimChannelBuffer } from '../src/lib/producer-tools/flipPrepClip.js';
import { DEFAULT_GROWL_PRESET, MIN_CLICK_FREE_ATTACK_SECONDS, MIN_CLICK_FREE_FILTER_ATTACK_SECONDS, MIN_LFO_DEPTH_ATTACK_SECONDS, STARTER_GROWL_PRESETS, driveMakeupGain, lfoSyncHz, normalizeGrowlPreset, resolveAdsrStageTimes, resolveDubstepSubFrequency, resolveFilterAttackFloorSeconds, SPLIT_CROSSOVER_HZ } from '../src/lib/producer-tools/synth.js';

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

  it('applies mangler effects without breaking render bounds', () => {
    const rendered = renderMangledBuffer(sourceBuffer(128), {
      slices: 8,
      glitch: 0.4,
      pitchSemitones: -2,
      crossfadeMs: 2,
      gain: 1.1,
      seed: 'fx',
      bitcrush: 0.75,
      filterSweep: 0.8,
      reverseChance: 0.5,
      gate: 0.6,
      stutter: 0.9,
      tapeStop: 0.45
    });

    expect(rendered.channels).toHaveLength(1);
    expect(rendered.channels[0].length).toBeGreaterThan(0);
    expect(Math.max(...rendered.channels[0])).toBeLessThanOrEqual(1);
    expect(Math.min(...rendered.channels[0])).toBeGreaterThanOrEqual(-1);
  });

  it('honors explicit slice order and per-slice overrides', () => {
    const rendered = renderMangledBuffer(sourceBuffer(64), {
      slices: 4,
      glitch: 0,
      pitchSemitones: 0,
      crossfadeMs: 0,
      gain: 1,
      seed: 'manual',
      order: [3, 2, 1, 0],
      sliceOverrides: {
        3: { reversed: true, repeats: 2, gain: 0.5 },
        1: { muted: true }
      }
    });

    expect(rendered.channels[0].length).toBeGreaterThan(0);
    expect(getPeakAmplitude(rendered)).toBeLessThanOrEqual(1);
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

  it('keeps master renders limited after headroom and bus treatment', () => {
    const rendered = renderMasterChannelBuffer({
      sampleRate: 44100,
      channels: [new Float32Array([0.9, -1.4, 1.2]), new Float32Array([-0.7, 1.3, -1.1])]
    });

    expect(getPeakAmplitude(rendered)).toBeLessThanOrEqual(0.913);
    expect(getPeakAmplitude(rendered)).toBeGreaterThan(0.86);
    expect(rendered.channels).toHaveLength(2);
  });

  it('applies gentle master glue compression above threshold without crushing sustained energy', () => {
    const channel = new Float32Array(4096);
    channel.fill(0.9, 128, 4096);
    const source = {
      sampleRate: 44100,
      channels: [channel]
    };
    const compressed = applyMasterGlueCompression(source);

    expect(compressed.channels[0][4095]).toBeLessThan(source.channels[0][4095]);
    expect(compressed.channels[0][4095]).toBeGreaterThan(0.82);
  });

  it('normalizes exports with conservative intersample headroom', () => {
    const rendered = normalizeTruePeakSafe({
      sampleRate: 44100,
      channels: [new Float32Array([0.85, -0.85, 0.85, -0.85])]
    }, -1);

    expect(getPeakAmplitude(rendered)).toBeLessThan(0.912);
  });

  it('monos low-frequency stereo content for bass compatibility', () => {
    const left = new Float32Array(128).fill(0.5);
    const right = new Float32Array(128).fill(-0.5);
    const rendered = monoLowBand({ sampleRate: 44100, channels: [left, right] }, 120);

    expect(Math.abs(rendered.channels[0][127] - rendered.channels[1][127])).toBeLessThan(1);
  });

  it('gain-compensates bass drive curves', () => {
    expect(driveMakeupGain('soft', 0.8)).toBeLessThan(1);
    expect(driveMakeupGain('hard', 0.8)).toBeLessThan(1);
  });

  it('keeps bass synth defaults biased toward sub and low-mid body', () => {
    expect(DEFAULT_GROWL_PRESET.subLevel).toBeGreaterThanOrEqual(0.9);
    expect(DEFAULT_GROWL_PRESET.drive).toBeGreaterThanOrEqual(0.55);
    expect(DEFAULT_GROWL_PRESET.unisonVoices).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_GROWL_PRESET.glideSeconds).toBeGreaterThan(0);
  });

  it('ships complete starter growl presets for instant loading', () => {
    expect(STARTER_GROWL_PRESETS.map((entry) => entry.name)).toEqual(['Deep Sub', 'Reese', 'Talking Bass', 'Hard Growl']);
    for (const entry of STARTER_GROWL_PRESETS) {
      expect(entry.preset.subLevel).toBeGreaterThan(0.8);
      expect(entry.preset.glideSeconds).toBeGreaterThanOrEqual(0);
      expect(entry.preset.bpm).toBe(DEFAULT_GROWL_PRESET.bpm);
    }
  });

  it('normalizes older saved growl presets with newly added fields', () => {
    const normalized = normalizeGrowlPreset({ ...DEFAULT_GROWL_PRESET, glideSeconds: undefined });
    expect(normalized.glideSeconds).toBe(DEFAULT_GROWL_PRESET.glideSeconds);
  });

  it('folds growl sub frequencies into the chest-hit octave', () => {
    expect(resolveDubstepSubFrequency(55)).toBeCloseTo(55);
    expect(resolveDubstepSubFrequency(98)).toBeCloseTo(49);
    expect(resolveDubstepSubFrequency(123.47)).toBeGreaterThanOrEqual(40);
    expect(resolveDubstepSubFrequency(123.47)).toBeLessThanOrEqual(80);
  });

  it('keeps the bass synth split crossover in the low-mid body range', () => {
    expect(SPLIT_CROSSOVER_HZ).toBe(220);
  });

  it('keeps the producer master present before limiting', () => {
    expect(DEFAULT_MASTER_HEADROOM_DB).toBe(-1.25);
    expect(DEFAULT_MASTER_MAKEUP_DB).toBeGreaterThan(2);
    expect(DEFAULT_MASTER_CEILING_DB).toBe(-0.8);
    expect(DEFAULT_MASTER_GLUE_THRESHOLD_DB).toBe(-7);
    expect(DEFAULT_MASTER_GLUE_RATIO).toBeLessThanOrEqual(1.12);
    expect(DEFAULT_LOW_MONO_HZ).toBeLessThanOrEqual(80);
  });

  it('round-trips WAV metadata for rendered buffers', () => {
    const wav = encodeWav({ sampleRate: 48000, channels: [new Float32Array(12), new Float32Array(12)] });
    expect(decodeWavHeader(wav)).toEqual({ sampleRate: 48000, channels: 2, frames: 12 });
  });

  it('clamps Flip Prep section selection to the configured CPU-safe duration', () => {
    expect(clampFlipPrepClipSelection(240, 12, 120, 45)).toEqual({
      startSeconds: 12,
      durationSeconds: 45,
      wasAutoTrimmed: true
    });
    expect(clampFlipPrepClipSelection(30, 25, 20, 60)).toEqual({
      startSeconds: 25,
      durationSeconds: 5,
      wasAutoTrimmed: true
    });
  });

  it('trims Flip Prep clips without changing sample rate or channel count', () => {
    const rendered = trimChannelBuffer({ sampleRate: 10, channels: [new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])] }, 0.2, 0.3);

    expect(rendered.sampleRate).toBe(10);
    expect(rendered.channels).toHaveLength(1);
    expect(Array.from(rendered.channels[0])).toEqual([2, 3, 4]);
  });

  it('estimates Flip Prep CPU time from the selected clip duration', () => {
    expect(estimateFlipPrepTotalSeconds(45)).toBe(900);
    expect(estimateFlipPrepTotalSeconds(2)).toBe(120);
  });

  it('calculates tempo-synced LFO rates', () => {
    expect(lfoSyncHz(120, '1/4')).toBeCloseTo(2);
    expect(lfoSyncHz(120, '1/8')).toBeCloseTo(4);
    expect(lfoSyncHz(120, '1/16')).toBeCloseTo(8);
    expect(lfoSyncHz(120, '1/8.')).toBeCloseTo(2.666, 2);
    expect(lfoSyncHz(120, '1/8T')).toBeCloseTo(6);
    expect(lfoSyncHz(120, '1/16T')).toBeCloseTo(12);
  });

  it('resolves ADSR envelope stage timing', () => {
    const times = resolveAdsrStageTimes(1, 0.05, 0.2, 0.3, 2);
    expect(times.attackEnd).toBeCloseTo(1.05);
    expect(times.decayEnd).toBeCloseTo(1.25);
    expect(times.releaseEnd).toBeCloseTo(2.3);
  });

  it('enforces a click-free attack floor when requested', () => {
    const times = resolveAdsrStageTimes(1, 0, 0.2, 0.3, 2, MIN_CLICK_FREE_ATTACK_SECONDS);
    expect(times.attackEnd).toBeCloseTo(1 + MIN_CLICK_FREE_ATTACK_SECONDS);
    expect(times.decayEnd).toBeCloseTo(1 + MIN_CLICK_FREE_ATTACK_SECONDS + 0.2);
  });

  it('slows resonant filter attack enough to avoid sweep crackle', () => {
    expect(resolveFilterAttackFloorSeconds(4)).toBe(MIN_CLICK_FREE_FILTER_ATTACK_SECONDS);
    expect(resolveFilterAttackFloorSeconds(14)).toBeGreaterThan(MIN_CLICK_FREE_FILTER_ATTACK_SECONDS);
    expect(MIN_LFO_DEPTH_ATTACK_SECONDS).toBeGreaterThan(MIN_CLICK_FREE_ATTACK_SECONDS);
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
