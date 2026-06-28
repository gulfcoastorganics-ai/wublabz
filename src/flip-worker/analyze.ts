import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AcapellaStretchResult, AudioAnalysisResult } from './types.js';
import { spawnChecked } from './process.js';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'analyze_and_stretch.py');

export async function analyzeAndStretch(inputPath: string, vocalsPath: string, outputPath: string, timeoutMs: number): Promise<AudioAnalysisResult & AcapellaStretchResult> {
  const analysis = await analyzeOriginal(inputPath, timeoutMs);
  const stretch = await stretchAcapella(inputPath, vocalsPath, outputPath, analysis.bpm, timeoutMs);
  return { ...analysis, ...stretch };
}

export async function analyzeOriginal(inputPath: string, timeoutMs: number): Promise<AudioAnalysisResult> {
  const result = await spawnChecked('python3', [
    SCRIPT_PATH,
    '--mode',
    'analyze',
    '--input',
    inputPath
  ], { timeoutMs });
  const parsed = JSON.parse(result.stdout.trim()) as { key?: string; bpm?: number };
  if (!parsed.key || !parsed.bpm) {
    throw new Error(`Invalid analysis response: ${result.stdout}`);
  }
  return {
    key: parsed.key,
    bpm: parsed.bpm
  };
}

export async function stretchAcapella(inputPath: string, vocalsPath: string, outputPath: string, bpm: number, timeoutMs: number): Promise<AcapellaStretchResult> {
  const result = await spawnChecked('python3', [
    SCRIPT_PATH,
    '--mode',
    'stretch',
    '--input',
    inputPath,
    '--vocals',
    vocalsPath,
    '--output',
    outputPath,
    '--bpm',
    String(bpm)
  ], { timeoutMs });
  const parsed = JSON.parse(result.stdout.trim()) as { acapellaPath?: string };
  if (!parsed.acapellaPath) {
    throw new Error(`Invalid stretch response: ${result.stdout}`);
  }
  return {
    acapellaPath: parsed.acapellaPath
  };
}
