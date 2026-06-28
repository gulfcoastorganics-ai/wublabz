import type { FlipPrepResult } from './flipPrepTypes.js';
import type { ChannelBuffer } from './mangler.js';
import { DEFAULT_GROWL_PRESET, randomGrowlPreset, type GrowlPreset, type SyncDivision } from './synth.js';

export type RemixSectionKind = 'intro' | 'buildup' | 'drop' | 'breakdown' | 'second-drop' | 'outro';
export type RemixTrackType = 'acapella' | 'drums' | 'bass' | 'fills';
export type RemixClipType = 'audio' | 'drum-pattern' | 'bass-growl' | 'mangler-fill';
export type DrumPatternKind = 'sparse-intro' | 'buildup-riser' | 'half-time-drop' | 'breakdown-space' | 'outro-tail';

export interface RemixSection {
  id: string;
  kind: RemixSectionKind;
  label: string;
  startBar: number;
  bars: number;
}

export interface RemixClip {
  id: string;
  trackId: string;
  type: RemixClipType;
  sectionId: string;
  startBar: number;
  bars: number;
  startBeat: number;
  durationBeats: number;
  payload: Record<string, unknown>;
}

export interface RemixTrack {
  id: string;
  type: RemixTrackType;
  name: string;
  muted: boolean;
  solo: boolean;
  clips: RemixClip[];
}

export interface RemixArrangement {
  id: string;
  title: string;
  targetBpm: 140;
  sourceBpm: number;
  detectedKey: string;
  keyOverride?: string;
  seed: string;
  sections: RemixSection[];
  tracks: RemixTrack[];
  bassPreset: GrowlPreset;
  flipPrep: Pick<FlipPrepResult, 'key' | 'bpm' | 'stems' | 'acapella140Url'>;
}

export interface GenerateRemixArrangementOptions {
  flipPrep: FlipPrepResult;
  seed?: string | number;
  keyOverride?: string;
  title?: string;
}

export interface GridEvent {
  trackId: string;
  clipId: string;
  beat: number;
  durationBeats: number;
}

const TARGET_BPM = 140 as const;
const SECTION_BARS: Array<[RemixSectionKind, string, number]> = [
  ['intro', 'Intro', 8],
  ['buildup', 'Buildup', 16],
  ['drop', 'DROP', 16],
  ['breakdown', 'Breakdown', 8],
  ['second-drop', '2nd Drop', 16],
  ['outro', 'Outro', 8]
];

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
const NOTE_TO_MIDI: Record<string, number> = {
  c: 48,
  'c#': 49,
  db: 49,
  d: 50,
  'd#': 51,
  eb: 51,
  e: 52,
  f: 53,
  'f#': 54,
  gb: 54,
  g: 55,
  'g#': 56,
  ab: 56,
  a: 57,
  'a#': 58,
  bb: 58,
  b: 59
};

export function generateRemixArrangement(options: GenerateRemixArrangementOptions): RemixArrangement {
  const seed = String(options.seed ?? 'wublabz-remix');
  const rng = createArrangerRng(seed);
  const sections = createDubstepSections();
  const detectedKey = options.keyOverride ?? options.flipPrep.key;
  const scale = keyToMidiScale(detectedKey);
  const tracks = createTracks();
  const bassPreset = {
    ...randomGrowlPreset(`${seed}:bass`, DEFAULT_GROWL_PRESET),
    bpm: TARGET_BPM,
    wobbleMode: 'sync' as const,
    syncDivision: pickSyncDivision(rng)
  };

  addAcapellaClips(tracks.acapella, sections, options.flipPrep);
  addDrumClips(tracks.drums, sections, seed);
  addBassClips(tracks.bass, sections, scale, seed, bassPreset);
  addFillClips(tracks.fills, sections, seed);

  return {
    id: `remix-${hashText(seed).toString(36)}`,
    title: options.title ?? 'Remix to Dubstep Skeleton',
    targetBpm: TARGET_BPM,
    sourceBpm: options.flipPrep.bpm,
    detectedKey: options.flipPrep.key,
    keyOverride: options.keyOverride,
    seed,
    sections,
    tracks: Object.values(tracks),
    bassPreset,
    flipPrep: options.flipPrep
  };
}

export function createDubstepSections(): RemixSection[] {
  let startBar = 0;
  return SECTION_BARS.map(([kind, label, bars]) => {
    const section = { id: kind, kind, label, startBar, bars };
    startBar += bars;
    return section;
  });
}

export function secondsPerBar(bpm = TARGET_BPM): number {
  return (60 / bpm) * 4;
}

export function barToBeat(bar: number): number {
  return bar * 4;
}

