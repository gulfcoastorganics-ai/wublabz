# Sample Mangler

Sample Mangler is a browser producer tool registered in `src/App.tsx`.

## Engine Integration

- Audio decode flows through `src/lib/audio/ProducerAudioEngine.ts`, which reuses one shared Web Audio context for producer tools.
- Playback flows through `src/lib/playback/ProducerPlayback.ts`, which routes rendered buffers through the shared analyser path.
- WAV export flows through `src/lib/export/AudioRenderExport.ts` and `src/lib/export/wav.ts`.
- Pure slice and render logic lives in `src/lib/producer-tools/mangler.ts`.

## DSP

The renderer divides the source into `N` slices, creates a seeded shuffle plan, and applies reverse/stutter decisions from one `GLITCH` macro. Each rendered slice gets equal-power edge fades from `src/lib/audio/outputQuality.ts`, and adjacent slices overlap through that fade region so slice boundaries crossfade instead of clicking.

The final buffer is soft-limited before playback/export, and WAV export also passes through the shared -1 dBFS normalization helper in `src/lib/export/AudioRenderExport.ts`.

## Deferred

- TODO: Replace the current pitch resampling shortcut with a duration-preserving phase-vocoder pitch-shift path. The hook point is `renderMangledBuffer` after slice source selection and before final limiting.
