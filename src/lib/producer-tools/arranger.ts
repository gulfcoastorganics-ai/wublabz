import type { FlipPrepResult } from './flipPrepTypes.js';
import type { ChannelBuffer } from './mangler.js';
import { DEFAULT_GROWL_PRESET, randomGrowlPreset, resolveDubstepSubFrequency, lfoSyncHz, type GrowlPreset, type SyncDivision } from './synth.js';

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
  flipPrep: Pick<FlipPrepResult, 'key' | 'bpm' | 'stems' | 'acapella140Url' | 'outputPaths'>;
}

export interface RemixAudioAssets {
  acapella140?: ChannelBuffer;
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

// Per-note event within a bass-growl clip — carries timing, pitch, sub/mid freqs, and LFO division
interface BassNotePayload {
  startBeat: number;
  durationBeats: number;
  midiNote: number;
  frequencyHz: number;
  subFrequencyHz: number;
  wobbleDivision: SyncDivision;
  velocity: number;
  isGhost: boolean;
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

// Energy gain ramps [startMult, endMult] — the contrast IS the genre
const SECTION_ENERGY: Record<RemixSectionKind, [number, number]> = {
  'intro':       [0.42, 0.62],
  'buildup':     [0.66, 1.00], // rises continuously into the drop
  'drop':        [1.00, 1.00],
  'breakdown':   [0.30, 0.22], // pulled WAY back
  'second-drop': [1.00, 1.00],
  'outro':       [0.68, 0.16]  // fades out
};

// Per-track base level — sets relative balance: vocal on top, fills as texture
const TRACK_LEVEL: Record<RemixTrackType, number> = {
  'acapella': 0.82,
  'drums':    0.72,
  'bass':     0.65,
  'fills':    0.48
};

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
  const bassPreset: GrowlPreset = {
    osc1: 'sawtooth',
    osc2: 'square',
    detuneCents: 12,
    detuneSpreadCents: 16,
    unisonVoices: 4,
    cutoffHz: 820,
    resonance: 12,
    filterEnvelopeAmount: 0.78,
    keyTrack: 0.32,
    formantAmount: 0.45,
    lfoShape: 'sine',
    wobbleMode: 'sync',
    syncDivision: '1/8',
    freeHz: 4,
    lfoDepth: 0.85,
    secondLfoDepth: 0.35,
    secondLfoHz: 0.65,
    drive: 0.82,
    driveType: 'foldback',
    subLevel: 0.95,
    attack: 0.005,
    decay: 0.18,
    sustain: 0.58,
    release: 0.16,
    filterAttack: 0.02,
    filterDecay: 0.2,
    filterSustain: 0.35,
    filterRelease: 0.12,
    bpm: TARGET_BPM,
    glideSeconds: 0.08
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
    const breakdown = sectionMap.get('breakdown');
    const secondDrop = sectionMap.get('second-drop');
    if (buildup) track.clips.push(createAudioClip(track.id, buildup, 'verse', next.flipPrep.acapella140Url));
    if (drop) track.clips.push(createAudioClip(track.id, drop, 'hook', next.flipPrep.acapella140Url));
    if (breakdown) track.clips.push(createAudioClip(track.id, breakdown, 'verse-break', next.flipPrep.acapella140Url));
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
  const pairs = arrangement.tracks.map((track) => ({ stem: renderArrangementGuideStem(arrangement, track.type, sampleRate), type: track.type }));
  const mixed = mixArrangementStemsWithContext(pairs.map((p) => p.stem), pairs.map((p) => p.type), arrangement);
  applyEnergyDeltaSuckOutAndImpacts(mixed.channels[0], mixed.channels[1], sampleRate, arrangement.targetBpm, arrangement.sections, arrangement.detectedKey);
  return mixed;
}

export function renderArrangementMasterWithAudio(arrangement: RemixArrangement, assets: RemixAudioAssets, sampleRate = 44100): ChannelBuffer {
  const pairs = arrangement.tracks.map((track) => ({ stem: renderArrangementStemWithAudio(arrangement, track.type, assets, sampleRate), type: track.type }));
  const mixed = mixArrangementStemsWithContext(pairs.map((p) => p.stem), pairs.map((p) => p.type), arrangement);
  applyEnergyDeltaSuckOutAndImpacts(mixed.channels[0], mixed.channels[1], sampleRate, arrangement.targetBpm, arrangement.sections, arrangement.detectedKey);
  return mixed;
}

export function renderArrangementStemWithAudio(arrangement: RemixArrangement, trackType: RemixTrackType, assets: RemixAudioAssets, sampleRate = 44100): ChannelBuffer {
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
    if (clip.type === 'audio') {
      if (!assets.acapella140) throw new Error('Real acapella audio is required to render Remix audio clips');
      renderAudioClip(left, right, sampleRate, arrangement.targetBpm, clip, assets.acapella140, 1.05);
    }
  }

