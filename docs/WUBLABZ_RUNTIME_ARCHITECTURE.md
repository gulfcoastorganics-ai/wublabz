# WubLabz Runtime Architecture

## Core Identity

WubLabz is a local-first AI Producer, AI Remix Engineer, and AI Arrangement Workstation.

It is not a generic text-to-music generator.

## Runtime Flow

```text
Audio File
-> AnalysisSnapshot
-> StemManifest
-> BeatGrid
-> PhraseGrid
-> SectionGrid
-> SongDNA
-> ProducerBrain
-> RemixBlueprint
-> ArrangementReconstructionEngine
-> TimelineEventV2
-> EventScheduler
-> TimelineEventRouter
-> ToneAdapter
-> BusGraph
-> Playback / Export
```

## Runtime Boundaries

- `server.ts` owns HTTP/WebSocket transport only.
- `server.ts` proxies Flip Prep HTTP jobs to the standalone `src/flip-worker` process; Demucs never runs inside the WubPad/ENGINE_STATUS process.
- `protocol.ts` owns inbound event validation.
- `RuntimeController` owns orchestration and diagnostics updates.
- `WubLabzEngine` owns playback engine composition.
- `PlaybackTransport` coordinates scheduler and renderer.
- `ToneAdapter` owns Tone rendering primitives.
- `BusGraph` owns audio graph lifecycle and modulation parameter binding.
- Producer tools under `src/producer-tools/` must call shared modules in `src/lib/audio`, `src/lib/playback`, `src/lib/export`, and `src/lib/persistence`; DSP-only logic belongs in `src/lib/producer-tools`.

## Producer Intelligence

Producer Intelligence v1 includes:

- `MotifMemory`
- `PhraseRecall`
- `DropEscalation`
- `RepetitionFatigue`
- `ProducerBrain`

Repeated consecutive fakeouts deterministically suppress the second fakeout into breakdown strategy output without mutating `SongDNA`.

## Diagnostics

Runtime diagnostics track:

- engine state and transport state
- BPM, beat, bar, phrase
- scene state
- scheduled event count
- bus and modulation target counts
- active modulation count
- pending macro count
- route, scheduler, audio, modulation, scene, macro errors
- producer diagnostics

## Current Limitations

- Source classification is still lightweight.
- Route actions for macro/modulation/gain/mute are typed but not all renderer actions are fully materialized.
- Flip Prep local separation is implemented through Demucs subprocesses. Cloud separation remains a future `StemSeparator` adapter.
