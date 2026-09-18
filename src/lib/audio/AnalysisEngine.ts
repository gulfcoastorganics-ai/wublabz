import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import wavefile from 'wavefile';
import { MPEGDecoder } from 'mpg123-decoder';
import type {
  AnalysisSnapshot,
  AudioDecodeResult,
  BeatBar,
  BeatGrid,
  KeyEstimate,
  SectionBoundary,
  SectionType,
  SilenceRegion,
  StemRole,
  WaveformPeak
} from '../producer/types.js';
import { clamp, roundTo } from '../producer/seeded-rng.js';
import { StorageManager } from '../persistence/StorageManager.js';
import type { AnalysisWorkerInput } from './analysis.worker.js';

const { WaveFile } = wavefile as unknown as { WaveFile: new (buffer?: Uint8Array) => WaveFileLike };

interface WaveFileLike {
  fmt: {
    sampleRate: number;
    numChannels: number;
  };
  getSamples(interleaved?: boolean): Float64Array | number[] | Float64Array[] | number[][];
}

export interface AudioIngestionSnapshot extends AnalysisSnapshot {
  sourcePath: string;
  fileSizeBytes: number;
  sha256: string;
  sampleCount: number;
  decodeFormat: 'mp3' | 'wav';
}

export interface AnalysisEngineOptions {
  useWorkers?: boolean;
  cacheRoot?: string;
}

export interface CacheStats {
  namespace: string;
  rootPath: string;
  fileCount: number;
  validFileCount: number;
  invalidFileCount: number;
  totalBytes: number;
}

interface CacheEnvelope<T> {
  version: 1;
  kind: string;
  createdAt: string;
  payload: T;
}

const SILENCE_RMS_THRESHOLD = 0.015;
const WAVEFORM_WINDOW = 1024;
const RMS_WINDOW = 2048;
const RMS_HOP = 1024;
const DEFAULT_BEATS_PER_BAR = 4;
const CHROMA_TEMPLATE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const CHROMA_TEMPLATE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SECTION_ORDER: SectionType[] = ['intro', 'build', 'fakeout', 'drop', 'breakdown', 'build_2', 'second_drop', 'outro'];

type WorkerPayload<TInput, TOutput> = {
  input: TInput;
  output?: TOutput;
  error?: string;
};

export class AnalysisEngine {
  constructor(private readonly options: AnalysisEngineOptions = {}) {}

  async analyzeFile(filePath: string): Promise<AudioIngestionSnapshot> {
    const bytes = new Uint8Array(await readFile(filePath));
    return this.analyzeBytes(bytes, filePath);
  }

  async analyzeBytes(bytes: Uint8Array, sourcePath: string): Promise<AudioIngestionSnapshot> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const analysisCache = new AnalysisCache(this.options.cacheRoot);
    const cached = await analysisCache.read<AudioIngestionSnapshot>(sha256);
    if (cached) {
      return cached;
    }

    const analysisWorkerPath = resolveWorkerPath('analysis.worker.js');
    if ((this.options.useWorkers ?? true) && analysisWorkerPath && existsSync(analysisWorkerPath)) {
      try {
        const workerResult = await runWorker<AnalysisWorkerInput, AudioIngestionSnapshot>(analysisWorkerPath, {
          bytes,
          sourcePath,
          ...(this.options.cacheRoot !== undefined ? { cacheRoot: this.options.cacheRoot } : {})
        });
        await analysisCache.write(sha256, workerResult);
        return workerResult;
      } catch {
        // fall through to inline analysis
      }
    }

