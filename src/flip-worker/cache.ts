import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { DemucsStemMode, StemPaths } from './types.js';

export interface StemCacheOptions {
  cacheDir: string;
  maxAgeMs: number;
  maxBytes: number;
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function cacheKey(hash: string, mode: DemucsStemMode): string {
  return `${hash}-${mode}`;
}

export class StemCache {
  constructor(private readonly options: StemCacheOptions) {}

  async get(hash: string, mode: DemucsStemMode): Promise<StemPaths | undefined> {
    const dir = this.entryDir(hash, mode);
    const stems = stemsInDir(dir, mode);
    try {
      await Promise.all(Object.values(stems).filter(Boolean).map((file) => stat(file)));
      const now = new Date();
      await utimes(dir, now, now).catch(() => undefined);
      return stems;
    } catch {
      return undefined;
    }
  }

  async put(hash: string, mode: DemucsStemMode, stems: StemPaths): Promise<StemPaths> {
    const dir = this.entryDir(hash, mode);
    await mkdir(dir, { recursive: true });
    const cached = stemsInDir(dir, mode);
    await Promise.all(
      (Object.entries(stems) as Array<[keyof StemPaths, string | undefined]>)
        .filter((entry): entry is [keyof StemPaths, string] => Boolean(entry[1]))
        .map(([stem, source]) => copyFile(source, cached[stem]!))
    );
    await this.cleanup(dir);
    return cached;
  }

  async cleanup(protectedDir?: string): Promise<void> {
    await mkdir(this.options.cacheDir, { recursive: true });
    const entries = await readdir(this.options.cacheDir, { withFileTypes: true });
    const now = Date.now();
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.options.cacheDir, entry.name);
      const info = await directoryInfo(dir);
      if (protectedDir && path.resolve(dir) === path.resolve(protectedDir)) {
        dirs.push({ dir, ...info });
        continue;
      }
      if (now - info.mtimeMs > this.options.maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      dirs.push({ dir, ...info });
    }

    let total = dirs.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of dirs.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= this.options.maxBytes) break;
      if (protectedDir && path.resolve(entry.dir) === path.resolve(protectedDir)) continue;
      await rm(entry.dir, { recursive: true, force: true });
      total -= entry.bytes;
    }
  }

  private entryDir(hash: string, mode: DemucsStemMode): string {
    return path.join(this.options.cacheDir, cacheKey(hash, mode));
  }
}

function stemsInDir(dir: string, mode: DemucsStemMode): StemPaths {
  if (mode === 'vocals') {
    return {
      vocals: path.join(dir, 'vocals.mp3'),
      other: path.join(dir, 'no_vocals.mp3')
    };
  }
  return {
    drums: path.join(dir, 'drums.mp3'),
    bass: path.join(dir, 'bass.mp3'),
    vocals: path.join(dir, 'vocals.mp3'),
    other: path.join(dir, 'other.mp3')
  };
}

async function directoryInfo(dir: string): Promise<{ bytes: number; mtimeMs: number }> {
  const root = await stat(dir);
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await directoryInfo(file);
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      bytes += (await stat(file)).size;
    }
  }
  return { bytes, mtimeMs: root.mtimeMs };
}
