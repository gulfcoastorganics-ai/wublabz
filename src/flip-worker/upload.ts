import path from 'node:path';

export interface ParsedUpload {
  fileName: string;
  contentType: string;
  bytes: Buffer;
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aiff', '.aif', '.flac', '.m4a', '.ogg']);

export function parseMultipartUpload(contentType: string, body: Buffer): ParsedUpload {
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) {
    throw new Error('Multipart boundary is missing');
  }
  const boundary = Buffer.from(`--${boundaryMatch[1].replace(/^"|"$/g, '')}`);
  let cursor = 0;

  while (cursor < body.length) {
    const boundaryStart = body.indexOf(boundary, cursor);
    if (boundaryStart < 0) break;
    const partStart = boundaryStart + boundary.length;
    if (body.subarray(partStart, partStart + 2).toString('utf8') === '--') break;

    const headersStart = body.subarray(partStart, partStart + 2).toString('utf8') === '\r\n' ? partStart + 2 : partStart;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headersStart);
    if (headerEnd < 0) break;

    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundaryMatch[1].replace(/^"|"$/g, '')}`), headerEnd + 4);
    if (nextBoundary < 0) break;

    const rawHeaders = body.subarray(headersStart, headerEnd).toString('utf8');
    const payload = body.subarray(headerEnd + 4, nextBoundary);
    cursor = nextBoundary + 2;

    if (!rawHeaders.includes('Content-Disposition') || !rawHeaders.includes('filename=')) continue;
    const nameMatch = rawHeaders.match(/filename="([^"]+)"/i);
    const typeMatch = rawHeaders.match(/Content-Type:\s*([^\r\n]+)/i);
    const fileName = sanitizeFileName(nameMatch?.[1] ?? 'upload.audio');
    return {
      fileName,
      contentType: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
      bytes: Buffer.from(payload)
    };
  }
  throw new Error('No uploaded audio file found');
}

export function validateAudioUpload(upload: ParsedUpload, maxBytes: number): void {
  if (upload.bytes.length <= 0) {
    throw new Error('Uploaded audio is empty');
  }
  if (upload.bytes.length > maxBytes) {
    throw new Error(`Upload exceeds ${maxBytes} byte limit`);
  }
  const extension = path.extname(upload.fileName).toLowerCase();
  if (!upload.contentType.startsWith('audio/') && !AUDIO_EXTENSIONS.has(extension)) {
    throw new Error('Upload must be an audio file');
  }
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || 'upload.audio';
}
