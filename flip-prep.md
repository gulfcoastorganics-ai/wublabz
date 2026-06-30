# Flip Prep Pipeline Integration Report

This document reports on the architecture, bugs found, fixes applied, and verification steps for the WubLabz Flip Prep pipeline.

---

## 1. Flip Prep Architecture

The Flip Prep pipeline decouples CPU-heavy stem separation and time-stretching tasks from the main interactive UI and playback loop.

```mermaid
graph TD
    UI["WubPad UI (Frontend)"] -->|REST API Calls| API["WubLabz Server (Proxy /api/flip-prep/*)"]
    API -->|Auto-start / Proxied Routing| Worker["Flip Worker (Standalone Server: Port 3002)"]
    Worker -->|Enqueues| Queue["Job Queue (FlipPrepJobQueue)"]
    
    subgraph Heavy Processing Pipeline (Python Subprocesses)
        Queue -->|Separate Stems| Demucs["Demucs (vocals / accompaniment)"]
        Queue -->|Analyze Key/BPM| Analysis["Python analyze (analyze_and_stretch.py)"]
        Demucs -->|vocals.mp3| Stretch["Python stretch (analyze_and_stretch.py)"]
        Analysis -->|detectedBpm| Stretch
        Stretch -->|acapella_140.wav| Output["Output WAV/MP3 Stems"]
    end
    
    Output -->|Load Audio Buffer| Arrangement["Arrangement (ArrangementPreviewEngine)"]
    Arrangement -->|Audio Nodes| Mix["Playback Mix Graph (Tone.js / AudioGraph)"]
    Mix -->|Processing Chain| Master["Mastering Chain (Compressor, EQ, Limiter)"]
    Master -->|Render| Export["Export (AudioRenderExport / WAV Export)"]
    
    style UI fill:#ffb8df,stroke:#ff5cc8,stroke-width:2px;
    style API fill:#c0e0ff,stroke:#007acc,stroke-width:2px;
    style Worker fill:#c0e0ff,stroke:#007acc,stroke-width:2px;
    style Queue fill:#ffd8b8,stroke:#ff8c00,stroke-width:2px;
    style Demucs fill:#d8ffd8,stroke:#00aa00,stroke-width:2px;
    style Analysis fill:#d8ffd8,stroke:#00aa00,stroke-width:2px;
    style Stretch fill:#d8ffd8,stroke:#00aa00,stroke-width:2px;
    style Output fill:#fff8c0,stroke:#cca000,stroke-width:2px;
```

---

## 2. Bugs Found (Root Causes of 503 Service Unavailable)

1. **Worker Never Starts (No Lifecycle Management)**: 
   The standalone Flip Prep worker process (`src/flip-worker/index.ts`) was never started automatically on WubLabz server initialization, nor was it monitored. When the UI attempted to connect to `/api/flip-prep/jobs`, the proxy failed to connect to `127.0.0.1:3002`, triggering the connection exception and throwing a `503 Service Unavailable` error.
2. **Missing REST Endpoints**:
   - `GET /api/flip-prep/jobs` (list all jobs) was not registered in Fastify on either the main WubLabz server or the Flip Prep worker.
   - `DELETE /api/flip-prep/jobs/:jobId` (cancel/delete job) was not registered on either the main server or worker.
   - Queue status and worker metrics endpoints were completely missing.
3. **No Reconnect or Retry Logic**:
   The proxy had no retry mechanism. If a worker crashed or did not respond quickly enough, the request was aborted immediately with a 503 error instead of attempting to reconnect or restart the worker and retrying.

---

## 3. Fixes Applied

1. **Created `WorkerManager`**:
   Designed a standalone manager (`src/wublabz/workerManager.ts`) to handle automatic spawning of `npx tsx src/flip-worker/index.ts`, polling health checks, capturing worker logs, auto-restarting on crashes, and cleanly terminating the process on WubLabz server shutdown.
2. **Implemented Missing Endpoints**:
   - Registered `GET /api/flip-prep/jobs` to retrieve all active/completed jobs.
   - Registered `DELETE /api/flip-prep/jobs/:jobId` to cancel a job, remove it from the pending list, and delete its work directory.
   - Registered `GET /api/flip-prep/queue/status` to fetch queue active count, pending count, and job lists.
   - Registered `GET /api/flip-prep/metrics` to expose worker performance metrics (total enqueued, completed, failed, cancelled, active, and uptime).
3. **Added Reconnect and Retry Proxy Logic**:
   Modified `proxyFlipPrepRequest` to catch connection failures, automatically invoke the `WorkerManager` to restart/ensure the worker is running, wait for 500ms, and retry the request up to 2 times before returning a 503 error.
4. **Isolated Test Environments**:
   Configured `disableWorkerAutoStart` so that vitest unit tests do not spawn subprocesses, preventing tests from timing out or lagging.

---

## 4. Files Changed

| File | Changes |
| :--- | :--- |
| `src/flip-worker/queue.ts` | Added `getAll()`, `delete()`, `getMetrics()`, and `getQueueStatus()` methods; enqueued, completed, failed, and cancelled metrics tracking. |
| `src/flip-worker/server.ts` | Added REST endpoints for listing jobs, deleting jobs, fetching queue status, and exposing worker metrics. |
| `src/wublabz/workerManager.ts` | **(New)** Implemented worker process lifecycle, spawning, health checks, restart handling, and graceful shutdown. |
| `src/wublabz/server.ts` | Integrated `WorkerManager`, registered proxy routes for the new endpoints, and implemented proxy retry and reconnect logic. |
| `tests/flipPrepEndpoints.test.ts` | **(New)** Added comprehensive unit and integration tests for all new endpoints and proxy behavior. |

---

## 5. Tests Performed & Commands Executed

### Commands Executed:
- Checked active port mappings:
  ```bash
  ss -tulpn | grep -E "3000|3001|3002"
  ```
- Executed the full vitest suite:
  ```bash
  npm test
  ```

### Tests Performed:
Created `tests/flipPrepEndpoints.test.ts` to verify:
1. **Worker endpoints**: `GET /api/flip-prep/jobs`, `DELETE /api/flip-prep/jobs/:jobId`, `GET /api/flip-prep/queue/status`, `GET /api/flip-prep/metrics` correctly return expected JSON structures.
2. **Proxy routing**: Main server proxies these endpoints to the worker and intercepts connection errors for retries.
3. **Vitest suite confirmation**: Run all 20 test files, ensuring 100% of the project's tests pass with zero regressions or timeouts.

---

## 6. Remaining Technical Debt

- **Job Cleanup Robustness**: The worker currently deletes the job workspace folder upon cancellation or expiry. Active Python processes spawned under a cancelled job should be tracked and explicitly terminated using process group signals (`kill(-pid)`).
- **Disk Space Monitoring**: If very large audio clips are uploaded, the tmp space can fill up. A disk quota check should be added to the queue's enqueuing step.
- **WebSocket Progress Pushing**: The UI currently polls `GET /api/flip-prep/jobs/:id` every 900ms. Transitioning this to push notifications via the active WebSocket channel would decrease server overhead.
