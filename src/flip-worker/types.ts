import type { FlipPrepError, FlipPrepJob, FlipPrepProgressInfo, FlipPrepStep, FlipPrepStemName } from '../lib/producer-tools/flipPrepTypes.js';

export interface StemPaths {
  vocals: string;
  drums?: string;
  bass?: string;
  other?: string;
}

export interface StemSeparator {
  separate(inputPath: string, outDir: string, onProgress?: (progress: number) => void): Promise<StemPaths>;
}

export interface AudioAnalysisResult {
  key: string;
  bpm: number;
  keyConfidence: number;
  bpmOctaveCorrected: boolean;
}

export interface AcapellaStretchResult {
  acapellaPath: string;
}

export type DemucsStemMode = 'vocals' | 'full';

export interface FlipPrepWorkerConfig {
  port: number;
  host: string;
  separator: 'local' | 'cloud';
  maxUploadBytes: number;
  maxClipSeconds: number;
  minSourceSeconds: number;
  maxSourceSeconds: number;
  concurrency: number;
  jobTtlMs: number;
  demucsTimeoutMs: number;
  workDir: string;
  stemMode: DemucsStemMode;
  demucsSegmentSeconds?: number;
  cacheDir: string;
  cacheMaxAgeMs: number;
  cacheMaxBytes: number;
}

export interface InternalFlipPrepJob extends FlipPrepJob {
  createdAt: number;
  updatedAt: number;
  phaseStartedAt: number;
  inputPath?: string;
  workDir?: string;
  files?: Partial<Record<FlipPrepStemName | 'acapella140', string>>;
  errorDetail?: FlipPrepError;
}

export interface JobPatch {
  status?: InternalFlipPrepJob['status'];
  step?: FlipPrepStep;
  progress?: number;
  progressInfo?: FlipPrepProgressInfo;
  result?: InternalFlipPrepJob['result'];
  error?: string;
  errorDetail?: FlipPrepError;
  files?: InternalFlipPrepJob['files'];
}
