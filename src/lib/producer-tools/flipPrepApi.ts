import { FLIP_PREP_API_PREFIX, type FlipPrepJob } from './flipPrepTypes.js';
export type { FlipPrepError, FlipPrepJob, FlipPrepJobStatus, FlipPrepResult, FlipPrepStem, FlipPrepStep } from './flipPrepTypes.js';

export interface FlipPrepClient {
  readonly baseUrl: string;
  createJob(file: unknown): Promise<FlipPrepJob>;
  getJob(jobId: string): Promise<FlipPrepJob>;
}

export class HttpFlipPrepClient implements FlipPrepClient {
  constructor(readonly baseUrl: string) {}

  async createJob(file: unknown): Promise<FlipPrepJob> {
    const formDataCtor = (globalThis as any).FormData;
    const fetchFn = (globalThis as any).fetch;
    if (!formDataCtor || !fetchFn) {
      throw new Error('Flip Prep HTTP client requires fetch and FormData');
    }
    const body = new formDataCtor();
    body.append('file', file);
    const response = await fetchFn(`${this.baseUrl}${FLIP_PREP_API_PREFIX}/jobs`, { method: 'POST', body });
    return readJobResponse(response);
  }

  async getJob(jobId: string): Promise<FlipPrepJob> {
    const fetchFn = (globalThis as any).fetch;
    if (!fetchFn) {
      throw new Error('Flip Prep HTTP client requires fetch');
    }
    const response = await fetchFn(`${this.baseUrl}${FLIP_PREP_API_PREFIX}/jobs/${encodeURIComponent(jobId)}`);
    return readJobResponse(response);
  }
}

export class OfflineFlipPrepClient implements FlipPrepClient {
  readonly baseUrl = '';
  private polls = 0;

  async createJob(): Promise<FlipPrepJob> {
    this.polls = 0;
    return { jobId: 'stub-flip-prep', status: 'processing', step: 'separating-stems', progress: 0.15 };
  }

  async getJob(jobId: string): Promise<FlipPrepJob> {
    this.polls += 1;
    if (this.polls === 1) return { jobId, status: 'processing', step: 'detecting-key-bpm', progress: 0.45 };
    if (this.polls === 2) return { jobId, status: 'processing', step: 'stretching-acapella', progress: 0.75 };
    return {
      jobId,
      status: 'done',
      step: 'stretching-acapella',
      progress: 1,
      result: {
        key: 'A minor',
        bpm: 140,
        keyConfidence: 1,
        bpmOctaveCorrected: false,
        stems: [
          { name: 'drums', url: '#' },
          { name: 'bass', url: '#' },
          { name: 'vocals', url: '#' },
          { name: 'other', url: '#' }
        ],
        acapella140Url: '#'
      }
    };
  }
}

export function resolveFlipPrepAssetUrl(baseUrl: string, url: string): string {
  if (!url || url.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url;
  }
  return new URL(url, ensureTrailingSlash(baseUrl)).toString();
}

async function readJobResponse(response: { ok: boolean; status: number; json: () => Promise<FlipPrepJob | Record<string, any>> }): Promise<FlipPrepJob> {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' ? payload.errorDetail : undefined;
    const message = detail?.actionable ? `${detail.message} ${detail.actionable}` : payload?.error ?? `Flip Prep API returned ${response.status}`;
    throw new Error(message);
  }
  return payload as FlipPrepJob;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
