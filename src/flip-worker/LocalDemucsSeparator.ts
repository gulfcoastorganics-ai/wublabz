import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { DemucsStemMode, StemPaths, StemSeparator } from './types.js';
import { StemCache, hashFile } from './cache.js';
import { spawnChecked } from './process.js';
import { resolveDemucsStemPaths } from './stemPaths.js';

export interface LocalDemucsSeparatorOptions {
  timeoutMs: number;
  mode: DemucsStemMode;
  cacheDir: string;
  cacheMaxAgeMs: number;
  cacheMaxBytes: number;
  segmentSeconds?: number;
}

export class LocalDemucsSeparator implements StemSeparator {
  private readonly cache: StemCache;

  constructor(private readonly options: LocalDemucsSeparatorOptions) {
    this.cache = new StemCache({
      cacheDir: options.cacheDir,
      maxAgeMs: options.cacheMaxAgeMs,
      maxBytes: options.cacheMaxBytes
    });
  }

  async separate(inputPath: string, outDir: string, onProgress?: (progress: number) => void): Promise<StemPaths> {
    const hash = await hashFile(inputPath);
    const stems = resolveDemucsStemPaths(outDir, inputPath, 'htdemucs', this.options.mode);
    const cached = await this.cache.get(hash, this.options.mode);
    if (cached) {
      await materializeStemPaths(cached, stems);
      onProgress?.(1);
      return stems;
    }

    const args = buildDemucsArgs(inputPath, outDir, this.options.mode, this.options.segmentSeconds);
    await spawnChecked('python3', args, {
      timeoutMs: this.options.timeoutMs,
      onStderr: (chunk) => {
        const progress = parseDemucsProgress(chunk);
        if (progress !== undefined) onProgress?.(progress);
      }
    });

    await this.cache.put(hash, this.options.mode, stems);
    return stems;
  }
}

export async function materializeStemPaths(source: StemPaths, target: StemPaths): Promise<void> {
  await Promise.all(
    (Object.entries(source) as Array<[keyof StemPaths, string | undefined]>)
      .filter((entry): entry is [keyof StemPaths, string] => Boolean(entry[1] && target[entry[0]]))
      .map(async ([stem, sourcePath]) => {
        const targetPath = target[stem]!;
        await mkdir(path.dirname(targetPath), { recursive: true });
        await copyFile(sourcePath, targetPath);
      })
  );
}

export function buildDemucsArgs(inputPath: string, outDir: string, mode: DemucsStemMode, segmentSeconds?: number): string[] {
  const args = ['-m', 'demucs', '--mp3', '-n', 'htdemucs', '-o', outDir];
  if (mode === 'vocals') {
    args.push('--two-stems', 'vocals');
  }
  if (segmentSeconds !== undefined) {
    args.push('--segment', String(segmentSeconds));
  }
  args.push(inputPath);
  return args;
}

export function parseDemucsProgress(chunk: string): number | undefined {
  const match = chunk.match(/(\d{1,3})%/);
  if (!match) return undefined;
  return Math.max(0, Math.min(1, Number(match[1]) / 100));
}
