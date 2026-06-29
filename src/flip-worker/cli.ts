import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FLIP_PREP_API_PREFIX, type FlipPrepJob } from '../lib/producer-tools/flipPrepTypes.js';

const DEFAULT_WORKER_URL = 'http://127.0.0.1:3002';

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error('Usage: npm run flip-prep:cli -- <audio-file>');
  }

  const inputPath = path.resolve(input);
  const workerUrl = process.env.FLIP_WORKER_URL ?? DEFAULT_WORKER_URL;
  const startedAt = Date.now();

  console.log(`Submitting ${inputPath}`);
  console.log(`Worker ${workerUrl}`);

  const job = await createJob(workerUrl, inputPath);
  console.log(`Job ${job.jobId}`);

  let current = job;
  let lastPhase = '';
  printPhase(current, startedAt, true);

  while (current.status === 'queued' || current.status === 'processing') {
    await delay(2_000);
    current = await getJob(workerUrl, current.jobId);
    const phaseKey = `${current.status}:${current.step}:${current.progressInfo?.detail ?? ''}`;
    if (phaseKey !== lastPhase) {
      printPhase(current, startedAt);
      lastPhase = phaseKey;
    }
  }

  if (current.status === 'error') {
    throw new Error(current.error ?? 'Flip Prep failed');
  }

  printPhase(current, startedAt, true);
  printOutputs(current);
}

async function createJob(workerUrl: string, inputPath: string): Promise<FlipPrepJob> {
  const bytes = await readFile(inputPath);
  const body = new FormData();
  body.append('file', new Blob([bytes], { type: contentTypeFor(inputPath) }), path.basename(inputPath));

  const response = await fetch(`${workerUrl}${FLIP_PREP_API_PREFIX}/jobs`, {
    method: 'POST',
    body
  });
  return readJobResponse(response);
}

async function getJob(workerUrl: string, jobId: string): Promise<FlipPrepJob> {
  const response = await fetch(`${workerUrl}${FLIP_PREP_API_PREFIX}/jobs/${encodeURIComponent(jobId)}`);
  return readJobResponse(response);
}

async function readJobResponse(response: Response): Promise<FlipPrepJob> {
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : `Flip Prep API returned ${response.status}`;
    throw new Error(error);
  }
  return payload as FlipPrepJob;
}

function printPhase(job: FlipPrepJob, startedAt: number, force = false): void {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const label = job.progressInfo?.phaseLabel ?? job.step;
  const detail = job.progressInfo?.detail ? ` (${job.progressInfo.detail})` : '';
  const percent = Number.isFinite(job.progress) ? ` ${Math.round(job.progress * 100)}%` : '';
  if (force || job.status === 'queued' || job.status === 'processing') {
    console.log(`[${formatDuration(elapsed)}] ${job.status} ${label}${percent}${detail}`);
  }
}

function printOutputs(job: FlipPrepJob): void {
  const paths = job.result?.outputPaths;
  if (!paths) {
    console.log('No output paths returned.');
    return;
  }

  console.log('Outputs:');
  for (const [name, outputPath] of Object.entries(paths)) {
    if (outputPath) console.log(`${name}: ${outputPath}`);
  }
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.aif' || ext === '.aiff') return 'audio/aiff';
  return 'application/octet-stream';
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
