import type { TimelineEventV2 } from '../producer/types.js';
import { EventScheduler, type ScheduledTimelineEvent } from './EventScheduler.js';
import type { AudioClipManager } from './AudioClipManager.js';
import type { AudioGraph } from './AudioGraph.js';
import { PlaybackValidator } from './PlaybackValidator.js';
import type { PlaybackInstruction, EventPlaybackStrategy } from './EventPlaybackStrategy.js';
import { resolvePlaybackInstructions, createDefaultPlaybackStrategies } from './EventPlaybackStrategy.js';
import { ToneJsAdapter, type TimelineControlActionHandler } from './ToneAdapter.js';

export type PlaybackState = 'stopped' | 'loading' | 'playing' | 'paused' | 'seeking' | 'rendering';

export interface PlaybackSession {
  ok: boolean;
  eventCount: number;
  transportName: string;
  logs: string[];
}

export interface PlaybackTransportOptions {
  adapter?: ToneJsAdapter;
  scheduler?: EventScheduler;
  validator?: PlaybackValidator;
  clipManager?: AudioClipManager;
  graph?: AudioGraph;
  strategies?: EventPlaybackStrategy[];
  sourcePath?: string;
}

type Listener = (state: PlaybackState) => void;
type PositionListener = (position: number) => void;

export class PlaybackTransport {
  readonly transportName = 'tonejs-playback';

  private state: PlaybackState = 'stopped';
  private readonly adapter: ToneJsAdapter;
  private readonly scheduler: EventScheduler;
  private readonly clipManager: AudioClipManager | undefined;
  private readonly graph: AudioGraph | undefined;
  private readonly strategies: EventPlaybackStrategy[];
  private loopRange: { start: number; end: number } | undefined;
  private scheduledEvents: ScheduledTimelineEvent[] = [];
  private triggeredEvents: ScheduledTimelineEvent[] = [];
  private playListeners: Listener[] = [];
  private pauseListeners: Listener[] = [];
  private stopListeners: Listener[] = [];
  private seekListeners: Listener[] = [];
  private positionListeners: PositionListener[] = [];

  constructor(options: PlaybackTransportOptions = {}) {
    this.adapter = options.adapter ?? new ToneJsAdapter();
    if (options.sourcePath !== undefined) {
      this.adapter.setSourcePath(options.sourcePath);
    }
    if (options.clipManager) {
      this.adapter.setClipManager(options.clipManager);
    }
    this.scheduler =
      options.scheduler ??
      new EventScheduler({
        adapter: this.adapter,
        ...(options.validator ? { validator: options.validator } : {})
      });
    this.clipManager = options.clipManager;
    this.graph = options.graph;
    this.strategies = options.strategies ?? createDefaultPlaybackStrategies();
    this.adapter.setEventHandler((event, command) => {
      this.triggeredEvents.push(event);
      this.handlePlaybackInstruction(resolvePlaybackInstructions(event, { event, sectionId: event.sectionId }, this.strategies), event, command.payload);
    });
  }

  onPlay(listener: Listener): () => void {
    this.playListeners.push(listener);
    return () => {
      this.playListeners = this.playListeners.filter((entry) => entry !== listener);
    };
  }

  onPause(listener: Listener): () => void {
    this.pauseListeners.push(listener);
    return () => {
      this.pauseListeners = this.pauseListeners.filter((entry) => entry !== listener);
    };
  }

  onStop(listener: Listener): () => void {
    this.stopListeners.push(listener);
    return () => {
      this.stopListeners = this.stopListeners.filter((entry) => entry !== listener);
    };
  }

  onSeek(listener: Listener): () => void {
    this.seekListeners.push(listener);
    return () => {
      this.seekListeners = this.seekListeners.filter((entry) => entry !== listener);
    };
  }

  onPositionChanged(listener: PositionListener): () => void {
    this.positionListeners.push(listener);
    return () => {
      this.positionListeners = this.positionListeners.filter((entry) => entry !== listener);
    };
  }

  setControlActionHandler(handler?: TimelineControlActionHandler): void {
    this.adapter.setControlActionHandler(handler);
  }

  loadTimeline(events: TimelineEventV2[]): void {
    this.scheduledEvents = this.scheduler.scheduleTimeline(events);
    this.triggeredEvents = [];
    void this.adapter.preloadEvents(this.scheduledEvents);
  }

