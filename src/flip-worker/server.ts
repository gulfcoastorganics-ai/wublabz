import { createReadStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import { FLIP_PREP_API_PREFIX } from '../lib/producer-tools/flipPrepTypes.js';
import { loadFlipPrepWorkerConfig } from './config.js';
import { createStemSeparator } from './SeparatorFactory.js';
import { FlipPrepJobQueue, mapUploadError } from './queue.js';
import { parseMultipartUpload, validateAudioUpload } from './upload.js';
import type { FlipPrepWorkerConfig } from './types.js';

export interface FlipPrepWorkerOptions {
  config?: FlipPrepWorkerConfig;
  logger?: boolean;
  now?: () => number;
}

export async function createFlipPrepWorker(options: FlipPrepWorkerOptions = {}) {
  const config = options.config ?? loadFlipPrepWorkerConfig();
  const server = Fastify({
    logger: options.logger ?? true,
    bodyLimit: config.maxUploadBytes + 1024 * 1024
  });
  const queue = new FlipPrepJobQueue(config, createStemSeparator(config), options.now ?? Date.now);
  await mkdir(config.workDir, { recursive: true });

  server.addContentTypeParser(/^multipart\/form-data/i, { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  server.get('/health', async () => ({
    status: 'ok',
    worker: 'flip-prep',
    separator: config.separator,
    concurrency: config.concurrency
  }));

  server.post(`${FLIP_PREP_API_PREFIX}/jobs`, async (request, reply) => {
    try {
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string') {
        throw new Error('Content-Type header is required');
      }
      const upload = parseMultipartUpload(contentType, request.body as Buffer);
      validateAudioUpload(upload, config.maxUploadBytes);
      reply.code(202);
      return queue.enqueue(upload);
    } catch (error) {
      const detail = mapUploadError(error, config.maxUploadBytes);
      reply.code(detail.code === 'UPLOAD_TOO_LARGE' ? 413 : 400);
      return {
        jobId: 'rejected',
        status: 'error',
        step: 'queued',
        progress: 1,
        error: detail.message,
        errorDetail: detail
      };
    }
  });

  server.get(`${FLIP_PREP_API_PREFIX}/jobs/:jobId`, async (request, reply) => {
    const params = request.params as { jobId?: string };
    const job = params.jobId ? queue.get(params.jobId) : undefined;
    if (!job) {
      reply.code(404);
      return { error: 'Flip Prep job not found' };
    }
    return job;
  });

  server.get(`${FLIP_PREP_API_PREFIX}/jobs/:jobId/files/:name`, async (request, reply) => {
    const params = request.params as { jobId?: string; name?: string };
    const filePath = params.jobId && params.name ? queue.getFilePath(params.jobId, params.name) : undefined;
    if (!filePath) {
      reply.code(404);
      return { error: 'Flip Prep file not found' };
    }
    try {
      await access(filePath);
    } catch {
      reply.code(404);
      return { error: 'Flip Prep file not found' };
    }
    reply.type(filePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav');
    return reply.send(createReadStream(filePath));
  });

  return server;
}

export async function startFlipPrepWorker(): Promise<void> {
  const config = loadFlipPrepWorkerConfig();
  const server = await createFlipPrepWorker({ config });
  await server.listen({ port: config.port, host: config.host });
  console.log(`Flip Prep worker listening on http://${config.host}:${config.port}`);
}
