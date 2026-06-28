import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Improved Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static CLOSING = 2;

  readyState = 0;
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    if (this.onclose) this.onclose({ wasClean: true, code: 1000 });
  });

  triggerOpen() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  triggerClose(wasClean: boolean, code: number) {
    this.readyState = 3;
    if (this.onclose) this.onclose({ wasClean, code });
  }
}

// Assign to globalThis before ANY import
(globalThis as any).WebSocket = MockWebSocket;

describe('WubWebSocketClient', () => {
  let client: any;
  let WubWebSocketClient: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    const mod = await import('../src/wubpad-integration/WebSocketClient.js');
    WubWebSocketClient = mod.WubWebSocketClient;
    client = new WubWebSocketClient({ url: 'ws://127.0.0.1:3001', autoConnect: false });
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it('transitions through connection states', async () => {
    expect(client.getStatus()).toBe('idle');
    
    client.connect();
    expect(client.getStatus()).toBe('connecting');

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws.triggerOpen();
    expect(client.getStatus()).toBe('connected');

    client.disconnect();
    expect(client.getStatus()).toBe('disconnected');
  });

  it('reconnects with exponential backoff on unclean close', async () => {
    client.connect();
    MockWebSocket.instances[0].triggerOpen();
    expect(client.getStatus()).toBe('connected');

    // Simulate unclean close
    MockWebSocket.instances[0].triggerClose(false, 1006);
    expect(client.getStatus()).toBe('error');
    
    // First reconnect should happen after ~1000ms (+ jitter)
    await vi.advanceTimersByTimeAsync(1300);
    expect(client.getStatus()).toBe('reconnecting');
    expect(MockWebSocket.instances.length).toBe(2);
    
    // Simulate another failure
    MockWebSocket.instances[1].triggerClose(false, 1006);
    
    // Second reconnect should happen after ~1500ms (+ jitter)
    await vi.advanceTimersByTimeAsync(1800);
    expect(client.getStatus()).toBe('reconnecting');
    expect(MockWebSocket.instances.length).toBe(3);
  });

  it('uses injectable client ids and reconnect jitter', async () => {
    client.disconnect();
    client = new WubWebSocketClient({
      url: 'ws://127.0.0.1:3001',
      autoConnect: false,
      clientIdFactory: () => 'wubpad-test-id',
      reconnectJitterMs: (attempt: number) => attempt * 25
    });

    expect(client.getClientId()).toBe('wubpad-test-id');

    client.connect();
    MockWebSocket.instances[0].triggerOpen();
    MockWebSocket.instances[0].triggerClose(false, 1006);

    await vi.advanceTimersByTimeAsync(1024);
    expect(MockWebSocket.instances.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances.length).toBe(2);
    expect(client.getStatus()).toBe('reconnecting');
  });

  it('trips circuit breaker after repeated failures', async () => {
    client.connect();
    
    for (let i = 0; i < 5; i++) {
        const ws = MockWebSocket.instances[i];
        ws.triggerClose(false, 1006);
        // Advance time to trigger next reconnect
        await vi.advanceTimersByTimeAsync(5000);
    }

    expect(client.getStatus()).toBe('tripped');
    expect(MockWebSocket.instances.length).toBe(5); // Should stop after 5
  });

  it('resets circuit breaker manually', async () => {
    client.connect();
    for (let i = 0; i < 5; i++) {
        MockWebSocket.instances[i].triggerClose(false, 1006);
        await vi.advanceTimersByTimeAsync(5000);
    }
    expect(client.getStatus()).toBe('tripped');

    client.resetCircuitBreaker();
    expect(client.getStatus()).toBe('connecting');
    expect(MockWebSocket.instances.length).toBe(6);
  });

  it('captures close code and reason on disconnect', async () => {
    client.connect();
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();

    ws.triggerClose(false, 1006);
    expect(client.getLastCloseCode()).toBe(1006);
    expect(client.getStatus()).toBe('error');
  });

  it('sends validated protocol events', async () => {
    client.connect();
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();
    
    const result = client.send('TRANSPORT_PLAY', {});
    
    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalled();
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('TRANSPORT_PLAY');
    expect(sent.source).toBe('wubpad');
  });

  it('refuses to send invalid protocol events', async () => {
    client.connect();
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();
    
    // @ts-ignore - testing runtime validation
    const result = client.send('TRANSPORT_SEEK', {}); // requires position
    
    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('always sends emergency stop when connected', async () => {
    client.connect();
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();
    
    client.send('EMERGENCY_STOP', {});
    
    expect(ws.send).toHaveBeenCalled();
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('EMERGENCY_STOP');
  });

  it('reports an error instead of throwing when WebSocket is unavailable', async () => {
    const originalWebSocket = (globalThis as any).WebSocket;
    let unavailableClient: any = null;

    try {
      vi.stubGlobal('WebSocket', undefined);

      unavailableClient = new WubWebSocketClient({ url: 'ws://127.0.0.1:3001', autoConnect: false });
      let status: string | null = null;
      let error: string | null | undefined = null;

      unavailableClient.onStatusChange((nextStatus: string, nextError?: string | null) => {
        status = nextStatus;
        error = nextError;
      });

      expect(() => unavailableClient.connect()).not.toThrow();
      expect(status).toBe('error');
      expect(error).toContain('WebSocket is unavailable');
      expect(unavailableClient.send('HEARTBEAT', {})).toBe(false);
    } finally {
      unavailableClient?.disconnect();
      vi.stubGlobal('WebSocket', originalWebSocket);
    }
  });

  it('notifies listeners of inbound ENGINE_STATUS with meter data', async () => {
    client.connect();
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();

    let receivedStatus: any = null;
    client.onEvent((e: any) => {
        if (e.type === 'ENGINE_STATUS') receivedStatus = e.payload;
    });

    const statusMessage = JSON.stringify({
        type: 'ENGINE_STATUS',
        source: 'wublabz-server',
        timestamp: Date.now(),
        payload: {
            transportState: 'playing',
            busLevels: { drum: 0.8, bass: 0.5 }
        }
    });

    if (ws.onmessage) {
        ws.onmessage({ data: statusMessage });
    }

    expect(receivedStatus).toBeDefined();
    expect(receivedStatus.transportState).toBe('playing');
    expect(receivedStatus.busLevels.drum).toBe(0.8);
  });
});
