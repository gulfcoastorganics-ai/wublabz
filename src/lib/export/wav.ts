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

export function decodeWav(bytes: Uint8Array): ChannelBuffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV header');
  }

  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;

    if (id === 'fmt ') {
      format = view.getUint16(bodyOffset, true);
      channels = view.getUint16(bodyOffset + 2, true);
      sampleRate = view.getUint32(bodyOffset + 4, true);
      bitsPerSample = view.getUint16(bodyOffset + 14, true);
    } else if (id === 'data') {
      dataOffset = bodyOffset;
      dataBytes = size;
      break;
    }

    offset = bodyOffset + size + (size % 2);
  }

  if (format !== 1 && format !== 3) throw new Error(`Unsupported WAV format ${format}`);
  if (channels < 1 || sampleRate < 1 || dataOffset < 0) throw new Error('Invalid WAV data');
  if (format === 1 && bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) throw new Error(`Unsupported PCM bit depth ${bitsPerSample}`);
  if (format === 3 && bitsPerSample !== 32) throw new Error(`Unsupported float WAV bit depth ${bitsPerSample}`);

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataBytes / (channels * bytesPerSample));
  const decoded = Array.from({ length: channels }, () => new Float32Array(frames));

  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sampleOffset = dataOffset + (frame * channels + channel) * bytesPerSample;
      decoded[channel][frame] = readWavSample(view, sampleOffset, format, bitsPerSample);
    }
  }

  return { sampleRate, channels: decoded };
}

function readWavSample(view: DataView, offset: number, format: number, bitsPerSample: number): number {
  if (format === 3) return Math.max(-1, Math.min(1, view.getFloat32(offset, true)));
  if (bitsPerSample === 16) return Math.max(-1, Math.min(1, view.getInt16(offset, true) / 0x8000));
  if (bitsPerSample === 24) {
    const b0 = view.getUint8(offset);
    const b1 = view.getUint8(offset + 1);
    const b2 = view.getUint8(offset + 2);
    let value = b0 | (b1 << 8) | (b2 << 16);
    if (value & 0x800000) value |= 0xff000000;
    return Math.max(-1, Math.min(1, value / 0x800000));
  }
  return Math.max(-1, Math.min(1, view.getInt32(offset, true) / 0x80000000));
}

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
