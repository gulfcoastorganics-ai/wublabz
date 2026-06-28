import type { ChannelBuffer } from '../producer-tools/mangler.js';

export function encodeWav(buffer: ChannelBuffer): Uint8Array {
  const channels = buffer.channels.length;
  const frames = channels > 0 ? buffer.channels[0].length : 0;
  const dataBytes = frames * channels * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  let offset = 0;

  const text = (value: string) => {
    for (let i = 0; i < value.length; i++) out[offset++] = value.charCodeAt(i);
  };
  const u16 = (value: number) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  const u32 = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };

  text('RIFF');
  u32(out.length - 8);
  text('WAVEfmt ');
  u32(16);
  u16(1);
  u16(channels);
  u32(buffer.sampleRate);
  u32(buffer.sampleRate * channels * 2);
  u16(channels * 2);
  u16(16);
  text('data');
  u32(dataBytes);

  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, buffer.channels[channel][frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return out;
}

export function decodeWavHeader(bytes: Uint8Array): { sampleRate: number; channels: number; frames: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8, 12)) !== 'WAVE') {
    throw new Error('Invalid WAV header');
  }
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const dataBytes = view.getUint32(40, true);
  return {
    sampleRate,
    channels,
    frames: channels > 0 ? dataBytes / (channels * 2) : 0
  };
}
