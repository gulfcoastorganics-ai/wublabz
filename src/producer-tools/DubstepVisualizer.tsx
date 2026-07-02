import React, { useEffect, useRef } from 'react';
import { getProducerAnalyser } from '../lib/audio/ProducerAudioEngine';
import { freshBandState, updateBandState, FRAME_INTERVAL_MS, SHOCKWAVE_LIFETIME_MS, type BandState } from './dubstepVisualizerMath';

export interface DubstepVisualizerProps {
  active: boolean;
  height?: number;
}

// "Impact Core": a genre-tied visual language instead of a generic bar-graph
// EQ. Sub-bass reads as a pulsing core (weight), mid-bass/wobble reads as a
// rotating ring of radial bars (motion), and drum transients read as
// expanding shockwave rings (tension breaking on the hit) — the three
// signal classes look distinct from each other, not just "louder = bigger".
export function DubstepVisualizer({ active, height = 220 }: DubstepVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<BandState>(freshBandState());
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let frame = 0;
    let lastDrawAt = 0;
    let lastResizeWidth = 0;
    let lastResizeHeight = 0;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - lastDrawAt < FRAME_INTERVAL_MS) return;
      lastDrawAt = now;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const analyser = getProducerAnalyser() as AnalyserNode | undefined;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.max(1, Math.floor(rect.width * dpr));
      const pixelHeight = Math.max(1, Math.floor(rect.height * dpr));
      if (pixelWidth !== lastResizeWidth || pixelHeight !== lastResizeHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        lastResizeWidth = pixelWidth;
        lastResizeHeight = pixelHeight;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx || !analyser) return;

      const bins = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(bins);
      updateBandState(stateRef.current, bins, analyser.context.sampleRate, now, activeRef.current);
      draw(ctx, rect.width, rect.height, dpr, stateRef.current, now, activeRef.current);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvasRef} className="wub-canvas-frame" style={{ width: '100%', height, display: 'block', borderRadius: 14 }} />;
}

function draw(ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number, state: BandState, now: number, active: boolean): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const centerX = width / 2;
  const centerY = height / 2;
  const baseRadius = Math.min(width, height) * 0.16;

  // Background: near-black with a faint warm vignette that brightens with
  // overall energy — subtle tension cue during buildups.
  const vignette = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(width, height) * 0.7);
  vignette.addColorStop(0, `rgba(60, 12, 18, ${0.35 + state.broadband * 0.25})`);
  vignette.addColorStop(1, 'rgba(10, 6, 8, 1)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  // Shockwave rings: drum transients read as expanding rings, distinct from
  // the continuous sub/mid motion.
  for (const wave of state.shockwaves) {
    const age = (now - wave.bornAt) / SHOCKWAVE_LIFETIME_MS;
    const radius = baseRadius + age * Math.max(width, height) * 0.55;
    const alpha = (1 - age) * wave.strength * 0.8;
    if (alpha <= 0) continue;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 209, 102, ${alpha})`;
    ctx.lineWidth = 3 * (1 - age) + 1;
    ctx.stroke();
  }

  // Mid-bass / wobble ring: radial bars rotating slowly, length driven by
  // the mid-bass band — motion reads as "wobble", not a static bar graph.
  const barCount = 48;
  const rotation = (now / 4000) % (Math.PI * 2);
  for (let i = 0; i < barCount; i++) {
    const angle = (i / barCount) * Math.PI * 2 + rotation;
    const barLevel = state.mid * (0.6 + 0.4 * Math.sin(angle * 3 + now / 600));
    const innerR = baseRadius * 1.35;
    const outerR = innerR + barLevel * Math.min(width, height) * 0.28;
    const x1 = centerX + Math.cos(angle) * innerR;
    const y1 = centerY + Math.sin(angle) * innerR;
    const x2 = centerX + Math.cos(angle) * outerR;
    const y2 = centerY + Math.sin(angle) * outerR;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = `rgba(255, ${Math.round(43 + barLevel * 160)}, ${Math.round(61 + barLevel * 60)}, ${0.55 + barLevel * 0.45})`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Sub-bass core: a pulsing filled disc — weight, not detail. Scales and
  // glows with sub energy so the drop reads as physical impact.
  const coreRadius = baseRadius * (1 + state.sub * 0.9);
  const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, coreRadius * 1.6);
  glow.addColorStop(0, `rgba(255, 43, 61, ${0.85 + state.sub * 0.15})`);
  glow.addColorStop(0.6, `rgba(224, 16, 48, ${0.35 + state.sub * 0.3})`);
  glow.addColorStop(1, 'rgba(224, 16, 48, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(centerX, centerY, coreRadius * 1.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 244, 245, ${active ? 0.9 : 0.35})`;
  ctx.fill();

  if (!active) {
    ctx.fillStyle = 'rgba(216, 201, 205, 0.6)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Play the skeleton to see it react', centerX, height - 14);
    ctx.textAlign = 'start';
  }
}