    const decode = await decodeAudio(bytes, sourcePath, this.options.useWorkers ?? true);
    const monoSamples = mixToMono(decode.channelData);
    const waveformPeaks = await buildWaveform(sha256, decode, this.options);
    const rmsCurve = computeRmsCurve(monoSamples, decode.sampleRate, RMS_WINDOW, RMS_HOP);
    const energyCurve = computeEnergyCurve(rmsCurve);
    const silenceRegions = detectSilenceRegions(monoSamples, decode.sampleRate, rmsCurve, RMS_WINDOW, RMS_HOP);
    const dynamicRangeDb = computeDynamicRangeDb(rmsCurve);
    const transientDensity = computeTransientDensity(energyCurve, decode.sampleRate, RMS_HOP);
    const beatGrid = await new BeatDetectionEngine().detect(decode, energyCurve, transientDensity);
    const keyEstimate = await new KeyDetectionEngine().detect(decode);
    const sectionBoundaries = await new SectionDetectionEngine().detect({
      decode,
      energyCurve,
      transientDensity,
      beatGrid
    });
    const meanEnergy = average(energyCurve);
    const confidence = clamp(
      0.32 +
        (beatGrid.confidence ?? 0.5) * 0.28 +
        keyEstimate.confidence * 0.22 +
        clamp(transientDensity / 4, 0, 0.12) +
        clamp(meanEnergy, 0, 0.06),
      0.35,
      0.98
    );

    const snapshot: AudioIngestionSnapshot = {
      id: `analysis-${sha256.slice(0, 12)}`,
      sourcePath,
      sourceName: path.basename(sourcePath),
      fileSizeBytes: bytes.length,
      sha256,
      sampleCount: decode.samplesDecoded,
      decodeFormat: decode.format,
      durationSeconds: roundTo(decode.samplesDecoded / decode.sampleRate, 3),
      sampleRate: decode.sampleRate,
      channels: decode.channelData.length,
      bpm: beatGrid.bpm,
      bpmConfidence: beatGrid.confidence ?? 0.5,
      beatsPerBar: DEFAULT_BEATS_PER_BAR,
      key: `${keyEstimate.tonic} ${keyEstimate.scale}`,
      keyEstimate,
      camelot: keyEstimate.camelot,
      waveformPeaks,
      rmsCurve,
      energyCurve,
      silenceRegions,
      dynamicRangeDb,
      transientDensity,
      beatGrid,
      sectionBoundaries,
      analysisConfidence: roundTo(confidence, 1000),
      energy: clamp(meanEnergy, 0, 1),
      genre: inferGenreFromFeatures(keyEstimate, meanEnergy, transientDensity),
      confidence: roundTo(confidence, 1000),
      stemHints: inferStemHints(meanEnergy, transientDensity, keyEstimate)
    };

    await analysisCache.write(sha256, snapshot);
    return snapshot;
  }
}

export class BeatDetectionEngine {
  async detect(
    decode: AudioDecodeResult,
    energyCurve: number[],
    transientDensity: number
  ): Promise<BeatGrid> {
    const beatCandidates = analyzeTempoCandidates(energyCurve, decode.sampleRate, RMS_HOP);
    const bpm = beatCandidates[0]?.bpm ?? 120;
    const confidence = beatCandidates[0]?.confidence ?? 0.5;
    const beatDuration = 60 / bpm;
    const durationSeconds = decode.samplesDecoded / decode.sampleRate;
    const totalBeats = Math.max(1, Math.floor(durationSeconds / beatDuration));
    const bars: BeatBar[] = [];
    const downbeats: number[] = [];

    for (let barIndex = 0; barIndex < Math.ceil(totalBeats / DEFAULT_BEATS_PER_BAR); barIndex += 1) {
      const startBeat = barIndex * DEFAULT_BEATS_PER_BAR;
      const endBeat = startBeat + DEFAULT_BEATS_PER_BAR;
      bars.push({
        barIndex,
        startBeat,
        endBeat,
        startTime: roundTo(startBeat * beatDuration, 1000),
        endTime: roundTo(endBeat * beatDuration, 1000)
      });
      downbeats.push(startBeat);
    }

    return {
      bpm: roundTo(bpm, 1000),
      beatsPerBar: DEFAULT_BEATS_PER_BAR,
      bars,
      downbeats,
      confidence: roundTo(clamp(confidence + clamp(transientDensity / 8, 0, 0.15), 0.35, 0.99), 1000)
    };
  }
}

