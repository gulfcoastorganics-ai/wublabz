import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpFlipPrepClient, resolveFlipPrepAssetUrl } from '../src/lib/producer-tools/flipPrepApi.js';
import { isFlipPrepJob } from '../src/lib/producer-tools/flipPrepTypes.js';
import { buildDemucsArgs, LocalDemucsSeparator, materializeStemPaths } from '../src/flip-worker/LocalDemucsSeparator.js';
import { StemCache, hashFile } from '../src/flip-worker/cache.js';
import { calculateStretchRate } from '../src/flip-worker/math.js';
import { mapProcessError } from '../src/flip-worker/errors.js';
import { FlipPrepJobQueue } from '../src/flip-worker/queue.js';
import { spawnChecked } from '../src/flip-worker/process.js';
import { resolveDemucsStemPaths } from '../src/flip-worker/stemPaths.js';
import { parseMultipartUpload, validateAudioUpload } from '../src/flip-worker/upload.js';
import type { FlipPrepWorkerConfig, StemSeparator } from '../src/flip-worker/types.js';

describe('Flip Prep worker pure logic', () => {
  it('captures subprocess output and rejects non-zero exits with stderr', async () => {
    await expect(spawnChecked('/bin/sh', ['-c', 'printf ok'], { timeoutMs: 1_000 })).resolves.toMatchObject({ stdout: 'ok' });
    await expect(spawnChecked('/bin/sh', ['-c', 'printf bad >&2; exit 2'], { timeoutMs: 1_000 })).rejects.toThrow('bad');
  });

  it('terminates subprocesses on timeout before rejecting', async () => {
    const started = Date.now();
    await expect(spawnChecked('/bin/sh', ['-c', 'trap "" TERM; sleep 5'], {
      timeoutMs: 20,
      killGraceMs: 20
    })).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('calculates acapella stretch rate as target over detected BPM', () => {
    expect(calculateStretchRate(140, 70)).toBe(2);
    expect(calculateStretchRate(140, 140)).toBe(1);
    expect(() => calculateStretchRate(140, 0)).toThrow('detectedBpm');
  });

  it('resolves Demucs htdemucs mp3 stem paths', () => {
    expect(resolveDemucsStemPaths('/tmp/out', '/tmp/uploads/song.wav', 'htdemucs', 'full')).toEqual({
      drums: path.join('/tmp/out', 'htdemucs', 'song', 'drums.mp3'),
      bass: path.join('/tmp/out', 'htdemucs', 'song', 'bass.mp3'),
      vocals: path.join('/tmp/out', 'htdemucs', 'song', 'vocals.mp3'),
      other: path.join('/tmp/out', 'htdemucs', 'song', 'other.mp3')
    });
    expect(resolveDemucsStemPaths('/tmp/out', '/tmp/uploads/song.wav', 'htdemucs', 'vocals')).toEqual({
      vocals: path.join('/tmp/out', 'htdemucs', 'song', 'vocals.mp3'),
      other: path.join('/tmp/out', 'htdemucs', 'song', 'no_vocals.mp3')
    });
  });

  it('selects two-stem vocals by default and supports full four-stem args', () => {
    expect(buildDemucsArgs('song.wav', '/tmp/out', 'vocals')).toEqual([
      '-m', 'demucs', '--mp3', '-n', 'htdemucs', '-o', '/tmp/out', '--two-stems', 'vocals', 'song.wav'
    ]);
    expect(buildDemucsArgs('song.wav', '/tmp/out', 'full', 12)).toEqual([
      '-m', 'demucs', '--mp3', '-n', 'htdemucs', '-o', '/tmp/out', '--segment', '12', 'song.wav'
    ]);
  });

  it('maps missing dependency errors to actionable client errors', () => {
    expect(mapProcessError(new Error('python3 ENOENT')).code).toBe('PYTHON_MISSING');
    expect(mapProcessError(new Error('No module named demucs')).code).toBe('DEMUCS_MISSING');
    expect(mapProcessError(new Error('ffmpeg not found')).code).toBe('FFMPEG_MISSING');
    expect(mapProcessError(new Error('timeout')).code).toBe('TIMEOUT');
  });

  it('parses multipart uploads without corrupting binary audio bytes', () => {
    const boundary = 'wublabz-boundary';
    const audioBytes = Buffer.from([0, 255, 128, 13, 10, 45, 45, 1, 2, 3, 254]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../bad name.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      audioBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const upload = parseMultipartUpload(`multipart/form-data; boundary=${boundary}`, body);

    expect(upload.fileName).toBe('bad_name.wav');
    expect(upload.contentType).toBe('audio/wav');
    expect(upload.bytes).toEqual(audioBytes);
    expect(() => validateAudioUpload(upload, 1024)).not.toThrow();
  });

  it('rejects non-audio uploads and oversized audio', () => {
    expect(() => validateAudioUpload({
      fileName: 'notes.txt',
      contentType: 'text/plain',
      bytes: Buffer.from('not audio')
    }, 1024)).toThrow('audio');
    expect(() => validateAudioUpload({
      fileName: 'loop.wav',
      contentType: 'audio/wav',
      bytes: Buffer.alloc(4)
    }, 3)).toThrow('exceeds');
  });

  it('runs queued job transitions with a mocked separator and analyzer', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'flip-worker-test-'));
    const separator: StemSeparator = {
      async separate(_inputPath, outDir) {
        const stems = resolveDemucsStemPaths(outDir, path.join(workDir, 'song.wav'), 'htdemucs', 'vocals');
        await Promise.all(Object.values(stems).map((stemPath) => writeFileWithDirs(stemPath, 'stem')));
        return stems;
      }
    };
    const queue = new FlipPrepJobQueue(testConfig(workDir), separator, Date.now, async () => {
      return { key: 'D minor', bpm: 128 };
    }, async (_input, _vocals, output) => {
      await writeFile(output, 'wav');
      return { acapellaPath: output };
    });

    const created = await queue.enqueue({
      fileName: 'song.wav',
      contentType: 'audio/wav',
      bytes: Buffer.from('audio')
    });

    const done = await waitFor(() => {
      const job = queue.get(created.jobId);
      return job?.status === 'done' ? job : undefined;
    });

    expect(done.step).toBe('stretching-acapella');
    expect(done.result?.key).toBe('D minor');
    expect(done.result?.stems.map((stem) => stem.name)).toEqual(['vocals', 'other']);
    expect(queue.getFilePath(created.jobId, 'vocals')).toContain('vocals.mp3');
    expect(isFlipPrepJob(done)).toBe(true);
  });

  it('cleans expired completed jobs and removes their work directories', async () => {
    let now = 1_000;
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'flip-expiry-test-'));
    const separator: StemSeparator = {
      async separate(_inputPath, outDir) {
        const stems = resolveDemucsStemPaths(outDir, path.join(workDir, 'song.wav'), 'htdemucs', 'vocals');
        await Promise.all(Object.values(stems).map((stemPath) => writeFileWithDirs(stemPath, 'stem')));
        return stems;
      }
    };
    const queue = new FlipPrepJobQueue(testConfig(workDir), separator, () => now, async () => {
      return { key: 'G minor', bpm: 140 };
    }, async (_input, _vocals, output) => {
      await writeFile(output, 'wav');
      return { acapellaPath: output };
    });
    const created = await queue.enqueue({ fileName: 'song.wav', contentType: 'audio/wav', bytes: Buffer.from('audio') });
    const done = await waitFor(() => queue.get(created.jobId)?.status === 'done' ? queue.get(created.jobId) : undefined);
    const filePath = queue.getFilePath(created.jobId, 'vocals')!;
    await expect(stat(filePath)).resolves.toBeTruthy();

    now += 2_000;
    await expect(queue.cleanupExpiredJobs()).resolves.toBe(1);

    expect(queue.get(created.jobId)).toBeUndefined();
    await expect(stat(filePath)).rejects.toThrow();
    expect(done.status).toBe('done');
  });

  it('caches stems by content hash and mode', async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'flip-cache-test-'));
    const source = path.join(cacheDir, 'source.wav');
    const stemsDir = path.join(cacheDir, 'stems');
    await writeFile(source, 'same audio');
    const hash = await hashFile(source);
    const cache = new StemCache({ cacheDir, maxAgeMs: 60_000, maxBytes: 10_000_000 });
    const stems = resolveDemucsStemPaths(stemsDir, source, 'htdemucs', 'vocals');
    await Promise.all(Object.values(stems).map((stemPath) => writeFileWithDirs(stemPath, 'stem')));

    expect(await cache.get(hash, 'vocals')).toBeUndefined();
    await cache.put(hash, 'vocals', stems);
    expect(await cache.get(hash, 'vocals')).toMatchObject({ vocals: expect.stringContaining('vocals.mp3') });
    expect(await cache.get(hash, 'full')).toBeUndefined();
  });

  it('evicts cache entries by age and size while preserving the latest write', async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'flip-cache-cleanup-test-'));
    const cache = new StemCache({ cacheDir, maxAgeMs: 1_000, maxBytes: 16 });
    const oldDir = path.join(cacheDir, 'old-vocals');
    const largeDir = path.join(cacheDir, 'large-vocals');
    await writeFileWithDirs(path.join(oldDir, 'vocals.mp3'), 'old');
    await writeFileWithDirs(path.join(oldDir, 'no_vocals.mp3'), 'old');
    await writeFileWithDirs(path.join(largeDir, 'vocals.mp3'), 'large-large-large');
    await writeFileWithDirs(path.join(largeDir, 'no_vocals.mp3'), 'large-large-large');
    const oldDate = new Date(Date.now() - 10_000);
    await utimes(oldDir, oldDate, oldDate);

    const source = path.join(cacheDir, 'source.wav');
    await writeFile(source, 'new');
    const hash = await hashFile(source);
    const stemsDir = path.join(cacheDir, 'new-stems');
    const stems = resolveDemucsStemPaths(stemsDir, source, 'htdemucs', 'vocals');
    await Promise.all(Object.values(stems).map((stemPath) => writeFileWithDirs(stemPath, 'new')));
    const cached = await cache.put(hash, 'vocals', stems);

    const entries = await readdir(cacheDir);
    expect(entries).not.toContain('old-vocals');
    expect(entries).not.toContain('large-vocals');
    await expect(stat(cached.vocals)).resolves.toBeTruthy();
  });

  it('materializes cached stems into the current job output layout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flip-cache-materialize-test-'));
    const cached = {
      vocals: path.join(root, 'cache', 'vocals.mp3'),
      other: path.join(root, 'cache', 'no_vocals.mp3')
    };
    const jobLocal = resolveDemucsStemPaths(path.join(root, 'job-demucs'), path.join(root, 'song.wav'), 'htdemucs', 'vocals');
    await writeFileWithDirs(cached.vocals, 'cached-vocals');
    await writeFileWithDirs(cached.other, 'cached-other');

    await materializeStemPaths(cached, jobLocal);

    expect(await readFile(jobLocal.vocals, 'utf8')).toBe('cached-vocals');
    expect(await readFile(jobLocal.other!, 'utf8')).toBe('cached-other');
  });

  it('starts analysis before separation completes and stretches after vocals exist', async () => {
    const calls: string[] = [];
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'flip-parallel-test-'));
    let releaseSeparator!: () => void;
    const separator: StemSeparator = {
      async separate(_inputPath, outDir) {
        calls.push('separator:start');
        await new Promise<void>((resolve) => { releaseSeparator = resolve; });
        const stems = resolveDemucsStemPaths(outDir, path.join(workDir, 'song.wav'), 'htdemucs', 'vocals');
        await Promise.all(Object.values(stems).map((stemPath) => writeFileWithDirs(stemPath, 'stem')));
        calls.push('separator:end');
        return stems;
      }
    };
    const queue = new FlipPrepJobQueue(testConfig(workDir), separator, Date.now, async () => {
      calls.push('analysis:start');
      return { key: 'F minor', bpm: 140 };
    }, async (_input, vocals, output) => {
      calls.push(`stretch:${path.basename(vocals)}`);
      await writeFile(output, 'wav');
      return { acapellaPath: output };
    });

    const created = await queue.enqueue({ fileName: 'song.wav', contentType: 'audio/wav', bytes: Buffer.from('audio') });
    await waitFor(() => calls.includes('analysis:start') && calls.includes('separator:start') ? true : undefined);
    expect(calls).toEqual(['analysis:start', 'separator:start']);
    releaseSeparator();
    await waitFor(() => queue.get(created.jobId)?.status === 'done' ? true : undefined);
    expect(calls).toEqual(['analysis:start', 'separator:start', 'separator:end', 'stretch:vocals.mp3']);
  });

  it('settles parallel analysis failures without racing separator completion', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'flip-parallel-error-test-'));
    let releaseSeparator!: () => void;
    const separator: StemSeparator = {
      async separate(_inputPath, outDir) {
        await new Promise<void>((resolve) => { releaseSeparator = resolve; });
        return resolveDemucsStemPaths(outDir, path.join(workDir, 'song.wav'), 'htdemucs', 'vocals');
      }
    };
    const queue = new FlipPrepJobQueue(testConfig(workDir), separator, Date.now, async () => {
      throw new Error('analysis failed fast');
    }, async () => {
      throw new Error('stretch should not run');
    });

    const created = await queue.enqueue({ fileName: 'song.wav', contentType: 'audio/wav', bytes: Buffer.from('audio') });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.get(created.jobId)?.status).toBe('processing');
    releaseSeparator();

    const failed = await waitFor(() => {
      const job = queue.get(created.jobId);
      return job?.status === 'error' ? job : undefined;
    });
    expect(failed.error).toContain('analysis failed fast');
  });

  it('keeps HttpFlipPrepClient contract aligned with worker endpoints', async () => {
    const calls: string[] = [];
    const originalFetch = (globalThis as any).fetch;
    const originalFormData = (globalThis as any).FormData;
    (globalThis as any).FormData = class {
      append() {}
    };
    (globalThis as any).fetch = async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ jobId: 'job-1', status: 'queued', step: 'queued', progress: 0 })
      };
    };
    try {
      const client = new HttpFlipPrepClient('http://worker');
      expect(await client.createJob({})).toMatchObject({ jobId: 'job-1' });
      expect(await client.getJob('job-1')).toMatchObject({ step: 'queued' });
      expect(calls).toEqual([
        'http://worker/api/flip-prep/jobs',
        'http://worker/api/flip-prep/jobs/job-1'
      ]);
    } finally {
      (globalThis as any).fetch = originalFetch;
      (globalThis as any).FormData = originalFormData;
    }
  });

  it('resolves worker download URLs against the configured API base URL', () => {
    expect(resolveFlipPrepAssetUrl('http://127.0.0.1:3001', '/api/flip-prep/jobs/1/files/vocals')).toBe(
      'http://127.0.0.1:3001/api/flip-prep/jobs/1/files/vocals'
    );
    expect(resolveFlipPrepAssetUrl('http://127.0.0.1:3001/base', 'api/flip-prep/jobs/1/files/vocals')).toBe(
      'http://127.0.0.1:3001/base/api/flip-prep/jobs/1/files/vocals'
    );
    expect(resolveFlipPrepAssetUrl('http://127.0.0.1:3001', 'https://cdn.example/stem.wav')).toBe('https://cdn.example/stem.wav');
    expect(resolveFlipPrepAssetUrl('', '#')).toBe('#');
  });

  it('surfaces actionable worker errors through the HTTP client', async () => {
    const originalFetch = (globalThis as any).fetch;
    const originalFormData = (globalThis as any).FormData;
    (globalThis as any).FormData = class {
      append() {}
    };
    (globalThis as any).fetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({
        error: 'Flip Prep worker is not reachable.',
        errorDetail: {
          message: 'Flip Prep worker is not reachable.',
          actionable: 'Start the worker with npm run flip-worker.'
        }
      })
    });
    try {
      await expect(new HttpFlipPrepClient('http://worker').createJob({})).rejects.toThrow('Start the worker');
    } finally {
      (globalThis as any).fetch = originalFetch;
      (globalThis as any).FormData = originalFormData;
    }
  });
});

