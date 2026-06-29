# WubLabz ↔ WubPad Connection Details

## Environment Variables
WubPad requires the following variables for connection:

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_WUBLABZ_HTTP_URL` | WubLabz Health & API URL | `http://localhost:3001` |
| `VITE_WUBLABZ_WS_URL` | WubLabz WebSocket URL | `ws://localhost:3001` |
| `VITE_WUBLABZ_MOCK` | Enable Mock Engine Mode | `false` |

## Shared Event Protocol
Every WebSocket event must follow this structure:

```json
{
  "clientId": "uuid-string",
  "timestamp": 1234567890,
  "source": "wubpad",
  "type": "EVENT_TYPE",
  "payload": {}
}
```

### Event Rejection
If WubLabz cannot process an event (e.g., engine not ready, unknown parameter, timeline not loaded), it will return an `EVENT_REJECTED` event:

```json
{
  "type": "EVENT_REJECTED",
  "payload": {
    "originalType": "MODULATION",
    "reason": "Unknown modulation target",
    "suggestedAction": "Check parameter list",
    "timestamp": 1234567890
  }
}
```

### Supported Event Types

#### 1. TRANSPORT_CONTROL
Controls playback transport. Rejects if no events are loaded into the scheduler.
**Payload:**
```json
{
  "action": "PLAY" // or "PAUSE", "STOP", "SEEK", "RESET"
}
```

#### 2. SCENE_TRIGGER
Queues a scene for transport boundary activation. 
**Payload:**
```json
{
  "sceneId": "DROP_A",
  "quantize": "nextBar" // "immediate" | "nextBeat" | "nextBar" | "nextPhrase"
}
```
**Supported Scenes:** `INTRO`, `BUILD`, `FAKEOUT`, `DROP_A`, `DROP_B`, `BREAKDOWN`, `RISER`, `IMPACT`, `BASS_FILL`, `RELOAD`, `OUTRO`.

#### 3. MODULATION
Routes safe, clamped automation signals to the engine.
**Payload:**
```json
{
  "effectId": "filter",
  "parameter": "cutoff",
  "value": 2000,
  "rampTime": 0.5
}
```
**Supported Targets:**
- `filter.cutoff`: 20 - 20000 Hz
- `filter.resonance`: 0.1 - 20 Q
- `reverb.wet`: 0 - 1
- `delay.feedback`: 0 - 0.85
- `delay.wet`: 0 - 1
- `distortion.drive`: 0 - 1
- `master.volume`: 0 - 1

#### 4. PERFORMANCE_MACRO
Dispatches synchronized, multi-parameter automation routines.
**Payload:**
```json
{
  "macroId": "filter_sweep_up",
  "intensity": 0.85
}
```
**Supported Macros:** `filter_sweep_up`, `filter_sweep_down`, `delay_throw`, `reverb_bloom`, `distortion_push`, `drop_impact`, `fakeout_silence`, `riser_build`.

#### 5. EMERGENCY_STOP
Instant halt of audio transport, silences busses, clears the scene queue, and resets all active modulations to their registry defaults. Works irrespective of engine readiness status.

#### 6. HEARTBEAT
Ping/pong for latency and synchronized time tracking.

### Verifying Audible Modulation
To verify WubPad controls are producing audible changes:
1. Ensure the WubLabz engine has an active, loaded timeline event (`TRANSPORT_CONTROL` -> `PLAY`).
2. Dispatch a `MODULATION` event via the WebSocket targeting `filter.cutoff` with `value: 400` and `rampTime: 2`.
3. The WebAudio `Tone.Filter` will physically sweep, audibly reducing high frequencies across all loaded stems (Drums, Bass, Melody, etc.) over 2 seconds.
4. Sending an `EMERGENCY_STOP` will instantly mute the bus channels, cancelling pending automation curves.