export class KeyDetectionEngine {
  async detect(decode: AudioDecodeResult): Promise<KeyEstimate> {
    const mono = mixToMono(decode.channelData);
    const chroma = computeChromaProfile(mono, decode.sampleRate);
    const candidates = scoreKeyCandidates(chroma);
    const best = candidates[0];

    if (!best) {
      return {
        tonic: 'C',
        scale: 'major',
        camelot: '8B',
        confidence: 0.2,
        profile: chroma
      };
    }

    return {
      tonic: NOTE_NAMES[best.tonicIndex] ?? 'C',
      scale: best.scale,
      camelot: best.camelot,
      confidence: roundTo(best.confidence, 1000),
      profile: chroma
    };
  }
}

export class SectionDetectionEngine {
  async detect(input: {
    decode: AudioDecodeResult;
    energyCurve: number[];
    transientDensity: number;
    beatGrid: BeatGrid;
  }): Promise<SectionBoundary[]> {
    const { decode, energyCurve, transientDensity, beatGrid } = input;
    const durationSeconds = decode.samplesDecoded / decode.sampleRate;
    const segments = SECTION_ORDER.length;
    const segmentLength = Math.max(1, Math.ceil(energyCurve.length / segments));
    const boundaries: SectionBoundary[] = [];
    const beatDuration = 60 / beatGrid.bpm;
    let cursor = 0;

    for (let index = 0; index < segments; index += 1) {
      const startIndex = cursor;
      const endIndex = index === segments - 1 ? energyCurve.length : Math.min(energyCurve.length, startIndex + segmentLength);
      cursor = endIndex;
      const slice = energyCurve.slice(startIndex, endIndex);
      const sectionEnergy = average(slice);
      const type = SECTION_ORDER[index] ?? 'outro';
      const startTime = (startIndex * RMS_HOP) / decode.sampleRate;
      const endTime = index === segments - 1 ? durationSeconds : Math.max(startTime + 0.05, (endIndex * RMS_HOP) / decode.sampleRate);
      const startBeat = startTime / beatDuration;
      const endBeat = Math.max(startBeat + 0.5, endTime / beatDuration);
      const startBar = startBeat / DEFAULT_BEATS_PER_BAR;
      const endBar = Math.max(startBar + 0.25, endBeat / DEFAULT_BEATS_PER_BAR);
      const transientDelta = computeTransientDelta(energyCurve, startIndex, endIndex);

      boundaries.push({
        id: `${type}-${index + 1}`,
        type,
        startTime: roundTo(startTime, 1000),
        endTime: roundTo(endTime, 1000),
        startBeat: roundTo(startBeat, 1000),
        endBeat: roundTo(endBeat, 1000),
        startBar: roundTo(startBar, 1000),
        endBar: roundTo(endBar, 1000),
        energy: roundTo(sectionEnergy, 1000),
        transientDelta: roundTo(transientDelta + transientDensity * 0.01, 1000)
      });
    }

    return normalizeSectionBoundaries(boundaries);
  }
}

export class AnalysisCache {
  private readonly rootPath: string;

  constructor(cacheRoot?: string) {
    const storage = new StorageManager();
    this.rootPath = cacheRoot ? path.join(cacheRoot, 'analysis') : path.dirname(storage.getCachePath('analysis', 'default'));
  }

  async read<T>(key: string): Promise<T | undefined> {
    const filePath = this.filePath(key);
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as CacheEnvelope<T>;
      if (!isValidCacheEnvelope(parsed, 'analysis')) {
        return undefined;
      }

      return parsed.payload;
    } catch {
      return undefined;
    }
  }

  async write<T>(key: string, value: T): Promise<string> {
    await mkdir(this.rootPath, { recursive: true });
    const filePath = this.filePath(key);
    const envelope: CacheEnvelope<T> = {
      version: 1,
      kind: 'analysis',
      createdAt: new Date().toISOString(),
      payload: value
    };
    await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    return filePath;
  }

  async cleanupCache(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    return cleanupCacheDirectory(this.rootPath, 'analysis', '.json', maxAgeMs);
  }

  async getCacheStats(): Promise<CacheStats> {
    return getCacheStatsForDirectory(this.rootPath, 'analysis', '.json');
  }

  private filePath(key: string): string {
    return path.join(this.rootPath, `${key}.json`);
  }
}

