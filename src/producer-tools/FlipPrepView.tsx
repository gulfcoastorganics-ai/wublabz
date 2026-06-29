import React, { useMemo, useState } from 'react';
import { HttpFlipPrepClient, OfflineFlipPrepClient, resolveFlipPrepAssetUrl, type FlipPrepJob } from '../lib/producer-tools/flipPrepApi';
import { getWubLabzHttpUrl } from '../wubpad-integration/env';
import { styles, ToolPanel } from './SampleManglerView';

const STEP_LABELS: Record<string, string> = {
  'separating-stems': 'Separating drums, bass, vocals, and other',
  'detecting-key-bpm': 'Detecting key and BPM',
  'stretching-acapella': 'Stretching acapella to 140 half-time'
};

export function FlipPrepView() {
  const [job, setJob] = useState<FlipPrepJob | null>(null);
  const [error, setError] = useState('');
  const client = useMemo(() => {
    const offline = (import.meta as any).env?.VITE_FLIP_PREP_OFFLINE === 'true';
    const baseUrl = (import.meta as any).env?.VITE_FLIP_PREP_API_URL ?? getWubLabzHttpUrl();
    return offline ? new OfflineFlipPrepClient() : new HttpFlipPrepClient(baseUrl);
  }, []);

  async function upload(file?: File) {
    if (!file) return;
    setError('');
    try {
      let current = await client.createJob(file);
      setJob(current);
      while (current.status === 'queued' || current.status === 'processing') {
        await new Promise((resolve) => setTimeout(resolve, 900));
        current = await client.getJob(current.jobId);
        setJob(current);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Flip Prep failed');
    }
  }

  return (
    <ToolPanel title="Flip Prep" tone="#ff5cc8">
      <label style={styles.dropZone}>
        <input type="file" accept="audio/*" onChange={(event) => void upload(event.target.files?.[0])} style={{ display: 'none' }} />
        <div style={{ padding: '1rem' }}>
          <strong>Upload a song</strong>
          <p style={{ color: '#bbb', lineHeight: 1.5 }}>Server-side Flip Prep returns drums, bass, vocals, other, detected key/BPM, and a 140 half-time acapella.</p>
          <p style={{ color: '#ffb8df', lineHeight: 1.5 }}>You are responsible for rights to uploaded audio.</p>
        </div>
      </label>
      {job && (
        <div style={{ ...styles.control, marginTop: '1rem' }}>
          <strong>{job.progressInfo?.phaseLabel ?? STEP_LABELS[job.step] ?? job.step}</strong>
          <span>{job.progressInfo ? `Elapsed ${formatSeconds(job.progressInfo.elapsedSeconds)} · Phase ${formatSeconds(job.progressInfo.phaseElapsedSeconds)}` : 'Preparing job'}</span>
          {job.progressInfo?.detail && <span>{job.progressInfo.detail}</span>}
          <progress value={job.progress} max={1} style={{ width: '100%' }} />
          <span>{job.status.toUpperCase()}</span>
        </div>
      )}
      {job?.result && (
        <div style={styles.grid}>
          <div style={styles.control}>KEY <strong>{job.result.key}</strong></div>
          <div style={styles.control}>BPM <strong>{job.result.bpm}</strong></div>
          {job.result.stems.map((stem) => (
            <a key={stem.name} href={resolveFlipPrepAssetUrl(client.baseUrl, stem.url)} style={styles.button}>Download {stem.name}</a>
          ))}
          <a href={resolveFlipPrepAssetUrl(client.baseUrl, job.result.acapella140Url)} style={styles.primaryButton}>Download acapella 140</a>
        </div>
      )}
      {(error || job?.error) && <p style={{ color: '#ff8c8c' }}>{error || job?.error}</p>}
    </ToolPanel>
  );
}

function formatSeconds(seconds: number): string {
  return `${Math.max(0, Math.floor(seconds))}s`;
}
