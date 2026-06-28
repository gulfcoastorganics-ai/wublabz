import type { ChannelBuffer } from '../producer-tools/mangler.js';

export const DEFAULT_NORMALIZE_TARGET_DBFS = -1;
export const DEFAULT_MASTER_LIMITER_DRIVE = 1.15;

export function equalPowerFadeGain(index: number, length: number, fadeIn: boolean): number {
  if (length <= 0) return 1;
  const phase = clamp01(index / length);
  return fadeIn ? Math.sin(phase * Math.PI * 0.5) : Math.cos(phase * Math.PI * 0.5);
}

export function applyEqualPowerFade(value: number, index: number, length: number, fadeIn: boolean): number {
  return value * equalPowerFadeGain(index, length, fadeIn);
}

export function softLimitSample(sample: number, drive = DEFAULT_MASTER_LIMITER_DRIVE): number {
  const shaped = Math.tanh(sample * drive);
  const ceiling = Math.tanh(drive);
  const normalized = ceiling > 0 ? shaped / ceiling : shaped;
  return Math.max(-1, Math.min(1, normalized));
}

export function softLimitChannel(channel: Float32Array, drive = DEFAULT_MASTER_LIMITER_DRIVE): Float32Array {
  const limited = new Float32Array(channel.length);
  for (let i = 0; i < channel.length; i++) {
    limited[i] = softLimitSample(channel[i], drive);
  }
  return limited;
}

export function createSoftLimiterCurve(samples = 2048, drive = DEFAULT_MASTER_LIMITER_DRIVE): Float32Array {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = softLimitSample(x, drive);
  }
  return curve;
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function normalizeChannelBuffer(buffer: ChannelBuffer, targetDbfs = DEFAULT_NORMALIZE_TARGET_DBFS): ChannelBuffer {
  const peak = getPeakAmplitude(buffer);
  if (peak <= 0) {
    return {
      sampleRate: buffer.sampleRate,
      channels: buffer.channels.map((channel) => new Float32Array(channel))
    };
  }

  const target = dbToLinear(targetDbfs);
  const gain = target / peak;
  return {
    sampleRate: buffer.sampleRate,
    channels: buffer.channels.map((channel) => {
      const normalized = new Float32Array(channel.length);
      for (let i = 0; i < channel.length; i++) {
        normalized[i] = channel[i] * gain;
      }
      return normalized;
    })
  };
}

export function getPeakAmplitude(buffer: ChannelBuffer): number {
  let peak = 0;
  for (const channel of buffer.channels) {
    for (let i = 0; i < channel.length; i++) {
      peak = Math.max(peak, Math.abs(channel[i]));
    }
  }
  return peak;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