export class WaveformCache {
  private readonly rootPath: string;

  constructor(cacheRoot?: string) {
    const storage = new StorageManager();
    this.rootPath = cacheRoot ? path.join(cacheRoot, 'waveform') : path.dirname(storage.getCachePath('waveform', 'default'));
  }

  async read<T>(key: string): Promise<T | undefined> {
    const filePath = this.filePath(key);
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as CacheEnvelope<T>;
      if (!isValidCacheEnvelope(parsed, 'waveform')) {
        return undefined;
      }

      return parsed.payload;
    } catch {
      return undefined;
    }
  }

  async write<T>(key: string, value: T): Promise<string> {
    await mkdir(this.rootPath, { recursive: true });
    const filePath = this.filePath(key);
    const envelope: CacheEnvelope<T> = {
      version: 1,
      kind: 'waveform',
      createdAt: new Date().toISOString(),
      payload: value
    };
    await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    return filePath;
  }

  async cleanupCache(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    return cleanupCacheDirectory(this.rootPath, 'waveform', '.waveform.json', maxAgeMs);
  }

  async getCacheStats(): Promise<CacheStats> {
    return getCacheStatsForDirectory(this.rootPath, 'waveform', '.waveform.json');
  }

  private filePath(key: string): string {
    return path.join(this.rootPath, `${key}.waveform.json`);
  }
}

function isValidCacheEnvelope<T>(value: unknown, kind: string): value is CacheEnvelope<T> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const envelope = value as Partial<CacheEnvelope<T>>;
  return envelope.version === 1 && envelope.kind === kind && typeof envelope.createdAt === 'string' && 'payload' in envelope;
}

async function cleanupCacheDirectory(
  rootPath: string,
  kind: string,
  extension: string,
  maxAgeMs: number
): Promise<number> {
  let removed = 0;
  await mkdir(rootPath, { recursive: true });

  let entries: string[] = [];
  try {
    entries = await readdir(rootPath);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.endsWith(extension)) {
      continue;
    }

    const filePath = path.join(rootPath, entry);
    let keep = true;
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as CacheEnvelope<unknown>;
      if (!isValidCacheEnvelope(parsed, kind)) {
        keep = false;
      } else {
        const createdAt = Date.parse(parsed.createdAt);
        if (Number.isFinite(createdAt) && createdAt < cutoff) {
          keep = false;
        }
      }
    } catch {
      keep = false;
    }

    if (!keep) {
      await unlink(filePath).catch(() => undefined);
      removed += 1;
    }
  }

  return removed;
}

async function getCacheStatsForDirectory(
  rootPath: string,
  kind: string,
  extension: string
): Promise<CacheStats> {
  await mkdir(rootPath, { recursive: true });
  let entries: string[] = [];
  try {
    entries = await readdir(rootPath);
  } catch {
    entries = [];
  }

  let fileCount = 0;
  let validFileCount = 0;
  let invalidFileCount = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    if (!entry.endsWith(extension)) {
      continue;
    }

    fileCount += 1;
    const filePath = path.join(rootPath, entry);
    try {
      const fileStat = await stat(filePath);
      totalBytes += fileStat.size;
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as CacheEnvelope<unknown>;
      if (isValidCacheEnvelope(parsed, kind)) {
        validFileCount += 1;
      } else {
        invalidFileCount += 1;
      }
    } catch {
      invalidFileCount += 1;
    }
  }

  return {
    namespace: kind,
    rootPath,
    fileCount,
    validFileCount,
    invalidFileCount,
    totalBytes
  };
}

