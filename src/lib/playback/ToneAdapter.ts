import * as Tone from 'tone';
import { AudioClipManager, type LoadedClip } from './AudioClipManager.js';
import type { ScheduledTimelineEvent } from './EventScheduler.js';
import type { TimelineEventV2 } from '../producer/types.js';
import type { BusGraph } from '../audio/BusGraph.js';
import { resolveTimelineEventBus, routeTimelineEvent, type TimelineRouteAction } from './timelineEventRouter.js';

export interface ToneCommand {
  id: string;
  eventId: string;
  commandType: 'trigger' | 'fade' | 'marker' | 'noop';
  startTime: number;
  endTime: number;
  payload: Record<string, unknown>;
}

export interface ScheduledToneEvent extends ToneCommand {
  scheduleId: number;
}

export interface PlaybackMetrics {
  activePlayers: number;
  loadedClips: number;
  memoryUsageBytes: number;
  scheduledEvents: number;
  droppedEvents: number;
}

export type TonePlaybackState = 'stopped' | 'loading' | 'playing' | 'paused' | 'seeking' | 'rendering';

interface DecodedAudioBufferLike {
  length: number;
  numberOfChannels: number;
}

export interface ToneAudioBufferLike {
  duration: number;
  loaded?: boolean;
  dispose?: () => void;
  get?: () => DecodedAudioBufferLike | undefined;
}

export interface TonePlayerLike {
  connect?: (destination: unknown) => TonePlayerLike;
  start: (time?: number, offset?: number, duration?: number) => TonePlayerLike;
  stop: (time?: number) => TonePlayerLike;
  dispose: () => TonePlayerLike;
  buffer?: unknown;
  volume?: { value: number };
  playbackRate?: number;
}

export interface ToneLikeRuntime {
  start: () => Promise<void>;
  now: () => number;
  Transport: {
    bpm: { value: number };
    seconds: number;
    scheduleOnce: (callback: (time: number) => void, time: number) => number;
    clear: (id: number) => void;
    cancel: (time?: number) => void;
    start: (time?: number) => void;
    pause: (time?: number) => void;
    stop: (time?: number) => void;
  };
  Player: new (buffer?: ToneAudioBufferLike | string | unknown) => TonePlayerLike;
  ToneAudioBuffer: {
    fromUrl: (url: string) => Promise<ToneAudioBufferLike>;
    supportsType?: (url: string) => boolean;
  };
  context?: {
    state: string;
    resume?: () => Promise<void>;
  };
}

export interface ToneJsAdapterOptions {
  runtime?: ToneLikeRuntime;
  clipManager?: AudioClipManager<any>;
  sourcePath?: string;
  resolveSourcePath?: (event: ScheduledTimelineEvent, command: ScheduledToneEvent) => string | undefined;
}

function createToneRuntime(): ToneLikeRuntime {
  return Tone as unknown as ToneLikeRuntime;
}

function isRuntimeLike(value: ToneLikeRuntime | ToneJsAdapterOptions | undefined): value is ToneLikeRuntime {
  return Boolean(value && 'Transport' in value && 'Player' in value && 'ToneAudioBuffer' in value);
}

function classifyCommandType(event: TimelineEventV2): ToneCommand['commandType'] {
  return routeTimelineEvent(event).action.commandType;
}

export class ToneJsAdapter {
  private runtime: ToneLikeRuntime | undefined;
  private busGraph: BusGraph | undefined;
  private state: TonePlaybackState = 'stopped';
  private eventHandler: ((event: ScheduledTimelineEvent, command: ScheduledToneEvent) => void) | undefined;
  private scheduled = new Map<string, ScheduledToneEvent>();
  private activePlayers = new Map<string, TonePlayerLike>();
  private activeCleanupScheduleIds = new Map<string, number>();
  private loadedClipIds = new Set<string>();
  private droppedEvents = 0;
  private lifecycleBound = false;
  private readonly options: ToneJsAdapterOptions;
  private clipManager: AudioClipManager<any> | undefined;
  private defaultSourcePath: string | undefined;

  setBusGraph(busGraph: BusGraph) {
    this.busGraph = busGraph;
  }

  constructor(runtimeOrOptions?: ToneLikeRuntime | ToneJsAdapterOptions) {
    if (isRuntimeLike(runtimeOrOptions)) {
      this.runtime = runtimeOrOptions;
      this.options = {};
    } else {
      this.options = runtimeOrOptions ?? {};
      this.runtime = this.options.runtime;
    }

    this.clipManager = this.options.clipManager;
    this.defaultSourcePath = this.options.sourcePath;
  }

