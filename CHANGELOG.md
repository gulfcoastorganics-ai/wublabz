# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Remix to Dubstep:** Added a Flip Prep-powered editable dubstep skeleton arranger with 140 BPM section generation, key-matched growl bass clips, drum/fill lanes, timeline controls, guide playback, and guide stem/master WAV export.
- **Sample Mangler:** Engine-integrated loop slicing, seeded rerolls, glitch macro, equal-power fades, soft limiting, playback, and WAV export.
- **Bass Synth:** Engine-BPM-aware growl synth with shared voice graph construction, split drive, ADSR controls, analyser display, preset persistence, and one-shot export.
- **Flip Prep:** Typed job-polling UI, WubLabz server proxying, and a standalone TypeScript worker with a real Demucs subprocess pipeline, key/BPM analysis, acapella stretching, job queue, and downloads.

### Changed
- **Producer Tools Audio Quality:** Added shared equal-power fade, soft-limit, and export-normalization helpers; routed producer live output through a master soft limiter; tightened Sample Mangler seams with overlap crossfades; expanded Bass Synth ADSR/wobble/polyphony/export quality.
- **Flip Prep Worker:** Default local Demucs to `--two-stems vocals`, add content-hash stem caching, run key/BPM analysis in parallel with separation, and expose `DEMUCS_SEGMENT_SECONDS` without enabling `--shifts` by default.

## [1.0.0-rc.1] - 2026-06-08

### Added
- **WubPad Controller:** Production-ready mobile/web MIDI controller.
- **Bi-directional Feedback:** Real-time transport, position, and scene status display.
- **Metering UI:** High-frequency per-stem peak level monitoring (20Hz telemetry).
- **MIDI Mapping:** Integrated 'Learn Mode' for binding hardware to macros/scenes.
- **Pairing UX:** Manual URL input with recent connection history and persistence.
- **Safety Mode:** Optional confirmation prompts for destructive playback actions.
- **Hardened Protocol:** Standardized `ENGINE_STATUS` and `EVENT_REJECTED` types.

### Fixed
- **Memory Leaks:** Correct cleanup of MIDI listeners and WebSocket telemetry intervals.
- **Connection Stability:** Exponential backoff and heartbeat monitoring.
- **Type Safety:** Comprehensive TypeScript coverage for all protocol intents.

### Performance
- Throttled 50ms telemetry loop for low-latency visual feedback without flooding the network.
- Optimized React rendering paths with `useCallback` and `useRef`.
