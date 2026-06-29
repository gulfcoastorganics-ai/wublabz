import React, { useMemo, useRef, useState } from 'react';
import { decodeProducerAudio, toChannelBuffer } from '../lib/audio/ProducerAudioEngine';
import { renderBufferToWav } from '../lib/export/AudioRenderExport';
import { HttpFlipPrepClient, OfflineFlipPrepClient, resolveFlipPrepAssetUrl, type FlipPrepJob } from '../lib/producer-tools/flipPrepApi';
import { clampFlipPrepClipSelection, estimateFlipPrepTotalSeconds, trimChannelBuffer } from '../lib/producer-tools/flipPrepClip';
import type { ChannelBuffer } from '../lib/producer-tools/mangler';
import { getFlipPrepApiUrl, getFlipPrepMaxClipSeconds } from '../wubpad-integration/env';
import { ActionButton, StatusMessage, styles, toArrayBuffer, ToolPanel } from './SampleManglerView';

const STEP_LABELS: Record<string, string> = {
  'separating-stems': 'Separating vocals and accompaniment',
  'detecting-key-bpm': 'Detecting key and BPM',
  'stretching-acapella': 'Stretching acapella to 140 half-time'
};

export function FlipPrepView() {
  const [job, setJob] = useState<FlipPrepJob | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loadingAction, setLoadingAction] = useState<'load' | 'submit' | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [sourceBuffer, setSourceBuffer] = useState<ChannelBuffer | null>(null);
  const [sourceDurationSeconds, setSourceDurationSeconds] = useState(0);
  const [clipStartSeconds, setClipStartSeconds] = useState(0);
  const [clipDurationSeconds, setClipDurationSeconds] = useState(60);
  const [lastSubmittedName, setLastSubmittedName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const maxClipSeconds = useMemo(() => getFlipPrepMaxClipSeconds(), []);
  const client = useMemo(() => {
    const offline = (import.meta as any).env?.VITE_FLIP_PREP_OFFLINE === 'true';
    const baseUrl = getFlipPrepApiUrl();
    return offline ? new OfflineFlipPrepClient() : new HttpFlipPrepClient(baseUrl);
  }, []);
  const clipSelection = clampFlipPrepClipSelection(sourceDurationSeconds, clipStartSeconds, clipDurationSeconds, maxClipSeconds);
  const busy = loadingAction !== null;
  const progressEstimate = job ? createProgressEstimate(job, clipSelection.durationSeconds) : null;
  const vocalsStem = job?.result?.stems.find((stem) => stem.name === 'vocals');
  const accompanimentStem = job?.result?.stems.find((stem) => stem.name === 'other');

  async function load(file?: File) {
    if (!file) return;
    setError('');
    setSuccess('');
    setJob(null);
    setLoadingAction('load');
    try {
      const decoded = await decodeProducerAudio(await file.arrayBuffer());
      const buffer = toChannelBuffer(decoded);
      const duration = (buffer.channels[0]?.length ?? 0) / buffer.sampleRate;
      const initialSelection = clampFlipPrepClipSelection(duration, 0, Math.min(duration, maxClipSeconds), maxClipSeconds);
      setSelectedFile(file);
      setSourceBuffer(buffer);
      setSourceDurationSeconds(duration);
      setClipStartSeconds(initialSelection.startSeconds);
      setClipDurationSeconds(initialSelection.durationSeconds);
      setSuccess(`Loaded ${file.name}. Choose a section up to ${formatSeconds(maxClipSeconds)} before starting Flip Prep.`);
    } catch (err) {
      setSelectedFile(null);
      setSourceBuffer(null);
      setSourceDurationSeconds(0);
      setError(err instanceof Error ? err.message : 'Audio load failed');
    } finally {
      setLoadingAction(null);
    }
  }

  async function submitClip() {
    if (!selectedFile || !sourceBuffer) return;
    setError('');
    setSuccess('');
    setLoadingAction('submit');
    try {
      const selection = clampFlipPrepClipSelection(sourceDurationSeconds, clipStartSeconds, clipDurationSeconds, maxClipSeconds);
      const clipBuffer = trimChannelBuffer(sourceBuffer, selection.startSeconds, selection.durationSeconds);
      const baseName = selectedFile.name.replace(/\.[^.]+$/, '') || 'flip-prep';
      const wav = renderBufferToWav(`${baseName}-flip-prep-${Math.round(selection.startSeconds)}s-${Math.round(selection.durationSeconds)}s.wav`, clipBuffer);
      const clippedBlob = new Blob([toArrayBuffer(wav.bytes)], { type: wav.mimeType });
      const clippedFile = typeof File !== 'undefined' ? new File([clippedBlob], wav.fileName, { type: wav.mimeType }) : clippedBlob;
      setLastSubmittedName(wav.fileName);
      setClipStartSeconds(selection.startSeconds);
      setClipDurationSeconds(selection.durationSeconds);

      let current = await client.createJob(clippedFile);
      setJob(current);
      while (current.status === 'queued' || current.status === 'processing') {
        await new Promise((resolve) => setTimeout(resolve, 900));
        current = await client.getJob(current.jobId);
        setJob(current);
      }
      if (current.status === 'done') setSuccess('Flip Prep complete. Previews and downloads are ready.');
      if (current.status === 'error') setError(formatFlipPrepUiError(current.error ?? 'Flip Prep failed', client.baseUrl));
    } catch (err) {
      setError(formatFlipPrepUiError(err, client.baseUrl));
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <ToolPanel title="Flip Prep" tone="#ff5cc8">
      <div style={styles.dropZone}>
        <input ref={fileInputRef} type="file" accept="audio/*" disabled={busy} onChange={(event) => void load(event.target.files?.[0])} style={{ display: 'none' }} />
        <div style={{ padding: '1rem' }}>
          <strong>{loadingAction === 'load' ? 'Reading audio...' : selectedFile ? selectedFile.name : 'Upload a song'}</strong>
          <p style={{ color: '#bbb', lineHeight: 1.5 }}>Pick a short section before separation. Long files are clipped before upload so CPU runs avoid the timeout path.</p>
          <p style={{ color: '#ffb8df', lineHeight: 1.5 }}>You are responsible for rights to uploaded audio.</p>
          <ActionButton variant="primary" loading={loadingAction === 'load'} style={{ marginTop: '0.75rem' }} onClick={() => fileInputRef.current?.click()}>Choose Audio</ActionButton>
        </div>
      </div>
      {sourceBuffer && (
        <div style={styles.grid}>
          <NumberRange
            label="START TIME"
            value={clipSelection.startSeconds}
            min={0}
            max={Math.max(0, sourceDurationSeconds - 1)}
            step={0.5}
            display={formatSeconds(clipSelection.startSeconds)}
            onChange={setClipStartSeconds}
          />
          <NumberRange
            label="DURATION"
            value={clipSelection.durationSeconds}
            min={1}
            max={Math.min(maxClipSeconds, Math.max(1, sourceDurationSeconds - clipSelection.startSeconds))}
            step={0.5}
            display={`${formatSeconds(clipSelection.durationSeconds)} / max ${formatSeconds(maxClipSeconds)}`}
            onChange={setClipDurationSeconds}
          />
          <div style={styles.control}>
            <span>SOURCE</span>
            <strong>{formatSeconds(sourceDurationSeconds)}</strong>
            <span>{clipSelection.wasAutoTrimmed ? `Auto-trimming to ${formatSeconds(clipSelection.durationSeconds)} before upload.` : 'Selected range is within the CPU-safe limit.'}</span>
          </div>
        </div>
      )}
      <div style={styles.actions}>
        <ActionButton variant="primary" disabled={!sourceBuffer} loading={loadingAction === 'submit'} onClick={() => void submitClip()}>Start Flip Prep</ActionButton>
        {(error || job?.status === 'error') && (
          <ActionButton disabled={!sourceBuffer || busy} onClick={() => void submitClip()}>Retry Section</ActionButton>
        )}
      </div>
      {lastSubmittedName && <StatusMessage tone="info">Submitted clipped audio: {lastSubmittedName}</StatusMessage>}
      {job && (
        <div style={{ ...styles.control, marginTop: '1rem' }}>
          <strong>{job.progressInfo?.phaseLabel ?? STEP_LABELS[job.step] ?? job.step}</strong>
          <span>
            {progressEstimate
              ? `Elapsed ${formatSeconds(progressEstimate.elapsedSeconds)} · Estimate ${progressEstimate.remainingSeconds > 0 ? `${formatSeconds(progressEstimate.remainingSeconds)} remaining` : 'finishing now'}`
              : 'Preparing job'}
          </span>
          {job.progressInfo && <span>Phase time {formatSeconds(job.progressInfo.phaseElapsedSeconds)}</span>}
          {job.progressInfo?.detail && <span>{job.progressInfo.detail}</span>}
          <progress value={job.progress} max={1} style={{ width: '100%' }} />
          <span>{job.status.toUpperCase()}</span>
        </div>
      )}
      {job?.result && (
        <>
          <div style={styles.grid}>
            <div style={styles.control}>KEY <strong>{job.result.key}</strong></div>
            <div style={styles.control}>BPM <strong>{job.result.bpm}</strong></div>
            {vocalsStem && <StemPreview label="Vocals stem" url={resolveFlipPrepAssetUrl(client.baseUrl, vocalsStem.url)} />}
            <StemPreview label="Acapella 140" url={resolveFlipPrepAssetUrl(client.baseUrl, job.result.acapella140Url)} />
            {accompanimentStem && <StemPreview label="Accompaniment stem" url={resolveFlipPrepAssetUrl(client.baseUrl, accompanimentStem.url)} />}
          </div>
          <div style={styles.grid}>
            {job.result.stems.map((stem) => (
              <a key={stem.name} href={resolveFlipPrepAssetUrl(client.baseUrl, stem.url)} style={styles.button}>Download {stem.name}</a>
            ))}
            <a href={resolveFlipPrepAssetUrl(client.baseUrl, job.result.acapella140Url)} style={styles.primaryButton}>Download acapella 140</a>
          </div>
        </>
      )}
      {success && <StatusMessage tone="success">{success}</StatusMessage>}
      {(error || job?.error) && <StatusMessage tone="error">{error || job?.error}</StatusMessage>}
    </ToolPanel>
  );
}

function formatSeconds(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  if (safeSeconds >= 60) {
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = Math.floor(safeSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${remainder}`;
  }
  return `${Math.max(0, Math.floor(safeSeconds))}s`;
}

function formatFlipPrepUiError(error: unknown, baseUrl: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Flip Prep failed';
  if (message.includes('Flip Prep worker is not reachable')) {
    return `Flip Prep is not reachable through the WubLabz API at ${baseUrl}. Confirm the WubLabz server is running and proxying Flip Prep.`;
  }
  if (/timeout|timed out/i.test(message)) {
    return `${message} Shorten the selected section, then retry.`;
  }
  return message;
}

function createProgressEstimate(job: FlipPrepJob, clipDurationSeconds: number): { elapsedSeconds: number; remainingSeconds: number } {
  const elapsedSeconds = job.progressInfo?.elapsedSeconds ?? 0;
  if (job.status === 'done') return { elapsedSeconds, remainingSeconds: 0 };
  const estimatedTotalSeconds = estimateFlipPrepTotalSeconds(clipDurationSeconds);
  return { elapsedSeconds, remainingSeconds: Math.max(0, estimatedTotalSeconds - elapsedSeconds) };
}

function NumberRange({ label, value, min, max, step, display, onChange }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (value: number) => void }) {
  return (
    <label style={styles.control}>
      <span>{label}</span>
      <strong>{display}</strong>
      <input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
      <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} style={styles.input} />
    </label>
  );
}

function StemPreview({ label, url }: { label: string; url: string }) {
  return (
    <div style={styles.control}>
      <span>{label.toUpperCase()}</span>
      <audio controls preload="metadata" src={url} style={{ width: '100%' }} />
    </div>
  );
}
