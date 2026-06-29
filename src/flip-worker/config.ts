import os from 'node:os';
import path from 'node:path';
import { FLIP_PREP_DEFAULT_WORKER_PORT } from '../lib/producer-tools/flipPrepTypes.js';
import type { FlipPrepWorkerConfig } from './types.js';

export function loadFlipPrepWorkerConfig(env: NodeJS.ProcessEnv = process.env): FlipPrepWorkerConfig {
  return {
    port: numberEnv(env.FLIP_WORKER_PORT, FLIP_PREP_DEFAULT_WORKER_PORT),
    host: env.FLIP_WORKER_HOST ?? '0.0.0.0',
    separator: env.SEPARATOR === 'cloud' ? 'cloud' : 'local',
    maxUploadBytes: numberEnv(env.FLIP_PREP_MAX_UPLOAD_BYTES, 250 * 1024 * 1024),
    maxClipSeconds: numberEnv(env.FLIP_PREP_MAX_CLIP_SECONDS, 60),
    concurrency: Math.max(1, numberEnv(env.FLIP_PREP_CONCURRENCY, 1)),
    jobTtlMs: numberEnv(env.FLIP_PREP_JOB_TTL_MS, 30 * 60 * 1000),
    demucsTimeoutMs: numberEnv(env.DEMUCS_TIMEOUT_MS, 20 * 60 * 1000),
    workDir: env.FLIP_PREP_WORK_DIR ?? path.join(os.tmpdir(), 'wublabz-flip-prep'),
    stemMode: env.FLIP_PREP_STEMS === 'full' ? 'full' : 'vocals',
    demucsSegmentSeconds: optionalNumberEnv(env.DEMUCS_SEGMENT_SECONDS),
    cacheDir: env.FLIP_PREP_CACHE_DIR ?? path.join(os.tmpdir(), 'wublabz-flip-cache'),
    cacheMaxAgeMs: numberEnv(env.FLIP_PREP_CACHE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000),
    cacheMaxBytes: numberEnv(env.FLIP_PREP_CACHE_MAX_BYTES, 10 * 1024 * 1024 * 1024)
  };
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalNumberEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
