import type { FlipPrepWorkerConfig } from './types.js';
import type { StemSeparator } from './types.js';
import { LocalDemucsSeparator } from './LocalDemucsSeparator.js';

export function createStemSeparator(config: FlipPrepWorkerConfig): StemSeparator {
  if (config.separator === 'cloud') {
    throw new Error('CloudSeparator is not implemented yet. TODO: add Replicate/Modal adapter behind StemSeparator.');
  }
  return new LocalDemucsSeparator({
    timeoutMs: config.demucsTimeoutMs,
    mode: config.stemMode,
    cacheDir: config.cacheDir,
    cacheMaxAgeMs: config.cacheMaxAgeMs,
    cacheMaxBytes: config.cacheMaxBytes,
    segmentSeconds: config.demucsSegmentSeconds
  });
}