  setSourcePath(sourcePath: string): void {
    this.defaultSourcePath = sourcePath;
  }

  setClipManager(clipManager: AudioClipManager<any>): void {
    this.clipManager = clipManager;
  }

  async initialize(): Promise<this> {
    if (!this.runtime) {
      this.runtime = createToneRuntime();
    }

    if (this.busGraph) {
      await this.busGraph.initialize(this.runtime);
    }

    this.ensureClipManager();
    this.bindLifecycleHooks();

    this.runtime.Transport.bpm.value = this.runtime.Transport.bpm.value || 120;

    if (this.runtime.context?.state === 'suspended' && this.runtime.context.resume) {
      await this.runtime.context.resume().catch(() => undefined);
    }

    this.state = 'stopped';
    return this;
  }

  async dispose(): Promise<void> {
    this.unbindLifecycleHooks();
    this.stopActivePlayers();
    this.runtime?.Transport.cancel(0);
    this.runtime?.Transport.stop();
    this.releaseLoadedClips();
    this.clipManager?.clearUnused(0);
    this.eventHandler = undefined;
    this.scheduled.clear();
    this.state = 'stopped';
  }

  setEventHandler(listener?: (event: ScheduledTimelineEvent, command: ScheduledToneEvent) => void): void {
    this.eventHandler = listener;
  }

  async preloadEvents(events: ScheduledTimelineEvent[]): Promise<LoadedClip<ToneAudioBufferLike>[]> {
    await this.initialize();
    const uniqueSources = new Map<string, { clipId: string; sourcePath: string }>();

    for (const event of events) {
      const commandType = classifyCommandType(event);
      if (commandType === 'noop' || commandType === 'marker') {
        continue;
      }

      const sourcePath = this.resolveSourcePath(event, commandType);
      if (!sourcePath) {
        continue;
      }

      uniqueSources.set(sourcePath, {
        clipId: this.resolveClipId(event, sourcePath, commandType),
        sourcePath
      });
    }

    const loaded: LoadedClip<ToneAudioBufferLike>[] = [];
    for (const { clipId, sourcePath } of uniqueSources.values()) {
      if (this.loadedClipIds.has(clipId)) {
        const clip = this.clipManager?.getLoadedClip(clipId);
        if (clip) {
          loaded.push(clip);
        }
        continue;
      }

      if (!this.clipManager) {
        continue;
      }

      const clip = await this.clipManager.loadClip(clipId, sourcePath);
      this.loadedClipIds.add(clipId);
      loaded.push(clip);
    }

    return loaded;
  }

  async play(): Promise<TonePlaybackState> {
    await this.initialize();
    this.state = 'loading';
    try {
      await this.resumeAudioContext();
      this.runtime!.Transport.start();
      await this.runtime!.start().catch(() => undefined);
      this.state = 'playing';
      return this.state;
    } catch (error) {
      this.stopActivePlayers();
      this.runtime?.Transport.stop();
      this.runtime?.Transport.cancel(0);
      this.state = 'stopped';
      throw error;
    }
  }

  pause(): TonePlaybackState {
    void this.initialize();
    this.stopActivePlayers();
    this.runtime?.Transport.pause();
    this.state = 'paused';
    return this.state;
  }

  stop(): TonePlaybackState {
    void this.initialize();
    this.stopActivePlayers();
    this.runtime?.Transport.stop();
    this.runtime?.Transport.cancel(0);
    this.releaseLoadedClips();
    this.clipManager?.clearUnused(0);
    this.scheduled.clear();
    this.state = 'stopped';
    return this.state;
  }

  seek(positionSeconds: number): TonePlaybackState {
    void this.initialize();
    this.state = 'seeking';
    this.stopActivePlayers();
    if (this.runtime) {
      this.runtime.Transport.seconds = Math.max(0, positionSeconds);
      this.runtime.Transport.cancel(0);
    }
    this.state = 'paused';
    return this.state;
  }

  setBpm(bpm: number): void {
    void this.initialize();
    if (this.runtime) {
      this.runtime.Transport.bpm.value = bpm;
    }
  }

