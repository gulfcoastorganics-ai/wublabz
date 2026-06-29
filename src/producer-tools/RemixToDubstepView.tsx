import React, { useMemo, useRef, useState } from 'react';
import { createGrowlVoice } from '../lib/audio/GrowlVoiceGraph';
import { fromChannelBuffer, getProducerAnalyser, getProducerAudioContext } from '../lib/audio/ProducerAudioEngine';
import { renderBufferToWav } from '../lib/export/AudioRenderExport';
import { HttpFlipPrepClient, OfflineFlipPrepClient, resolveFlipPrepAssetUrl, type FlipPrepJob } from '../lib/producer-tools/flipPrepApi';
import {
  arrangementDurationSeconds,
  generateRemixArrangement,
  midiToFrequency,
  regenerateArrangementElement,
  renderArrangementGuideMaster,
  renderArrangementGuideStem,
  type RemixArrangement,
  type RemixTrackType
} from '../lib/producer-tools/arranger';
import { WubLabzEngine } from '../lib/WubLabzEngine';
import { getFlipPrepApiUrl } from '../wubpad-integration/env';
import { ActionButton, StatusMessage, styles, toArrayBuffer, ToolPanel } from './SampleManglerView';

const TRACK_COLORS: Record<RemixTrackType, string> = {
  acapella: '#ff5cc8',
  drums: '#ffcc33',
  bass: '#00cfff',
  fills: '#00ff99'
};

