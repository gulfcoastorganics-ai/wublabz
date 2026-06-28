import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FLIP_PREP_API_PREFIX, createFlipPrepError, type FlipPrepJob, type FlipPrepStemName } from '../lib/producer-tools/flipPrepTypes.js';
import { analyzeOriginal, stretchAcapella } from './analyze.js';
import { FlipWorkerError, mapProcessError } from './errors.js';
import type { FlipPrepWorkerConfig, InternalFlipPrepJob, JobPatch, StemSeparator } from './types.js';
import type { AudioAnalysisResult } from './types.js';
import type { ParsedUpload } from './upload.js';

type AnalyzeFn = (inputPath: string, timeoutMs: number) => Promise<AudioAnalysisResult>;
type StretchFn = (inputPath: string, vocalsPath: string, outputPath: string, bpm: number, timeoutMs: number) => Promise<{ acapellaPath: string }>;

export class FlipPrepJobQueue {
  private jobs = new Map<string, InternalFlipPrepJob>();
  private pending: string[] = [];
  private active = 0;

  constructor(
    private readonly config: FlipPrepWorkerConfig,
    private readonly separator: StemSeparator,
    private readonly now: () => number = Date.now,
    private readonly analyzer: AnalyzeFn = analyzeOriginal,
    private readonly stretcher: StretchFn = stretchAcapella
  ) {}

  async enqueue(upload: ParsedUpload): Promise<FlipPrepJob> {
    const jobId = randomUUID();
    const jobDir = path.join(this.config.workDir, jobId);
    await mkdir(jobDir, { recursive: true });
    const inputPath = path.join(jobDir, upload.fileName);
    await writeFile(inputPath, upload.bytes);

    const job: InternalFlipPrepJob = {
      jobId,
      status: 'queued',
      step: 'queued',
      progress: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
      inputPath,
      workDir: jobDir
    };
    this.jobs.set(jobId, job);
    this.pending.push(jobId);
    this.pump();
    return publicJob(job);
  }

  get(jobId: string): FlipPrepJob | undefined {
    void this.cleanupExpiredJobs().catch(() => undefined);
    const job = this.jobs.get(jobId);
    return job ? publicJob(job) : undefined;
  }

  getFilePath(jobId: string, name: string): string | undefined {
    const job = this.jobs.get(jobId);
    if (!job?.files) return undefined;
    const key = fileKey(name);
    return key ? job.files[key] : undefined;
  }

  private pump(): void {
    while (this.active < this.config.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift()!;
      const job = this.jobs.get(jobId);
      if (!job) continue;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(job: InternalFlipPrepJob): Promise<void> {
    try {
      if (!job.inputPath || !job.workDir) throw new Error('Job input path is missing');
      this.patch(job.jobId, { status: 'processing', step: 'separating-stems', progress: 0.05 });
      const analysisPromise = this.analyzer(job.inputPath, this.config.demucsTimeoutMs);
      const stemsPromise = this.separator.separate(job.inputPath, path.join(job.workDir, 'demucs'), (progress) => {
        this.patch(job.jobId, { progress: 0.05 + progress * 0.55 });
      });
      const [stemsResult, analysisResult] = await Promise.allSettled([stemsPromise, analysisPromise]);
      if (stemsResult.status === 'rejected') {
        throw stemsResult.reason;
      }
      if (analysisResult.status === 'rejected') {
        throw analysisResult.reason;
      }
      const stems = stemsResult.value;

      this.patch(job.jobId, { step: 'detecting-key-bpm', progress: 0.68 });
      const acapellaPath = path.join(job.workDir, 'acapella_140.wav');
      const analysis = analysisResult.value;
      this.patch(job.jobId, { step: 'stretching-acapella', progress: 0.78 });
      const stretch = await this.stretcher(job.inputPath, stems.vocals, acapellaPath, analysis.bpm, this.config.demucsTimeoutMs);

      this.patch(job.jobId, {
        step: 'stretching-acapella',
        progress: 0.92,
        files: { ...stems, acapella140: stretch.acapellaPath }
      });
      this.patch(job.jobId, {
        status: 'done',
        progress: 1,
        result: {
          key: analysis.key,
          bpm: analysis.bpm,
          stems: (['drums', 'bass', 'vocals', 'other'] as const)
            .filter((stem) => Boolean(stems[stem]))
            .map((stem) => ({
              name: stem,
              url: `${FLIP_PREP_API_PREFIX}/jobs/${job.jobId}/files/${stem}`
            })),
          acapella140Url: `${FLIP_PREP_API_PREFIX}/jobs/${job.jobId}/files/acapella140`
        }
      });
    } catch (error) {
      const detail = error instanceof FlipWorkerError ? error.detail : mapProcessError(error, 'SEPARATION_FAILED');
      this.patch(job.jobId, {
        status: 'error',
        error: detail.message,
        errorDetail: detail,
        progress: 1
      });
      if (job.workDir) {
        await rm(job.workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  patch(jobId: string, patch: JobPatch): void {
    const current = this.jobs.get(jobId);
    if (!current) return;
    this.jobs.set(jobId, {
      ...current,
      ...patch,
      files: patch.files ? { ...current.files, ...patch.files } : current.files,
      updatedAt: this.now()
    });
  }

  async cleanupExpiredJobs(): Promise<number> {
    const cutoff = this.now() - this.config.jobTtlMs;
    const removals: Promise<unknown>[] = [];
    let removed = 0;
    for (const [jobId, job] of this.jobs) {
      if ((job.status === 'done' || job.status === 'error') && job.updatedAt < cutoff) {
        this.jobs.delete(jobId);
        removed += 1;
        if (job.workDir) {
          removals.push(rm(job.workDir, { recursive: true, force: true }).catch(() => undefined));
        }
      }
    }
    await Promise.all(removals);
    return removed;
  }
}

export function publicJob(job: InternalFlipPrepJob): FlipPrepJob {
  return {
    jobId: job.jobId,
    status: job.status,
    step: job.step,
    progress: job.progress,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.errorDetail ? { errorDetail: job.errorDetail } : {})
  };
}

export function mapUploadError(error: unknown, maxBytes: number) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('exceeds')) {
    return createFlipPrepError('UPLOAD_TOO_LARGE', message, `Use an audio file smaller than ${maxBytes} bytes.`);
  }
  return createFlipPrepError('INVALID_AUDIO', message, 'Upload an mp3, wav, aiff, flac, m4a, or ogg audio file.');
}

function fileKey(name: string): FlipPrepStemName | 'acapella140' | undefined {
  if (name === 'drums' || name === 'bass' || name === 'vocals' || name === 'other' || name === 'acapella140') {
    return name;
  }
  return undefined;
}