describe('Flip Prep real Demucs integration', () => {
  it.skipIf(process.env.RUN_DEMUCS_INTEGRATION !== 'true')('runs LocalDemucsSeparator when explicitly enabled', async () => {
    const inputPath = process.env.DEMUCS_TEST_AUDIO;
    if (!inputPath) throw new Error('Set DEMUCS_TEST_AUDIO to an audio file path');
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'demucs-integration-'));
    const stems = await new LocalDemucsSeparator({
      timeoutMs: 20 * 60 * 1000,
      mode: 'vocals',
      cacheDir: path.join(outDir, 'cache'),
      cacheMaxAgeMs: 60_000,
      cacheMaxBytes: 1024 * 1024 * 1024
    }).separate(inputPath, outDir);
    expect(stems.vocals).toContain('vocals.mp3');
  });
});

function testConfig(workDir: string): FlipPrepWorkerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    separator: 'local',
    maxUploadBytes: 1024 * 1024,
    concurrency: 1,
    jobTtlMs: 1000,
    demucsTimeoutMs: 1000,
    workDir,
    stemMode: 'vocals',
    cacheDir: path.join(workDir, 'cache'),
    cacheMaxAgeMs: 60_000,
    cacheMaxBytes: 10_000_000
  };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 1000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

async function writeFileWithDirs(filePath: string, contents: string): Promise<void> {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(filePath), { recursive: true }));
  await writeFile(filePath, contents);
}
