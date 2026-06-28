# Bass Synth

Bass Synth is a dubstep growl instrument registered in `src/App.tsx`.

## Engine Integration

- The view reads BPM through `WubLabzEngine` and keeps the synth BPM aligned with the engine transport.
- Voice construction lives in `src/lib/audio/GrowlVoiceGraph.ts`.
- Live playback uses `src/lib/audio/ProducerAudioEngine.ts`, the shared analyser, and the producer master soft limiter.
- Presets use `src/lib/persistence/ProducerPresetPersistence.ts`.
- One-shot WAV export uses `src/lib/export/AudioRenderExport.ts`, including shared export normalization.

## Voice

The voice graph is dual oscillator plus sub into a split-drive path: lows under roughly 180 Hz stay clean, highs hit the selected drive curve, and both flow into the resonant lowpass. Amp and filter ADSR envelopes are scheduled on every note.

The filter envelope opens above the base cutoff during attack, then settles to the sustain cutoff. That attack sweep is what gives the patch a more vocal "wow" instead of a flat distorted buzz.

## Quality Pass

- Amp ADSR and filter ADSR are both exposed in the view.
- Wobble can run from engine BPM sync (`1/4`, `1/8`, dotted `1/8`, `1/16`) or free Hz mode.
- Live play uses a six-voice pool so overlapping keyboard notes do not cut each other off immediately.
- Drive remains selectable (`soft`, `hard`, `foldback`) and is applied only above the 180 Hz split, keeping the sub cleaner.
- One-shot export renders the full release tail and normalizes to roughly -1 dBFS through the shared export helper.
