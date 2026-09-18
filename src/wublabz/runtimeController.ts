import { WubLabzEngine } from '../lib/WubLabzEngine.js';
import { EngineDiagnosticsStore } from '../lib/diagnostics/EngineDiagnosticsStore.js';
import { ModulationAdapter } from '../lib/audio/modulationAdapter.js';
import { runPerformanceMacro, cancelAllPendingMacros, getPendingMacroCount } from '../lib/audio/performanceMacros.js';
import { SceneScheduler } from '../lib/playback/sceneScheduler.js';
import type { TimelineRouteAction } from '../lib/playback/timelineEventRouter.js';
import type {
  SceneTriggerPayload,
  StemControlPayload,
  EffectTogglePayload,
  MacroTriggerPayload,
  MacroSetValuePayload,
  TimelineLoadPayload,
  TransportSeekPayload,
  ValidatedWubLabzEvent
} from './protocol.js';

export class RuntimeController {
  private engine: WubLabzEngine;
  private diagnostics: EngineDiagnosticsStore;
  private modulationAdapter: ModulationAdapter;
  private sceneScheduler: SceneScheduler;

  constructor() {
    this.engine = new WubLabzEngine();
    this.diagnostics = new EngineDiagnosticsStore();
    this.modulationAdapter = new ModulationAdapter(this.engine);
    this.sceneScheduler = new SceneScheduler();
    this.engine.setTimelineControlActionHandler((action) => {
      this.handleTimelineControlAction(action);
    });
  }

  initializeRuntime() {
    this.diagnostics.update({ engineReady: true, emergencyStopped: false });
  }

  getRuntimeDiagnostics() {
    // Try to advance scenes if playback is happening
    this.sceneScheduler.applyQueuedSceneIfBoundary(this.engine.transport.getState());
    
    // Engine automatically updates its internal BPM if needed, get a fresh snapshot
    const snapshot = this.engine.getTransportSnapshot();

    this.diagnostics.update({
      transportState: snapshot.transportState,
      bpm: snapshot.bpm,
      currentBeat: snapshot.currentBeat,
      currentBar: snapshot.currentBar,
      currentPhrase: snapshot.currentPhrase,
      scheduledEventCount: this.engine.transport.getScheduledEvents().length,
      activeModulationCount: this.modulationAdapter.getActiveModulationCount(),
      registeredBusCount: this.engine.busGraph.getRegisteredBusCount(),
      registeredModulationTargetCount: this.engine.busGraph.getRegisteredModulationTargetCount(),
      pendingMacroCount: getPendingMacroCount(),
      currentScene: this.sceneScheduler.getCurrentScene(),
      queuedScene: this.sceneScheduler.getQueuedScene(),
      busLevels: this.engine.busGraph.getBusLevels(),
      activeConnectionCount: (this as any).activeConnectionCount || 0
    });
    return this.diagnostics.getDiagnostics();
  }

  setActiveConnectionCount(count: number) {
    (this as any).activeConnectionCount = count;
  }

  handleIntent(event: ValidatedWubLabzEvent) {
    if (!this.diagnostics.getDiagnostics().engineReady && event.type !== 'HEARTBEAT' && event.type !== 'EMERGENCY_STOP') {
      return { type: 'EVENT_REJECTED', payload: { originalType: event.type, reason: "Engine not ready", timestamp: Date.now() } };
    }

    const requiresTimeline = event.type === 'TRANSPORT_PLAY' || event.type === 'TRANSPORT_SEEK';
    if (requiresTimeline && this.engine.transport.getScheduledEvents().length === 0) {
      this.diagnostics.update({ lastSchedulerError: "No timeline loaded" });
      return { type: 'EVENT_REJECTED', payload: { originalType: event.type, reason: "No timeline loaded", suggestedAction: "Upload/analyze/generate a remix first", timestamp: Date.now() } };
    }

    try {
      switch (event.type) {
        case 'HEARTBEAT':
          return { type: 'HEARTBEAT', payload: { ...event.payload, serverReceived: Date.now() } };

        case 'TIMELINE_LOAD': {
          const payload = event.payload as TimelineLoadPayload;
          this.engine.loadTimeline(payload.events);
          if (payload.bpm !== undefined) {
            this.engine.setBpm(payload.bpm);
          }
          this.diagnostics.update({
            emergencyStopped: false,
            lastSchedulerError: null,
            lastRouteError: null
          });
          break;
        }

        case 'TRANSPORT_PLAY':
          this.engine.play();
          break;
        case 'TRANSPORT_PAUSE':
          this.engine.pause();
          break;
        case 'TRANSPORT_STOP':
          this.engine.stop();
          break;
        case 'TRANSPORT_SEEK':
          this.engine.seek((event.payload as TransportSeekPayload).positionSeconds);
          break;

        case 'STEM_MUTE':
          this.modulationAdapter.applyModulation({
            effectId: (event.payload as StemControlPayload).stemId,
            parameter: 'mute',
            value: 1
          });
          break;
        case 'STEM_SOLO':
          this.modulationAdapter.applyModulation({
            effectId: (event.payload as StemControlPayload).stemId,
            parameter: 'solo',
            value: 1
          });
          break;
        case 'STEM_GAIN':
          this.modulationAdapter.applyModulation({
            effectId: (event.payload as StemControlPayload).stemId,
            parameter: 'volume',
            value: (event.payload as Required<StemControlPayload>).value
          });
          break;

        case 'EFFECT_TOGGLE':
          this.modulationAdapter.applyModulation({
            effectId: (event.payload as EffectTogglePayload).effectId,
            parameter: 'active',
            value: (event.payload as EffectTogglePayload).active === false ? 0 : 1
          });
          break;

        case 'MACRO_TRIGGER':
          return this.handlePerformanceMacro(event.payload as MacroTriggerPayload);

        case 'MACRO_SET_VALUE':
          this.modulationAdapter.applyModulation({
            effectId: 'macro',
            parameter: (event.payload as MacroSetValuePayload).macroId,
            value: (event.payload as MacroSetValuePayload).value
          });
          break;

        case 'SCENE_TRIGGER':
          return this.handleSceneTrigger(event.payload as SceneTriggerPayload);

        case 'EMERGENCY_STOP':
          return this.handleEmergencyStop();
      }

      return { type: 'ENGINE_STATUS', payload: this.getRuntimeDiagnostics() };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'Intent execution failed';
      return { type: 'EVENT_REJECTED', payload: { originalType: event.type, reason, timestamp: Date.now() } };
    }
  }

