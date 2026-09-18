import { PlaybackTransport } from './playback/PlaybackTransport.js';
import type { TimelineControlActionHandler } from './playback/ToneAdapter.js';
import type { TimelineEventV2 } from './producer/types.js';
import { BusGraph } from './audio/BusGraph.js';
import { type TransportSnapshot, calculateSecondsPerBeat, calculateSecondsPerBar, calculateSecondsPerPhrase } from './playback/transportSnapshot.js';

export class WubLabzEngine {
  public busGraph = new BusGraph();
  public transport = new PlaybackTransport();

  private bpm: number = 120;

  constructor() {
    // Note: If PlaybackTransport allows passing an adapter or setting it later,
    // we should set the busGraph on it. We can cast any adapter if we know it has setBusGraph.
    const adapter = (this.transport as any).adapter;
    if (adapter && adapter.setBusGraph) {
      adapter.setBusGraph(this.busGraph);
    }
  }

  loadTimeline(events: TimelineEventV2[]): void {
    this.transport.loadTimeline(events);
  }

  setTimelineControlActionHandler(handler?: TimelineControlActionHandler): void {
    this.transport.setControlActionHandler(handler);
  }

  play() {
    return this.transport.play();
  }

  pause() {
    return this.transport.pause();
  }

  stop() {
    return this.transport.stop();
  }

  seek(positionSeconds: number) {
    return this.transport.seek(positionSeconds);
  }

  emergencyStop() {
    this.transport.emergencyStop();
    this.busGraph.emergencyStopAudioGraph();
  }

  async dispose(): Promise<void> {
    await this.transport.dispose();
    this.busGraph.dispose();
  }

  setMasterVolume(value: number, rampTime?: number) {
    this.busGraph.setMasterVolume(value, rampTime);
  }

  setBusGain(busName: string, value: number, rampTime?: number) {
    // Left as TODO since it requires mapping BusName to BusGraph properly if we expose it later
  }

  applyEffectParameter(effectId: string, parameter: string, value: number, rampTime?: number) {
    this.busGraph.applyEffectParameter(effectId, parameter, value, rampTime);
  }

  resetEffectParameter(effectId: string, parameter: string, defaultValue: number) {
    this.busGraph.resetEffectParameter(effectId, parameter, defaultValue, 0);
  }

  getBpm(): number {
    return this.bpm;
  }

  setBpm(bpm: number): void {
    if (bpm > 0) {
      this.bpm = bpm;
      this.transport.setBpm(bpm);
    }
  }

  getCurrentBeat(): number {
    const pos = this.transport.getPosition();
    return Math.floor(pos / calculateSecondsPerBeat(this.bpm));
  }

  getCurrentBar(): number {
    const pos = this.transport.getPosition();
    return Math.floor(pos / calculateSecondsPerBar(this.bpm));
  }

  getCurrentPhrase(): number {
    const pos = this.transport.getPosition();
    return Math.floor(pos / calculateSecondsPerPhrase(this.bpm));
  }

  getTransportSnapshot(): TransportSnapshot {
    const state = this.transport.getState();
    const pos = this.transport.getPosition();
    
    const secPerBeat = calculateSecondsPerBeat(this.bpm);
    const secPerBar = calculateSecondsPerBar(this.bpm);
    const secPerPhrase = calculateSecondsPerPhrase(this.bpm);

    const currentBeat = Math.floor(pos / secPerBeat);
    const currentBar = Math.floor(pos / secPerBar);
    const currentPhrase = Math.floor(pos / secPerPhrase);

    // Calculate time until next boundaries
    const secondsUntilNextBeat = (currentBeat + 1) * secPerBeat - pos;
    const secondsUntilNextBar = (currentBar + 1) * secPerBar - pos;
    const secondsUntilNextPhrase = (currentPhrase + 1) * secPerPhrase - pos;

    return {
      bpm: this.bpm,
      transportState: state,
      currentBeat,
      currentBar,
      currentPhrase,
      secondsPerBeat: secPerBeat,
      secondsPerBar: secPerBar,
      phraseLengthBars: 4,
      secondsUntilNextBeat,
      secondsUntilNextBar,
      secondsUntilNextPhrase
    };
  }
}


