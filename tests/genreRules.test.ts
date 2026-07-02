import { describe, expect, it } from 'vitest';
import {
  applyGhostNoteRule,
  GROOVE_FEEL_RULES,
  HARMONY_SCALES,
  resolveHarmonyMode,
  scoreDropVariation,
  TRANSITION_RULES,
  type DropVariationInput
} from '../src/lib/producer-tools/genreRules.js';
import { explainArrangementDecisions, generateRemixArrangement, isMidiInKey, keyToMidiScale, type RemixTrack } from '../src/lib/producer-tools/arranger.js';
import type { SyncDivision } from '../src/lib/producer-tools/synth.js';

const flipPrep = {
  key: 'A minor',
  bpm: 92,
  keyConfidence: 1,
  bpmOctaveCorrected: false,
  stems: [
    { name: 'drums' as const, url: '/drums.mp3' },
    { name: 'bass' as const, url: '/bass.mp3' },
    { name: 'vocals' as const, url: '/vocals.mp3' },
    { name: 'other' as const, url: '/other.mp3' }
  ],
  acapella140Url: '/acapella_140.wav'
};

describe('groove feel: ghost notes', () => {
  it('silences the sub and pulls velocity down only at the targeted index', () => {
    const notes = [
      { startBeat: 0, velocity: 0.9, isGhost: false },
      { startBeat: 1, velocity: 0.8, isGhost: false },
      { startBeat: 2, velocity: 0.85, isGhost: false }
    ];
    const result = applyGhostNoteRule(notes, 1);
    expect(result[0].isGhost).toBe(false);
    expect(result[1].isGhost).toBe(true);
    expect(result[1].velocity).toBeCloseTo(0.8 * GROOVE_FEEL_RULES.ghostNoteVelocityScale, 5);
    expect(result[2].isGhost).toBe(false);
    expect(result[2].velocity).toBe(0.85);
  });

  it('is a no-op for an out-of-range index', () => {
    const notes = [{ startBeat: 0, velocity: 0.9, isGhost: false }];
    expect(applyGhostNoteRule(notes, 5)).toEqual(notes);
    expect(applyGhostNoteRule(notes, -1)).toEqual(notes);
  });
});

describe('harmony: minor / phrygian / harmonic-minor bias', () => {
  it('always resolves an explicitly major key to the major scale', () => {
    expect(resolveHarmonyMode('C major')).toBe('major');
    expect(HARMONY_SCALES.major).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  it('deterministically resolves the same minor-family key to the same mode every time', () => {
    const first = resolveHarmonyMode('A minor');
    const second = resolveHarmonyMode('A minor');
    expect(first).toBe(second);
    expect(['minor', 'phrygian', 'harmonicMinor']).toContain(first);
  });

  it('keeps keyToMidiScale and isMidiInKey in agreement for whichever mode a key resolves to', () => {
    const keys = ['A minor', 'C minor', 'E minor', 'G minor', 'D minor', 'F minor', 'B minor'];
    for (const key of keys) {
      const scale = keyToMidiScale(key, 3);
      for (const midi of scale) {
        expect(isMidiInKey(midi, key)).toBe(true);
      }
    }
  });

  it('produces at least two distinct modes across a spread of keys (bias is not collapsed to one mode)', () => {
    const keys = ['A minor', 'A# minor', 'B minor', 'C minor', 'C# minor', 'D minor', 'D# minor', 'E minor', 'F minor', 'F# minor', 'G minor', 'G# minor'];
    const modes = new Set(keys.map((key) => resolveHarmonyMode(key)));
    expect(modes.size).toBeGreaterThan(1);
  });
});

describe('arrangement structure: drop 2 must recontextualize drop 1', () => {
  it('scores identical drops as failing', () => {
    const input: DropVariationInput = { pitchClasses: [0, 3, 7], wobbleDivisions: ['1/8', '1/16'] as SyncDivision[] };
    const result = scoreDropVariation(input, input);
    expect(result.passes).toBe(false);
    expect(result.score).toBe(0);
  });

  it('scores fully distinct drops as passing', () => {
    const drop1: DropVariationInput = { pitchClasses: [0, 3, 7], wobbleDivisions: ['1/8'] as SyncDivision[] };
    const drop2: DropVariationInput = { pitchClasses: [1, 5, 8], wobbleDivisions: ['1/16T'] as SyncDivision[] };
    const result = scoreDropVariation(drop1, drop2);
    expect(result.passes).toBe(true);
    expect(result.score).toBe(1);
  });

  it('enforces the rule against the actual generated bass clips, not just hand-picked examples', () => {
    const arrangement = generateRemixArrangement({ flipPrep, seed: 'drop-variation-check' });
    const scale = keyToMidiScale(arrangement.detectedKey);
    const rootMidi = scale[0] ?? 45;
    const bassTrack = arrangement.tracks.find((track) => track.type === 'bass') as RemixTrack;

    const collect = (sectionId: string): DropVariationInput => {
      const pitchClasses: number[] = [];
      const wobbleDivisions: SyncDivision[] = [];
      for (const clip of bassTrack.clips) {
        if (clip.sectionId !== sectionId) continue;
        const notes = (clip.payload.notes ?? []) as Array<{ midiNote: number; wobbleDivision: SyncDivision }>;
        for (const note of notes) {
          pitchClasses.push(((note.midiNote - rootMidi) % 12 + 12) % 12);
          wobbleDivisions.push(note.wobbleDivision);
        }
      }
      return { pitchClasses, wobbleDivisions };
    };

    const result = scoreDropVariation(collect('drop'), collect('second-drop'));
    expect(result.passes).toBe(true);
  });
});

describe('transitions: pre-drop suck-out / riser architecture', () => {
  it('keeps the suck-out window inside the overall pre-drop transition window', () => {
    expect(TRANSITION_RULES.suckOutBeats).toBeLessThanOrEqual(TRANSITION_RULES.preDropTransitionBeats);
  });

  it('ramps energy down to a floor strictly between silence and full volume', () => {
    expect(TRANSITION_RULES.energyDeltaFloor).toBeGreaterThan(0);
    expect(TRANSITION_RULES.energyDeltaFloor).toBeLessThan(1);
  });
});

describe('explainArrangementDecisions: arranger self-verification', () => {
  it('traces harmony, drop variation, section energy, and mix rules for a real arrangement', () => {
    const arrangement = generateRemixArrangement({ flipPrep, seed: 'explain-test' });
    const trace = explainArrangementDecisions(arrangement);

    expect(trace.harmony.mode).toBe(resolveHarmonyMode(arrangement.detectedKey));
    expect(trace.harmony.reason).toContain(arrangement.detectedKey);

    expect(trace.dropVariation.passes).toBe(true);
    expect(trace.dropVariation.reason).toContain('distinct enough');

    const buildupSection = trace.sections.find((section) => section.kind === 'buildup');
    expect(buildupSection?.reason).toBe('Energy ramps up through this section.');
    const breakdownSection = trace.sections.find((section) => section.kind === 'breakdown');
    expect(breakdownSection?.reason).toBe('Energy pulls back through this section.');
    const dropSection = trace.sections.find((section) => section.kind === 'drop');
    expect(dropSection?.reason).toBe('Energy holds steady through this section.');

    expect(trace.mixRules.bassDuckUnderVocalFloor).toBeLessThan(trace.mixRules.drumsDuckUnderVocalFloor);
  });
});
