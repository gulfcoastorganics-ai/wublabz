# Flip Prep

Flip Prep is a server-side song preparation workflow behind the existing frontend polling client.

## Runtime Shape

The WubLabz server keeps `/api/flip-prep/*` as the app-facing endpoint and proxies those requests to the standalone TypeScript worker at `FLIP_WORKER_URL` (default `http://127.0.0.1:3002`).

```text
Frontend -> WubLabz server /api/flip-prep/* -> flip-worker -> Demucs/Python subprocesses
```

This keeps `src/wublabz/server.ts` responsible for app transport and keeps heavy audio processing out of the WubPad/ENGINE_STATUS runtime loop.

## Contract

`POST /api/flip-prep/jobs`

Multipart form upload with a single `file` audio field. Returns `202` and a job:

```json
{
  "jobId": "id",
  "status": "queued",
  "step": "queued",
  "progress": 0
}
```

`GET /api/flip-prep/jobs/:jobId`

Returns progress or final results:

```json
{
  "jobId": "id",
  "status": "done",
  "step": "stretching-acapella",
  "progress": 1,
  "result": {
    "key": "A minor",
    "bpm": 140,
    "stems": [
      { "name": "drums", "url": "/api/flip-prep/jobs/id/files/drums" },
      { "name": "bass", "url": "/api/flip-prep/jobs/id/files/bass" },
      { "name": "vocals", "url": "/api/flip-prep/jobs/id/files/vocals" },
      { "name": "other", "url": "/api/flip-prep/jobs/id/files/other" }
    ],
    "acapella140Url": "/api/flip-prep/jobs/id/files/acapella140"
  }
}
```

`GET /api/flip-prep/jobs/:jobId/files/:name`

Downloads `drums`, `bass`, `vocals`, `other`, or `acapella140`.

## Real Pipeline

1. `LocalDemucsSeparator` shells out with the fast two-stem default:

```bash
python3 -m demucs --mp3 -n htdemucs -o <outDir> --two-stems vocals <input>
```

Set `FLIP_PREP_STEMS=full` for drums/bass/vocals/other. `--shifts` is not used by default. `DEMUCS_SEGMENT_SECONDS` passes `--segment` for memory/speed tuning.

2. The worker starts key/BPM analysis in parallel with Demucs:

```bash
python3 src/flip-worker/python/analyze_and_stretch.py --mode analyze --input <input>
```

3. Once vocals are available, the worker stretches to 140 BPM:

```bash
python3 src/flip-worker/python/analyze_and_stretch.py --mode stretch --input <input> --vocals <vocals.mp3> --output <acapella_140.wav> --bpm <detectedBpm>
```

The Python script uses `librosa` for key/BPM and `pyrubberband` for stretching, with a `librosa.effects.time_stretch` fallback.

## Local Setup

Host dependencies:

- Python 3
- `demucs`
- `ffmpeg`
- `rubberband-cli`
- Python packages in `src/flip-worker/python/requirements.txt`

Run:

```bash
npm install
npm run flip-worker
npm run wublabz
npm run wubpad
```

Useful env vars:

- `FLIP_WORKER_URL` for the WubLabz server proxy target.
- `FLIP_WORKER_PORT` and `FLIP_WORKER_HOST` for the worker listener.
- `SEPARATOR=local|cloud`; only `local` is implemented.
- `FLIP_PREP_STEMS=vocals|full`; defaults to `vocals` for Demucs `--two-stems vocals`.
- `FLIP_PREP_CACHE_DIR`, `FLIP_PREP_CACHE_MAX_AGE_MS`, and `FLIP_PREP_CACHE_MAX_BYTES` control the content-hash stem cache.
- `DEMUCS_SEGMENT_SECONDS` optionally passes Demucs `--segment`.
- `FLIP_PREP_MAX_UPLOAD_BYTES`; defaults to 250 MB.
- `FLIP_PREP_CONCURRENCY`; defaults to 1 because Demucs is heavy.
- `DEMUCS_TIMEOUT_MS`; defaults to 20 minutes.

CPU Demucs can take minutes per song. GPU-backed Demucs is much faster.

## Docker

```bash
docker build -f Dockerfile.flip-worker -t wublabz-flip-worker .
docker run --rm -p 3002:3002 wublabz-flip-worker
```

The Docker image installs Python 3, Demucs, ffmpeg, rubberband-cli, librosa, soundfile, and pyrubberband.

## Separator Interface

Stem separation is isolated behind:

```ts
interface StemSeparator {
  separate(inputPath: string, outDir: string): Promise<StemPaths>;
}
```

`LocalDemucsSeparator` is implemented now. `CloudSeparator` is a documented future drop-in for Replicate/Modal selected through `SEPARATOR=cloud`.
