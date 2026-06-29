import { applyEqualPowerFade, softLimitChannel, softLimitSample } from '../audio/outputQuality.js';

export interface ChannelBuffer {
  sampleRate: number;
  channels: Float32Array[];
}

export interface SliceRenderOptions {
  slices: number;
  glitch: number;
  pitchSemitones: number;
  crossfadeMs: number;
  gain: number;
  seed: string | number;
  bitcrush?: number;
  filterSweep?: number;
  reverseChance?: number;
  gate?: number;
  stutter?: number;
  tapeStop?: number;
  order?: number[];
  sliceOverrides?: Record<number, SliceOverride>;
}

export interface SliceDecision {
  sourceIndex: number;
  reversed: boolean;
  repeats: number;
  gain: number;
  muted: boolean;
}

export interface SliceOverride {
  reversed?: boolean;
  repeats?: number;
  gain?: number;
  muted?: boolean;
}

export interface SlicePlan {
  order: number[];
  decisions: SliceDecision[];
}

export function createSeededRng(seed: string | number): () => number {
  let h = 2166136261;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSlicePlan(
  slices: number,
  glitch: number,
  seed: string | number,
  options: { reverseChance?: number; stutter?: number; order?: number[]; sliceOverrides?: Record<number, SliceOverride> } = {}
): SlicePlan {
  const count = Math.max(1, Math.floor(slices));
  const rng = createSeededRng(seed);
  const fallbackOrder = Array.from({ length: count }, (_, index) => index);
  const suppliedOrder = options.order?.filter((index) => Number.isInteger(index) && index >= 0 && index < count) ?? [];
  const missing = fallbackOrder.filter((index) => !suppliedOrder.includes(index));
  const order = suppliedOrder.length > 0 ? [...suppliedOrder, ...missing] : fallbackOrder;

  if (!options.order) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  const chance = clamp01(glitch);
  return {
    order,
    decisions: order.map((sourceIndex) => {
      const override = options.sliceOverrides?.[sourceIndex];
      const reversed = override?.reversed ?? rng() < Math.max(chance * 0.65, clamp01(options.reverseChance ?? 0));
      const stutterChance = Math.max(chance * 0.5, clamp01(options.stutter ?? 0));
      const stuttered = rng() < stutterChance;
      const repeats = stuttered ? (rng() < 0.55 ? 2 : 4) : 1;
      return {
        sourceIndex,
        reversed,
        repeats: clampInt(override?.repeats ?? repeats, 1, 8),
        gain: Math.max(0, override?.gain ?? 1),
        muted: override?.muted ?? false
      };
    })
  };
}

export function renderMangledBuffer(source: ChannelBuffer, options: SliceRenderOptions): ChannelBuffer {
  if (source.channels.length === 0 || source.channels[0].length === 0) {
    return { sampleRate: source.sampleRate, channels: source.channels.map(() => new Float32Array()) };
  }

  const plan = createSlicePlan(options.slices, options.glitch, options.seed, {
    reverseChance: options.reverseChance,
    stutter: options.stutter,
    order: options.order,
    sliceOverrides: options.sliceOverrides
  });
  const sliceLength = Math.floor(source.channels[0].length / plan.order.length);
  // TODO: Replace this resampling shortcut with duration-preserving phase-vocoder pitch-shift.
  const pitchRatio = Math.pow(2, options.pitchSemitones / 12);
  const crossfadeSamples = Math.max(0, Math.floor((options.crossfadeMs / 1000) * source.sampleRate));
  const gain = Math.max(0, options.gain);
  const renderedLengths = plan.decisions.flatMap((decision) => {
    const renderedSliceLength = Math.max(1, Math.floor(sliceLength / pitchRatio / decision.repeats));
    return Array.from({ length: decision.repeats }, () => renderedSliceLength);
  });
  const outputLength = renderedLengths.reduce((total, renderedSliceLength, index) => {
    const fadeLength = Math.min(crossfadeSamples, Math.floor(renderedSliceLength / 2));
    return total + renderedSliceLength - (index > 0 ? fadeLength : 0);
  }, 0);
  const output = source.channels.map(() => new Float32Array(outputLength));

  let writeOffset = 0;
  let sliceWriteIndex = 0;
  for (const decision of plan.decisions) {
    const repeatLength = Math.max(1, Math.floor(sliceLength / pitchRatio / decision.repeats));
    for (let repeat = 0; repeat < decision.repeats; repeat++) {
      const fadeLength = Math.min(crossfadeSamples, Math.floor(repeatLength / 2));
      const targetStart = Math.max(0, writeOffset - (sliceWriteIndex > 0 ? fadeLength : 0));
      for (let channel = 0; channel < source.channels.length; channel++) {
        writeSlice({
          source: source.channels[channel],
          target: output[channel],
          sourceStart: decision.sourceIndex * sliceLength,
          sourceLength: sliceLength,
          targetStart,
          targetLength: repeatLength,
          reversed: decision.reversed,
          gain: decision.muted ? 0 : gain * decision.gain,
          crossfadeSamples,
          fadeIn: sliceWriteIndex > 0,
          bitcrush: options.bitcrush ?? 0,
          gate: options.gate ?? 0,
          tapeStop: options.tapeStop ?? 0
        });
      }
      writeOffset = targetStart + repeatLength;
      sliceWriteIndex += 1;
    }
  }

  return {
    sampleRate: source.sampleRate,
    channels: output.map((channel) => softLimitChannel(applyFilterSweep(channel, source.sampleRate, options.filterSweep ?? 0)))
  };
}

export { applyEqualPowerFade, softLimitSample };

function writeSlice(options: {
  source: Float32Array;
  target: Float32Array;
  sourceStart: number;
  sourceLength: number;
  targetStart: number;
  targetLength: number;
  reversed: boolean;
  gain: number;
  crossfadeSamples: number;
  fadeIn: boolean;
  bitcrush: number;
  gate: number;
  tapeStop: number;
}): void {
  const fadeLength = Math.min(options.crossfadeSamples, Math.floor(options.targetLength / 2));
  for (let i = 0; i < options.targetLength; i++) {
    const progress = options.targetLength === 1 ? 0 : i / (options.targetLength - 1);
    const tapeCurve = applyTapeStopCurve(progress, options.tapeStop);
    const sourceOffset = Math.min(options.sourceLength - 1, Math.floor(tapeCurve * options.sourceLength));
    const sourceIndex = options.reversed
      ? options.sourceStart + options.sourceLength - 1 - sourceOffset
      : options.sourceStart + sourceOffset;
    let sample = (options.source[sourceIndex] ?? 0) * options.gain;
    sample = applyGate(sample, progress, options.gate);
    sample = applyBitcrush(sample, options.bitcrush);

    if (options.fadeIn && i < fadeLength) {
      sample = applyEqualPowerFade(sample, i, fadeLength, true);
    } else if (i >= options.targetLength - fadeLength) {
      sample = applyEqualPowerFade(sample, options.targetLength - i - 1, fadeLength, false);
    }

    options.target[options.targetStart + i] += sample;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function applyBitcrush(sample: number, amount: number): number {
  const crush = clamp01(amount);
  if (crush <= 0) return sample;
  const levels = Math.max(4, Math.round(256 - crush * 240));
  return Math.round(sample * levels) / levels;
}

function applyGate(sample: number, progress: number, amount: number): number {
  const gate = clamp01(amount);
  if (gate <= 0) return sample;
  const steps = 2 + Math.round(gate * 10);
  const phase = (progress * steps) % 1;
  const open = phase < 1 - gate * 0.72;
  return open ? sample : sample * (1 - gate);
}

function applyTapeStopCurve(progress: number, amount: number): number {
  const stop = clamp01(amount);
  if (stop <= 0) return progress;
  const start = 1 - stop * 0.82;
  if (progress <= start) return progress;
  const local = (progress - start) / Math.max(0.0001, 1 - start);
  const eased = 1 - Math.pow(1 - local, 2.2);
  return Math.min(1, start + eased * (1 - start) * (1 - stop * 0.55));
}

function applyFilterSweep(channel: Float32Array, sampleRate: number, amount: number): Float32Array {
  const sweep = clamp01(amount);
  if (sweep <= 0 || channel.length === 0) return channel;
  const output = new Float32Array(channel.length);
  let low = 0;
  for (let i = 0; i < channel.length; i++) {
    const progress = i / Math.max(1, channel.length - 1);
    const cutoff = 180 + Math.pow(progress, 1.4) * sweep * 7800;
    const alpha = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    low += alpha * (channel[i] - low);
    output[i] = low;
  }
  return output;
}
