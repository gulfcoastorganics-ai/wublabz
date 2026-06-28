export type FlipPrepStep = 'queued' | 'separating-stems' | 'detecting-key-bpm' | 'stretching-acapella';
export type FlipPrepJobStatus = 'queued' | 'processing' | 'done' | 'error';
export type FlipPrepStemName = 'drums' | 'bass' | 'vocals' | 'other';

export interface FlipPrepStem {
  name: FlipPrepStemName;
  url: string;
}

export interface FlipPrepResult {
  key: string;
  bpm: number;
  stems: FlipPrepStem[];
  acapella140Url: string;
}

export interface FlipPrepError {
  code:
    | 'UPLOAD_TOO_LARGE'
    | 'INVALID_AUDIO'
    | 'PYTHON_MISSING'
    | 'DEMUCS_MISSING'
    | 'FFMPEG_MISSING'
    | 'RUBBERBAND_MISSING'
    | 'SEPARATION_FAILED'
    | 'ANALYSIS_FAILED'
    | 'TIMEOUT'
    | 'WORKER_UNAVAILABLE'
    | 'UNKNOWN';
  message: string;
  actionable: string;
}

export interface FlipPrepJob {
  jobId: string;
  status: FlipPrepJobStatus;
  step: FlipPrepStep;
  progress: number;
  result?: FlipPrepResult;
  error?: string;
  errorDetail?: FlipPrepError;
}

export interface FlipPrepCreateJobResponse extends FlipPrepJob {}

export const FLIP_PREP_API_PREFIX = '/api/flip-prep';
export const FLIP_PREP_DEFAULT_WORKER_HOST = '127.0.0.1';
export const FLIP_PREP_DEFAULT_WORKER_PORT = 3002;
export const FLIP_PREP_DEFAULT_WORKER_URL = `http://${FLIP_PREP_DEFAULT_WORKER_HOST}:${FLIP_PREP_DEFAULT_WORKER_PORT}`;

export function createFlipPrepError(code: FlipPrepError['code'], message: string, actionable: string): FlipPrepError {
  return { code, message, actionable };
}

export function isFlipPrepJob(value: unknown): value is FlipPrepJob {
  if (!isRecord(value)) return false;
  return (
    typeof value.jobId === 'string' &&
    typeof value.status === 'string' &&
    typeof value.step === 'string' &&
    typeof value.progress === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
