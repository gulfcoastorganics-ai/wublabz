// Named, tunable rule modules for the WubLabz dubstep Genre Intelligence Layer.
//
// This file is the single place to adjust "how dubstep" the engine behaves —
// tempo/groove feel, frequency lane discipline, harmony bias, and how hard
// drop 2 must differ from drop 1. Each rule set is plain data or a small pure
// function so it can be read, tuned, and unit tested (see genreRules.test.ts)
// without touching the DSP render engine in arranger.ts.
import { DUBSTEP_SUB_MIN_HZ, DUBSTEP_SUB_MAX_HZ, SPLIT_CROSSOVER_HZ, type SyncDivision } from './synth.js';

// --- Tempo / groove ---------------------------------------------------------

export const TEMPO_GROOVE_RULES = {
  targetBpm: 140,
  kickStep: 0, // beat 1, on a 16th-note grid (4 steps per beat)
  snareStep: 8, // beat 3
  // Per-hit velocity is drawn from this range so a half-time groove doesn't
  // feel quantized-to-death — see velTable in arranger.ts's renderDrumClip.
  velocityJitterRange: [0.80, 1.0] as const
};

// --- Frequency lane separation ----------------------------------------------

export const FREQUENCY_LANE_RULES = {
  subMinHz: DUBSTEP_SUB_MIN_HZ,
  subMaxHz: DUBSTEP_SUB_MAX_HZ,
  // Sub/mid-bass crossover inside a single growl voice (GrowlVoiceGraph).
  midBassCrossoverHz: SPLIT_CROSSOVER_HZ,
  // Stereo -> mono fold point for the mastered output (outputQuality.DEFAULT_LOW_MONO_HZ).
  masterMonoBassCutoffHz: 75,
  // Sidechain relationship: minimum gain a bass/drum stem is allowed to duck to
  // under the kick or lead vocal. See getSidechainGain / mixArrangementStemsWithContext.
  bassDuckUnderKickFloor: 0,
  bassDuckUnderVocalFloor: 0.3,
  drumsDuckUnderVocalFloor: 0.7
};

// --- Groove feel: silence, ghost notes, micro-timing ------------------------

export const GROOVE_FEEL_RULES = {
  // Ghost notes keep the sub silent and pull the mid layer down to this
  // fraction of a normal hit's velocity — felt as rhythmic push, not heard
  // as a distinct note. See applyGhostNoteRule below.
  ghostNoteVelocityScale: 0.4,
  // Swing applied to odd 16th steps, as a fraction of a beat.
  swingRange: [0, 0.08] as const
};

export interface GroovableNote {
  startBeat: number;
  velocity: number;
  isGhost: boolean;
}

// Deliberately ghosts the note at `ghostIndex` (if present) in a hand-authored
// phrase: sub goes silent, mid layer drops to a felt-not-heard level. Keeps
// buildBassBar's phrases pure/deterministic (no rng threaded through) while
// still giving the groove a moment of rhythmic silence instead of every note
// hitting at full velocity.
export function applyGhostNoteRule<T extends GroovableNote>(notes: T[], ghostIndex: number): T[] {
  if (ghostIndex < 0 || ghostIndex >= notes.length) return notes;
  return notes.map((note, index) => {
    if (index !== ghostIndex) return note;
    return { ...note, isGhost: true, velocity: Number((note.velocity * GROOVE_FEEL_RULES.ghostNoteVelocityScale).toFixed(2)) };
  });
}

// --- Harmony: minor / phrygian / harmonic-minor bias ------------------------

export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
export const PHRYGIAN_SCALE = [0, 1, 3, 5, 7, 8, 10];
export const HARMONIC_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 11];

export type HarmonyMode = 'major' | 'minor' | 'phrygian' | 'harmonicMinor';

export const HARMONY_SCALES: Record<HarmonyMode, number[]> = {
  major: MAJOR_SCALE,
  minor: MINOR_SCALE,
  phrygian: PHRYGIAN_SCALE,
  harmonicMinor: HARMONIC_MINOR_SCALE
};

// Weighted bias across the three minor-family modes (major is only used when
// the detected/overridden key is explicitly major). Skews toward natural
// minor since it's the most singable/recognizable dubstep default, with
// phrygian and harmonic minor in rotation for tension and drama.
const MINOR_FAMILY_WEIGHTS: Array<{ mode: HarmonyMode; weight: number }> = [
  { mode: 'minor', weight: 0.5 },
  { mode: 'phrygian', weight: 0.3 },
  { mode: 'harmonicMinor', weight: 0.2 }
];

// Mode selection is a pure function of the key text alone (no seed) so that
// keyToMidiScale(key) and isMidiInKey(midi, key) — called independently from
// different places — always agree on which mode a given key resolves to.
export function resolveHarmonyMode(key: string): HarmonyMode {
  const normalized = key.trim().toLowerCase();
  if (normalized.includes('major')) return 'major';

  const hash = hashKeyText(normalized);
  const totalWeight = MINOR_FAMILY_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = (hash % 1000) / 1000 * totalWeight;
  for (const entry of MINOR_FAMILY_WEIGHTS) {
    if (roll < entry.weight) return entry.mode;
    roll -= entry.weight;
  }
  return 'minor';
}

function hashKeyText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- Arrangement structure: drop 2 must recontextualize drop 1 -------------

export interface DropVariationInput {
  pitchClasses: number[]; // relative semitone offsets from root used across the drop's bass notes
  wobbleDivisions: SyncDivision[];
}

export interface DropVariationScore {
  score: number; // 0 (identical) .. 1 (fully distinct)
  pitchOverlapRatio: number;
  divisionOverlapRatio: number;
  passes: boolean;
}

// Drop 2 recontextualizing drop 1 (not repeating it) is a hard genre
// requirement, not a hope — this scores how distinct two drops' bass
// vocabularies are so it can be asserted in tests/generation instead of
// trusted by eye. Score combines pitch-class-set and wobble-division-set
// overlap; lower overlap (more variation) scores higher.
export function scoreDropVariation(drop1: DropVariationInput, drop2: DropVariationInput, threshold = 0.35): DropVariationScore {
  const pitchOverlapRatio = setOverlapRatio(drop1.pitchClasses, drop2.pitchClasses);
  const divisionOverlapRatio = setOverlapRatio(drop1.wobbleDivisions, drop2.wobbleDivisions);
  const score = Number((1 - (pitchOverlapRatio * 0.6 + divisionOverlapRatio * 0.4)).toFixed(3));
  return { score, pitchOverlapRatio, divisionOverlapRatio, passes: score >= threshold };
}

function setOverlapRatio<T>(a: T[], b: T[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const value of setA) if (setB.has(value)) shared += 1;
  return shared / Math.max(setA.size, setB.size);
}

// --- Transitions: pre-drop suck-out / riser architecture --------------------

export const TRANSITION_RULES = {
  preDropTransitionBeats: 8, // total pre-drop window (energy delta + suck-out), 2 bars
  suckOutBeats: 2, // tail of the window faded to absolute silence right before the downbeat
  energyDeltaFloor: 0.25, // energy delta ramps buildup volume down to this fraction
  tensionSwellBeats: 2, // reverse-cymbal-style noise swell rising into the downbeat
  tensionSwellCurve: 4.5 // exponent controlling how late the swell's rise concentrates
};

// --- Mix processing signature -----------------------------------------------

export const MIX_SIGNATURE_RULES = {
  headroomDb: -1.25,
  makeupDb: 2.25,
  saturationDrive: 1.18,
  glueThresholdDb: -7,
  glueRatio: 1.12,
  limiterDrive: 1.04,
  ceilingDb: -0.8
};
