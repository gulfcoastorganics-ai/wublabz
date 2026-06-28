import type { ChannelBuffer } from '../producer-tools/mangler.js';
import { createSoftLimiterCurve } from './outputQuality.js';

type AudioContextLike = any;

let sharedContext: AudioContextLike;
let analyser: any;
let masterLimiter: any;

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
    masterLimiter = context.createWaveShaper();
    masterLimiter.curve = createSoftLimiterCurve();
    masterLimiter.oversample = '4x';
    analyser.connect(masterLimiter);
    masterLimiter.connect(context.destination);
  }
  return analyser;
}
