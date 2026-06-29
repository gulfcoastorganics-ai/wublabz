import { createDriveCurve, driveMakeupGain, resolveAdsrStageTimes, resolveDubstepSubFrequency, resolveLfoHz, SPLIT_CROSSOVER_HZ, type GrowlPreset, type LfoShape } from '../producer-tools/synth.js';

export interface GrowlVoice {
  start: (time?: number) => void;
  stop: (time?: number, releaseSeconds?: number) => void;
  updatePreset: (preset: GrowlPreset, engineBpm?: number, time?: number) => void;
  glideTo: (frequencyHz: number, time?: number, glideSeconds?: number) => void;
  output: any;
}

export function createGrowlVoice(
  context: any,
  preset: GrowlPreset,
  frequencyHz: number,
  destination: any,
  engineBpm?: number,
  options: { startFrequencyHz?: number } = {}
): GrowlVoice {
  const unisonVoices = clamp(Math.round(preset.unisonVoices ?? 1), 1, 4);
  const detuneSpreadCents = Math.max(0, preset.detuneSpreadCents ?? 0);
  const oscillators: any[] = [];
  let targetFrequencyHz = frequencyHz;
  let currentFrequencyHz = options.startFrequencyHz ?? frequencyHz;
  const sub = context.createOscillator();
  const carrierMix = context.createGain();
  const subGain = context.createGain();
  const subLowpass = context.createBiquadFilter();
  const lowSplit = context.createBiquadFilter();
  const highSplit = context.createBiquadFilter();
  const cleanLow = context.createGain();
  const bodyBand = context.createBiquadFilter();
  const bodyLevel = context.createGain();
  const driveInput = context.createGain();
  const highLevel = context.createGain();
  const drive = context.createWaveShaper();
  const driveMakeup = context.createGain();
  const filter = context.createBiquadFilter();
  const formant = context.createBiquadFilter();
  const postFilter = context.createGain();
  const amp = context.createGain();
  const lfo = context.createOscillator();
  const lfoDepth = context.createGain();
  const secondLfo = context.createOscillator();
  const secondLfoDepth = context.createGain();

  for (let voice = 0; voice < unisonVoices; voice++) {
    const position = unisonVoices === 1 ? 0 : (voice / (unisonVoices - 1)) * 2 - 1;
    const voiceGain = context.createGain();
    const osc1 = context.createOscillator();
    const osc2 = context.createOscillator();
    osc1.type = preset.osc1;
    osc2.type = preset.osc2;
    osc1.frequency.value = currentFrequencyHz;
    osc2.frequency.value = currentFrequencyHz;
    osc1.detune.value = position * detuneSpreadCents * 0.5;
    osc2.detune.value = (preset.detuneCents ?? 0) - position * detuneSpreadCents * 0.5;
    voiceGain.gain.value = 0.56 / Math.sqrt(unisonVoices);
    osc1.connect(voiceGain);
    osc2.connect(voiceGain);
    if (typeof context.createStereoPanner === 'function' && unisonVoices > 1) {
      const panner = context.createStereoPanner();
      panner.pan.value = position * 0.16;
      voiceGain.connect(panner);
      panner.connect(carrierMix);
    } else {
      voiceGain.connect(carrierMix);
    }
    oscillators.push(osc1, osc2);
  }

  sub.type = 'sine';
  const subFrequency = resolveDubstepSubFrequency(currentFrequencyHz);
  sub.frequency.value = subFrequency;

  carrierMix.gain.value = 0.96;
  subGain.gain.value = clamp(preset.subLevel ?? 0.85, 0, 1) * 1.08;
  subLowpass.type = 'lowpass';
  subLowpass.frequency.value = clamp(subFrequency * 2.15, 86, 145);
  subLowpass.Q.value = 0.7;
  lowSplit.type = 'lowpass';
  lowSplit.frequency.value = SPLIT_CROSSOVER_HZ;
  highSplit.type = 'highpass';
  highSplit.frequency.value = SPLIT_CROSSOVER_HZ;
  cleanLow.gain.value = 1.08;
  bodyBand.type = 'peaking';
  bodyBand.frequency.value = clamp(frequencyHz * 2, 115, 260);
  bodyBand.Q.value = 0.85;
  bodyBand.gain.value = 4.5;
  bodyLevel.gain.value = 0.48;
  driveInput.gain.value = 0.88;
  highLevel.gain.value = Math.max(0.42, 1 - (preset.subLevel ?? 0.85) * 0.12);
  drive.curve = createDriveCurve(preset.driveType, preset.drive, 2048);
  drive.oversample = '4x';
  driveMakeup.gain.value = Math.max(0.58, driveMakeupGain(preset.driveType, preset.drive));

  filter.type = 'lowpass';
  filter.frequency.value = resolveTrackedCutoff(preset, frequencyHz);
  filter.Q.value = clamp(preset.resonance ?? 10, 0.5, 14);
  formant.type = 'bandpass';
  formant.frequency.value = Math.min(5200, Math.max(180, resolveTrackedCutoff(preset, frequencyHz) * 2.65));
  formant.Q.value = 3.5;
  postFilter.gain.value = 0.58;
  amp.gain.value = 0.0001;

  lfo.type = toOscillatorLfoType(preset.lfoShape);
  lfo.frequency.value = resolveLfoHz(preset, engineBpm);
  lfoDepth.gain.value = resolveTrackedCutoff(preset, frequencyHz) * (preset.lfoDepth ?? 0);
  secondLfo.type = preset.lfoShape === 'talk' ? 'square' : 'triangle';
  secondLfo.frequency.value = Math.max(0.01, preset.secondLfoHz ?? 0.35);
  secondLfoDepth.gain.value = resolveTrackedCutoff(preset, frequencyHz) * resolveSecondLfoDepth(preset);

  sub.connect(subGain);
  subGain.connect(subLowpass);
  subLowpass.connect(amp);
  carrierMix.connect(lowSplit);
  carrierMix.connect(highSplit);
  carrierMix.connect(bodyBand);
  lowSplit.connect(cleanLow);
  cleanLow.connect(filter);
  bodyBand.connect(bodyLevel);
  bodyLevel.connect(filter);
  highSplit.connect(driveInput);
  driveInput.connect(drive);
  drive.connect(driveMakeup);
  driveMakeup.connect(highLevel);
  highLevel.connect(filter);
  lfo.connect(lfoDepth);
  lfoDepth.connect(filter.frequency);
  secondLfo.connect(secondLfoDepth);
  secondLfoDepth.connect(formant.frequency);
  filter.connect(amp);
  filter.connect(formant);
  formant.connect(postFilter);
  postFilter.connect(amp);
  amp.connect(destination);

  const applyLivePreset = (nextPreset: GrowlPreset, nextEngineBpm?: number, time = context.currentTime) => {
    const trackedCutoff = resolveTrackedCutoff(nextPreset, targetFrequencyHz);
    const safeTime = Math.max(0, time);
    lfo.type = toOscillatorLfoType(nextPreset.lfoShape);
    secondLfo.type = nextPreset.lfoShape === 'talk' ? 'square' : 'triangle';
    setTarget(lfo.frequency, resolveLfoHz(nextPreset, nextEngineBpm), safeTime, 0.015);
    setTarget(lfoDepth.gain, trackedCutoff * (nextPreset.lfoDepth ?? 0), safeTime, 0.015);
    setTarget(secondLfo.frequency, Math.max(0.01, nextPreset.secondLfoHz ?? 0.35), safeTime, 0.02);
    setTarget(secondLfoDepth.gain, trackedCutoff * resolveSecondLfoDepth(nextPreset), safeTime, 0.02);
    setTarget(filter.Q, clamp(nextPreset.resonance ?? 10, 0.5, 14), safeTime, 0.02);
    setTarget(filter.frequency, Math.max(60, trackedCutoff * (nextPreset.filterSustain ?? 0.35)), safeTime, 0.04);
    setTarget(formant.frequency, Math.min(5200, Math.max(180, trackedCutoff * 2.65)), safeTime, 0.03);
    setTarget(bodyBand.frequency, clamp(targetFrequencyHz * 2, 115, 260), safeTime, 0.03);
    setTarget(bodyLevel.gain, 0.48, safeTime, 0.03);
    setTarget(subGain.gain, clamp(nextPreset.subLevel ?? 0.85, 0, 1) * 1.08, safeTime, 0.02);
    setTarget(highLevel.gain, Math.max(0.42, 1 - (nextPreset.subLevel ?? 0.85) * 0.12), safeTime, 0.02);
    drive.curve = createDriveCurve(nextPreset.driveType, nextPreset.drive, 2048);
    setTarget(driveMakeup.gain, Math.max(0.58, driveMakeupGain(nextPreset.driveType, nextPreset.drive)), safeTime, 0.02);
  };

  return {
    output: amp,
    updatePreset: applyLivePreset,
    start(time = context.currentTime) {
      const peak = 0.31;
      const ampTimes = resolveAdsrStageTimes(time, preset.attack, preset.decay, preset.release);
      const filterTimes = resolveAdsrStageTimes(time, preset.filterAttack, preset.filterDecay, preset.filterRelease);
      const baseCutoff = resolveTrackedCutoff(preset, targetFrequencyHz);
      const envelopeAmount = clamp(preset.filterEnvelopeAmount ?? 0.78, 0, 1);
      const startCutoff = Math.max(60, baseCutoff * (0.38 + envelopeAmount * 0.12));
      const wowCutoff = Math.min(12000, baseCutoff * (1.2 + envelopeAmount * 1.55));
      const sustainCutoff = Math.max(60, baseCutoff * preset.filterSustain);
      const formantAmount = clamp(preset.formantAmount ?? 0, 0, 1);
      amp.gain.cancelScheduledValues(time);
      amp.gain.setValueAtTime(0.0001, time);
      amp.gain.linearRampToValueAtTime(peak, ampTimes.attackEnd);
      amp.gain.linearRampToValueAtTime(peak * preset.sustain, ampTimes.decayEnd);
      filter.frequency.cancelScheduledValues(time);
      filter.frequency.setValueAtTime(startCutoff, time);
      filter.frequency.linearRampToValueAtTime(wowCutoff, filterTimes.attackEnd);
      filter.frequency.linearRampToValueAtTime(sustainCutoff, filterTimes.decayEnd);
      formant.frequency.cancelScheduledValues(time);
      formant.frequency.setValueAtTime(Math.max(180, startCutoff * (1.8 + formantAmount)), time);
      formant.frequency.linearRampToValueAtTime(Math.min(5200, wowCutoff * (1.45 + formantAmount)), filterTimes.attackEnd);
      formant.frequency.linearRampToValueAtTime(Math.min(4200, sustainCutoff * (2.1 + formantAmount)), filterTimes.decayEnd);
      postFilter.gain.cancelScheduledValues(time);
      postFilter.gain.setValueAtTime(0.15 + formantAmount * 0.45, time);
      for (const node of oscillators) {
        node.start(time);
      }
      sub.start(time);
      lfo.start(time);
      secondLfo.start(time);
      if (currentFrequencyHz !== targetFrequencyHz) {
        glideToFrequency(targetFrequencyHz, time, preset.glideSeconds ?? 0);
      }
    },
    stop(time = context.currentTime, releaseSeconds?: number) {
      const ampRelease = releaseSeconds ?? preset.release;
      const filterRelease = releaseSeconds ?? preset.filterRelease;
      const releaseEnd = time + ampRelease;
      const filterReleaseEnd = time + filterRelease;
      const baseCutoff = resolveTrackedCutoff(preset, targetFrequencyHz);
      amp.gain.cancelScheduledValues(time);
      amp.gain.setValueAtTime(Math.max(0.0001, amp.gain.value), time);
      amp.gain.linearRampToValueAtTime(0.0001, releaseEnd);
      filter.frequency.cancelScheduledValues(time);
      filter.frequency.setValueAtTime(Math.max(60, filter.frequency.value), time);
      filter.frequency.linearRampToValueAtTime(Math.max(60, baseCutoff * 0.3), filterReleaseEnd);
      for (const node of [...oscillators, sub, lfo, secondLfo]) {
        try {
          node.stop(Math.max(releaseEnd, filterReleaseEnd) + 0.03);
        } catch {
          // Already stopped.
        }
      }
    },
    glideTo: glideToFrequency
  };

  function glideToFrequency(nextFrequencyHz: number, time = context.currentTime, glideSeconds = preset.glideSeconds ?? 0): void {
    targetFrequencyHz = Math.max(1, nextFrequencyHz);
    const safeTime = Math.max(0, time);
    const endTime = safeTime + Math.max(0, glideSeconds);
    for (const node of oscillators) {
      setRamp(node.frequency, currentFrequencyHz, targetFrequencyHz, safeTime, endTime);
    }
    const nextSubFrequency = resolveDubstepSubFrequency(targetFrequencyHz);
    setRamp(sub.frequency, resolveDubstepSubFrequency(currentFrequencyHz), nextSubFrequency, safeTime, endTime);
    setTarget(subLowpass.frequency, clamp(nextSubFrequency * 2.15, 86, 145), safeTime, Math.max(0.015, glideSeconds * 0.4));
    setTarget(bodyBand.frequency, clamp(targetFrequencyHz * 2, 115, 260), safeTime, Math.max(0.015, glideSeconds * 0.4));
    currentFrequencyHz = targetFrequencyHz;
  }
}

