import { getWubLabzWsUrl } from './env.js';
import { validateInboundEvent, type ValidatedWubLabzEvent } from '../wublabz/protocol.js';

export type WubConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'tripped';

export interface WubWebSocketClientOptions {
  url?: string;
  clientId?: string;
  clientIdFactory?: () => string;
  autoConnect?: boolean;
  maxReconnectAttempts?: number;
  baseReconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnectJitterMs?: (attempt: number) => number;
}

let generatedClientIdCounter = 0;

export class WubWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectTimeout: any = null;
  private reconnectDelay: number;
  private readonly baseReconnectDelay: number;
  private readonly maxReconnectDelay: number;
  private readonly maxReconnectAttempts: number;
  private reconnectAttempts = 0;
  
  private status: WubConnectionStatus = 'idle';
  private lastError: string | null = null;
  private lastCloseCode: number | null = null;
  private lastCloseReason: string | null = null;
  private eventListeners: Set<(event: ValidatedWubLabzEvent) => void> = new Set();
  private statusListeners: Set<(status: WubConnectionStatus, error?: string | null) => void> = new Set();
  private latency = 0;
  private heartbeatInterval: any = null;
  private readonly url: string;
  private readonly clientId: string;
  private readonly reconnectJitterMs: (attempt: number) => number;
  
  private failureWindowStart = 0;
  private failuresInWindow = 0;
  private readonly CIRCUIT_BREAKER_THRESHOLD = 5;
  private readonly CIRCUIT_BREAKER_WINDOW_MS = 30000;

  constructor(options: WubWebSocketClientOptions = {}) {
    this.url = options.url ?? getWubLabzWsUrl();
    this.clientId = options.clientId ?? options.clientIdFactory?.() ?? createDefaultClientId();
    this.baseReconnectDelay = options.baseReconnectDelay ?? 1000;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 50;
    this.reconnectJitterMs = options.reconnectJitterMs ?? ((attempt) => deterministicReconnectJitterMs(this.clientId, attempt));
    this.reconnectDelay = this.baseReconnectDelay;

    if (options.autoConnect) {
      this.connect();
    }
  }

  connect() {
    if (this.status === 'tripped') return;

    const WebSocketCtor = getWebSocketConstructor();
    if (!WebSocketCtor) {
      this.handleError('WebSocket is unavailable in this browser/runtime');
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocketCtor.OPEN || this.ws.readyState === WebSocketCtor.CONNECTING)) {
        return;
    }

    this.cleanupReconnect();
    this.setStatus(this.status === 'disconnected' || this.status === 'error' ? 'reconnecting' : 'connecting');
    
    try {
      this.ws = new WebSocketCtor(this.url);
    } catch (err: any) {
      this.handleError(`Failed to create WebSocket: ${err.message}`);
      return;
    }

    this.ws.onopen = () => {
      this.reconnectDelay = this.baseReconnectDelay;
      this.reconnectAttempts = 0;
      this.failuresInWindow = 0;
      this.lastError = null;
      this.lastCloseCode = null;
      this.lastCloseReason = null;
      this.setStatus('connected');
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const rawEvent = JSON.parse(event.data);
        const result = validateInboundEvent(rawEvent);
        
        if (result.success) {
          const wubEvent = result.event;
          if (wubEvent.type === 'HEARTBEAT' && wubEvent.payload.clientSent) {
            this.latency = Date.now() - wubEvent.payload.clientSent;
          }
          this.eventListeners.forEach((l) => l(wubEvent));
        } else {
          console.warn('Received invalid protocol event', result.rejection);
        }
      } catch (err) {
        console.error('Failed to parse WubEvent', err);
      }
    };

    this.ws.onclose = (event) => {
      const wasConnected = this.status === 'connected';
      const wasAttempting = this.status === 'connecting' || this.status === 'reconnecting';
      
      this.lastCloseCode = event.code;
      this.lastCloseReason = event.reason;
      this.cleanup();
      
      if (!event.wasClean) {
        this.recordFailure();
        this.handleError(`Connection lost (code: ${event.code}, reason: ${event.reason || 'none'})`);
      } else {
        this.setStatus('disconnected');
      }
      
      if (this.status !== 'tripped' && (wasConnected || wasAttempting || this.status === 'error')) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.handleError('WebSocket error occurred');
    };
  }

  private recordFailure() {
    const now = Date.now();
    if (now - this.failureWindowStart > this.CIRCUIT_BREAKER_WINDOW_MS) {
      this.failureWindowStart = now;
      this.failuresInWindow = 1;
    } else {
      this.failuresInWindow++;
    }

    if (this.failuresInWindow >= this.CIRCUIT_BREAKER_THRESHOLD) {
      this.setStatus('tripped', 'Circuit breaker tripped after repeated failures. Manual retry required.');
    }
  }

  resetCircuitBreaker() {
    this.failuresInWindow = 0;
    this.reconnectAttempts = 0;
    this.reconnectDelay = this.baseReconnectDelay;
    if (this.status === 'tripped') {
        this.setStatus('idle');
    }
    this.connect();
  }

  reconnect() {
    this.disconnect();
    this.connect();
  }

  private handleError(message: string) {
    this.lastError = message;
    if (this.status !== 'tripped') {
        this.setStatus('error', message);
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout || this.status === 'tripped') return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.setStatus('tripped', 'Maximum reconnection attempts reached.');
        return;
    }

    this.reconnectAttempts++;
    
    // Exponential backoff with deterministic jitter keeps reconnect waves spread without hidden randomness.
    const jitter = clampJitter(this.reconnectJitterMs(this.reconnectAttempts));
    const delay = Math.min(this.reconnectDelay + jitter, this.maxReconnectDelay);
    
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
      this.connect();
    }, delay);
  }

  private cleanupReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private startHeartbeat() {
    this.cleanup(); // Ensure no double heartbeats
    this.heartbeatInterval = setInterval(() => {
      this.send('HEARTBEAT', { clientSent: Date.now() });
    }, 5000);
  }

  private cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  send(type: ValidatedWubLabzEvent['type'], payload: any = {}): boolean {
    const WebSocketCtor = getWebSocketConstructor();
    if (!WebSocketCtor || this.ws?.readyState !== WebSocketCtor.OPEN) return false;

    const event = {
      clientId: this.clientId,
      timestamp: Date.now(),
      source: 'wubpad',
      type,
      payload
    };

    const validation = validateInboundEvent(event);
    if (!validation.success) {
      console.error('Refusing to send invalid protocol event', validation.rejection);
      return false;
    }

    try {
        this.ws.send(JSON.stringify(validation.event));
        return true;
    } catch (err) {
        console.error('Failed to send WebSocket message', err);
        return false;
    }
  }

  onEvent(listener: (event: ValidatedWubLabzEvent) => void) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatusChange(listener: (status: WubConnectionStatus, error?: string | null) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: WubConnectionStatus, error: string | null = null) {
    this.status = status;
    this.statusListeners.forEach((l) => l(status, error));
  }

  getStatus(): WubConnectionStatus {
    return this.status;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getLastCloseCode(): number | null {
    return this.lastCloseCode;
  }

  getLastCloseReason(): string | null {
    return this.lastCloseReason;
  }

  getUrl(): string {
    return this.url;
  }

  getClientId(): string {
    return this.clientId;
  }

  getLatency() {
    return this.latency;
  }

  disconnect() {
    this.cleanupReconnect();
    this.cleanup();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      
      try {
        if (this.ws.readyState !== 3 /* CLOSED */) {
            this.ws.close();
        }
      } catch (err) {
        // Ignore close errors
      }
      this.ws = null;
    }
    if (this.status !== 'tripped') {
        this.setStatus('disconnected');
    }
  }
}

function getWebSocketConstructor(): typeof WebSocket | null {
  return typeof WebSocket === 'undefined' ? null : WebSocket;
}

function createDefaultClientId(): string {
  generatedClientIdCounter += 1;
  return `wubpad-${Date.now().toString(36)}-${generatedClientIdCounter.toString(36)}`;
}

function deterministicReconnectJitterMs(clientId: string, attempt: number): number {
  return hashText(`${clientId}:${attempt}`) % 200;
}

function clampJitter(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(199, value));
}

function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