export async function decodeAudio(bytes: Uint8Array, sourcePath: string, useWorkers: boolean): Promise<AudioDecodeResult> {
  const workerPath = resolveWorkerPath('audioDecode.worker.js');
  if (useWorkers && workerPath && existsSync(workerPath)) {
    try {
      return await runWorker<{ bytes: Uint8Array; sourcePath: string }, AudioDecodeResult>(workerPath, {
        bytes,
        sourcePath
      });
    } catch {
      // fall through to inline decode
    }
  }

  return decodeAudioInline(bytes, sourcePath);
}

export function decodeAudioInline(bytes: Uint8Array, sourcePath: string): AudioDecodeResult {
  const format = detectFormat(bytes, sourcePath);
  if (format === 'wav') {
    const wav = new WaveFile(bytes);
    const channelData = extractWavefileChannels(wav);
    return {
      format,
      sampleRate: wav.fmt.sampleRate,
      channelData,
      samplesDecoded: channelData[0]?.length ?? 0
    };
  }

  const decoder = new MPEGDecoder();
  const decoded = decoder.decode(bytes);
  decoder.free();

  return {
    format,
    sampleRate: decoded.sampleRate,
    channelData: decoded.channelData.map((channel) => Float32Array.from(channel)),
    samplesDecoded: decoded.samplesDecoded
  };
}

export function computeWaveformPeaks(samples: Float32Array, sampleRate: number, windowSize: number): WaveformPeak[] {
  const peaks: WaveformPeak[] = [];
  const windows = Math.max(1, Math.ceil(samples.length / windowSize));

  for (let windowIndex = 0; windowIndex < windows; windowIndex += 1) {
    const start = windowIndex * windowSize;
    const end = Math.min(samples.length, start + windowSize);
    let min = 1;
    let max = -1;
    let sumSquares = 0;
    const count = Math.max(1, end - start);

    for (let index = start; index < end; index += 1) {
      const value = samples[index] ?? 0;
      min = Math.min(min, value);
      max = Math.max(max, value);
      sumSquares += value * value;
    }

    peaks.push({
      time: roundTo(start / sampleRate, 1000),
      min: roundTo(min, 1000),
      max: roundTo(max, 1000),
      rms: roundTo(Math.sqrt(sumSquares / count), 1000)
    });
  }

  return peaks;
}

export function computeRmsCurve(samples: Float32Array, sampleRate: number, windowSize: number, hopSize: number): number[] {
  void sampleRate;
  const rms: number[] = [];
  for (let start = 0; start < samples.length; start += hopSize) {
    const end = Math.min(samples.length, start + windowSize);
    let sumSquares = 0;
    const count = Math.max(1, end - start);
    for (let index = start; index < end; index += 1) {
      const value = samples[index] ?? 0;
      sumSquares += value * value;
    }
    rms.push(Math.sqrt(sumSquares / count));
  }
  return rms;
}

export function computeEnergyCurve(rmsCurve: number[]): number[] {
  return smoothCurve(normalizeCurve(rmsCurve));
}

function normalizeCurve(curve: number[]): number[] {
  const max = Math.max(...curve, 1e-9);
  return curve.map((value) => clamp(value / max, 0, 1));
}

function smoothCurve(curve: number[]): number[] {
  if (curve.length < 3) {
    return curve.slice();
  }

  return curve.map((value, index) => {
    const prev = curve[index - 1] ?? value;
    const next = curve[index + 1] ?? value;
    return roundTo((prev + value + next) / 3, 1000);
  });
}