  private handleSceneTrigger(payload: SceneTriggerPayload) {
    const result = this.sceneScheduler.queueScene(payload.sceneId, payload.quantize);
    if (!result.success) {
      this.diagnostics.update({ lastSceneError: result.reason });
      return { type: 'EVENT_REJECTED', payload: { originalType: 'SCENE_TRIGGER', reason: result.reason, timestamp: Date.now() } };
    }
    return { type: 'ENGINE_STATUS', payload: this.getRuntimeDiagnostics() };
  }

  private handlePerformanceMacro(payload: MacroTriggerPayload) {
    const snapshot = this.engine.getTransportSnapshot();
    const result = runPerformanceMacro(payload.macroId, { 
      intensity: payload.intensity,
      transportSnapshot: snapshot
    }, this.modulationAdapter);
    
    if (!result.success) {
      const reason = result.reason || 'Unknown macro failure';
      this.diagnostics.update({ lastMacroError: reason });
      return { type: 'EVENT_REJECTED', payload: { originalType: 'MACRO_TRIGGER', reason: reason, timestamp: Date.now() } };
    }
    return { type: 'ENGINE_STATUS', payload: this.getRuntimeDiagnostics() };
  }

  private handleTimelineControlAction(action: TimelineRouteAction): void {
    let reason: string | undefined;

    if (action.actionType === 'stemMute') {
      const result = this.modulationAdapter.applyModulation({
        effectId: action.bus,
        parameter: 'mute',
        value: action.muted ? 1 : 0
      });
      if (!result.success) reason = result.reason;
    } else if (action.actionType === 'gainChange') {
      const result = this.modulationAdapter.applyModulation({
        effectId: action.bus,
        parameter: 'volume',
        value: action.value,
        rampTime: action.rampTime
      });
      if (!result.success) reason = result.reason;
    } else if (action.actionType === 'modulation') {
      const result = this.modulationAdapter.applyModulation({
        effectId: action.effectId,
        parameter: action.parameter,
        value: action.value,
        ...(action.rampTime !== undefined ? { rampTime: action.rampTime } : {})
      });
      if (!result.success) reason = result.reason;
    } else if (action.actionType === 'macro') {
      const result = runPerformanceMacro(
        action.macroId,
        { transportSnapshot: this.engine.getTransportSnapshot() },
        this.modulationAdapter
      );
      if (!result.success) reason = result.reason;
    }

    this.diagnostics.update({ lastRouteError: reason ?? null });
  }

  handleEmergencyStop() {
    this.engine.emergencyStop();
    this.modulationAdapter.resetAllModulation();
    this.sceneScheduler.emergencyStopScenes();
    cancelAllPendingMacros();

    this.diagnostics.update({
      emergencyStopped: true,
      transportState: 'stopped',
      queuedScene: '',
      currentScene: '',
      activeModulationCount: 0,
      pendingMacroCount: 0,
      lastSchedulerError: null,
      lastRouteError: null,
      lastAudioError: null,
      lastModulationError: null,
      lastSceneError: null,
      lastMacroError: null
    });

    return { type: 'ENGINE_STATUS', payload: this.getRuntimeDiagnostics() };
  }

  async disposeRuntime(): Promise<void> {
    cancelAllPendingMacros();
    this.engine.setTimelineControlActionHandler(undefined);
    await this.engine.dispose();
  }
}