export function RemixToDubstepView() {
  const [engine] = useState(() => new WubLabzEngine());
  const [job, setJob] = useState<FlipPrepJob | null>(null);
  const [arrangement, setArrangement] = useState<RemixArrangement | null>(null);
  const [seed, setSeed] = useState('dubstep-skeleton');
  const [keyOverride, setKeyOverride] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState('');
  const [playing, setPlaying] = useState(false);
  const activeSources = useRef<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const client = useMemo(() => {
    const offline = (import.meta as any).env?.VITE_FLIP_PREP_OFFLINE === 'true';
    const baseUrl = getFlipPrepApiUrl();
    return offline ? new OfflineFlipPrepClient() : new HttpFlipPrepClient(baseUrl);
  }, []);

  async function upload(file?: File) {
    if (!file) return;
    setError('');
    setSuccess('');
    setArrangement(null);
    setUploading(true);
    try {
      let current = await client.createJob(file);
      setJob(current);
      while (current.status === 'queued' || current.status === 'processing') {
        await new Promise((resolve) => setTimeout(resolve, 900));
        current = await client.getJob(current.jobId);
        setJob(current);
      }
      if (!current.result) throw new Error(current.error ?? 'Flip Prep did not return a result');
      engine.setBpm(140);
      const next = generateRemixArrangement({
        flipPrep: current.result,
        seed,
        keyOverride: keyOverride || undefined,
        title: `${file.name.replace(/\.[^.]+$/, '')} dubstep skeleton`
      });
      setArrangement(next);
      setKeyOverride(next.keyOverride ?? next.detectedKey);
      setSuccess('Remix skeleton generated. Playback and exports are ready.');
    } catch (err) {
      setError(formatFlipPrepUiError(err, client.baseUrl));
    } finally {
      setUploading(false);
    }
  }

  function regenerate(type: RemixTrackType) {
    if (!arrangement) return;
    setArrangement(regenerateArrangementElement(arrangement, type, `${seed}:${type}:${Date.now()}`));
    setSuccess(`Regenerated ${type}.`);
  }

  function toggleTrack(trackId: string, field: 'muted' | 'solo') {
    setArrangement((current) => current && {
      ...current,
      tracks: current.tracks.map((track) => track.id === trackId ? { ...track, [field]: !track[field] } : track)
    });
  }

  function shiftAcapella(deltaBars: number) {
    setArrangement((current) => current && {
      ...current,
      tracks: current.tracks.map((track) => track.type === 'acapella'
        ? {
            ...track,
            clips: track.clips.map((clip) => ({
              ...clip,
              startBar: Math.max(0, clip.startBar + deltaBars),
              startBeat: Math.max(0, (clip.startBar + deltaBars) * 4)
            }))
          }
        : track)
    });
  }

  function applyKeyOverride() {
    if (!job?.result) return;
    setArrangement(generateRemixArrangement({ flipPrep: job.result, seed, keyOverride: keyOverride || undefined }));
    setSuccess('Applied key override.');
  }

  function play() {
    if (!arrangement) return;
    stop();
    const context = getProducerAudioContext();
    engine.setBpm(arrangement.targetBpm);
    const now = context.currentTime + 0.05;
    const rendered = renderArrangementGuideMaster(arrangement, 44100);
    const source = context.createBufferSource();
    source.buffer = fromChannelBuffer(context, rendered);
    source.connect(getProducerAnalyser());
    source.start(now);
    source.onended = () => setPlaying(false);
    activeSources.current.push(source);
    setPlaying(true);

    const bassTrack = arrangement.tracks.find((track) => track.type === 'bass' && !track.muted);
    for (const clip of bassTrack?.clips ?? []) {
      const midi = Number(clip.payload.midi ?? 45);
      const start = now + (clip.startBeat * 60) / arrangement.targetBpm;
      const voice = createGrowlVoice(context, arrangement.bassPreset, midiToFrequency(midi), getProducerAnalyser(), engine.getBpm());
      voice.start(start);
      voice.stop(start + 0.85);
    }
  }

  function stop() {
    for (const source of activeSources.current) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect?.();
    }
    activeSources.current = [];
    setPlaying(false);
  }

  function exportStem(type: RemixTrackType) {
    if (!arrangement) return;
    setExporting(type);
    try {
      const wav = renderBufferToWav(`wublabz-${type}-skeleton.wav`, renderArrangementGuideStem(arrangement, type));
      downloadBytes(wav.bytes, wav.fileName, wav.mimeType);
      setSuccess(`Exported ${wav.fileName}.`);
    } finally {
      setExporting('');
    }
  }

  function exportMaster() {
    if (!arrangement) return;
    setExporting('master');
    try {
      const wav = renderBufferToWav('wublabz-dubstep-skeleton-master.wav', renderArrangementGuideMaster(arrangement));
      downloadBytes(wav.bytes, wav.fileName, wav.mimeType);
      setSuccess(`Exported ${wav.fileName}.`);
    } finally {
      setExporting('');
    }
  }

  return (
    <ToolPanel title="Remix to Dubstep" tone="#ffcc33">
      <p style={{ color: '#d8d8d8', lineHeight: 1.5 }}>
        This creates an editable dubstep skeleton to finish in your DAW or here. It is not a finished auto-track.
      </p>
      <div style={styles.dropZone}>
        <input ref={fileInputRef} type="file" accept="audio/*" disabled={uploading} onChange={(event) => void upload(event.target.files?.[0])} style={{ display: 'none' }} />
        <div style={{ padding: '1rem' }}>
          <strong>{uploading ? 'Generating remix skeleton...' : 'Upload a song'}</strong>
          <p style={{ color: '#bbb', lineHeight: 1.5 }}>Flip Prep supplies stems, key/BPM, and the 140 half-time acapella. The arranger builds sections, drums, growls, and transition fills from engine rules.</p>
          <ActionButton variant="primary" loading={uploading} style={{ marginTop: '0.75rem' }} onClick={() => fileInputRef.current?.click()}>Choose Audio</ActionButton>
        </div>
      </div>

      <div style={styles.grid}>
        <label style={styles.control}>
          <span>SEED</span>
          <input className="wub-control-input" value={seed} onChange={(event) => setSeed(event.target.value)} style={styles.input} />
        </label>
        <label style={styles.control}>
          <span>KEY OVERRIDE</span>
          <input className="wub-control-input" value={keyOverride} onChange={(event) => setKeyOverride(event.target.value)} style={styles.input} placeholder="A minor" />
        </label>
        <ActionButton disabled={!job?.result || uploading} onClick={applyKeyOverride}>Apply Key</ActionButton>
      </div>

      {job && (
        <div style={{ ...styles.control, marginTop: '1rem' }}>
          <strong>{job.progressInfo?.phaseLabel ?? job.step}</strong>
          <span>{job.progressInfo ? `Elapsed ${formatSeconds(job.progressInfo.elapsedSeconds)} · Phase ${formatSeconds(job.progressInfo.phaseElapsedSeconds)}` : 'Preparing job'}</span>
          {job.progressInfo?.detail && <span>{job.progressInfo.detail}</span>}
          <progress className="wub-progress" value={job.progress} max={1} />
          <span>{job.status.toUpperCase()}</span>
        </div>
      )}

      {arrangement && (
        <>
          <div style={styles.grid}>
            <div style={styles.control}>DETECTED KEY <strong>{arrangement.detectedKey}</strong></div>
            <div style={styles.control}>SOURCE BPM <strong>{arrangement.sourceBpm}</strong></div>
            <div style={styles.control}>TARGET BPM <strong>{arrangement.targetBpm}</strong></div>
            <div style={styles.control}>DURATION <strong>{Math.round(arrangementDurationSeconds(arrangement))}s</strong></div>
          </div>
          <Timeline arrangement={arrangement} onMute={(trackId) => toggleTrack(trackId, 'muted')} onSolo={(trackId) => toggleTrack(trackId, 'solo')} />
          <div style={styles.actions}>
            <ActionButton variant="primary" loading={playing} onClick={play}>Play Skeleton</ActionButton>
            <ActionButton onClick={stop}>Stop</ActionButton>
            <ActionButton onClick={() => regenerate('drums')}>Regenerate Drums</ActionButton>
            <ActionButton onClick={() => regenerate('bass')}>Randomize Growl</ActionButton>
            <ActionButton onClick={() => regenerate('fills')}>Regenerate Fills</ActionButton>
            <ActionButton onClick={() => shiftAcapella(-1)}>Acapella -1 Bar</ActionButton>
            <ActionButton onClick={() => shiftAcapella(1)}>Acapella +1 Bar</ActionButton>
          </div>
          <div style={styles.actions}>
            {arrangement.tracks.map((track) => <ActionButton key={track.id} loading={exporting === track.type} onClick={() => exportStem(track.type)}>Export {track.name}</ActionButton>)}
            <ActionButton variant="primary" loading={exporting === 'master'} onClick={exportMaster}>Export Master</ActionButton>
          </div>
          <div style={styles.actions}>
            <a href={resolveFlipPrepAssetUrl(client.baseUrl, arrangement.flipPrep.acapella140Url)} style={styles.button}>Download Flip Prep Acapella</a>
          </div>
        </>
      )}
      {success && <StatusMessage tone="success">{success}</StatusMessage>}
      {(error || job?.error) && <StatusMessage tone="error">{error || job?.error}</StatusMessage>}
    </ToolPanel>
  );
}