export function detectSilenceRegions(
  samples: Float32Array,
  sampleRate: number,
  rmsCurve: number[],
  windowSize: number,
  hopSize: number
): SilenceRegion[] {
  const regions: SilenceRegion[] = [];
  let currentStart: number | undefined;

  rmsCurve.forEach((level, index) => {
    if (level < SILENCE_RMS_THRESHOLD) {
      if (currentStart === undefined) {
        currentStart = index;
      }
      return;
    }

    if (currentStart !== undefined) {
      const startSample = currentStart * hopSize;
      const endSample = index * hopSize + windowSize;
      regions.push({
        startTime: roundTo(startSample / sampleRate, 1000),
        endTime: roundTo(endSample / sampleRate, 1000),
        startSample,
        endSample
      });
      currentStart = undefined;
    }
  });

  if (currentStart !== undefined) {
    const startSample = currentStart * hopSize;
    const endSample = samples.length;
    regions.push({
      startTime: roundTo(startSample / sampleRate, 1000),
      endTime: roundTo(endSample / sampleRate, 1000),
      startSample,
      endSample
    });
  }

  return regions;
}

export function computeDynamicRangeDb(rmsCurve: number[]): number {
  const sorted = [...rmsCurve].sort((a, b) => a - b);
  const low = percentile(sorted, 0.1);
  const high = percentile(sorted, 0.9);
  return roundTo(20 * Math.log10(Math.max(high, 1e-6) / Math.max(low, 1e-6)), 1000);
}

export function computeTransientDensity(energyCurve: number[], sampleRate: number, hopSize: number): number {
  let transients = 0;
  for (let index = 2; index < energyCurve.length; index += 1) {
    const diff = energyCurve[index]! - energyCurve[index - 1]!;
    const prevDiff = energyCurve[index - 1]! - energyCurve[index - 2]!;
    if (diff > 0.08 && diff > prevDiff * 1.35) {
      transients += 1;
    }
  }

  const durationSeconds = (energyCurve.length * hopSize) / sampleRate;
  return durationSeconds > 0 ? roundTo(transients / durationSeconds, 1000) : 0;
}

export function mixToMono(channelData: Float32Array[]): Float32Array {
  const length = Math.max(...channelData.map((channel) => channel.length), 0);
  const mono = new Float32Array(length);
  if (!channelData.length) {
    return mono;
  }

  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of channelData) {
      sum += channel[index] ?? 0;
    }
    mono[index] = sum / channelData.length;
  }

  return mono;
}

async function buildWaveform(
  sha256: string,
  decode: AudioDecodeResult,
  options: AnalysisEngineOptions
): Promise<WaveformPeak[]> {
  const key = `${sha256}:waveform`;
  const cache = new WaveformCache(options.cacheRoot);
  const cached = await cache.read<WaveformPeak[]>(key);
  if (cached?.length) {
    return cached;
  }

  const workerPath = resolveWorkerPath('waveform.worker.js');
  if ((options.useWorkers ?? true) && workerPath && existsSync(workerPath)) {
    try {
      const waveform = await runWorker<{ channelData: Float32Array[]; sampleRate: number }, WaveformPeak[]>(
        workerPath,
        {
          channelData: decode.channelData,
          sampleRate: decode.sampleRate
        }
      );
      await cache.write(key, waveform);
      return waveform;
    } catch {
      // inline fallback
    }
  }

  const waveform = computeWaveformPeaks(mixToMono(decode.channelData), decode.sampleRate, WAVEFORM_WINDOW);
  await cache.write(key, waveform);
  return waveform;
}

function detectFormat(bytes: Uint8Array, sourcePath: string): 'mp3' | 'wav' {
  const extension = path.extname(sourcePath).toLowerCase();
  const isRiff =
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x41;

  if (extension === '.wav' || isRiff) {
    return 'wav';
  }

  return 'mp3';
}

