# WubLabz

WubLabz is a local-first music production system built around a Fastify/WebSocket engine, the WubPad browser controller, producer tools, and the Flip Prep audio-preparation worker. The current package is `1.0.0-rc.1` and is designed to run locally without uploading raw audio to a hosted service.

## Current scope

- Fastify/WebSocket WubLabz engine with runtime status telemetry and validated control events
- WubPad React/Vite controller for transport, scenes, MIDI mapping, and metering
- Producer tools including Sample Mangler, Bass Synth, and Remix to Dubstep
- Flip Prep worker for BPM/key analysis, audio preparation, downloads, and optional Demucs stem separation
- TypeScript build, type checks, Vitest coverage, and production distribution output

See `CHANGELOG.md` for the current release history and `docs/` for deeper subsystem documentation.

## Requirements

- Node.js `>=20.20.2`
- npm `>=10.5.2`
- npm is the supported package manager
- Optional for local stem separation: a working Demucs installation available to the Flip Prep worker

## Install

```bash
npm install
```

## Run the core development stack

```bash
npm run dev
```

This starts the WubLabz engine and WubPad together. The browser controller runs on port `3000`; the engine uses its configured WubLabz port and exposes `/health` plus the WebSocket control surface.

Run individual services when needed:

```bash
npm run wublabz
npm run wubpad
npm run flip-worker
```

## Validation

Run the full repository checks before release:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The build output is written to `dist/` and the package exports the compiled WubLabz runtime from `dist/wublabz`.

## Flip Prep

The WubLabz server proxies Flip Prep requests to the worker. Start the worker with:

```bash
npm run flip-worker
```

Useful environment variables include:

- `FLIP_WORKER_URL` — server-to-worker URL override
- `FLIP_WORKER_PORT` — Flip Prep worker port
- `FLIP_WORKER_HOST` — worker bind host, default `0.0.0.0`
- `FLIP_PREP_MAX_UPLOAD_BYTES` — upload limit, default 250 MiB
- `FLIP_PREP_MAX_CLIP_SECONDS` — prepared clip limit, default 60 seconds
- `FLIP_PREP_MAX_SOURCE_SECONDS` — maximum accepted source duration, default 15 minutes
- `FLIP_PREP_CONCURRENCY` — worker concurrency, default 1
- `FLIP_PREP_WORK_DIR` — temporary job directory
- `FLIP_PREP_CACHE_DIR` — stem cache directory
- `FLIP_PREP_STEMS=full` — request full stem mode; the default is vocals-only
- `DEMUCS_TIMEOUT_MS` — Demucs processing timeout
- `DEMUCS_SEGMENT_SECONDS` — optional Demucs segment size

The server returns a structured `503` error when the worker is unavailable instead of silently failing.

## Useful commands

```bash
npm run flip-prep:cli
npm run server
```

## Release boundary

This repository is an RC-quality local production system, not a hosted multi-tenant audio service. A launch candidate should pass `typecheck`, `lint`, `test`, and `build` on the target machine and receive a human by-ear pass for audio quality and workflow behavior before being promoted from RC to stable.

No credentials or real secrets should be committed to the repository.
