# Bass Synth

Bass Synth is a dubstep growl instrument registered in `src/App.tsx`.

## Engine Integration

- The view reads BPM through `WubLabzEngine` and keeps the synth BPM aligned with the engine transport.
- Voice construction lives in `src/lib/audio/GrowlVoiceGraph.ts`.
- Live playback uses `src/lib/audio/ProducerAudioEngine.ts`, the shared analyser, headroom gain, gentle bus compressor, and producer master soft limiter.
- Presets use `src/lib/persistence/ProducerPresetPersistence.ts`.
- One-shot WAV export uses `src/lib/export/AudioRenderExport.ts`, including shared export headroom, glue saturation, low-end mono compatibility, limiting, and normalization.

## Voice

The voice graph is detuned dual oscillator plus optional unison and a clean phase-reset sine sub. Upper harmonics use a split-drive path: lows under roughly 180 Hz stay clean, highs hit the selected drive curve, and both flow into the resonant lowpass plus a subtle bandpass formant stage. The sine sub bypasses the drive/filter growl path through its own lowpass so energy below roughly 80 Hz stays solid instead of being hollowed out by distortion or wobble sweeps.

The filter envelope opens above the key-tracked base cutoff during attack, then settles to the sustain cutoff. That attack sweep is what gives the patch a more vocal "wow" instead of a flat distorted buzz. Resonance is clamped in the voice graph so high settings stay musical and do not run away into self-oscillation.

## Controls

- `SPREAD`: detunes the paired oscillators across each unison voice for width and beating without touching the clean sub.
- `UNISON`: layers one to four deterministic oscillator pairs for thickness.
- `ENV AMT`: scales how far the filter envelope opens on note attack.
- `KEY TRACK`: raises cutoff on higher notes so patches do not become dull up the keyboard or overly harsh on low notes.
- `FORMANT`: blends the second bandpass filter stage for a talking vowel-like growl.
- `LFO`: phase-reset wobble shape: sine, triangle, square, or ramp.
- `LFO 2` / `LFO 2 HZ`: slow secondary movement on the formant stage for evolving timbre.
- `DRIVE TYPE`: soft, hard, or foldback saturation. The drive output is gain-compensated so more grit does not simply mean more loudness.
- `SUB`: clean sine level below the growl path.

## Quality Pass

- Amp ADSR and filter ADSR are both exposed in the view.
- Wobble can run from engine BPM sync (`1/4`, `1/8`, dotted `1/8`, `1/16`) or free Hz mode, and resets phase on note start for tighter rhythmic bass.
- Live play uses a six-voice pool so overlapping keyboard notes do not cut each other off immediately.
- Drive remains selectable (`soft`, `hard`, `foldback`) and is applied only above the 180 Hz split, keeping the sub cleaner.
- One-shot export renders the full release tail, preserves mono-compatible lows under 120 Hz, and normalizes to roughly -1 dBFS through the shared export helper.
