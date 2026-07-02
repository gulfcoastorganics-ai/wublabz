export type FlipPrepStep = 'queued' | 'validating-input' | 'separating-stems' | 'detecting-key-bpm' | 'stretching-acapella';
export type FlipPrepJobStatus = 'queued' | 'processing' | 'done' | 'error';
export type FlipPrepStemName = 'drums' | 'bass' | 'vocals' | 'other';

export interface FlipPrepStem {
  name: FlipPrepStemName;
  url: string;
}

export interface FlipPrepProgressInfo {
  phase: FlipPrepStep;
  phaseLabel: string;
  elapsedSeconds: number;
  phaseElapsedSeconds: number;
  detail?: string;
}

export interface FlipPrepResult {
  key: string;
  bpm: number;
  /** 0..1 — how confidently the key was detected; below ~0.3 the key is a
   * near-coin-flip guess and should be treated as ambiguous, not certain. */
  keyConfidence: number;
  /** True if the raw tempo detection fell outside a plausible song-tempo
   * range and was folded by octave (halved/doubled) before use. */
  bpmOctaveCorrected: boolean;
  stems: FlipPrepStem[];
  acapella140Url: string;
  outputPaths?: Partial<Record<FlipPrepStemName | 'acapella140', string>>;
}

export interface FlipPrepError {
  code:
    | 'UPLOAD_TOO_LARGE'
    | 'INVALID_AUDIO'
    | 'AUDIO_TOO_SHORT'
    | 'AUDIO_TOO_LONG'
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
  progressInfo?: FlipPrepProgressInfo;
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
