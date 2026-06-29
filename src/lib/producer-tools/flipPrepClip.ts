import type { ChannelBuffer } from './mangler.js';

export const DEFAULT_FLIP_PREP_MAX_CLIP_SECONDS = 60;
export const MIN_FLIP_PREP_CLIP_SECONDS = 1;

export interface FlipPrepClipSelection {
  startSeconds: number;
  durationSeconds: number;
  wasAutoTrimmed: boolean;
}

export function clampFlipPrepClipSelection(
  sourceDurationSeconds: number,
  startSeconds: number,
  durationSeconds: number,
  maxDurationSeconds = DEFAULT_FLIP_PREP_MAX_CLIP_SECONDS
): FlipPrepClipSelection {
  const sourceDuration = positiveFinite(sourceDurationSeconds, MIN_FLIP_PREP_CLIP_SECONDS);
  const maxDuration = Math.max(MIN_FLIP_PREP_CLIP_SECONDS, positiveFinite(maxDurationSeconds, DEFAULT_FLIP_PREP_MAX_CLIP_SECONDS));
  const maxStart = Math.max(0, sourceDuration - MIN_FLIP_PREP_CLIP_SECONDS);
  const start = clamp(finiteOr(startSeconds, 0), 0, maxStart);
  const available = Math.max(MIN_FLIP_PREP_CLIP_SECONDS, sourceDuration - start);
  const requestedDuration = positiveFinite(durationSeconds, Math.min(maxDuration, available));
  const duration = clamp(requestedDuration, MIN_FLIP_PREP_CLIP_SECONDS, Math.min(maxDuration, available));

  return {
    startSeconds: roundSeconds(start),
    durationSeconds: roundSeconds(duration),
    wasAutoTrimmed: sourceDuration > maxDuration || requestedDuration > duration
  };
}

export function trimChannelBuffer(buffer: ChannelBuffer, startSeconds: number, durationSeconds: number): ChannelBuffer {
  const sourceFrames = buffer.channels[0]?.length ?? 0;
  const sampleRate = positiveFinite(buffer.sampleRate, 44100);
  const startFrame = clamp(Math.floor(finiteOr(startSeconds, 0) * sampleRate), 0, Math.max(0, sourceFrames - 1));
  const requestedFrames = Math.max(1, Math.floor(positiveFinite(durationSeconds, MIN_FLIP_PREP_CLIP_SECONDS) * sampleRate));
  const endFrame = clamp(startFrame + requestedFrames, startFrame + 1, sourceFrames);

  return {
    sampleRate,
    channels: buffer.channels.map((channel) => new Float32Array(channel.slice(startFrame, endFrame)))
  };
}

export function estimateFlipPrepTotalSeconds(durationSeconds: number): number {
  return Math.max(120, Math.round(positiveFinite(durationSeconds, DEFAULT_FLIP_PREP_MAX_CLIP_SECONDS) * 20));
}

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