  scheduleEvent(event: ScheduledTimelineEvent): ScheduledToneEvent {
    const existing = this.scheduled.get(event.id);
    if (existing) {
      return existing;
    }

    void this.initialize();
    const route = routeTimelineEvent(event);
    const command: ScheduledToneEvent = {
      id: `${event.id}:tone`,
      eventId: event.id,
      commandType: route.action.commandType,
      startTime: event.startTime,
      endTime: event.endTime,
      payload: createToneCommandPayload(event, route.action, this.defaultSourcePath),
      scheduleId: -1
    };

    if (this.runtime) {
      command.scheduleId = this.runtime.Transport.scheduleOnce((time) => {
        void this.triggerEventPlayback(event, command, time);
      }, event.startTime);
    }

    this.scheduled.set(event.id, command);
    return command;
  }

  scheduleEvents(events: ScheduledTimelineEvent[]): ScheduledToneEvent[] {
    return events.map((event) => this.scheduleEvent(event));
  }

  clearSchedule(eventIds?: string[]): void {
    if (!this.runtime) {
      this.scheduled.clear();
      return;
    }

    if (!eventIds) {
      this.stopActivePlayers();
      this.runtime.Transport.cancel(0);
      this.scheduled.clear();
      return;
    }

    for (const eventId of eventIds) {
      const scheduled = this.scheduled.get(eventId);
      if (!scheduled) {
        continue;
      }

      this.runtime.Transport.clear(scheduled.scheduleId);
      this.disposeActivePlayer(eventId);
      this.scheduled.delete(eventId);
    }
  }

  getPosition(): number {
    return this.runtime?.Transport.seconds ?? 0;
  }

  getState(): TonePlaybackState {
    return this.state;
  }

  getScheduledCount(): number {
    return this.scheduled.size;
  }

  getMetrics(): PlaybackMetrics {
    return {
      activePlayers: this.activePlayers.size,
      loadedClips: this.clipManager?.getLoadedClipCount() ?? 0,
      memoryUsageBytes: this.clipManager?.getMemoryUsageBytes() ?? 0,
      scheduledEvents: this.scheduled.size,
      droppedEvents: this.droppedEvents
    };
  }

  private ensureClipManager(): void {
    if (this.clipManager || !this.runtime) {
      return;
    }

    this.clipManager = new AudioClipManager<ToneAudioBufferLike>(async (sourcePath) => {
      if (this.runtime?.ToneAudioBuffer.supportsType && !this.runtime.ToneAudioBuffer.supportsType(sourcePath)) {
        throw new Error(`Unsupported audio type: ${sourcePath}`);
      }

      const buffer = await this.runtime!.ToneAudioBuffer.fromUrl(sourcePath);
      return {
        buffer,
        duration: buffer.duration,
        byteLength: estimateBufferByteLength(buffer)
      };
    });
  }

  private bindLifecycleHooks(): void {
    const globalWindow = globalThis as typeof globalThis & {
      window?: {
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
      };
      document?: {
        visibilityState: string;
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
      };
    };

    if (this.lifecycleBound || !globalWindow.window || !globalWindow.document) {
      return;
    }

    const handleFocus = () => {
      if (this.state === 'playing') {
        void this.resumeAudioContext();
      }
    };

    const handleVisibility = () => {
      if (globalWindow.document?.visibilityState === 'visible' && this.state === 'playing') {
        void this.resumeAudioContext();
      }
    };

    globalWindow.window.addEventListener('focus', handleFocus);
    globalWindow.document.addEventListener('visibilitychange', handleVisibility);
    this.lifecycleBound = true;
    this.focusHandler = handleFocus;
    this.visibilityHandler = handleVisibility;
  }