  return { sampleRate, channels: [left, right] };
}

function mixArrangementStems(stems: ChannelBuffer[]): ChannelBuffer {
  const sampleRate = stems[0]?.sampleRate ?? 44100;
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

// Section-energy + per-track-level mixer. Applies SECTION_ENERGY ramp × TRACK_LEVEL to each
// stem on-the-fly so the master has real energy architecture without touching the raw stems.
function mixArrangementStemsWithContext(stems: ChannelBuffer[], trackTypes: RemixTrackType[], arrangement: RemixArrangement): ChannelBuffer {
  const sampleRate = stems[0]?.sampleRate ?? 44100;
  const frames = stems[0]?.channels[0]?.length ?? 0;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const beatSeconds = 60 / arrangement.targetBpm;
  const MIX_SAFETY = 0.92; // headroom for 4 tracks summing

  for (let k = 0; k < stems.length; k++) {
    const stem = stems[k];
    const trackType = trackTypes[k];
    if (!stem || !trackType) continue;

    const trackLevel = TRACK_LEVEL[trackType];
    const segments = arrangement.sections.map((section) => {
      const [sm, em] = SECTION_ENERGY[section.kind];
      return {
        startFrame: Math.floor(section.startBar * 4 * beatSeconds * sampleRate),
        endFrame:   Math.floor((section.startBar + section.bars) * 4 * beatSeconds * sampleRate),
        startGain: sm * trackLevel,
        endGain:   em * trackLevel
      };
    });

    let si = 0;
    for (let i = 0; i < frames; i++) {
      while (si < segments.length - 1 && i >= segments[si].endFrame) si++;
      const seg = segments[si];
      const span = seg.endFrame - seg.startFrame;
      const t = span > 0 ? Math.max(0, Math.min(1, (i - seg.startFrame) / span)) : 0;
      const gain = (seg.startGain + (seg.endGain - seg.startGain) * t) * MIX_SAFETY;
      left[i]  += (stem.channels[0]?.[i] ?? 0) * gain;
      right[i] += (stem.channels[1]?.[i] ?? stem.channels[0]?.[i] ?? 0) * gain;
    }
  }

  return { sampleRate, channels: [left, right] };
}

export function getRootMidi(key: string): number {
  let clean = key.trim().split(' ')[0] || 'A';
  if (clean.endsWith('b') && clean.length > 1) {
    const flats: Record<string, string> = {
      'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'
    };
    clean = flats[clean] ?? clean;
  }
  const baseMidiMap: Record<string, number> = {
    'C': 24, 'C#': 25, 'D': 26, 'D#': 27, 'E': 28, 'F': 29,
    'F#': 30, 'G': 31, 'G#': 32, 'A': 33, 'A#': 34, 'B': 35
  };
  return baseMidiMap[clean] ?? 33; // Default to A1 (33)
}

// Energy Delta: thins last 2 bars of buildup; Suck-Out: silences last 2 beats; Stacked Impact: Kick + 808 + Boom + Cymbal Swell.
function applyEnergyDeltaSuckOutAndImpacts(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  bpm: number,
  sections: RemixSection[],
  detectedKey: string
): void {
  const beatSeconds = 60 / bpm;

  for (const section of sections.filter((s) => s.kind === 'drop' || s.kind === 'second-drop')) {
    const downbeatFrame = Math.floor(section.startBar * 4 * beatSeconds * sampleRate);

    // 1. Find buildup section that precedes this drop
    const precedingSection = sections.find((s) => s.startBar + s.bars === section.startBar);
    if (precedingSection) {
      // 1.1 Energy Delta: Pull final 2 bars (8 beats) of buildup way back (attenuate from 100% down to 25%)
      const energyDeltaStartFrame = Math.floor((section.startBar * 4 - 8) * beatSeconds * sampleRate);
      const energyDeltaEndFrame = Math.floor((section.startBar * 4 - 2) * beatSeconds * sampleRate);
      const energySpan = energyDeltaEndFrame - energyDeltaStartFrame;
      for (let i = energyDeltaStartFrame; i < energyDeltaEndFrame && i < left.length; i++) {
        if (i < 0) continue;
        const t = (i - energyDeltaStartFrame) / Math.max(1, energySpan);
        const gain = 1.0 - t * 0.75; // smoothly ramp down to 25% volume
        left[i] *= gain;
        right[i] *= gain;
      }

      // 1.2 Suck-Out: Fade to absolute silence over the last 2 beats of the buildup
      const suckOutStartFrame = Math.floor((section.startBar * 4 - 2) * beatSeconds * sampleRate);
      const suckOutEndFrame = downbeatFrame;
      const suckSpan = suckOutEndFrame - suckOutStartFrame;
      for (let i = suckOutStartFrame; i < suckOutEndFrame && i < left.length; i++) {
        if (i < 0) continue;
        const t = (i - suckOutStartFrame) / Math.max(1, suckSpan);
        const gain = Math.max(0, 1.0 - t / 0.80); // absolute silence in the final 20% of the suck-out zone
        left[i] *= gain;
        right[i] *= gain;
      }

      // 1.3 Tension Build: Overlay reverse cymbal swell rising into the downbeat (last 2 beats of buildup)
      const swellDuration = 2.0 * beatSeconds;
      const swellFrames = Math.floor(swellDuration * sampleRate);
      const swellStartFrame = downbeatFrame - swellFrames;
      let prevNoise = 0;
      let noiseState = 54321 + downbeatFrame;
      for (let i = 0; i < swellFrames; i++) {
        const frame = swellStartFrame + i;
        if (frame < 0 || frame >= left.length) continue;
        const t = i / swellFrames;
        const env = Math.pow(t, 4.5); // steep exponential rise

        noiseState = Math.imul(1664525, noiseState) + 1013904223;
        const noiseVal = ((noiseState >>> 0) / 4294967296) * 2 - 1;

        // highpass filter approximation (difference between adjacent noise samples)
        const hpVal = noiseVal - prevNoise;
        prevNoise = noiseVal;

        const swellSample = hpVal * env * 0.18;
        left[frame] += swellSample;
        right[frame] += swellSample;
      }
    }

    // 2. Stacked Drop Impact (exactly at downbeatFrame)
    if (downbeatFrame >= left.length) continue;

    // 2.1 The Three-Layer Kick (impact transient)
    addThreeLayerKick(left, right, downbeatFrame, sampleRate, 0.95);

    // 2.2 Deep 808 Sub Bass Hit on key tonic root (decaying sine sweep)
    const rootMidi = getRootMidi(detectedKey);
    const fSub = midiToFrequency(rootMidi);
    const subDuration = 2.5 * beatSeconds;
    const subFrames = Math.floor(subDuration * sampleRate);
    let subPhase = 0;
    for (let i = 0; i < subFrames; i++) {
      const frame = downbeatFrame + i;
      if (frame >= left.length) continue;
      const t = i / sampleRate;
      const env = Math.exp(-1.5 * (i / subFrames)); // slower exponential decay
      const pitchSweep = 1.0 + 0.4 * Math.exp(-95 * t); // fast pitch sweep (impact slam)
      subPhase += (2 * Math.PI * (fSub * pitchSweep)) / sampleRate;
      const subSample = Math.sin(subPhase) * env * 0.70; // massive low-end weight
      left[frame] += subSample;
      right[frame] += subSample;
    }

    // 2.3 Slam Low Impact Boom (swept lowpass filtered noise)
    const boomDuration = 2.4 * beatSeconds;
    const boomFrames = Math.floor(boomDuration * sampleRate);
    let filterState = 0;
    let boomNoiseState = 876543 + downbeatFrame;
    for (let i = 0; i < boomFrames; i++) {
      const frame = downbeatFrame + i;
      if (frame >= left.length) continue;
      const t = i / boomFrames;
      const env = Math.pow(1.0 - t, 2.5); // smooth decay

      boomNoiseState = Math.imul(1664525, boomNoiseState) + 1013904223;
      const noiseVal = ((boomNoiseState >>> 0) / 4294967296) * 2 - 1;

      // sweep lowpass filter cutoff from 350 Hz down to 20 Hz
      const cutoff = 350 * Math.pow(1.0 - t, 3.0) + 20;
      const rc = 1.0 / (2 * Math.PI * cutoff);
      const dt = 1.0 / sampleRate;
      const alpha = dt / (rc + dt);
      filterState = filterState + alpha * (noiseVal - filterState);

      const boomSample = filterState * env * 0.45;
      left[frame] += boomSample;
      right[frame] += boomSample;
    }
  }
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
  // breakdown included — vocal fullness there is a key energy contrast moment
  for (const [id, phrase] of [['buildup', 'verse'], ['drop', 'hook'], ['breakdown', 'verse-break'], ['second-drop', 'hook-alt']] as const) {
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
  for (const section of sections.filter((s) => s.kind === 'drop' || s.kind === 'second-drop')) {
    const isSecondDrop = section.kind === 'second-drop';
    for (let bar = 0; bar < section.bars; bar++) {
      const notes = buildBassBar(scale, bar % 4, Math.floor(bar / 4), isSecondDrop);
      const startBar = section.startBar + bar;
      // midi + frequencyHz kept for backward-compat with browser view (reads clip.payload.midi)
      track.clips.push(createClip(track.id, 'bass-growl', { id: section.id, startBar, bars: 1 }, {
        notes,
        preset: bassPreset,
        midi: notes.length > 0 ? notes[0].midiNote : 60,
        frequencyHz: notes.length > 0 ? notes[0].frequencyHz : midiToFrequency(60),
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
  const swingRatio = (clip.payload.swing as number | undefined) ?? 0.04;
  const seed = String(clip.payload.seed ?? clip.id);
  const startFrame = Math.floor(clip.startBeat * beatSeconds * sampleRate);
  const totalBeats = clip.durationBeats;
  const totalBars = Math.round(totalBeats / 4);
  const rng = createArrangerRng(seed);
  const velTable = Array.from({ length: 32 }, () => 0.80 + rng() * 0.20);
  const STEP = 0.25; // 1/16th note resolution

  for (let s = 0; s < Math.round(totalBeats / STEP); s++) {
    const rawBeat = s * STEP;
    const barIndex = Math.floor(rawBeat / 4);
    const stepInBar = Math.round((rawBeat % 4) / STEP) % 16; // 0–15
    const swingFrames = stepInBar % 2 === 1 ? Math.floor(swingRatio * beatSeconds * sampleRate) : 0;
    const frame = startFrame + Math.floor(rawBeat * beatSeconds * sampleRate) + swingFrames;
    if (frame >= left.length) continue;
    const vel = velTable[(barIndex * 16 + stepInBar) % 32] ?? 1.0;

    if (pattern === 'sparse-intro') drumSparseIntro(left, right, frame, sampleRate, barIndex, totalBars, stepInBar, vel);
    else if (pattern === 'buildup-riser') drumBuildup(left, right, frame, sampleRate, barIndex, totalBars, stepInBar, vel);
    else if (pattern === 'half-time-drop') drumDrop(left, right, frame, sampleRate, barIndex, totalBars, stepInBar, vel);
    else if (pattern === 'breakdown-space') drumBreakdown(left, right, frame, sampleRate, barIndex, totalBars, stepInBar, vel);
    else if (pattern === 'outro-tail') drumOutro(left, right, frame, sampleRate, barIndex, totalBars, stepInBar, vel);
  }
}

// Three-layer kick design: SUB swept sine + MID swept sine/noise click + TOP click transient.
function addThreeLayerKick(left: Float32Array, right: Float32Array, startFrame: number, sampleRate: number, gain: number): void {
  const subDuration = 0.120;
  const midDuration = 0.050;
  const topDuration = 0.006;
  
  const subFrames = Math.floor(subDuration * sampleRate);
  const midFrames = Math.floor(midDuration * sampleRate);
  const topFrames = Math.floor(topDuration * sampleRate);
  const totalFrames = Math.max(subFrames, midFrames, topFrames);

  const TAU = 2 * Math.PI;
  let state = 987654 + startFrame; // noise generator state

  for (let i = 0; i < totalFrames && startFrame + i < left.length; i++) {
    const t = i / sampleRate;
    let sample = 0;

    // 1. SUB sine sweep (150 -> 45 Hz)
    if (i < subFrames) {
      const tRatio = i / subFrames;
      const env = Math.cos(tRatio * Math.PI * 0.5); // Cosine decay
      const phase = TAU * (150 * t + 0.5 * (45 - 150) * t * tRatio);
      sample += Math.sin(phase) * 0.58 * env;
    }

    // 2. MID sine sweep (250 -> 75 Hz) + mid noise thud
    if (i < midFrames) {
      const tRatio = i / midFrames;
      const env = Math.cos(tRatio * Math.PI * 0.5);
      const phase = TAU * (250 * t + 0.5 * (75 - 250) * t * tRatio);
      
      state = Math.imul(1664525, state) + 1013904223;
      const noise = (((state >>> 0) / 4294967296) * 2 - 1) * 0.10 * env;
      
      sample += (Math.sin(phase) * 0.28 + noise) * env;
    }

    // 3. TOP click (fast high transient)
    if (i < topFrames) {
      const env = 1 - (i / topFrames);
      state = Math.imul(1664525, state) + 1013904223;
      const noise = (((state >>> 0) / 4294967296) * 2 - 1) * 0.18 * env;
      sample += noise;
    }

    const kickSample = sample * gain;
    left[startFrame + i] += kickSample;
    right[startFrame + i] += kickSample;
  }
}

// sparse-intro: kick + snare backbone enter progressively; hats emerge in second half
function drumSparseIntro(
  left: Float32Array, right: Float32Array, frame: number, sampleRate: number,
  barIndex: number, totalBars: number, stepInBar: number, vel: number
): void {
  const progress = barIndex / Math.max(1, totalBars - 1);
  if (stepInBar === 0) {
    addThreeLayerKick(left, right, frame, sampleRate, (0.38 + progress * 0.14) * vel);
  }
  // Snare enters at bar 2, builds in volume
  if (stepInBar === 8 && barIndex >= 2) {
    addNoiseBurst(left, right, frame, sampleRate, (0.22 + progress * 0.08) * vel, 0.08);
  }
  // Sparse offbeat hats (beats 1-and and 3-and) in second half only
  if ((stepInBar === 2 || stepInBar === 10) && progress > 0.55) {
    addNoiseBurst(left, right, frame, sampleRate, 0.05 * vel, 0.020);
  }
}

// buildup-riser: half-time backbone + densifying hats, 2-bar snare roll into the drop
function drumBuildup(
  left: Float32Array, right: Float32Array, frame: number, sampleRate: number,
  barIndex: number, totalBars: number, stepInBar: number, vel: number
): void {
  const progress = barIndex / Math.max(1, totalBars - 1);
  const barsLeft = totalBars - barIndex; // 1 = last bar, 2 = second-to-last

  // Kick every bar, getting harder
  if (stepInBar === 0) {
    addThreeLayerKick(left, right, frame, sampleRate, (0.42 + progress * 0.16) * vel);
  }

  if (barsLeft <= 2) {
    // Snare roll: 1/8ths in second-to-last bar, full 1/16ths in last bar
    const rollProgress = (2 - barsLeft + stepInBar / 16) / 2; // 0..1 across 2 bars
    const rollGain = Math.min(0.55, (0.18 + rollProgress * 0.37) * vel);
    const isRollHit = barsLeft <= 1 ? true : stepInBar % 2 === 0 && stepInBar > 0;
    if (isRollHit) addNoiseBurst(left, right, frame, sampleRate, rollGain, 0.065);
    // Step 0 of last bar: kick + snare wall of sound
    if (barsLeft <= 1 && stepInBar === 0) addNoiseBurst(left, right, frame, sampleRate, rollGain, 0.065);
  } else {
    // Normal snare on beat 3 (step 8)
    if (stepInBar === 8) {
      addNoiseBurst(left, right, frame, sampleRate, (0.26 + progress * 0.10) * vel, 0.09);
    }
    // Snare accent on "4-and" (step 14) in last 4 bars before the roll
    if (stepInBar === 14 && barsLeft <= 4) {
      addNoiseBurst(left, right, frame, sampleRate, 0.19 * vel, 0.07);
    }
  }

  // Hi-hats during buildup body (not during roll)
  if (barsLeft > 2) {
    const isEighthOff = stepInBar === 2 || stepInBar === 6 || stepInBar === 10 || stepInBar === 14;
    const isOnbeatEighth = stepInBar === 4 || stepInBar === 12;
    const isOddSixteenth = stepInBar % 2 === 1;
    if (isEighthOff) addNoiseBurst(left, right, frame, sampleRate, 0.065 * vel, 0.022);
    if (isOnbeatEighth && progress > 0.4) addNoiseBurst(left, right, frame, sampleRate, 0.050 * vel, 0.020);
    if (isOddSixteenth && progress > 0.70) addNoiseBurst(left, right, frame, sampleRate, 0.032 * vel, 0.016);
  }
}

// half-time-drop: hard kick + snare backbone, open hat offbeat, 1/16th groove hats, fills every 4 bars
function drumDrop(
  left: Float32Array, right: Float32Array, frame: number, sampleRate: number,
  barIndex: number, totalBars: number, stepInBar: number, vel: number
): void {
  const isFillBar = (barIndex + 1) % 4 === 0;
  const isLastBar = barIndex === totalBars - 1;
  const isFill = isFillBar || isLastBar;

  // 16-step grid patterns (1 = trigger, 0 = rest)
  const kickGrid = isFill
    ? [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0] // fill bar: kick on 1, 3-and, 4-e
    : [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]; // normal bar: kick on 1, 3-and

  const snareGrid = isFill
    ? [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1] // fill bar: snare on 3, 4-and, 4-a
    : [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]; // normal bar: snare on 3

  const openHatGrid = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0]; // open hat on 2-and, 4-and

  const closedHatGrid = [0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1]; // 1/16th groove driving pocket

  if (kickGrid[stepInBar]) {
    const isAccent = stepInBar === 0;
    const isFirstBarDownbeat = barIndex === 0 && stepInBar === 0;
    if (!isFirstBarDownbeat) {
      addThreeLayerKick(left, right, frame, sampleRate, (isAccent ? 0.65 : 0.52) * vel);
    }
  }

  if (snareGrid[stepInBar]) {
    const isAccent = stepInBar === 8;
    addNoiseBurst(left, right, frame, sampleRate, (isAccent ? 0.44 : 0.28) * vel, isAccent ? 0.10 : 0.075);
  }

  if (openHatGrid[stepInBar]) {
    addNoiseBurst(left, right, frame, sampleRate, 0.16 * vel, 0.048);
  }

  if (closedHatGrid[stepInBar]) {
    addNoiseBurst(left, right, frame, sampleRate, 0.08 * vel, 0.022);
  }
}

// breakdown-space: mostly empty; sparse kick every 2 bars, snare creeps back near end
function drumBreakdown(
  left: Float32Array, right: Float32Array, frame: number, sampleRate: number,
  barIndex: number, totalBars: number, stepInBar: number, vel: number
): void {
  if (stepInBar === 0 && barIndex % 2 === 0) {
    addThreeLayerKick(left, right, frame, sampleRate, 0.30 * vel);
  }
  if (stepInBar === 8 && barIndex >= totalBars - 2) {
    addNoiseBurst(left, right, frame, sampleRate, 0.18 * vel, 0.07);
  }
}

// outro-tail: half-time groove fades out over 8 bars
function drumOutro(
  left: Float32Array, right: Float32Array, frame: number, sampleRate: number,
  barIndex: number, totalBars: number, stepInBar: number, vel: number
): void {
  const fadeGain = Math.max(0, 1 - (barIndex / Math.max(1, totalBars - 1)) * 0.90);
  if (stepInBar === 0) {
    addThreeLayerKick(left, right, frame, sampleRate, 0.50 * vel * fadeGain);
  }
  if (stepInBar === 8) {
    addNoiseBurst(left, right, frame, sampleRate, 0.34 * vel * fadeGain, 0.09);
  }
  // Offbeat hats only in first half of outro
  if ((stepInBar === 2 || stepInBar === 10) && barIndex < totalBars / 2) {
    addNoiseBurst(left, right, frame, sampleRate, 0.065 * vel * fadeGain, 0.022);
  }
}

function renderBassClip(left: Float32Array, right: Float32Array, sampleRate: number, bpm: number, clip: RemixClip): void {
  const beatSeconds = 60 / bpm;
  const startFrame = Math.floor(clip.startBeat * beatSeconds * sampleRate);
  const notes: BassNotePayload[] = Array.isArray(clip.payload.notes) ? (clip.payload.notes as BassNotePayload[]) : [];
  const swingRatio = (clip.payload.swing as number | undefined) ?? 0.04;
  
  for (const note of notes) {
    const stepInBar = Math.round((note.startBeat % 4) / 0.25) % 16;
    const swingFrames = stepInBar % 2 === 1 ? Math.floor(swingRatio * beatSeconds * sampleRate) : 0;
    const noteFrame = startFrame + Math.floor(note.startBeat * beatSeconds * sampleRate) + swingFrames;
    if (noteFrame >= left.length) continue;
    renderBassNote(left, right, noteFrame, sampleRate, bpm, note);
  }
}

// Generates the BassNotePayload array for one bar of the 4-bar repeating phrase.
// Drop 1: root/5th/b7 riff with 1/4–1/8–1/8. wobble rates.
// Drop 2: 4th/b7 riff with 1/8T–1/16 wobble — mandatory harmonic and rhythmic variation.
function buildBassBar(scale: number[], phraseBar: number, phraseIndex: number, isSecondDrop: boolean): BassNotePayload[] {
  const root = scale[0] ?? 45; // Default to A1/A2 root if scale is empty
  
  // Key-aware relative scale degrees (chromatic offsets relative to root tonic)
  const b2 = root + 1;
  const minor3rd = root + 3;
  const fourth = root + 5;
  const b5 = root + 6;
  const fifth = root + 7;
  const b7 = root + 10;

  const n = (startBeat: number, durationBeats: number, midi: number, wob: SyncDivision, vel: number, ghost: boolean): BassNotePayload => {
    const freq = midiToFrequency(midi);
    const rootFreq = midiToFrequency(root);
    return { 
      startBeat, 
      durationBeats, 
      midiNote: midi, 
      frequencyHz: Number(freq.toFixed(2)), 
      // Sub-bass is locked to the root key frequency for constant deep low-end body
      subFrequencyHz: Number(resolveDubstepSubFrequency(rootFreq).toFixed(2)), 
      wobbleDivision: wob, 
      velocity: vel, 
      isGhost: ghost 
    };
  };

  if (!isSecondDrop) {
    // DROP 1 — melodic and dynamic wub-rate bassline hook
    if (phraseBar === 0) {
      // Melodic Hook - slow 1/8. to fast 1/8T triplet rise
      return [
        n(0.0, 1.5, root, '1/8.', 0.95, false),
        n(1.5, 1.0, b7, '1/8T', 0.85, false),
        n(2.5, 1.0, root, '1/8', 0.90, false),
      ];
    }
    if (phraseBar === 1) {
      // Tension stabs to 1/16 rapid wub burst
      const alt = phraseIndex % 2 === 0 ? b5 : b7;
      return [
        n(0.0, 1.0, root, '1/8', 0.90, false),
        n(1.0, 1.0, b2, '1/8', 0.85, false),
        n(2.0, 1.0, alt, '1/16', 0.92, false),
        n(3.0, 1.0, fourth, '1/8', 0.80, false),
      ];
    }
    if (phraseBar === 2) {
      // Call and response - fifth calling, b5 & fourth responding with triplets
      return [
        n(0.0, 1.5, fifth, '1/8T', 0.88, false),
        n(1.5, 1.0, b5, '1/8T', 0.82, false),
        n(2.5, 1.0, fourth, '1/8T', 0.85, false),
      ];
    }
    // phraseBar === 3: Groove resolve with 1/16th burst
    return [
      n(0.0, 1.0, b7, '1/8', 0.88, false),
      n(1.0, 1.0, root, '1/16', 0.95, false),
      n(2.0, 1.0, minor3rd, '1/8', 0.84, false),
      n(3.0, 1.0, root, '1/8', 0.90, false),
    ];
  } else {
    // DROP 2 — syncopated triplet/1/16 wub bursts, Locrian stabs, heavy resolve
    if (phraseBar === 0) {
      // Triplet drive to slow wub
      return [
        n(0.0, 1.0, fourth, '1/16', 0.92, false),
        n(1.0, 1.0, fifth, '1/8T', 0.88, false),
        n(2.0, 1.5, root, '1/8', 0.90, false),
      ];
    }
    if (phraseBar === 1) {
      // Syncopated melodic stab chain
      return [
        n(0.0,  0.75, root, '1/8', 0.90, false),
        n(0.75, 0.75, b2, '1/16', 0.82, false),
        n(1.5,  0.75, b5, '1/8T', 0.88, false),
        n(2.25, 0.75, fourth, '1/8', 0.80, false),
        n(3.0,  1.0,  root, '1/16', 0.85, false),
      ];
    }
    if (phraseBar === 2) {
      // Locrian hooks
      return [
        n(0.0, 1.5, b7, '1/8.', 0.88, false),
        n(1.5, 1.0, b5, '1/16', 0.90, false),
        n(2.5, 1.5, root, '1/8', 0.92, false),
      ];
    }
    // phraseBar === 3: Long sustained root wub resolving the phrase
    return [
      n(0.0, 1.0, fourth, '1/8', 0.85, false),
      n(1.0, 3.0, root, '1/4', 0.95, false),
    ];
  }
}

function getSidechainGain(frame: number, sampleRate: number, bpm: number): number {
  const beatSeconds = 60 / bpm;
  const frameBeat = frame / (beatSeconds * sampleRate);
  const barIndex = Math.floor(frameBeat / 4);
  const isFillBar = (barIndex + 1) % 4 === 0;

  // Kicks trigger at step 0 (beat 1), step 10 (beat 3-and) and step 13 (beat 4-e in fill bars)
  const kickSteps = isFillBar ? [0, 10, 13] : [0, 10];
  let minDistanceFrames = Infinity;
  const barStartFrame = barIndex * 4 * beatSeconds * sampleRate;

  for (const step of kickSteps) {
    const kickFrame = Math.floor(barStartFrame + step * 0.25 * beatSeconds * sampleRate);
    const dist = frame - kickFrame;
    if (dist >= 0 && dist < minDistanceFrames) {
      minDistanceFrames = dist;
    }
  }

  const scDuration = 0.38 * beatSeconds; // ~150ms sidechain window
  const scFrames = Math.floor(scDuration * sampleRate);
  if (minDistanceFrames < scFrames) {
    const t = minDistanceFrames / scFrames;
    return Math.pow(t, 2.0); // smooth exponential recovery
  }
  return 1.0;
}

// Renders one bass note: sub layer (pure sine, mono, long) + mid layer (resonant filter sweep + drive).
function renderBassNote(left: Float32Array, right: Float32Array, startFrame: number, sampleRate: number, bpm: number, note: BassNotePayload): void {
  const frames = Math.floor(note.durationBeats * (60 / bpm) * sampleRate);
  if (frames <= 0) return;

  const attackFrames = Math.min(Math.floor(0.008 * sampleRate), Math.floor(frames * 0.15));
  const releaseFrames = Math.min(Math.floor(0.10 * sampleRate), Math.floor(frames * 0.40));
  const lfoHz = lfoSyncHz(bpm, note.wobbleDivision);

  const subGain = note.isGhost ? 0 : 0.48 * note.velocity;
  const midGain = note.isGhost ? 0.14 * note.velocity : 0.22 * note.velocity;
  const fSub = note.subFrequencyHz;
  const fMid = note.frequencyHz;
  const TAU = 2 * Math.PI;

  for (let i = 0; i < frames && startFrame + i < left.length; i++) {
    const t = i / sampleRate;
    const envAtk = i < attackFrames ? i / Math.max(1, attackFrames) : 1.0;
    const envRel = i > frames - releaseFrames ? (frames - i) / Math.max(1, releaseFrames) : 1.0;
    const env = Math.min(envAtk, envRel);

    // LFO wobble controls both filter cutoff opening and amplitude
    const lfo = 0.48 + 0.52 * Math.sin(TAU * lfoHz * t);

    // Sub: pure sine, mono — constant volume (no LFO wobble ducking)
    const subSample = note.isGhost ? 0 : Math.sin(TAU * fSub * t) * subGain * env;

    // Mid: simulated resonant lowpass filter sweep on harmonic series (sawtooth approx)
    const cutoffHz = fMid * (1.5 + 5.0 * lfo); // sweep cutoff based on LFO
    let mid = 0;
    const harmonics = [
      { h: 1, amp: 0.55 },
      { h: 2, amp: 0.27 },
      { h: 3, amp: 0.14 },
      { h: 4, amp: 0.07 },
      { h: 5, amp: 0.04 }
    ];

    for (const { h, amp } of harmonics) {
      const f_h = fMid * h;
      let filterAtt = 1.0;
      if (f_h > cutoffHz) {
        filterAtt = Math.pow(cutoffHz / f_h, 2.0); // 12 dB/octave attenuation
      }
      
      // Simulate resonance peak near cutoff
      const distanceToCutoff = Math.abs(f_h - cutoffHz);
      const qBoost = 0.35 * Math.exp(-Math.pow(distanceToCutoff / (cutoffHz * 0.18), 2.0));
      
      mid += Math.sin(TAU * f_h * t) * amp * (filterAtt + qBoost);
    }

    // Saturated waveshaper distortion (Da Wubs style)
    let midSample = mid * midGain * env;
    midSample = Math.tanh(midSample * 1.8) * 0.85;

    const scGain = getSidechainGain(startFrame + i, sampleRate, bpm);
    left[startFrame + i] += (subSample + midSample) * scGain;
    right[startFrame + i] += (subSample + midSample * 0.88) * scGain; // slight mid stereo width
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

function renderAudioClip(left: Float32Array, right: Float32Array, sampleRate: number, bpm: number, clip: RemixClip, source: ChannelBuffer, gain: number): void {
  const beatSeconds = 60 / bpm;
  const startFrame = Math.floor(clip.startBeat * beatSeconds * sampleRate);
  const clipFrames = Math.floor(clip.durationBeats * beatSeconds * sampleRate);
  const fadeFrames = Math.min(Math.floor(sampleRate * 0.015), Math.floor(clipFrames / 3));

  for (let i = 0; i < clipFrames && startFrame + i < left.length; i++) {
    const sourceFrame = Math.floor((i * source.sampleRate) / sampleRate);
    if (sourceFrame >= (source.channels[0]?.length ?? 0)) break;
    const fadeIn = fadeFrames > 0 && i < fadeFrames ? i / fadeFrames : 1;
    const fadeOut = fadeFrames > 0 && i > clipFrames - fadeFrames ? (clipFrames - i) / fadeFrames : 1;
    const env = Math.max(0, Math.min(1, fadeIn, fadeOut));
    const sourceLeft = source.channels[0]?.[sourceFrame] ?? 0;
    const sourceRight = source.channels[1]?.[sourceFrame] ?? sourceLeft;
    left[startFrame + i] += sourceLeft * gain * env;
    right[startFrame + i] += sourceRight * gain * env;
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
