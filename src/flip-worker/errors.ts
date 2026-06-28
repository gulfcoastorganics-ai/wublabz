import { createFlipPrepError, type FlipPrepError } from '../lib/producer-tools/flipPrepTypes.js';

export class FlipWorkerError extends Error {
  constructor(public readonly detail: FlipPrepError) {
    super(detail.message);
  }
}

export function mapProcessError(error: unknown, fallbackCode: FlipPrepError['code'] = 'UNKNOWN'): FlipPrepError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('python') && (lower.includes('enoent') || lower.includes('not found'))) {
    return createFlipPrepError('PYTHON_MISSING', 'python3 is not available.', 'Install Python 3 or use the worker Docker image.');
  }
  if (lower.includes('no module named demucs') || lower.includes('demucs')) {
    return createFlipPrepError('DEMUCS_MISSING', 'Demucs is not installed for python3.', 'Install demucs with pip or use the worker Docker image.');
  }
  if (lower.includes('ffmpeg')) {
    return createFlipPrepError('FFMPEG_MISSING', 'ffmpeg is required for audio decoding/encoding.', 'Install ffmpeg or use the worker Docker image.');
  }
  if (lower.includes('rubberband')) {
    return createFlipPrepError('RUBBERBAND_MISSING', 'rubberband is not available; falling back may reduce quality.', 'Install rubberband-cli for best stretching quality.');
  }
  if (lower.includes('timeout')) {
    return createFlipPrepError('TIMEOUT', 'Flip Prep processing timed out.', 'Try a shorter file or run the worker on a faster CPU/GPU host.');
  }
  return createFlipPrepError(fallbackCode, message, 'Check worker logs and required audio processing dependencies.');
}
