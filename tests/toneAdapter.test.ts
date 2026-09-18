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

  it('scales cleanup delay based on playbackRate', async () => {
    vi.useFakeTimers();
    let disposeCalls = 0;

    const runtime: ToneLikeRuntime = {
      start: async () => undefined,
      now: () => 0,
      Transport: {
        bpm: { value: 120 },
        seconds: 0,
        scheduleOnce: (callback, time) => {
          const at = typeof time === 'number' ? time : 0;
          if (at <= 0) {
            callback(0);
          } else {
            setTimeout(() => callback(at), at * 1000);
          }
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
    event.payload = { ...event.payload, playbackRate: 0.5 }; // Plays 2s clip over 4s

    await adapter.preloadEvents([event]);
    adapter.scheduleEvent(event);
    await Promise.resolve();

    // At playbackRate 0.5, 2s clip takes 4s.
    // Cleanup should happen AFTER 4s.
    vi.advanceTimersByTime(2500);
    expect(disposeCalls).toBe(0);

    vi.advanceTimersByTime(2000);
    expect(disposeCalls).toBe(1);

    vi.useRealTimers();
  });
});
