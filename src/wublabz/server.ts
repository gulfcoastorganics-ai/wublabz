import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLIP_PREP_API_PREFIX, FLIP_PREP_DEFAULT_WORKER_URL, createFlipPrepError } from '../lib/producer-tools/flipPrepTypes.js';
import { RuntimeController } from './runtimeController.js';
import { parseAndValidateInboundEvent } from './protocol.js';
import {
  createHealthResponse,
  findPortOwner,
  formatPortInUseDiagnostics,
  formatStartupDiagnostics,
  isAddressInUseError,
  probeExistingWubLabz,
  resolveWubLabzPort
} from './startup.js';

type ServerResponse = {
  type: string;
  payload?: unknown;
};

const WS_OPEN = 1;
const WUBLABZ_DEV_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]);

export type WubLabzServerStartResult = 'started' | 'already-running' | 'port-in-use';

export interface WubLabzServerOptions {
  logger?: boolean;
  now?: () => number;
  startedAtMs?: number;
  flipPrepWorkerUrl?: string;
  flipPrepMaxUploadBytes?: number;
}

export async function createWubLabzServer(options: WubLabzServerOptions = {}) {
  const flipPrepMaxUploadBytes = options.flipPrepMaxUploadBytes ?? numberEnv(process.env.FLIP_PREP_MAX_UPLOAD_BYTES, 250 * 1024 * 1024);
  const server = Fastify({
    logger: options.logger ?? false,
    bodyLimit: flipPrepMaxUploadBytes + 1024 * 1024
  });
  await server.register(cors, {
    origin: (origin, callback) => {
      if (!origin || WUBLABZ_DEV_ORIGINS.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type'],
    maxAge: 86400
  });
  await server.register(websocket);

  const runtimeController = new RuntimeController();
  runtimeController.initializeRuntime();
  const startedAtMs = options.startedAtMs ?? Date.now();
  const now = options.now ?? Date.now;
  const flipPrepWorkerUrl = resolveFlipPrepWorkerUrl(process.env, options.flipPrepWorkerUrl);

  let activeConnections = 0;

  server.addContentTypeParser(/^multipart\/form-data/i, { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  server.get('/health', async () => {
    return createHealthResponse(startedAtMs, now());
  });

  server.post(`${FLIP_PREP_API_PREFIX}/jobs`, async (request, reply) => {
    const response = await proxyFlipPrepRequest(flipPrepWorkerUrl, `${FLIP_PREP_API_PREFIX}/jobs`, {
      method: 'POST',
      body: request.body as Buffer,
      contentType: request.headers['content-type']
    });
    reply.code(response.status);
    return response.body;
  });

  server.get(`${FLIP_PREP_API_PREFIX}/jobs/:jobId`, async (request, reply) => {
    const params = request.params as { jobId?: string };
    const response = await proxyFlipPrepRequest(flipPrepWorkerUrl, `${FLIP_PREP_API_PREFIX}/jobs/${encodeURIComponent(params.jobId ?? '')}`);
    reply.code(response.status);
    return response.body;
  });

  server.get(`${FLIP_PREP_API_PREFIX}/jobs/:jobId/files/:name`, async (request, reply) => {
    const params = request.params as { jobId?: string; name?: string };
    const response = await proxyFlipPrepRequest(
      flipPrepWorkerUrl,
      `${FLIP_PREP_API_PREFIX}/jobs/${encodeURIComponent(params.jobId ?? '')}/files/${encodeURIComponent(params.name ?? '')}`,
      { binary: true }
    );
    reply.code(response.status);
    if (response.contentType) reply.type(response.contentType);
    return response.binary ? reply.send(Buffer.from(response.binary)) : response.body;
  });

  // WebSocket connection handler
  server.get('/', { websocket: true }, (socket, req) => {
    activeConnections++;
    runtimeController.setActiveConnectionCount(activeConnections);
    const clientId = randomUUID();
    const remoteAddress = req.socket?.remoteAddress ?? req.ip ?? 'unknown';
    console.info(`Client connected: ${clientId} (${remoteAddress})`);
    server.log.debug({ clientId, remoteAddress }, 'Client connected');

    const sendResponse = (response: ServerResponse) => {
      if (socket.readyState !== WS_OPEN) return;
      socket.send(JSON.stringify({
        clientId,
        timestamp: Date.now(),
        source: 'wublabz-server',
        ...response
      }));
    };

    // Telemetry loop (50ms = 20Hz for meters)
    const telemetryInterval = setInterval(() => {
        sendResponse({
            type: 'ENGINE_STATUS',
            payload: runtimeController.getRuntimeDiagnostics()
        });
    }, 50);

    // Send initial status
    sendResponse({
      type: 'ENGINE_STATUS',
      payload: runtimeController.getRuntimeDiagnostics()
    });

    socket.on('message', (message: unknown) => {
      const validation = parseAndValidateInboundEvent(toMessageText(message));

      if (!validation.success) {
        sendResponse({
          type: 'EVENT_REJECTED',
          payload: validation.rejection
        });
        return;
      }

      const event = validation.event;

      try {
        const response = runtimeController.handleIntent(event);
        if (response) {
            sendResponse(response);
        }
      } catch (err) {
        server.log.error(err, 'Failed to handle WebSocket event');
      }
    });

    socket.on('close', () => {
      activeConnections--;
      runtimeController.setActiveConnectionCount(activeConnections);
      console.info(`Client disconnected: ${clientId}`);
      server.log.debug({ clientId }, 'Client disconnected');
      clearInterval(telemetryInterval);
    });

    socket.on('error', () => {
        clearInterval(telemetryInterval);
    });
  });

  return server;
}

export async function startServer(): Promise<WubLabzServerStartResult> {
  const port = resolveWubLabzPort();

  if (await probeExistingWubLabz(port)) {
    console.log(`WubLabz already running on port ${port}`);
    return 'already-running';
  }

  const server = await createWubLabzServer();

  const shutdown = async (signal: string) => {
    console.info(`${signal} received. Shutting down gracefully...`);
    await server.close();
    console.info('Server closed');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    server.close().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
  });

  try {
    await server.listen({ port, host: '0.0.0.0' });
    console.log(formatStartupDiagnostics(port));
    return 'started';
  } catch (err) {
    await server.close().catch(() => undefined);

    if (isAddressInUseError(err)) {
      if (await probeExistingWubLabz(port)) {
        console.log(`WubLabz already running on port ${port}`);
        return 'already-running';
      }

      console.error(formatPortInUseDiagnostics(port, await findPortOwner(port)));
      return 'port-in-use';
    }

    throw err;
  }
}

async function proxyFlipPrepRequest(
  workerUrl: string,
  pathname: string,
  options: { method?: 'GET' | 'POST'; body?: Buffer; contentType?: string | string[]; binary?: boolean } = {}
): Promise<{ status: number; body?: unknown; binary?: ArrayBuffer; contentType?: string }> {
  try {
    const headers: Record<string, string> = {};
    if (typeof options.contentType === 'string') {
      headers['content-type'] = options.contentType;
    }
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      ...(options.body ? { body: options.body as any, duplex: 'half' as any } : {})
    };
    const response = await fetch(`${workerUrl}${pathname}`, init);
    const contentType = response.headers.get('content-type') ?? undefined;
    if (options.binary) {
      return { status: response.status, binary: await response.arrayBuffer(), contentType };
    }
    return { status: response.status, body: await response.json().catch(() => ({})), contentType };
  } catch {
    const detail = createFlipPrepError(
      'WORKER_UNAVAILABLE',
      'Flip Prep worker is not reachable.',
      `Start the worker with npm run flip-worker or set FLIP_WORKER_URL for the server-to-worker proxy. Browser clients should keep using the WubLabz API on port 3001. Current worker URL: ${workerUrl}`
    );
    return {
      status: 503,
      body: {
        jobId: 'worker-unavailable',
        status: 'error',
        step: 'queued',
        progress: 1,
        error: detail.message,
        errorDetail: detail
      }
    };
  }
}

export function resolveFlipPrepWorkerUrl(env: { FLIP_WORKER_URL?: string } = process.env, override?: string): string {
  return override ?? env.FLIP_WORKER_URL ?? FLIP_PREP_DEFAULT_WORKER_URL;
}

if (isMainModule()) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

function toMessageText(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }

  if (Buffer.isBuffer(message)) {
    return message.toString('utf8');
  }

  if (message instanceof ArrayBuffer) {
    return Buffer.from(message).toString('utf8');
  }

  if (Array.isArray(message) && message.every(Buffer.isBuffer)) {
    return Buffer.concat(message).toString('utf8');
  }

  return String(message);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