  async play(events: ScheduledTimelineEvent[] = this.scheduledEvents): Promise<PlaybackSession> {
    try {
      if (events.length) {
        if (this.state === 'paused') {
          this.scheduledEvents = this.scheduler.seekRecovery(this.getPosition());
        } else {
          this.scheduledEvents = this.scheduler.scheduleTimeline(events);
        }
      }

      this.state = 'loading';
      await this.adapter.preloadEvents(this.scheduledEvents);
      await this.adapter.play();
      this.state = 'playing';
      this.emit(this.playListeners, this.state);
      return {
        ok: true,
        eventCount: this.scheduledEvents.length,
        transportName: this.transportName,
        logs: [`Playing ${this.scheduledEvents.length} scheduled events.`]
      };
    } catch (error) {
      this.state = 'stopped';
      throw error;
    }
  }

  pause(): PlaybackSession {
    this.adapter.pause();
    this.state = 'paused';
    this.emit(this.pauseListeners, this.state);
    return this.session(`Paused at ${this.getPosition().toFixed(3)}s.`);
  }

  stop(): PlaybackSession {
    this.adapter.stop();
    this.state = 'stopped';
    this.triggeredEvents = [];
    this.emit(this.stopListeners, this.state);
    return this.session('Playback stopped.');
  }

  emergencyStop(): PlaybackSession {
    this.scheduler.emergencyStop();
    this.scheduledEvents = [];
    this.triggeredEvents = [];
    this.state = 'stopped';
    this.emit(this.stopListeners, this.state);
    return this.session('Emergency stop cleared scheduled playback.');
  }

  seek(position: number): PlaybackSession {
    this.state = 'seeking';
    this.adapter.seek(position);
    this.scheduledEvents = this.scheduler.seekRecovery(position);
    this.state = 'paused';
    this.emit(this.seekListeners, this.state);
    this.emitPosition(position);
    return this.session(`Seeked to ${position.toFixed(3)}s.`);
  }

  setBpm(bpm: number): void {
    this.adapter.setBpm(bpm);
  }

  setLoop(start: number, end: number): void {
    this.loopRange = { start, end };
  }

  clearLoop(): void {
    this.loopRange = undefined;
  }

  getPosition(): number {
    return this.adapter.getPosition();
  }

  getDuration(): number {
    if (this.loopRange) {
      return this.loopRange.end;
    }

    return this.scheduledEvents.reduce((max, event) => Math.max(max, event.endTime), 0);
  }

  getState(): PlaybackState {
    return this.state;
  }

  getScheduledEvents(): ScheduledTimelineEvent[] {
    return this.scheduler.getScheduledEvents();
  }

  getTriggeredEvents(): ScheduledTimelineEvent[] {
    return [...this.triggeredEvents];
  }

  clearSchedule(): void {
    this.scheduler.clear();
    this.scheduledEvents = [];
    this.triggeredEvents = [];
  }

  async dispose(): Promise<void> {
    this.clearSchedule();
    this.adapter.setEventHandler(undefined);
    await this.adapter.dispose();
    this.loopRange = undefined;
    this.state = 'stopped';
    this.playListeners = [];
    this.pauseListeners = [];
    this.stopListeners = [];
    this.seekListeners = [];
    this.positionListeners = [];
  }

  private handlePlaybackInstruction(
    instructions: PlaybackInstruction[],
    event: ScheduledTimelineEvent,
    payload: Record<string, unknown>
  ): void {
    void payload;
    if (!this.graph || instructions.every((instruction) => instruction.commandType === 'noop')) {
      return;
    }

    const bus = resolveBus(event.type);
    this.graph.connect(bus, 'master');
  }

  getPlaybackMetrics(): {
    activePlayers: number;
    loadedClips: number;
    memoryUsageBytes: number;
    scheduledEvents: number;
    droppedEvents: number;
  } {
    return this.adapter.getMetrics();
  }

  private emit(listeners: Listener[], state: PlaybackState): void {
    for (const listener of listeners) {
      listener(state);
    }
  }

  private emitPosition(position: number): void {
    for (const listener of this.positionListeners) {
      listener(position);
    }
  }

  private session(log: string): PlaybackSession {
    return {
      ok: true,
      eventCount: this.scheduledEvents.length,
      transportName: this.transportName,
      logs: [log]
    };
  }
}

export class NullPlaybackTransport extends PlaybackTransport {}

function resolveBus(eventType: TimelineEventV2['type']): 'drum' | 'bass' | 'melody' | 'vocal' | 'fx' | 'preview' {
  if (eventType === 'drum') return 'drum';
  if (eventType === 'bass') return 'bass';
  if (eventType === 'lead' || eventType === 'synth' || eventType === 'stem_clip') return 'melody';
  if (eventType === 'vocal') return 'vocal';
  if (eventType === 'fx' || eventType === 'transition' || eventType === 'impact' || eventType === 'riser' || eventType === 'fill') {
    return 'fx';
  }
  return 'preview';
}
