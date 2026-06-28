import type { ChannelBuffer } from '../producer-tools/mangler.js';
import { fromChannelBuffer, getProducerAudioContext, getProducerAnalyser } from '../audio/ProducerAudioEngine.js';

let activeSource: any;

export function playRenderedBuffer(buffer: ChannelBuffer, destination?: any): void {
  stopRenderedBuffer();
  const context = getProducerAudioContext();
  const source = context.createBufferSource();
  source.buffer = fromChannelBuffer(context, buffer);
  source.connect(destination ?? getProducerAnalyser());
  source.start();
  activeSource = source;
}

export function stopRenderedBuffer(): void {
  if (!activeSource) return;
  try {
    activeSource.stop();
  } catch {
    // Already stopped.
  }
  activeSource.disconnect?.();
  activeSource = undefined;
}
