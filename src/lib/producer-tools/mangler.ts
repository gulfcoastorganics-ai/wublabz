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
}

export interface SliceDecision {
  sourceIndex: number;
  reversed: boolean;
  repeats: number;
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

export function createSlicePlan(slices: number, glitch: number, seed: string | number): SlicePlan {
  const count = Math.max(1, Math.floor(slices));
  const rng = createSeededRng(seed);
  const order = Array.from({ length: count }, (_, index) => index);

  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const chance = clamp01(glitch);
  return {
    order,
    decisions: order.map((sourceIndex) => {
      const reversed = rng() < chance * 0.65;
      const stuttered = rng() < chance * 0.5;
      const repeats = stuttered ? (rng() < 0.55 ? 2 : 4) : 1;
      return { sourceIndex, reversed, repeats };
    })
  };
}

export function renderMangledBuffer(source: ChannelBuffer, options: SliceRenderOptions): ChannelBuffer {
  if (source.channels.length === 0 || source.channels[0].length === 0) {
    return { sampleRate: source.sampleRate, channels: source.channels.map(() => new Float32Array()) };
  }

  const plan = createSlicePlan(options.slices, options.glitch, options.seed);
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
          gain,
          crossfadeSamples,
          fadeIn: sliceWriteIndex > 0
        });
      }
      writeOffset = targetStart + repeatLength;
      sliceWriteIndex += 1;
    }
  }

  return {
    sampleRate: source.sampleRate,
    channels: output.map(softLimitChannel)
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
}): void {
  const fadeLength = Math.min(options.crossfadeSamples, Math.floor(options.targetLength / 2));
  for (let i = 0; i < options.targetLength; i++) {
    const progress = options.targetLength === 1 ? 0 : i / (options.targetLength - 1);
    const sourceOffset = Math.min(options.sourceLength - 1, Math.floor(progress * options.sourceLength));
    const sourceIndex = options.reversed
      ? options.sourceStart + options.sourceLength - 1 - sourceOffset
      : options.sourceStart + sourceOffset;
    let sample = (options.source[sourceIndex] ?? 0) * options.gain;

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
