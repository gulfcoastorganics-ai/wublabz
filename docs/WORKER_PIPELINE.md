# Worker Pipeline

## Existing Workers

WubLabz currently has three Node worker-thread entrypoints:

- `src/lib/audio/audioDecode.worker.ts`
- `src/lib/audio/waveform.worker.ts`
- `src/lib/audio/analysis.worker.ts`

Flip Prep now uses a standalone TypeScript process under `src/flip-worker/` instead of a Node worker thread because Demucs is a heavyweight Python subprocess pipeline.

## Decode Worker

`audioDecode.worker.ts` accepts:

```ts
{
  input: {
    bytes: Uint8Array;
    sourcePath: string;
  }
}
```

It returns an `AudioDecodeResult` from `decodeAudioInline()`.

Missing input returns:

```ts
{ error: 'Missing audio decode input.' }
```

## Waveform Worker

`waveform.worker.ts` accepts decoded channel data and sample rate, mixes to mono, and computes waveform peaks.

It returns `WaveformPeak[]`.

Missing input returns:

```ts
{ error: 'Missing waveform input.' }
```

## Analysis Worker

`analysis.worker.ts` accepts raw audio bytes and a source path. It runs `AnalysisEngine` with `useWorkers: false` to prevent recursive worker spawning.

It returns an `AudioIngestionSnapshot`.

Missing input returns:

```ts
{ error: 'Missing analysis input.' }
```

## Lifecycle Expectations

- Workers must not own playback state.
- Workers must not create Tone/WebAudio nodes.
- Workers must post only serializable data.
- Worker callers must terminate workers after completion or failure.
- Analysis workers must not upload raw audio to Gemini or any remote API.

## Current Limitations

- Worker handlers are exported and testable, but lifecycle cleanup tests for actual `Worker` instances are still roadmap.
- Stem separation is isolated behind `StemSeparator`; only `LocalDemucsSeparator` is implemented.
- `SEPARATOR=cloud` is reserved for a future Replicate/Modal adapter.
- Full DSP offload should remain additive; do not rewrite the playback pipeline to add workerization.

## Flip Prep Worker

Entrypoint:

```bash
npm run flip-worker
```

Endpoints:

- `POST /api/flip-prep/jobs`
- `GET /api/flip-prep/jobs/:jobId`
- `GET /api/flip-prep/jobs/:jobId/files/:name`

The browser and producer-tool UI call the main WubLabz API at `http://localhost:3001`. The main WubLabz server proxies those `/api/flip-prep/*` paths to `FLIP_WORKER_URL`.

The canonical local Flip Prep worker default is `http://127.0.0.1:3002`; both the server proxy default and worker listener default are derived from the shared `FLIP_PREP_DEFAULT_WORKER_PORT` constant.

The local separator defaults to fast vocals-only separation:

```bash
python3 -m demucs --mp3 -n htdemucs -o <outDir> --two-stems vocals <input>
```

Set `FLIP_PREP_STEMS=full` to request drums/bass/vocals/other:

```bash
python3 -m demucs --mp3 -n htdemucs -o <outDir> <input>
```

`LocalDemucsSeparator` does not pass `--shifts` by default. This avoids test-time augmentation and keeps local runs fast. Set `DEMUCS_SEGMENT_SECONDS=<seconds>` to pass `--segment`; shorter segments can reduce memory use and sometimes improve throughput on constrained machines, while longer/default segmentation may preserve quality and context.

Key/BPM analysis starts in parallel with Demucs because it reads the original audio. The final stretch waits for both the detected BPM and the vocals stem.

Analysis:

```bash
python3 src/flip-worker/python/analyze_and_stretch.py --mode analyze --input <input>
```

Stretch:

```bash
python3 src/flip-worker/python/analyze_and_stretch.py --mode stretch --input <input> --vocals <vocals.mp3> --output <acapella_140.wav> --bpm <detectedBpm>
```

## Flip Prep Local Speed Controls

- `FLIP_PREP_STEMS=vocals` (default): uses Demucs `--two-stems vocals`; fastest path for acapella-focused flips.
- `FLIP_PREP_STEMS=full`: returns drums, bass, vocals, and other; slower but useful for full stem packs.
- `FLIP_PREP_CACHE_DIR`: stores content-hash stem outputs.
- `FLIP_PREP_CACHE_MAX_AGE_MS`: removes old cache entries.
- `FLIP_PREP_CACHE_MAX_BYTES`: removes least-recently-touched entries when the cache grows too large.
- `DEMUCS_SEGMENT_SECONDS`: optional `--segment` value for speed/memory tuning.

Cache key is `sha256(input) + stem mode`, so a two-stem hit does not satisfy a full-stem request and vice versa. Cache hits skip Demucs entirely, copy cached stems into the current job workspace, and return those job-local paths for downloads.