  private unbindLifecycleHooks(): void {
    const globalWindow = globalThis as typeof globalThis & {
      window?: {
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
      };
      document?: {
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
      };
    };

    if (!this.lifecycleBound || !globalWindow.window || !globalWindow.document) {
      return;
    }

    if (this.focusHandler) {
      globalWindow.window.removeEventListener('focus', this.focusHandler);
    }
    if (this.visibilityHandler) {
      globalWindow.document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.focusHandler = undefined;
    this.visibilityHandler = undefined;
    this.lifecycleBound = false;
  }

  private focusHandler: (() => void) | undefined;
  private visibilityHandler: (() => void) | undefined;

  private async resumeAudioContext(): Promise<void> {
    if (this.runtime?.context?.state === 'suspended' && this.runtime.context.resume) {
      await this.runtime.context.resume().catch(() => undefined);
      return;
    }

    await this.runtime?.start().catch(() => undefined);
  }

  private async triggerEventPlayback(
    event: ScheduledTimelineEvent,
    command: ScheduledToneEvent,
    scheduledTime: number
  ): Promise<void> {
    if (command.commandType === 'noop' || command.commandType === 'marker') {
      this.eventHandler?.(event, command);
      return;
    }

    try {
      const sourcePath = this.resolveSourcePath(event, command.commandType);
      if (!sourcePath || !this.clipManager) {
        this.droppedEvents += 1;
        this.eventHandler?.(event, command);
        return;
      }

      const clipId = this.resolveClipId(event, sourcePath, command.commandType);
      let clip = this.clipManager.getLoadedClip(clipId);
      if (!clip) {
        clip = await this.clipManager.loadClip(clipId, sourcePath);
        this.loadedClipIds.add(clipId);
      }

      if (!clip) {
        this.droppedEvents += 1;
        this.eventHandler?.(event, command);
        return;
      }

      const player = new this.runtime!.Player(clip.buffer);
      if (this.busGraph) {
        const busName = resolveTimelineEventBus(event);
        if (player.connect) {
          player.connect(this.busGraph.getBus(busName));
        }
      } else {
        this.droppedEvents += 1;
        this.eventHandler?.(event, command);
        player.dispose();
        return;
      }

      if (command.commandType === 'fade' && player.volume) {
        player.volume.value = -6;
      }

      if ('playbackRate' in player && typeof event.payload?.playbackRate === 'number') {
        player.playbackRate = event.payload.playbackRate;
      }

      this.activePlayers.set(event.id, player);

      const offset = resolveClipOffsetSeconds(event, clip, scheduledTime);
      const duration = resolveClipDurationSeconds(event, clip, offset, scheduledTime);
      player.start(scheduledTime, offset, duration);
      this.scheduleCleanup(event.id, event.endTime + 0.5);
      this.eventHandler?.(event, command);
    } catch {
      this.droppedEvents += 1;
      this.eventHandler?.(event, command);
    }
  }

  private scheduleCleanup(eventId: string, cleanupTimeSeconds: number): void {
    if (!this.runtime) {
      return;
    }

    const existingCleanupId = this.activeCleanupScheduleIds.get(eventId);
    if (existingCleanupId !== undefined) {
      this.runtime.Transport.clear(existingCleanupId);
    }

    const cleanupId = this.runtime.Transport.scheduleOnce(() => {
      this.activeCleanupScheduleIds.delete(eventId);
      this.disposeActivePlayer(eventId);
    }, cleanupTimeSeconds);

    this.activeCleanupScheduleIds.set(eventId, cleanupId);
  }

  private disposeActivePlayer(eventId: string): void {
    const cleanupId = this.activeCleanupScheduleIds.get(eventId);
    if (cleanupId !== undefined) {
      try {
        this.runtime?.Transport.clear(cleanupId);
      } catch {
        // ignore transport cleanup failures during teardown
      }
      this.activeCleanupScheduleIds.delete(eventId);
    }

    const player = this.activePlayers.get(eventId);
    if (player) {
      try {
        player.stop(this.runtime?.Transport.seconds ?? 0);
      } catch {
        // ignore stop failures in cleanup
      }

      try {
        player.dispose();
      } catch {
        // ignore dispose failures in cleanup
      }

      this.activePlayers.delete(eventId);
    }
  }

  private stopActivePlayers(): void {
    for (const eventId of [...this.activePlayers.keys()]) {
      this.disposeActivePlayer(eventId);
    }
  }

  private releaseLoadedClips(): void {
    if (!this.clipManager) {
      return;
    }

    for (const clipId of [...this.loadedClipIds]) {
      this.clipManager.releaseClip(clipId);
      this.loadedClipIds.delete(clipId);
    }
  }

  private resolveSourcePath(event: ScheduledTimelineEvent, commandType: ToneCommand['commandType']): string | undefined {
    const commandSourcePath = event.payload?.sourcePath;
    if (typeof commandSourcePath === 'string' && commandSourcePath.trim()) {
      return commandSourcePath;
    }

    const payloadSourcePath = event.payload?.clipPath;
    if (typeof payloadSourcePath === 'string' && payloadSourcePath.trim()) {
      return payloadSourcePath;
    }

    if (this.options.resolveSourcePath) {
      const resolved = this.options.resolveSourcePath(event, {
        id: `${event.id}:tone`,
        eventId: event.id,
        commandType,
        startTime: event.startTime,
        endTime: event.endTime,
        payload: {
          ...event.payload,
          sourcePath: commandSourcePath ?? payloadSourcePath ?? this.defaultSourcePath
        },
        scheduleId: -1
      });
      if (typeof resolved === 'string' && resolved.trim()) {
        return resolved;
      }
    }

    return this.defaultSourcePath;
  }

  private resolveClipId(
    event: ScheduledTimelineEvent,
    sourcePath: string,
    commandType: ToneCommand['commandType']
  ): string {
    if (sourcePath.trim()) {
      return sourcePath;
    }

    const payloadClipId = event.payload?.clipId;
    if (typeof payloadClipId === 'string' && payloadClipId.trim()) {
      return payloadClipId;
    }

    if (typeof event.stemId === 'string' && event.stemId.trim()) {
      return event.stemId;
    }

    if (commandType === 'fade' || commandType === 'trigger') {
      return sourcePath;
    }

    return event.sourceId;
  }
}

export class ToneAdapter extends ToneJsAdapter {
  adapt(events: TimelineEventV2[]): ToneCommand[] {
    return events.map((event) => {
      const route = routeTimelineEvent(event);
      return {
        id: `${event.id}:tone`,
        eventId: event.id,
        commandType: route.action.commandType,
        startTime: event.startTime,
        endTime: event.endTime,
        payload: createToneCommandPayload(event, route.action)
      };
    });
  }
}

function createToneCommandPayload(
  event: TimelineEventV2,
  action: TimelineRouteAction,
  defaultSourcePath?: string
): Record<string, unknown> {
  return {
    ...action.payload,
    actionType: action.actionType,
    type: event.type,
    sectionId: event.sectionId,
    stemId: event.stemId,
    clipId: resolveCommandClipId(event, action),
    sourcePath: action.payload.sourcePath ?? event.payload.sourcePath ?? event.payload.clipPath ?? defaultSourcePath,
    energyLevel: event.energyLevel
  };
}

function resolveCommandClipId(event: TimelineEventV2, action: TimelineRouteAction): string {
  if (action.actionType === 'triggerClip' || action.actionType === 'sliceTrigger') {
    return action.clipId;
  }

  const clipId = action.payload.clipId;
  return typeof clipId === 'string' && clipId.trim() ? clipId : event.stemId ?? event.sourceId;
}

function resolveClipOffsetSeconds(
  event: ScheduledTimelineEvent,
  clip: LoadedClip<ToneAudioBufferLike>,
  actualStartTime?: number
): number {
  const explicitOffset = event.payload?.clipOffsetSeconds;
  if (typeof explicitOffset === 'number' && Number.isFinite(explicitOffset)) {
    return clamp(explicitOffset, 0, Math.max(0, clip.duration));
  }

  const baseStartTime = event.startTime;
  const transportPosition = actualStartTime ?? baseStartTime;
  const elapsed = Math.max(0, transportPosition - baseStartTime);

  if (clip.duration <= 0) {
    return elapsed;
  }

  // Calculate offset within the clip, accounting for loops
  return clamp(elapsed % clip.duration, 0, Math.max(0, clip.duration));
}

function resolveClipDurationSeconds(
  event: ScheduledTimelineEvent,
  clip: LoadedClip<ToneAudioBufferLike>,
  offset: number,
  actualStartTime?: number
): number {
  const baseStartTime = event.startTime;
  const transportPosition = actualStartTime ?? baseStartTime;
  const elapsed = Math.max(0, transportPosition - baseStartTime);

  const requestedDuration = Math.max(0.01, event.endTime - event.startTime - elapsed);
  if (clip.duration <= 0) {
    return requestedDuration;
  }

  return Math.max(0.01, Math.min(requestedDuration, clip.duration - offset));
}

function estimateBufferByteLength(buffer: ToneAudioBufferLike): number {
  if (typeof buffer.get === 'function') {
    const audioBuffer = buffer.get();
    if (audioBuffer) {
      return audioBuffer.length * audioBuffer.numberOfChannels * 4;
    }
  }

  return Math.max(1, Math.round(buffer.duration * 44100 * 4));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
