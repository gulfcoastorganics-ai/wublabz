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
import { getWubLabzHttpUrl } from '../wubpad-integration/env';
import { styles, toArrayBuffer, ToolPanel } from './SampleManglerView';

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
  const activeSources = useRef<any[]>([]);
  const client = useMemo(() => {
    const offline = (import.meta as any).env?.VITE_FLIP_PREP_OFFLINE === 'true';
    const baseUrl = (import.meta as any).env?.VITE_FLIP_PREP_API_URL ?? getWubLabzHttpUrl();
    return offline ? new OfflineFlipPrepClient() : new HttpFlipPrepClient(baseUrl);
  }, []);

  async function upload(file?: File) {
    if (!file) return;
    setError('');
    setArrangement(null);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remix arrangement failed');
    }
  }

  function regenerate(type: RemixTrackType) {
    if (!arrangement) return;
    setArrangement(regenerateArrangementElement(arrangement, type, `${seed}:${type}:${Date.now()}`));
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
    activeSources.current.push(source);

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
  }

  function exportStem(type: RemixTrackType) {
    if (!arrangement) return;
    const wav = renderBufferToWav(`wublabz-${type}-skeleton.wav`, renderArrangementGuideStem(arrangement, type));
    downloadBytes(wav.bytes, wav.fileName, wav.mimeType);
  }

  function exportMaster() {
    if (!arrangement) return;
    const wav = renderBufferToWav('wublabz-dubstep-skeleton-master.wav', renderArrangementGuideMaster(arrangement));
    downloadBytes(wav.bytes, wav.fileName, wav.mimeType);
  }

  return (
    <ToolPanel title="Remix to Dubstep" tone="#ffcc33">
      <p style={{ color: '#d8d8d8', lineHeight: 1.5 }}>
        This creates an editable dubstep skeleton to finish in your DAW or here. It is not a finished auto-track.
      </p>
      <label style={styles.dropZone}>
        <input type="file" accept="audio/*" onChange={(event) => void upload(event.target.files?.[0])} style={{ display: 'none' }} />
        <div style={{ padding: '1rem' }}>
          <strong>Upload a song</strong>
          <p style={{ color: '#bbb', lineHeight: 1.5 }}>Flip Prep supplies stems, key/BPM, and the 140 half-time acapella. The arranger builds sections, drums, growls, and transition fills from engine rules.</p>
        </div>
      </label>

      <div style={styles.grid}>
        <label style={styles.control}>
          <span>SEED</span>
          <input value={seed} onChange={(event) => setSeed(event.target.value)} style={styles.input} />
        </label>
        <label style={styles.control}>
          <span>KEY OVERRIDE</span>
          <input value={keyOverride} onChange={(event) => setKeyOverride(event.target.value)} style={styles.input} placeholder="A minor" />
        </label>
        <button style={styles.button} disabled={!job?.result} onClick={applyKeyOverride}>Apply Key</button>
      </div>

      {job && (
        <div style={{ ...styles.control, marginTop: '1rem' }}>
          <strong>{job.progressInfo?.phaseLabel ?? job.step}</strong>
          <span>{job.progressInfo ? `Elapsed ${formatSeconds(job.progressInfo.elapsedSeconds)} · Phase ${formatSeconds(job.progressInfo.phaseElapsedSeconds)}` : 'Preparing job'}</span>
          {job.progressInfo?.detail && <span>{job.progressInfo.detail}</span>}
          <progress value={job.progress} max={1} style={{ width: '100%' }} />
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
            <button style={styles.primaryButton} onClick={play}>Play Skeleton</button>
            <button style={styles.button} onClick={stop}>Stop</button>
            <button style={styles.button} onClick={() => regenerate('drums')}>Regenerate Drums</button>
            <button style={styles.button} onClick={() => regenerate('bass')}>Randomize Growl</button>
            <button style={styles.button} onClick={() => regenerate('fills')}>Regenerate Fills</button>
            <button style={styles.button} onClick={() => shiftAcapella(-1)}>Acapella -1 Bar</button>
            <button style={styles.button} onClick={() => shiftAcapella(1)}>Acapella +1 Bar</button>
          </div>
          <div style={styles.actions}>
            {arrangement.tracks.map((track) => <button key={track.id} style={styles.button} onClick={() => exportStem(track.type)}>Export {track.name}</button>)}
            <button style={styles.primaryButton} onClick={exportMaster}>Export Master</button>
          </div>
          <div style={styles.actions}>
            <a href={resolveFlipPrepAssetUrl(client.baseUrl, arrangement.flipPrep.acapella140Url)} style={styles.button}>Download Flip Prep Acapella</a>
          </div>
        </>
      )}
      {(error || job?.error) && <p style={{ color: '#ff8c8c' }}>{error || job?.error}</p>}
    </ToolPanel>
  );
}

function Timeline({ arrangement, onMute, onSolo }: { arrangement: RemixArrangement; onMute: (trackId: string) => void; onSolo: (trackId: string) => void }) {
  const totalBars = arrangement.sections.reduce((max, section) => Math.max(max, section.startBar + section.bars), 0);
  return (
    <div style={{ marginTop: '1rem', border: '1px solid #333', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `140px repeat(${totalBars}, minmax(12px, 1fr))`, background: '#171717' }}>
        <div style={{ padding: '0.5rem', color: '#aaa' }}>Sections</div>
        {arrangement.sections.map((section) => (
          <div key={section.id} style={{ gridColumn: `${section.startBar + 2} / span ${section.bars}`, padding: '0.5rem 0.25rem', color: '#fff', borderLeft: '1px solid #333', fontSize: '0.75rem' }}>
            {section.label}
          </div>
        ))}
      </div>
      {arrangement.tracks.map((track) => (
        <div key={track.id} style={{ display: 'grid', gridTemplateColumns: `140px repeat(${totalBars}, minmax(12px, 1fr))`, minHeight: 48, borderTop: '1px solid #2b2b2b', background: '#101010' }}>
          <div style={{ padding: '0.45rem', display: 'grid', gap: 4 }}>
            <strong style={{ color: TRACK_COLORS[track.type], fontSize: '0.78rem' }}>{track.name}</strong>
            <span>
              <button style={miniButton(track.muted)} onClick={() => onMute(track.id)}>M</button>
              <button style={miniButton(track.solo)} onClick={() => onSolo(track.id)}>S</button>
            </span>
          </div>
          {track.clips.map((clip) => (
            <div key={clip.id} title={clip.type} style={{
              gridColumn: `${clip.startBar + 2} / span ${clip.bars}`,
              margin: '8px 2px',
              borderRadius: 4,
              background: TRACK_COLORS[track.type],
              color: '#050505',
              fontSize: '0.68rem',
              fontWeight: 800,
              padding: '0.35rem',
              overflow: 'hidden',
              whiteSpace: 'nowrap'
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
    borderRadius: 4,
    border: `1px solid ${active ? '#00ffcc' : '#444'}`,
    background: active ? '#06352e' : '#1c1c1c',
    color: active ? '#00ffcc' : '#ddd',
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
