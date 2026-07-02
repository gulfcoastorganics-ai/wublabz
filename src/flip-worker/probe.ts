import { spawnChecked } from './process.js';
import type { StemPaths } from './types.js';

export interface AudioProbeResult {
  durationSeconds: number;
}

// Cheap ffprobe pass before the expensive Demucs run: catches corrupt/
// truncated/unreadable audio immediately with a clear message instead of
// letting it fail deep inside a multi-minute separation job, and gives us
// duration up front for the too-short/too-long guards in queue.ts.
export async function probeAudioDuration(inputPath: string, timeoutMs: number): Promise<AudioProbeResult> {
  let result: { stdout: string };
  try {
    result = await spawnChecked('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      inputPath
    ], { timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Audio file could not be read (corrupt or unsupported): ${message}`);
  }

  let parsed: { format?: { duration?: string } };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('Audio file could not be read (corrupt or unsupported): ffprobe returned no format data');
  }

  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Audio file could not be read (corrupt or unsupported): no readable duration');
  }
  return { durationSeconds };
}

export interface StemQualityReport {
  stem: string;
  meanVolumeDb?: number;
  maxVolumeDb?: number;
  isSilent: boolean;
  isClipped: boolean;
  error?: string;
}

const SILENCE_THRESHOLD_DB = -50;
const CLIP_THRESHOLD_DB = -0.1;

// Best-effort, non-blocking quality signal on Demucs output: near-total
// silence usually means a separation failure (rather than "no bass in this
// song" — a genuinely bassless stem still has room noise/bleed well above
// -50dB), and a max volume pinned at ~0dB across the whole stem usually
// means clipped/corrupted output. Never throws — a stem this can't analyze
// (e.g. mocked test fixtures) is reported with `error`, not failed.
export async function analyzeStemQuality(stemPaths: StemPaths, timeoutMs: number): Promise<StemQualityReport[]> {
  const entries = Object.entries(stemPaths).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return Promise.all(entries.map(async ([stem, filePath]) => {
    try {
      const result = await spawnChecked('ffmpeg', [
        '-i', filePath,
        '-af', 'volumedetect',
        '-f', 'null',
        '-'
      ], { timeoutMs });
      const output = `${result.stdout}\n${result.stderr}`;
      const meanVolumeDb = parseVolumeDb(output, 'mean_volume');
      const maxVolumeDb = parseVolumeDb(output, 'max_volume');
      return {
        stem,
        meanVolumeDb,
        maxVolumeDb,
        isSilent: meanVolumeDb !== undefined && meanVolumeDb <= SILENCE_THRESHOLD_DB,
        isClipped: maxVolumeDb !== undefined && maxVolumeDb >= CLIP_THRESHOLD_DB
      };
    } catch (error) {
      return {
        stem,
        isSilent: false,
        isClipped: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }));
}

function parseVolumeDb(output: string, label: 'mean_volume' | 'max_volume'): number | undefined {
  const match = output.match(new RegExp(`${label}:\\s*(-?[\\d.]+)\\s*dB`));
  return match ? Number(match[1]) : undefined;
}