export function arrangementDurationSeconds(arrangement: Pick<RemixArrangement, 'sections' | 'targetBpm'>): number {
  const last = arrangement.sections[arrangement.sections.length - 1];
  return last ? (last.startBar + last.bars) * secondsPerBar(arrangement.targetBpm) : 0;
}

export function flattenArrangementEvents(arrangement: RemixArrangement): GridEvent[] {
  return arrangement.tracks.flatMap((track) =>
    track.clips.map((clip) => ({
      trackId: track.id,
      clipId: clip.id,
      beat: clip.startBeat,
      durationBeats: clip.durationBeats
    }))
  );
}

export function areEventsTempoLocked(arrangement: RemixArrangement): boolean {
  return flattenArrangementEvents(arrangement).every((event) => Number.isInteger(event.beat * 4) && Number.isInteger(event.durationBeats * 4));
}

export function keyToMidiScale(key: string, octave = 2): number[] {
  const normalized = key.trim().toLowerCase();
  const rootMatch = normalized.match(/^([a-g](?:#|b)?)/);
  const root = rootMatch ? NOTE_TO_MIDI[rootMatch[1]] ?? NOTE_TO_MIDI.a : NOTE_TO_MIDI.a;
  const mode = normalized.includes('major') ? MAJOR_SCALE : MINOR_SCALE;
  const octaveOffset = (octave - 3) * 12;
  return mode.map((interval) => root + octaveOffset + interval);
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function isMidiInKey(midi: number, key: string): boolean {
  const pitchClass = ((midi % 12) + 12) % 12;
  return keyToMidiScale(key, 3).some((note) => ((note % 12) + 12) % 12 === pitchClass);
}

export function regenerateArrangementElement(arrangement: RemixArrangement, element: RemixTrackType, seed: string | number): RemixArrangement {
  const next: RemixArrangement = structuredClone(arrangement);
  const sectionMap = new Map(next.sections.map((section) => [section.id, section]));
  const scale = keyToMidiScale(next.keyOverride ?? next.detectedKey);
  const track = next.tracks.find((entry) => entry.type === element);
  if (!track) return next;

  track.clips = [];
  if (element === 'drums') {
    addDrumClipsToTrack(track, next.sections, String(seed));
  } else if (element === 'bass') {
    addBassClipsToTrack(track, next.sections, scale, String(seed), next.bassPreset);
  } else if (element === 'fills') {
    addFillClipsToTrack(track, next.sections, String(seed));
  } else if (element === 'acapella') {
    const buildup = sectionMap.get('buildup');
    const drop = sectionMap.get('drop');
    const secondDrop = sectionMap.get('second-drop');
    if (buildup) track.clips.push(createAudioClip(track.id, buildup, 'verse', next.flipPrep.acapella140Url));
    if (drop) track.clips.push(createAudioClip(track.id, drop, 'hook', next.flipPrep.acapella140Url));
    if (secondDrop) track.clips.push(createAudioClip(track.id, secondDrop, 'hook-alt', next.flipPrep.acapella140Url));
  }

  next.seed = `${arrangement.seed}:${element}:${seed}`;
  return next;
}

export function renderArrangementGuideStem(arrangement: RemixArrangement, trackType: RemixTrackType, sampleRate = 44100): ChannelBuffer {
  const durationSeconds = arrangementDurationSeconds(arrangement);
  const frames = Math.ceil(durationSeconds * sampleRate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const track = arrangement.tracks.find((entry) => entry.type === trackType);
  if (!track || track.muted) return { sampleRate, channels: [left, right] };

  for (const clip of track.clips) {
    if (clip.type === 'drum-pattern') renderDrumClip(left, right, sampleRate, arrangement.targetBpm, clip);
    if (clip.type === 'bass-growl') renderBassClip(left, right, sampleRate, arrangement.targetBpm, clip);
    if (clip.type === 'mangler-fill') renderFillClip(left, right, sampleRate, arrangement.targetBpm, clip);
    if (clip.type === 'audio') renderAcapellaGuideClip(left, right, sampleRate, arrangement.targetBpm, clip);
  }

  return { sampleRate, channels: [left, right] };
}

export function renderArrangementGuideMaster(arrangement: RemixArrangement, sampleRate = 44100): ChannelBuffer {
  const stems = arrangement.tracks.map((track) => renderArrangementGuideStem(arrangement, track.type, sampleRate));
  const frames = stems[0]?.channels[0]?.length ?? 0;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (const stem of stems) {
    for (let i = 0; i < frames; i++) {
      left[i] += (stem.channels[0]?.[i] ?? 0) * 0.75;
      right[i] += (stem.channels[1]?.[i] ?? stem.channels[0]?.[i] ?? 0) * 0.75;
    }
  }
  return { sampleRate, channels: [left, right] };
}

function createTracks(): Record<RemixTrackType, RemixTrack> {
  return {
    acapella: { id: 'track-acapella', type: 'acapella', name: 'Acapella 140', muted: false, solo: false, clips: [] },
    drums: { id: 'track-drums', type: 'drums', name: 'Dubstep Drums', muted: false, solo: false, clips: [] },
    bass: { id: 'track-bass', type: 'bass', name: 'Growl Bass', muted: false, solo: false, clips: [] },
    fills: { id: 'track-fills', type: 'fills', name: 'Mangler Fills', muted: false, solo: false, clips: [] }
  };
}

function addAcapellaClips(track: RemixTrack, sections: RemixSection[], flipPrep: FlipPrepResult): void {
  const byId = new Map(sections.map((section) => [section.id, section]));
  for (const [id, phrase] of [['buildup', 'verse'], ['drop', 'hook'], ['second-drop', 'hook-alt']] as const) {
    const section = byId.get(id);
    if (section) track.clips.push(createAudioClip(track.id, section, phrase, flipPrep.acapella140Url));
  }
}

function addDrumClips(track: RemixTrack, sections: RemixSection[], seed: string): void {
  addDrumClipsToTrack(track, sections, seed);
}

function addDrumClipsToTrack(track: RemixTrack, sections: RemixSection[], seed: string): void {
  const rng = createArrangerRng(`${seed}:drums`);
  for (const section of sections) {
    const pattern = drumPatternForSection(section.kind);
    track.clips.push(createClip(track.id, 'drum-pattern', section, {
      pattern,
      swing: Number((rng() * 0.08).toFixed(3)),
      seed: `${seed}:${section.id}:drums`
    }));
  }
}

function addBassClips(track: RemixTrack, sections: RemixSection[], scale: number[], seed: string, bassPreset: GrowlPreset): void {
  addBassClipsToTrack(track, sections, scale, seed, bassPreset);
}

function addBassClipsToTrack(track: RemixTrack, sections: RemixSection[], scale: number[], seed: string, bassPreset: GrowlPreset): void {
  const rng = createArrangerRng(`${seed}:bass`);
  for (const section of sections.filter((entry) => entry.kind === 'drop' || entry.kind === 'second-drop')) {
    for (let bar = 0; bar < section.bars; bar += 2) {
      const noteMidi = scale[Math.floor(rng() * scale.length)];
      const startBar = section.startBar + bar;
      track.clips.push(createClip(track.id, 'bass-growl', { ...section, startBar, bars: 2 }, {
        midi: noteMidi,
        frequencyHz: Number(midiToFrequency(noteMidi).toFixed(2)),
        preset: bassPreset,
        wobbleDivision: bassPreset.syncDivision,
        seed: `${seed}:${section.id}:bass:${bar}`
      }));
    }
  }
}

function addFillClips(track: RemixTrack, sections: RemixSection[], seed: string): void {
  addFillClipsToTrack(track, sections, seed);
}

function addFillClipsToTrack(track: RemixTrack, sections: RemixSection[], seed: string): void {
  for (let i = 0; i < sections.length - 1; i++) {
    const section = sections[i];
    const fillStart = section.startBar + section.bars - 1;
    track.clips.push(createClip(track.id, 'mangler-fill', { ...section, startBar: fillStart, bars: 1 }, {
      seed: `${seed}:${section.id}:fill`,
      slices: section.kind === 'buildup' ? 16 : 8,
      glitch: section.kind === 'buildup' || section.kind === 'breakdown' ? 0.72 : 0.42
    }));
  }
}

function createAudioClip(trackId: string, section: RemixSection, phrase: string, url: string): RemixClip {
  return createClip(trackId, 'audio', section, { phrase, url });
}

function createClip(trackId: string, type: RemixClipType, section: Pick<RemixSection, 'id' | 'startBar' | 'bars'>, payload: Record<string, unknown>): RemixClip {
  return {
    id: `${trackId}-${type}-${section.id}-${section.startBar}`,
    trackId,
    type,
    sectionId: section.id,
    startBar: section.startBar,
    bars: section.bars,
    startBeat: barToBeat(section.startBar),
    durationBeats: section.bars * 4,
    payload
  };
}

function drumPatternForSection(kind: RemixSectionKind): DrumPatternKind {
  if (kind === 'intro') return 'sparse-intro';
  if (kind === 'buildup') return 'buildup-riser';
  if (kind === 'drop' || kind === 'second-drop') return 'half-time-drop';
  if (kind === 'breakdown') return 'breakdown-space';
  return 'outro-tail';
}

function renderDrumClip(left: Float32Array, right: Float32Array, sampleRate: number, bpm: number, clip: RemixClip): void {
  const beatSeconds = 60 / bpm;
  const pattern = clip.payload.pattern as DrumPatternKind;
  const startFrame = Math.floor(clip.startBeat * beatSeconds * sampleRate);
  const totalBeats = clip.durationBeats;
  for (let beat = 0; beat < totalBeats; beat += 0.5) {
    const isKick = pattern === 'half-time-drop' ? beat % 4 === 0 : beat % 4 === 0 && pattern !== 'breakdown-space';
    const isSnare = pattern === 'half-time-drop' ? beat % 4 === 2 : pattern === 'buildup-riser' && beat % 2 === 1;
    const isHat = pattern === 'buildup-riser' || (pattern === 'half-time-drop' && beat % 1 !== 0);
    const frame = startFrame + Math.floor(beat * beatSeconds * sampleRate);
    if (isKick) addDecayingTone(left, right, frame, sampleRate, 55, 0.55, 0.12);
    if (isSnare) addNoiseBurst(left, right, frame, sampleRate, 0.32, 0.08);
    if (isHat) addNoiseBurst(left, right, frame, sampleRate, 0.08, 0.025);
  }
}

function renderBassClip(left: Float32Array, right: Float32Array, sampleRate: number, bpm: number, clip: RemixClip): void {
  const beatSeconds = 60 / bpm;
  const startFrame = Math.floor(clip.startBeat * beatSeconds * sampleRate);
  const frequency = Number(clip.payload.frequencyHz ?? 55);
  for (let beat = 0; beat < clip.durationBeats; beat += 2) {
    const frame = startFrame + Math.floor(beat * beatSeconds * sampleRate);
    addDecayingTone(left, right, frame, sampleRate, frequency, 0.38, beatSeconds * 1.5);
    addDecayingTone(left, right, frame, sampleRate, frequency * 2.01, 0.12, beatSeconds * 0.8);
  }
}

function renderFillClip(left: Float32Array, right: Float32Array, sampleRate: number, bpm: number, clip: RemixClip): void {
  const beatSeconds = 60 / bpm;
  const startFrame = Math.floor(clip.startBeat * beatSeconds * sampleRate);
  const lengthFrames = Math.floor(clip.durationBeats * beatSeconds * sampleRate);
  const rng = createArrangerRng(String(clip.payload.seed ?? clip.id));
  for (let i = 0; i < lengthFrames && startFrame + i < left.length; i++) {
    const rise = i / Math.max(1, lengthFrames - 1);
    const sample = (rng() * 2 - 1) * rise * 0.16;
    left[startFrame + i] += sample;
    right[startFrame + i] -= sample * 0.8;
  }
}

function renderAcapellaGuideClip(left: Float32Array, right: Float32Array, sampleRate: number, bpm: number, clip: RemixClip): void {
  const beatSeconds = 60 / bpm;
  const startFrame = Math.floor(clip.startBeat * beatSeconds * sampleRate);
  const lengthFrames = Math.floor(clip.durationBeats * beatSeconds * sampleRate);
  for (let i = 0; i < lengthFrames && startFrame + i < left.length; i++) {
    const t = i / sampleRate;
    const phraseAmp = clip.payload.phrase === 'verse' ? 0.08 : 0.11;
    const env = Math.sin(Math.PI * (i / Math.max(1, lengthFrames - 1)));
    const sample = Math.sin(2 * Math.PI * 220 * t) * phraseAmp * env;
    left[startFrame + i] += sample;
    right[startFrame + i] += sample;
  }
}

function addDecayingTone(left: Float32Array, right: Float32Array, startFrame: number, sampleRate: number, frequency: number, gain: number, seconds: number): void {
  const frames = Math.floor(seconds * sampleRate);
  for (let i = 0; i < frames && startFrame + i < left.length; i++) {
    const env = 1 - i / Math.max(1, frames - 1);
    const sample = Math.sin(2 * Math.PI * frequency * (i / sampleRate)) * gain * env;
    left[startFrame + i] += sample;
    right[startFrame + i] += sample;
  }
}

function addNoiseBurst(left: Float32Array, right: Float32Array, startFrame: number, sampleRate: number, gain: number, seconds: number): void {
  const frames = Math.floor(seconds * sampleRate);
  let state = 1234567 + startFrame;
  for (let i = 0; i < frames && startFrame + i < left.length; i++) {
    state = Math.imul(1664525, state) + 1013904223;
    const noise = (((state >>> 0) / 4294967296) * 2 - 1) * gain * (1 - i / Math.max(1, frames - 1));
    left[startFrame + i] += noise;
    right[startFrame + i] += noise * 0.9;
  }
}

function pickSyncDivision(rng: () => number): SyncDivision {
  const divisions: SyncDivision[] = ['1/4', '1/8', '1/8.', '1/16'];
  return divisions[Math.floor(rng() * divisions.length)];
}

function createArrangerRng(seed: string): () => number {
  let h = hashText(seed);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
