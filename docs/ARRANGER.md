# Remix to Dubstep Arranger

The Remix to Dubstep view creates an editable skeleton, not a finished auto-track. It uses Flip Prep analysis/stems and WubLabz producer tools to lay out a dubstep starting point the user can finish in WubLabz or a DAW.

## Pipeline

1. The view uploads the source song through the existing Flip Prep HTTP contract.
2. Flip Prep returns detected key, source BPM, stems, and `acapella_140.wav`.
3. `src/lib/producer-tools/arranger.ts` creates a 140 BPM half-time arrangement model.
4. The UI renders that model as sections, tracks, and clips on a timeline.
5. Playback/export use WubLabz producer audio and export helpers.

## Arrangement Model

The arrangement is structured data:

- `sections`: intro, buildup, drop, breakdown, second drop, outro.
- `tracks`: acapella, drums, bass, fills.
- `clips`: typed timeline items with `startBar`, `bars`, `startBeat`, `durationBeats`, and payload data.

The default section map is 72 bars:

- intro: 8 bars
- buildup: 16 bars
- drop: 16 bars
- breakdown: 8 bars
- second drop: 16 bars
- outro: 8 bars

All clips are generated on the 140 BPM grid. The source BPM is preserved as metadata, but the skeleton target is always 140.

## Engine Use

- Flip Prep is reused through `src/lib/producer-tools/flipPrepApi.ts`; separation is not duplicated.
- Bass clips are key-matched from the detected or overridden key and use the improved `GrowlVoiceGraph` preset shape.
- Drum clips are rule-based half-time patterns placed by section.
- Fill clips are Mangler-style transition clips using seed, slice, and glitch payloads.
- Playback schedules the guide skeleton through `ProducerAudioEngine` and the shared analyser/limiter path.
- WAV export uses `src/lib/export/AudioRenderExport.ts`, so guide stems and master bounce are normalized/limited consistently.

## Editing

The first UI pass supports:

- play/stop skeleton transport
- mute/solo track state
- regenerate drums, bass, or fills from a seed
- randomize the growl bass lane
- shift acapella placement by bar
- override key and regenerate
- export per-track guide stems and a master guide bounce

## Future Seam

Generative bass is deliberately deferred. A future MusicGen, local model, or cloud bass generator should sit behind the bass clip payload/generation step in `arranger.ts` and return editable bass clip data, not a finished opaque bounce.
