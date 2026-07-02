# Ears-On Log

Nothing in this codebase is "finalized" on code review or passing tests
alone — audio-generating code is only actually done once a human has
listened to a real render and confirmed it holds up. Log every listen here,
pass or fail, before calling the corresponding change finished.

Note: `dubstep-remixer.md` and `flip-prep.md` in this repo both describe
work (a Critique Engine, Reference Vault, WorkerManager, job-management
endpoints) that was never actually implemented — see git history. Don't
trust status claims in this repo without checking the log below or the
actual code.

## Format

```
## YYYY-MM-DD — <track/file> — <what changed>
Status: PASS | FAIL | NEEDS-FOLLOWUP
What was heard:
- ...
```

## Pending listens (Phase 1, this session)

The following changes are real, tested at the code/unit level, and verified
to run without errors — but none of them have been listened to yet. Render
outputs are in `output/` (see below). Please listen and log a real entry
above the line once you have:

- **Drop 2 bassline rewrite** (`src/lib/producer-tools/arranger.ts`,
  `buildBassBar`) — drop 2 was rewritten to use disjoint pitch/rhythm
  vocabulary from drop 1 (enforced by `scoreDropVariation`, was previously
  86%/80% overlapping). Listen for: does drop 2 actually feel like a
  variation on drop 1, not a copy? Does it still sound musically coherent?
- **Ghost notes** (same file) — `isGhost` was dead code (always `false`);
  now a handful of bass notes per phrase are deliberately ghosted (sub
  silent, mid pulled down) for groove. Listen for: does this read as groove/
  breathing room, or as missing notes / a glitch?
- **BPM octave correction** (`src/flip-worker/python/analyze_and_stretch.py`)
  — tempo detection outside 60-200 BPM now folds by octave. Listen for:
  does the 140 half-time stretch feel tempo-locked on a variety of source
  tracks, especially already-fast or already-slow ones?
- **Live playback fix** (`src/producer-tools/RemixToDubstepView.tsx`) —
  "Play Skeleton" previously did nothing at all (Tone.js/raw AudioContext
  mismatch, silently swallowed). Now actually plays. Listen for: does the
  live in-app preview sound right — levels, no clicks/dropouts, mastering
  chain (compression/saturation/mono-sub) audibly present?
- **DubstepVisualizer** (`src/producer-tools/DubstepVisualizer.tsx`) — new
  canvas visualizer, not audio, but should be *watched* alongside a listen:
  does the sub-bass core / mid-bass ring / transient shockwaves actually
  track what's playing, or does it feel disconnected from the music?
- **WubPad mute/solo buttons** — now show active state locally on click.
  Not an audio check, but worth confirming the visual state doesn't drift
  from actual audible mute state once the engine is connected.

## Rendered output for this session

`test-audio/eulogy_short.mp3` run through the full pipeline (Flip Prep →
Demucs stem separation → key/BPM detection → 140 half-time acapella stretch
→ generateRemixArrangement → renderArrangementMasterWithAudio →
renderBufferToWav) — see console output / commit message for the exact file
path and detected key/BPM at render time.
