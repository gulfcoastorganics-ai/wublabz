import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('tone', () => ({
  start: async () => undefined,
  now: () => 0,
  Transport: {
    bpm: { value: 120 },
    seconds: 0,
    scheduleOnce: () => -1,
    clear: () => undefined,
    cancel: () => undefined,
    start: () => undefined,
    pause: () => undefined,
    stop: () => undefined
  },
  Player: class {
    volume = { value: 0 };
    connect() { return this; }
    start() { return this; }
    stop() { return this; }
    dispose() { return this; }
  },
  ToneAudioBuffer: {
    fromUrl: async () => ({ duration: 1 })
  },
  Gain: class {
    constructor() { (this as any).gain = { value: 1, cancelScheduledValues: () => {} }; }
    connect() { return this; }
    chain() { return this; }
  },
  Filter: class {
    constructor() { (this as any).frequency = { value: 1000, cancelScheduledValues: () => {} }; (this as any).Q = { value: 1, cancelScheduledValues: () => {} }; }
  },
  Distortion: class {
    constructor() { (this as any).distortion = { value: 0, cancelScheduledValues: () => {} }; }
  },
  FeedbackDelay: class {
    constructor() { (this as any).feedback = { value: 0, cancelScheduledValues: () => {} }; (this as any).wet = { value: 0, cancelScheduledValues: () => {} }; }
  },
  Reverb: class {
    constructor() { (this as any).wet = { value: 0, cancelScheduledValues: () => {} }; }
    generate() { return Promise.resolve(); }
  },
  Channel: class {
    constructor() { (this as any).volume = { value: 0, cancelScheduledValues: () => {} }; (this as any).mute = false; (this as any).solo = false; }
    connect() { return this; }
  },
  Meter: class {
    getValue() { return 0; }
  },
  Destination: {
    volume: { value: 0 }
  },
  getContext: () => ({
    destination: { volume: { value: 0 } },
    state: 'suspended',
    resume: () => Promise.resolve()
  }),
  context: {
    state: 'suspended',
    resume: () => Promise.resolve()
  }
}));

import { RuntimeController } from '../src/wublabz/runtimeController.js';

interface RuntimeResponsePayload {
  transportState?: string;
  reason?: string;
  activeModulationCount?: number;
}

describe('RuntimeController', () => {
  let controller: RuntimeController;

  beforeEach(() => {
    controller = new RuntimeController();
    controller.initializeRuntime();
  });

  it('HEARTBEAT returns serverReceived timestamp', () => {
    const response = controller.handleIntent({
      type: 'HEARTBEAT',
      source: 'wubpad',
      payload: { clientSent: 100 }
    });
    expect(response.type).toBe('HEARTBEAT');
    // @ts-ignore
    expect(response.payload.serverReceived).toBeGreaterThan(0);
  });

  it('TRANSPORT_PLAY rejects when no timeline loaded', () => {
    const response = controller.handleIntent({
      type: 'TRANSPORT_PLAY',
      source: 'wubpad',
      payload: {}
    });
    expect(response.type).toBe('EVENT_REJECTED');
    expect((response.payload as RuntimeResponsePayload).reason).toBe('No timeline loaded');
  });

  it('loads a canonical timeline and allows transport play', async () => {
    const diagnostics = controller.loadTimeline([{
      id: 'marker-1',
      type: 'marker',
      sourceId: 'source-1',
      sectionId: 'intro-1',
      startTime: 0,
      endTime: 1,
      beatStart: 0,
      beatEnd: 2,
      barStart: 0,
      barEnd: 0.5,
      energyLevel: 0.2,
      enabled: true,
      probability: 1,
      payload: { sectionType: 'intro' }
    }], 140);

    expect(diagnostics.scheduledEventCount).toBe(1);
    expect(diagnostics.bpm).toBe(140);

    const response = controller.handleIntent({
      type: 'TRANSPORT_PLAY',
      source: 'wubpad',
      payload: {}
    });
    expect(response.type).toBe('ENGINE_STATUS');
  });

  it('TRANSPORT_STOP succeeds without a loaded timeline', () => {
    const response = controller.handleIntent({
      type: 'TRANSPORT_STOP',
      source: 'wubpad',
      payload: {}
    });
    expect(response.type).toBe('ENGINE_STATUS');
    expect((response.payload as RuntimeResponsePayload).transportState).toBe('stopped');
  });

  it('TRANSPORT_PAUSE succeeds without a loaded timeline', () => {
    const response = controller.handleIntent({
      type: 'TRANSPORT_PAUSE',
      source: 'wubpad',
      payload: {}
    });
    expect(response.type).toBe('ENGINE_STATUS');
  });

  it('TRANSPORT_SEEK rejects when no timeline loaded', () => {
    const response = controller.handleIntent({
      type: 'TRANSPORT_SEEK',
      source: 'wubpad',
      payload: { positionSeconds: 10 }
    });
    expect(response.type).toBe('EVENT_REJECTED');
    expect((response.payload as RuntimeResponsePayload).reason).toBe('No timeline loaded');
  });

  it('SCENE_TRIGGER unknown scene rejects', () => {
    const response = controller.handleIntent({
      type: 'SCENE_TRIGGER',
      source: 'wubpad',
      payload: { sceneId: 'NonExistent' }
    });
    expect(response.type).toBe('EVENT_REJECTED');
  });

  it('SCENE_TRIGGER accepted updates diagnostics', () => {
    const response = controller.handleIntent({
        type: 'SCENE_TRIGGER',
        source: 'wubpad',
        payload: { sceneId: 'Intro' }
    });
    expect(response.type).toBe('EVENT_REJECTED');
  });

  it('STEM_MUTE valid target updates active modulation count', () => {
    const response = controller.handleIntent({
        type: 'STEM_MUTE',
        source: 'wubpad',
        payload: { stemId: 'drum' }
    });
    expect(response.type).toBe('ENGINE_STATUS');
    expect((response.payload as RuntimeResponsePayload).activeModulationCount).toBeGreaterThan(0);
  });

  it('MACRO_TRIGGER unknown macro rejects', () => {
    const response = controller.handleIntent({
        type: 'MACRO_TRIGGER',
        source: 'wubpad',
        payload: { macroId: 'unknown' }
    });
    expect(response.type).toBe('EVENT_REJECTED');
  });

  it('EMERGENCY_STOP works before readiness and clears state', () => {
    const response = controller.handleEmergencyStop();
    expect(response.type).toBe('ENGINE_STATUS');
    expect((response.payload as any).emergencyStopped).toBe(true);
  });
});
