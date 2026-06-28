import type { ChannelBuffer } from '../producer-tools/mangler.js';
import { normalizeChannelBuffer } from '../audio/outputQuality.js';
import { encodeWav } from './wav.js';

export interface RenderedAudioFile {
  fileName: string;
  mimeType: 'audio/wav';
  bytes: Uint8Array;
}

export function renderBufferToWav(fileName: string, buffer: ChannelBuffer): RenderedAudioFile {
  const normalized = normalizeChannelBuffer(buffer);
  return {
    fileName,
    mimeType: 'audio/wav',
    bytes: encodeWav(normalized)
  };
}
