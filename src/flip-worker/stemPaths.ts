import path from 'node:path';
import type { DemucsStemMode, StemPaths } from './types.js';

export function resolveDemucsStemPaths(outDir: string, inputPath: string, model = 'htdemucs', mode: DemucsStemMode = 'full'): StemPaths {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const root = path.join(outDir, model, baseName);
  if (mode === 'vocals') {
    return {
      vocals: path.join(root, 'vocals.mp3'),
      other: path.join(root, 'no_vocals.mp3')
    };
  }
  return {
    drums: path.join(root, 'drums.mp3'),
    bass: path.join(root, 'bass.mp3'),
    vocals: path.join(root, 'vocals.mp3'),
    other: path.join(root, 'other.mp3')
  };
}

export function assertStemPaths(value: Partial<StemPaths>): asserts value is StemPaths {
  if (!value.vocals) {
    throw new Error('Missing vocals stem output');
  }
}
