import type { ChannelBuffer } from '../producer-tools/mangler.js';

export const DEFAULT_NORMALIZE_TARGET_DBFS = -1;
export const DEFAULT_MASTER_LIMITER_DRIVE = 1.15;
export const DEFAULT_MASTER_HEADROOM_DB = -3;
export const DEFAULT_LOW_MONO_HZ = 120;
export const DEFAULT_MASTER_SATURATION_DRIVE = 1.08;
export const DEFAULT_MASTER_GLUE_THRESHOLD_DB = -12;
export const DEFAULT_MASTER_GLUE_RATIO = 1.35;

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

export function renderMasterChannelBuffer(buffer: ChannelBuffer, targetDbfs = DEFAULT_NORMALIZE_TARGET_DBFS): ChannelBuffer {
  const staged = applyMasterHeadroom(buffer);
  const saturated = applyMasterSoftSaturation(staged, DEFAULT_MASTER_SATURATION_DRIVE);
  const glued = applyMasterGlueCompression(saturated);
  const monoLow = monoLowBand(glued, DEFAULT_LOW_MONO_HZ);
  const limited = {
    sampleRate: monoLow.sampleRate,
    channels: monoLow.channels.map((channel) => softLimitChannel(channel, DEFAULT_MASTER_LIMITER_DRIVE))
  };
  return normalizeTruePeakSafe(limited, targetDbfs);
}

export function applyMasterHeadroom(buffer: ChannelBuffer, headroomDb = DEFAULT_MASTER_HEADROOM_DB): ChannelBuffer {
  const gain = dbToLinear(headroomDb);
  return {
    sampleRate: buffer.sampleRate,
    channels: buffer.channels.map((channel) => {
      const staged = new Float32Array(channel.length);
      for (let i = 0; i < channel.length; i++) {
        staged[i] = channel[i] * gain;
      }
      return staged;
    })
  };
}

export function applyMasterSoftSaturation(buffer: ChannelBuffer, drive = 1.04): ChannelBuffer {
  return {
    sampleRate: buffer.sampleRate,
    channels: buffer.channels.map((channel) => {
      const saturated = new Float32Array(channel.length);
      for (let i = 0; i < channel.length; i++) {
        saturated[i] = Math.tanh(channel[i] * drive) / Math.tanh(drive);
      }
      return saturated;
    })
  };
}

export function applyMasterGlueCompression(buffer: ChannelBuffer, thresholdDb = DEFAULT_MASTER_GLUE_THRESHOLD_DB, ratio = DEFAULT_MASTER_GLUE_RATIO): ChannelBuffer {
  const threshold = dbToLinear(thresholdDb);
  const safeRatio = Math.max(1, ratio);
  const rendered = buffer.channels.map((channel) => new Float32Array(channel.length));
  const length = Math.max(0, ...buffer.channels.map((channel) => channel.length));
  let envelope = 0;
  let gain = 1;
  const attack = coefficient(buffer.sampleRate, 0.018);
  const release = coefficient(buffer.sampleRate, 0.16);

  for (let i = 0; i < length; i++) {
    let peak = 0;
    for (const channel of buffer.channels) {
      peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    }

    const detector = peak > envelope ? attack : release;
    envelope = detector * envelope + (1 - detector) * peak;
    const targetGain = envelope > threshold ? Math.pow(envelope / threshold, (1 / safeRatio) - 1) : 1;
    const gainSmoothing = targetGain < gain ? attack : release;
    gain = gainSmoothing * gain + (1 - gainSmoothing) * targetGain;

    for (let channelIndex = 0; channelIndex < buffer.channels.length; channelIndex++) {
      const source = buffer.channels[channelIndex];
      if (i < source.length) {
        rendered[channelIndex][i] = source[i] * gain;
      }
    }
  }

  return {
    sampleRate: buffer.sampleRate,
    channels: rendered
  };
}

export function monoLowBand(buffer: ChannelBuffer, cutoffHz = DEFAULT_LOW_MONO_HZ): ChannelBuffer {
  if (buffer.channels.length < 2) {
    return {
      sampleRate: buffer.sampleRate,
      channels: buffer.channels.map((channel) => new Float32Array(channel))
    };
  }

  const left = buffer.channels[0];
  const right = buffer.channels[1];
  const length = Math.min(left.length, right.length);
  const lowLeft = onePoleLowpass(left, buffer.sampleRate, cutoffHz);
  const lowRight = onePoleLowpass(right, buffer.sampleRate, cutoffHz);
  const rendered = buffer.channels.map((channel) => new Float32Array(channel));
  for (let i = 0; i < length; i++) {
    const monoLow = (lowLeft[i] + lowRight[i]) * 0.5;
    rendered[0][i] = (left[i] - lowLeft[i]) + monoLow;
    rendered[1][i] = (right[i] - lowRight[i]) + monoLow;
  }
  return {
    sampleRate: buffer.sampleRate,
    channels: rendered
  };
}

export function normalizeTruePeakSafe(buffer: ChannelBuffer, targetDbfs = DEFAULT_NORMALIZE_TARGET_DBFS): ChannelBuffer {
  const target = dbToLinear(targetDbfs);
  const peak = Math.max(getPeakAmplitude(buffer), estimateIntersamplePeak(buffer));
  if (peak <= 0) {
    return {
      sampleRate: buffer.sampleRate,
      channels: buffer.channels.map((channel) => new Float32Array(channel))
    };
  }

  const gain = Math.min(target / peak, target / getPeakAmplitude(buffer));
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

function coefficient(sampleRate: number, seconds: number): number {
  return Math.exp(-1 / (Math.max(1, sampleRate) * Math.max(0.001, seconds)));
}

function estimateIntersamplePeak(buffer: ChannelBuffer): number {
  let peak = 0;
  for (const channel of buffer.channels) {
    for (let i = 1; i < channel.length; i++) {
      const previous = channel[i - 1];
      const current = channel[i];
      const transitionOvershoot = Math.abs(current - previous) * 0.125;
      peak = Math.max(peak, Math.abs(previous), Math.abs(current), Math.abs((previous + current) * 0.5), Math.max(Math.abs(previous), Math.abs(current)) + transitionOvershoot);
    }
  }
  return peak;
}

function onePoleLowpass(channel: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const output = new Float32Array(channel.length);
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * Math.max(1, cutoffHz));
  const alpha = dt / (rc + dt);
  let previous = 0;
  for (let i = 0; i < channel.length; i++) {
    previous += alpha * (channel[i] - previous);
    output[i] = previous;
  }
  return output;
}
