import { describe, expect, it, vi } from 'vitest';
import { AudioClipManager } from '../src/lib/playback/AudioClipManager.js';
import { ToneJsAdapter } from '../src/lib/playback/ToneAdapter.js';
import type {
  ScheduledTimelineEvent,
} from '../src/lib/playback/EventScheduler.js';
import type {
  ToneAudioBufferLike,
  ToneLikeRuntime,
  TonePlayerLike,
} from '../src/lib/playback/ToneAdapter.js';

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
  Player: class {},
  ToneAudioBuffer: {
    fromUrl: async () => ({ duration: 1 })
  }
}));

function createScheduledEvent(): ScheduledTimelineEvent {
  return {
    id: 'event-1',
    type: 'bass',
    sourceId: 'source-1',
    stemId: 'bass-stem',
    sectionId: 'drop-1',
    startTime: 0,
    endTime: 1,
    beatStart: 0,
    beatEnd: 4,
    barStart: 0,
    barEnd: 1,
    energyLevel: 0.8,
    enabled: true,
    probability: 1,
    payload: { sourcePath: 'fixture.wav' },
    scheduledIndex: 0,
    scheduledStartTime: 0,
    scheduledEndTime: 1
  };
}

describe('ToneJsAdapter', () => {
  it('drops renderable events instead of routing to destination when BusGraph is missing', async () => {
    let scheduledCallback: ((time: number) => void) | undefined;
    let startCalls = 0;
    let disposeCalls = 0;

    class TestPlayer implements TonePlayerLike {
      volume = { value: 0 };
      playbackRate = 1;

      constructor(readonly buffer?: unknown) {}

      connect() {
        return this;
      }

      start() {
        startCalls += 1;
        return this;
      }

      stop() {
        return this;
      }

      dispose() {
        disposeCalls += 1;
        return this;
      }
    }

    const runtime: ToneLikeRuntime = {
      start: async () => undefined,
      now: () => 0,
      Transport: {
        bpm: { value: 120 },
        seconds: 0,
        scheduleOnce: (callback) => {
          scheduledCallback = callback;
          return 1;
        },
        clear: () => undefined,
        cancel: () => undefined,
        start: () => undefined,
        pause: () => undefined,
        stop: () => undefined
      },
      Player: TestPlayer,
      ToneAudioBuffer: {
        fromUrl: async () => ({ duration: 1 })
      }
    };

    const clipManager = new AudioClipManager<ToneAudioBufferLike>(async () => ({
      buffer: { duration: 1 },
      duration: 1
    }));
    const adapter = new ToneJsAdapter({ runtime, clipManager });
    const event = createScheduledEvent();

    await adapter.preloadEvents([event]);
    adapter.scheduleEvent(event);
    scheduledCallback?.(0);
    await Promise.resolve();

    expect(startCalls).toBe(0);
    expect(disposeCalls).toBe(1);
    expect(adapter.getMetrics().droppedEvents).toBe(1);
  });

  it('does not trigger audio loading, playback, or increment droppedEvents for marker/control events', async () => {
    let scheduledCallback: ((time: number) => void) | undefined;
    let startCalls = 0;
    let eventHandlerCalls = 0;

    class TestPlayer implements TonePlayerLike {
      constructor(readonly buffer?: unknown) {}
      start() { startCalls += 1; return this; }
      stop() { return this; }
      dispose() { return this; }
    }

    const runtime: ToneLikeRuntime = {
      start: async () => undefined,
      now: () => 0,
      Transport: {
        bpm: { value: 120 },
        seconds: 0,
        scheduleOnce: (callback) => {
          scheduledCallback = callback;
          return 1;
        },
        clear: () => undefined,
        cancel: () => undefined,
        start: () => undefined,
        pause: () => undefined,
        stop: () => undefined
      },
      Player: TestPlayer,
      ToneAudioBuffer: {
        fromUrl: async () => ({ duration: 1 })
      }
    };

    const clipManager = new AudioClipManager<ToneAudioBufferLike>(async () => ({
      buffer: { duration: 1 },
      duration: 1
    }));
    const adapter = new ToneJsAdapter({ runtime, clipManager });
    
    adapter.setEventHandler(() => {
      eventHandlerCalls += 1;
    });

    const markerEvent: ScheduledTimelineEvent = {
      id: 'marker-1',
      type: 'marker',
      sourceId: 'source-1',
      stemId: undefined,
      sectionId: 'drop-1',
      startTime: 0,
      endTime: 1,
      beatStart: 0,
      beatEnd: 4,
      barStart: 0,
      barEnd: 1,
      energyLevel: 0.8,
      enabled: true,
      probability: 1,
      payload: { sectionType: 'drop' },
      scheduledIndex: 0,
      scheduledStartTime: 0,
      scheduledEndTime: 1
    };

    adapter.scheduleEvent(markerEvent);
    scheduledCallback?.(0);
    await Promise.resolve();

    expect(startCalls).toBe(0);
    expect(eventHandlerCalls).toBe(1);
    expect(adapter.getMetrics().droppedEvents).toBe(0);
  });

  it('compensates clip offset and duration during seek recovery', async () => {
    let startArgs: [number?, number?, number?] = [];
    const runtime: ToneLikeRuntime = {
      start: async () => undefined,
      now: () => 0,
      Transport: {
        bpm: { value: 120 },
        seconds: 1.5, // Transport is ahead
        scheduleOnce: (callback) => {
          callback(1.5); // Immediate callback with current transport time
          return 1;
        },
        clear: () => undefined,
        cancel: () => undefined,
        start: () => undefined,
        pause: () => undefined,
        stop: () => undefined
      },
      Player: class {
        volume = { value: 0 };
        connect() { return this; }
        start(time?: number, offset?: number, duration?: number) {
          startArgs = [time, offset, duration];
          return this;
        }
        stop() { return this; }
        dispose() { return this; }
      } as any,
      ToneAudioBuffer: {
        fromUrl: async () => ({ duration: 4 })
      }
    };

    const clipManager = new AudioClipManager<ToneAudioBufferLike>(async () => ({
      buffer: { duration: 4 },
      duration: 4
    }));
    const adapter = new ToneJsAdapter({ runtime, clipManager });
    const busGraph = { getBus: () => ({}), initialize: async () => {} } as any;
    adapter.setBusGraph(busGraph);

    const event = createScheduledEvent();
    event.startTime = 1.0;
    event.endTime = 5.0; // Event duration 4s

    // At transport position 1.5, elapsed = 0.5.
    // Clip offset should be 0.5.
    // Remaining duration should be 3.5.
    await adapter.preloadEvents([event]);
    adapter.scheduleEvent(event);
    await Promise.resolve();

    expect(startArgs[0]).toBe(1.5); // scheduledTime
    expect(startArgs[1]).toBe(0.5); // offset
    expect(startArgs[2]).toBe(3.5); // duration
  });

  it('materializes timeline gain and mute control actions through BusGraph', async () => {
    const callbacks: Array<(time: number) => void> = [];
    const applied: Array<[string, string, number, number]> = [];
    const runtime: ToneLikeRuntime = {
      start: async () => undefined,
      now: () => 0,
      Transport: {
        bpm: { value: 120 },
        seconds: 0,
        scheduleOnce: (callback) => {
          callbacks.push(callback);
          return callbacks.length;
        },
        clear: () => undefined,
        cancel: () => undefined,
        start: () => undefined,
        pause: () => undefined,
        stop: () => undefined
      },
      Player: class {
        start() { return this; }
        stop() { return this; }
        dispose() { return this; }
      } as any,
      ToneAudioBuffer: { fromUrl: async () => ({ duration: 1 }) }
    };

    const adapter = new ToneJsAdapter({ runtime });
    adapter.setBusGraph({
      initialize: async () => undefined,
      applyEffectParameter: (effectId: string, parameter: string, value: number, rampTime = 0) => {
        applied.push([effectId, parameter, value, rampTime]);
        return { success: true };
      }
    } as any);

    const gainEvent = {
      ...createScheduledEvent(),
      id: 'gain-event',
      type: 'bass' as const,
      payload: { action: 'gainChange', gain: -4, rampTime: 0.25 }
    };
    const muteEvent = {
      ...createScheduledEvent(),
      id: 'mute-event',
      type: 'vocal' as const,
      stemId: 'vocals',
      payload: { action: 'stemMute', muted: true }
    };

    adapter.scheduleEvent(gainEvent);
    adapter.scheduleEvent(muteEvent);
    callbacks[0]?.(0);
    callbacks[1]?.(0);

    expect(applied).toContainEqual(['bass', 'volume', -4, 0.25]);
    expect(applied).toContainEqual(['vocal', 'mute', 1, 0]);
    expect(adapter.getMetrics().droppedEvents).toBe(0);
  });

  it('schedules player cleanup on the Tone transport clock instead of wall-clock timers', async () => {
    let disposeCalls = 0;
    let nextScheduleId = 1;
    const callbacks = new Map<number, (time: number) => void>();
    const scheduleTimes = new Map<number, number>();

    const runtime: ToneLikeRuntime = {
      start: async () => undefined,
      now: () => 0,
      Transport: {
        bpm: { value: 120 },
        seconds: 0,
        scheduleOnce: (callback, time) => {
          const id = nextScheduleId++;
          callbacks.set(id, callback);
          scheduleTimes.set(id, time);
          return id;
        },
        clear: (id) => {
          callbacks.delete(id);
          scheduleTimes.delete(id);
        },
        cancel: () => undefined,
        start: () => undefined,
        pause: () => undefined,
        stop: () => undefined
      },
      Player: class {
        volume = { value: 0 };
        playbackRate = 1;
        connect() { return this; }
        start() { return this; }
        stop() { return this; }
        dispose() { disposeCalls += 1; return this; }
      } as any,
      ToneAudioBuffer: {
        fromUrl: async () => ({ duration: 2 })
      }
    };

    const clipManager = new AudioClipManager<ToneAudioBufferLike>(async () => ({
      buffer: { duration: 2 },
      duration: 2
    }));
    const adapter = new ToneJsAdapter({ runtime, clipManager });
    adapter.setBusGraph({ getBus: () => ({}), initialize: async () => {} } as any);

    const event = createScheduledEvent();
    event.endTime = 4;

    await adapter.preloadEvents([event]);
    adapter.scheduleEvent(event);

    const playbackCallback = callbacks.get(1);
    expect(playbackCallback).toBeDefined();
    playbackCallback?.(0);
    await Promise.resolve();

    expect(disposeCalls).toBe(0);
    expect(scheduleTimes.get(2)).toBe(4.5);

    callbacks.get(2)?.(4.5);
    expect(disposeCalls).toBe(1);
  });
});