function Timeline({ arrangement, onMute, onSolo }: { arrangement: RemixArrangement; onMute: (trackId: string) => void; onSolo: (trackId: string) => void }) {
  const totalBars = arrangement.sections.reduce((max, section) => Math.max(max, section.startBar + section.bars), 0);
  return (
    <div style={{ marginTop: '1rem', border: '1px solid rgba(210, 236, 255, 0.14)', borderTop: '1px solid rgba(255, 255, 255, 0.18)', borderRadius: 14, overflow: 'hidden', background: 'rgba(7, 12, 20, 0.72)', boxShadow: '0 16px 38px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.08)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `140px repeat(${totalBars}, minmax(12px, 1fr))`, background: 'rgba(255, 255, 255, 0.055)' }}>
        <div style={{ padding: '0.6rem', color: '#a8b3c7', fontWeight: 760 }}>Sections</div>
        {arrangement.sections.map((section) => (
          <div key={section.id} style={{ gridColumn: `${section.startBar + 2} / span ${section.bars}`, padding: '0.6rem 0.35rem', color: '#f5f8ff', borderLeft: '1px solid rgba(210, 236, 255, 0.12)', fontSize: '0.75rem', fontWeight: 760 }}>
            {section.label}
          </div>
        ))}
      </div>
      {arrangement.tracks.map((track) => (
        <div key={track.id} style={{ display: 'grid', gridTemplateColumns: `140px repeat(${totalBars}, minmax(12px, 1fr))`, minHeight: 52, borderTop: '1px solid rgba(210, 236, 255, 0.1)', background: 'rgba(255, 255, 255, 0.028)' }}>
          <div style={{ padding: '0.45rem', display: 'grid', gap: 4 }}>
            <strong style={{ color: TRACK_COLORS[track.type], fontSize: '0.78rem' }}>{track.name}</strong>
            <span>
              <ActionButton style={miniButton(track.muted)} onClick={() => onMute(track.id)}>M</ActionButton>
              <ActionButton style={miniButton(track.solo)} onClick={() => onSolo(track.id)}>S</ActionButton>
            </span>
          </div>
          {track.clips.map((clip) => (
            <div key={clip.id} title={clip.type} style={{
              gridColumn: `${clip.startBar + 2} / span ${clip.bars}`,
              margin: '8px 2px',
              borderRadius: 9,
              background: `linear-gradient(135deg, ${TRACK_COLORS[track.type]}, rgba(255,255,255,0.55))`,
              color: '#051018',
              fontSize: '0.68rem',
              fontWeight: 800,
              padding: '0.35rem',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              boxShadow: `0 8px 18px ${TRACK_COLORS[track.type]}33, inset 0 1px 0 rgba(255, 255, 255, 0.38)`
            }}>
              {clip.type}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function miniButton(active: boolean): React.CSSProperties {
  return {
    minWidth: 28,
    minHeight: 24,
    marginRight: 4,
    borderRadius: 8,
    border: `1px solid ${active ? 'rgba(110, 231, 255, 0.72)' : 'rgba(210, 236, 255, 0.18)'}`,
    background: active ? 'rgba(110, 231, 255, 0.16)' : 'rgba(255, 255, 255, 0.06)',
    color: active ? '#dffcff' : '#d7deeb',
    cursor: 'pointer'
  };
}

function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatSeconds(seconds: number): string {
  return `${Math.max(0, Math.floor(seconds))}s`;
}

function formatFlipPrepUiError(error: unknown, baseUrl: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Remix arrangement failed';
  if (message.includes('Flip Prep worker is not reachable')) {
    return `Flip Prep is not reachable through the WubLabz API at ${baseUrl}. The browser is using the app API proxy; confirm the server can reach the Flip Prep worker.`;
  }
  return message;
}
