# Playback Pipeline

## Canonical Runtime Path

Public-alpha playback must flow through this path:

```text
SongDNA
-> SourceClassifier / stem manifest
-> ProducerBrain
-> RemixBlueprintGenerator
-> ArrangementReconstructionEngine
-> TimelineEventV2[]
-> EventScheduler
-> TimelineEventRouter
-> ToneAdapter
-> BusGraph
-> Audio Output
```

No UI component, server handler, scene trigger, macro, or engine helper should schedule sound outside:

```text
TimelineEventV2[] -> EventScheduler -> TimelineEventRouter -> ToneAdapter -> BusGraph
```

The producer tools added for local sound design use the same boundary principle at tool scope: React views delegate decode, graph construction, playback, export, and persistence to shared `src/lib/*` modules. Pure DSP transforms are isolated in `src/lib/producer-tools` and covered by Vitest.

## Event Ownership

- `ArrangementReconstructionEngine` creates `TimelineEventV2[]`.
- `EventScheduler` validates, deduplicates, orders, and clears scheduled events.
- `TimelineEventRouter` maps `TimelineEventV2` to typed playback actions.
- `ToneAdapter` owns rendering primitives and Tone transport callbacks.
- `BusGraph` owns Tone/WebAudio nodes and the final output path.

## Tone.js Audio Graph

WubLabz engine uses a robust Tone.js effect graph managed by `BusGraph`. All playback events are dynamically routed to specific named buses, which merge into a master effects chain before reaching the destination.

### Node Graph Flow
```
Inputs: [drum, bass, melody, vocal, fx, preview, render]
   ↓
(Tone.Channel per bus)
   ↓
preMasterNode (Tone.Gain)
   ↓
filterNode (Tone.Filter)
   ↓
distortionNode (Tone.Distortion)
   ↓
delayNode (Tone.FeedbackDelay)
   ↓
reverbNode (Tone.Reverb)
   ↓
masterGainNode (Tone.Gain)
   ↓
Destination
```

## Modulation Target Bindings

The WebSocket protocol exposes abstract parameters. The `BusGraph` physically binds these to Tone.js AudioParams:

| Protocol Target        | Tone.js Mapping               | Type / Unit     |
|------------------------|-------------------------------|-----------------|
| `filter.cutoff`        | `filterNode.frequency`        | Hz              |
| `filter.resonance`     | `filterNode.Q`                | Q               |
| `reverb.wet`           | `reverbNode.wet`              | Normalized (0-1)|
| `delay.feedback`       | `delayNode.feedback`          | Normalized (0-1)|
| `delay.wet`            | `delayNode.wet`               | Normalized (0-1)|
| `distortion.drive`     | `distortionNode.distortion`   | Normalized (0-1)|
| `master.volume`        | `masterGainNode.gain`         | Normalized (0-1)|

## Emergency Stop Cascade

An `EMERGENCY_STOP` event cascades safely through the engine layers:
1. **Server Transport:** `WubLabzEngine.emergencyStop()` clears playback transport scheduling and halts `Tone.Transport`.
2. **Modulation Adapter:** Wipes `activeModulations` state and fires reset routines.
3. **Scene Scheduler:** Clears `queuedScene` and `currentScene`.
4. **BusGraph Audio:** 
   - Immediately sets `.mute = true` on all input `Tone.Channel` buses.
   - Clears pending automations via `cancelScheduledValues(Tone.now())` on all effect parameters.
   - Rapidly ramps `masterGainNode.gain` to `0`.

## Test vs Node Environments
The `BusGraph` handles missing or incomplete `Tone` instances defensively. In Node.js testing environments, where WebAudio API is not fully available, `BusGraph` binds to proxy objects and gracefully ignores un-schedulable automations (e.g. falling back to simple assignment if `exponentialRampTo` is undefined), preventing test suite crashes.

## Current Limitations

- Source classification is still stem-manifest driven; no full stem separation worker exists yet.
- Slice/chop, macro, gain, and modulation route actions are typed by `TimelineEventRouter`, but most are marker-level actions until full renderer support is implemented.
- `ToneAdapter` drops renderable events if no `BusGraph` is attached; it must never fall back to direct destination output.