function extractWavefileChannels(wav: WaveFileLike): Float32Array[] {
  const samples = wav.getSamples(true);
  const raw = flattenWaveSamples(samples);
  const channels = Math.max(1, wav.fmt.numChannels);
  const samplesPerChannel = Math.floor(raw.length / channels);
  const channelData = Array.from({ length: channels }, () => new Float32Array(samplesPerChannel));
  const maxAbs = raw.reduce((max, value) => Math.max(max, Math.abs(Number(value) || 0)), 0);
  const scale = maxAbs > 1.5 ? 32768 : 1;

  for (let index = 0; index < samplesPerChannel; index += 1) {
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      channelData[channelIndex]![index] = Number(raw[index * channels + channelIndex] ?? 0) / scale;
    }
  }

  return channelData;
}

function flattenWaveSamples(samples: Float64Array | number[] | Float64Array[] | number[][]): number[] {
  if (Array.isArray(samples)) {
    return (samples as unknown[]).flat(Infinity).map((value) => Number(value));
  }

  return Array.from(samples as ArrayLike<number>, (value) => Number(value));
}

function analyzeTempoCandidates(
  energyCurve: number[],
  sampleRate: number,
  hopSize: number
): Array<{ bpm: number; confidence: number }> {
  const onsetEnvelope = energyCurve.map((value, index) => {
    const prev = energyCurve[index - 1] ?? value;
    return Math.max(0, value - prev);
  });

  const scores: Array<{ bpm: number; score: number }> = [];
  for (let bpm = 70; bpm <= 175; bpm += 1) {
    const lag = Math.max(1, Math.round((60 / bpm) / (hopSize / sampleRate)));
    if (lag >= onsetEnvelope.length) {
      continue;
    }

    let score = 0;
    for (let index = lag; index < onsetEnvelope.length; index += 1) {
      score += onsetEnvelope[index]! * onsetEnvelope[index - lag]!;
    }
    scores.push({ bpm, score });
  }

  const ranked = scores.sort((left, right) => right.score - left.score).slice(0, 5);
  if (!ranked.length) {
    return [{ bpm: 120, confidence: 0.4 }];
  }

  const best = ranked[0]!;
  const second = ranked[1]?.score ?? best.score * 0.5;
  const confidence = clamp((best.score - second) / Math.max(best.score, 1e-6) + 0.55, 0.35, 0.98);

  return [{ bpm: best.bpm, confidence }, ...ranked.slice(1).map((candidate) => ({ bpm: candidate.bpm, confidence: 0.2 }))];
}

function computeChromaProfile(samples: Float32Array, sampleRate: number): number[] {
  const frameSize = 4096;
  const hopSize = 2048;
  const profile = new Array<number>(12).fill(0);

  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const frame = samples.slice(start, start + frameSize);
    for (let midi = 36; midi <= 84; midi += 1) {
      const frequency = midiToFrequency(midi);
      const magnitude = goertzelMagnitude(frame, sampleRate, frequency);
      profile[midi % 12]! += magnitude;
    }
  }

  const total = profile.reduce((sum, value) => sum + value, 0) || 1;
  return profile.map((value) => roundTo(value / total, 1000));
}

function scoreKeyCandidates(chroma: number[]): Array<{ tonicIndex: number; scale: 'major' | 'minor'; camelot: string; confidence: number }> {
  const candidates: Array<{ tonicIndex: number; scale: 'major' | 'minor'; camelot: string; confidence: number }> = [];
  for (let tonicIndex = 0; tonicIndex < 12; tonicIndex += 1) {
    const majorScore = templateScore(rotate(chroma, tonicIndex), CHROMA_TEMPLATE_MAJOR);
    const minorScore = templateScore(rotate(chroma, tonicIndex), CHROMA_TEMPLATE_MINOR);
    if (majorScore >= minorScore) {
      candidates.push({ tonicIndex, scale: 'major', camelot: CAMELOT_MAJOR[tonicIndex] ?? '8B', confidence: majorScore });
    } else {
      candidates.push({ tonicIndex, scale: 'minor', camelot: CAMELOT_MINOR[tonicIndex] ?? '8A', confidence: minorScore });
    }
  }

  return candidates.sort((left, right) => right.confidence - left.confidence);
}

