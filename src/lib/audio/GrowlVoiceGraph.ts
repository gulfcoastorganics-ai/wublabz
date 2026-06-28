import { createDriveCurve, resolveAdsrStageTimes, resolveLfoHz, SPLIT_CROSSOVER_HZ, type GrowlPreset } from '../producer-tools/synth.js';

export interface GrowlVoice {
  start: (time?: number) => void;
  stop: (time?: number) => void;
  output: any;
}

export function createGrowlVoice(context: any, preset: GrowlPreset, frequencyHz: number, destination: any, engineBpm?: number): GrowlVoice {
  const osc1 = context.createOscillator();
  const osc2 = context.createOscillator();
  const sub = context.createOscillator();
  const mix = context.createGain();
  const subGain = context.createGain();
  const lowSplit = context.createBiquadFilter();
  const highSplit = context.createBiquadFilter();
  const cleanLow = context.createGain();
  const highLevel = context.createGain();
  const drive = context.createWaveShaper();
  const filter = context.createBiquadFilter();
  const amp = context.createGain();
  const lfo = context.createOscillator();
  const lfoDepth = context.createGain();

  osc1.type = preset.osc1;
  osc2.type = preset.osc2;
  sub.type = 'sine';
  osc1.frequency.value = frequencyHz;
  osc2.frequency.value = frequencyHz;
  osc2.detune.value = preset.detuneCents;
  sub.frequency.value = frequencyHz / 2;

  subGain.gain.value = preset.subLevel;
  lowSplit.type = 'lowpass';
  lowSplit.frequency.value = SPLIT_CROSSOVER_HZ;
  highSplit.type = 'highpass';
  highSplit.frequency.value = SPLIT_CROSSOVER_HZ;
  cleanLow.gain.value = 0.8;
  highLevel.gain.value = Math.max(0.2, 1 - preset.subLevel * 0.25);
  drive.curve = createDriveCurve(preset.driveType, preset.drive, 2048);
  drive.oversample = '4x';

  filter.type = 'lowpass';
  filter.frequency.value = preset.cutoffHz;
  filter.Q.value = preset.resonance;
  amp.gain.value = 0.0001;

  lfo.type = preset.lfoShape === 'tri' ? 'triangle' : preset.lfoShape === 'saw' ? 'sawtooth' : preset.lfoShape;
  lfo.frequency.value = resolveLfoHz(preset, engineBpm);
  lfoDepth.gain.value = preset.cutoffHz * preset.lfoDepth;

  osc1.connect(mix);
  osc2.connect(mix);
  sub.connect(subGain);
  subGain.connect(mix);
  mix.connect(lowSplit);
  mix.connect(highSplit);
  lowSplit.connect(cleanLow);
  cleanLow.connect(filter);
  highSplit.connect(drive);
  drive.connect(highLevel);
  highLevel.connect(filter);
  lfo.connect(lfoDepth);
  lfoDepth.connect(filter.frequency);
  filter.connect(amp);
  amp.connect(destination);

  return {
    output: amp,
    start(time = context.currentTime) {
      const peak = 0.25;
      const ampTimes = resolveAdsrStageTimes(time, preset.attack, preset.decay, preset.release);
      const filterTimes = resolveAdsrStageTimes(time, preset.filterAttack, preset.filterDecay, preset.filterRelease);
      const baseCutoff = Math.max(60, preset.cutoffHz);
      const startCutoff = Math.max(60, baseCutoff * 0.35);
      const wowCutoff = Math.min(12000, baseCutoff * 2.35);
      const sustainCutoff = Math.max(60, baseCutoff * preset.filterSustain);
      amp.gain.cancelScheduledValues(time);
      amp.gain.setValueAtTime(0.0001, time);
      amp.gain.linearRampToValueAtTime(peak, ampTimes.attackEnd);
      amp.gain.linearRampToValueAtTime(peak * preset.sustain, ampTimes.decayEnd);
      filter.frequency.cancelScheduledValues(time);
      filter.frequency.setValueAtTime(startCutoff, time);
      filter.frequency.linearRampToValueAtTime(wowCutoff, filterTimes.attackEnd);
      filter.frequency.linearRampToValueAtTime(sustainCutoff, filterTimes.decayEnd);
      osc1.start(time);
      osc2.start(time);
      sub.start(time);
      lfo.start(time);
    },
    stop(time = context.currentTime) {
      const releaseEnd = time + preset.release;
      const filterReleaseEnd = time + preset.filterRelease;
      amp.gain.cancelScheduledValues(time);
      amp.gain.setValueAtTime(Math.max(0.0001, amp.gain.value), time);
      amp.gain.linearRampToValueAtTime(0.0001, releaseEnd);
      filter.frequency.cancelScheduledValues(time);
      filter.frequency.setValueAtTime(Math.max(60, filter.frequency.value), time);
      filter.frequency.linearRampToValueAtTime(Math.max(60, preset.cutoffHz * 0.3), filterReleaseEnd);
      for (const node of [osc1, osc2, sub, lfo]) {
        try {
          node.stop(Math.max(releaseEnd, filterReleaseEnd) + 0.03);
        } catch {
          // Already stopped.
        }
      }
    }
  };
}
