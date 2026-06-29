import type { ChannelBuffer } from '../producer-tools/mangler.js';
import { createSoftLimiterCurve, dbToLinear, DEFAULT_MASTER_GLUE_RATIO, DEFAULT_MASTER_GLUE_THRESHOLD_DB, DEFAULT_MASTER_HEADROOM_DB, DEFAULT_MASTER_LIMITER_DRIVE, DEFAULT_MASTER_SATURATION_DRIVE } from './outputQuality.js';

type AudioContextLike = any;

let sharedContext: AudioContextLike;
let analyser: any;
let masterHeadroom: any;
let masterSaturation: any;
let masterCompressor: any;
let masterLimiter: any;
let masterCeiling: any;

export function getProducerAudioContext(): AudioContextLike {
  if (sharedContext) return sharedContext;
  const ctor = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  if (!ctor) {
    throw new Error('Web Audio is not available in this runtime');
  }
  sharedContext = new ctor();
  return sharedContext;
}

export async function decodeProducerAudio(arrayBuffer: ArrayBuffer): Promise<any> {
  const context = getProducerAudioContext();
  if (context.state === 'suspended' && typeof context.resume === 'function') {
    await context.resume();
  }
  return context.decodeAudioData(arrayBuffer.slice(0));
}

export function toChannelBuffer(audioBuffer: any): ChannelBuffer {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    channels.push(new Float32Array(audioBuffer.getChannelData(channel)));
  }
  return {
    sampleRate: audioBuffer.sampleRate,
    channels
  };
}

export function fromChannelBuffer(context: AudioContextLike, buffer: ChannelBuffer): any {
  const audioBuffer = context.createBuffer(buffer.channels.length, buffer.channels[0]?.length ?? 0, buffer.sampleRate);
  for (let channel = 0; channel < buffer.channels.length; channel++) {
    audioBuffer.copyToChannel(buffer.channels[channel], channel);
  }
  return audioBuffer;
}

export function getProducerAnalyser(): any {
  const context = getProducerAudioContext();
  if (!analyser) {
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    masterHeadroom = context.createGain();
    masterHeadroom.gain.value = dbToLinear(DEFAULT_MASTER_HEADROOM_DB);
    masterSaturation = context.createWaveShaper();
    masterSaturation.curve = createSoftLimiterCurve(2048, DEFAULT_MASTER_SATURATION_DRIVE);
    masterSaturation.oversample = '4x';
    masterCompressor = context.createDynamicsCompressor();
    masterCompressor.threshold.value = DEFAULT_MASTER_GLUE_THRESHOLD_DB;
    masterCompressor.knee.value = 18;
    masterCompressor.ratio.value = DEFAULT_MASTER_GLUE_RATIO;
    masterCompressor.attack.value = 0.018;
    masterCompressor.release.value = 0.16;
    masterLimiter = context.createWaveShaper();
    masterLimiter.curve = createSoftLimiterCurve(2048, DEFAULT_MASTER_LIMITER_DRIVE);
    masterLimiter.oversample = '4x';
    masterCeiling = context.createGain();
    masterCeiling.gain.value = dbToLinear(-1);
    analyser.connect(masterHeadroom);
    masterHeadroom.connect(masterSaturation);
    masterSaturation.connect(masterCompressor);
    masterCompressor.connect(masterLimiter);
    masterLimiter.connect(masterCeiling);
    masterCeiling.connect(context.destination);
  }
  return analyser;
}