function normalizeSectionBoundaries(boundaries: SectionBoundary[]): SectionBoundary[] {
  return boundaries.map((boundary, index) => ({
    ...boundary,
    startTime: index === 0 ? 0 : boundary.startTime,
    endTime: Math.max(boundary.endTime, boundary.startTime + 0.05)
  }));
}

function inferGenreFromFeatures(keyEstimate: KeyEstimate, meanEnergy: number, transientDensity: number): string {
  if (transientDensity > 4 && meanEnergy > 0.3) {
    return 'drum and bass';
  }
  if (keyEstimate.scale === 'minor' && meanEnergy > 0.4) {
    return 'melodic techno';
  }
  return 'electronic';
}

function inferStemHints(energy: number, transientDensity: number, keyEstimate: KeyEstimate): StemRole[] {
  const hints: StemRole[] = ['drums', 'bass', 'music', 'fx'];
  if (energy > 0.45) {
    hints.push('texture');
  }
  if (transientDensity > 3.5) {
    hints.push('perc');
  }
  if (keyEstimate.scale === 'minor') {
    hints.push('lead');
  }
  return hints;
}

function computeTransientDelta(curve: number[], startIndex: number, endIndex: number): number {
  if (endIndex <= startIndex + 1) {
    return 0;
  }

  let delta = 0;
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    delta += Math.max(0, curve[index]! - curve[index - 1]!);
  }

  return delta / Math.max(1, endIndex - startIndex);
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) {
    return 0;
  }

  const index = Math.min(values.length - 1, Math.max(0, Math.floor(values.length * quantile)));
  return values[index] ?? 0;
}

function goertzelMagnitude(samples: Float32Array, sampleRate: number, frequency: number): number {
  const normalizedFrequency = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(normalizedFrequency);
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;

  for (let index = 0; index < samples.length; index += 1) {
    q0 = coeff * q1 - q2 + (samples[index] ?? 0);
    q2 = q1;
    q1 = q0;
  }

  return Math.sqrt(q1 * q1 + q2 * q2 - coeff * q1 * q2);
}

function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function templateScore(profile: number[], template: number[]): number {
  let dot = 0;
  let profileEnergy = 0;
  let templateEnergy = 0;
  for (let index = 0; index < 12; index += 1) {
    const profileValue = profile[index] ?? 0;
    const templateValue = template[index] ?? 0;
    dot += profileValue * templateValue;
    profileEnergy += profileValue * profileValue;
    templateEnergy += templateValue * templateValue;
  }

  return dot / Math.sqrt(Math.max(profileEnergy * templateEnergy, 1e-9));
}

function rotate(values: number[], shift: number): number[] {
  return values.map((_, index) => values[(index - shift + values.length) % values.length] ?? 0);
}

function resolveWorkerPath(fileName: string): string | undefined {
  try {
    return fileURLToPath(new URL(`./${fileName}`, import.meta.url));
  } catch {
    return undefined;
  }
}

export async function runWorker<TInput, TOutput>(workerPath: string, input: TInput): Promise<TOutput> {
  return await new Promise<TOutput>((resolve, reject) => {
    const worker = new Worker(workerPath);
    const payload: WorkerPayload<TInput, TOutput> = { input };
    let settled = false;

    const finish = async (result: { output?: TOutput; error?: Error }): Promise<void> => {
      if (settled) return;
      settled = true;
      await worker.terminate().catch(() => undefined);
      if (result.error) {
        reject(result.error);
      } else if (result.output !== undefined) {
        resolve(result.output);
      } else {
        reject(new Error('Worker returned no output'));
      }
    };

    worker.once('message', (message: WorkerPayload<TInput, TOutput>) => {
      void finish(message.error ? { error: new Error(message.error) } : { output: message.output });
    });

    worker.once('error', (error) => {
      void finish({ error });
    });

    worker.once('exit', (code) => {
      if (!settled) {
        void finish({ error: new Error(`Worker exited before returning output (code ${code}).`) });
      }
    });

    worker.postMessage(payload);
  });
}