function resolveTrackedCutoff(preset: GrowlPreset, frequencyHz: number): number {
  const baseCutoff = Math.max(60, preset.cutoffHz ?? 520);
  const keyTrack = clamp(preset.keyTrack ?? 0, 0, 1);
  const ratio = Math.max(0.25, frequencyHz / 55);
  return Math.min(12000, baseCutoff * Math.pow(ratio, keyTrack));
}

function toOscillatorLfoType(shape: LfoShape): 'sine' | 'triangle' | 'square' | 'sawtooth' {
  if (shape === 'tri') return 'triangle';
  if (shape === 'pulse') return 'square';
  if (shape === 'talk') return 'sawtooth';
  if (shape === 'saw' || shape === 'ramp') return 'sawtooth';
  return shape;
}

function resolveSecondLfoDepth(preset: GrowlPreset): number {
  const base = preset.secondLfoDepth ?? 0;
  return preset.lfoShape === 'talk' ? Math.max(base, 0.28) : base;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function setTarget(param: any, value: number, time: number, constant: number): void {
  if (typeof param?.setTargetAtTime === 'function') {
    param.setTargetAtTime(value, time, constant);
    return;
  }
  if (param && 'value' in param) {
    param.value = value;
  }
}

function setRamp(param: any, fromValue: number, toValue: number, startTime: number, endTime: number): void {
  if (typeof param?.cancelScheduledValues === 'function') {
    param.cancelScheduledValues(startTime);
  }
  if (typeof param?.setValueAtTime === 'function') {
    param.setValueAtTime(fromValue, startTime);
  } else if (param && 'value' in param) {
    param.value = fromValue;
  }
  if (endTime > startTime && typeof param?.linearRampToValueAtTime === 'function') {
    param.linearRampToValueAtTime(toValue, endTime);
  } else if (param && 'value' in param) {
    param.value = toValue;
  }
}
