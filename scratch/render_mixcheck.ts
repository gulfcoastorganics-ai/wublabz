import { readFileSync, writeFileSync } from 'node:fs';
import { generateRemixArrangement, renderArrangementMasterWithAudio } from '../src/lib/producer-tools/arranger.js';
import { decodeWav, encodeWav } from '../src/lib/export/wav.js';

const ACAPELLA_PATH = '/mnt/chromeos/removable/GIGASTONE/flip-cache/jobs/744b52bf-4283-4ed0-a921-eb85bcaa7520/acapella_140.wav';
const OUTPUT_PATH = '/mnt/chromeos/removable/GIGASTONE/flip-cache/eulogy_short-remix-dubstep-mixcheck.wav';

async function main() {
  console.log('Reading acapella...');
  const acapellaWav = readFileSync(ACAPELLA_PATH);
  const acapellaBuffer = decodeWav(new Uint8Array(acapellaWav));

  const flipPrep: any = {
    key: 'D major',
    bpm: 157,
    stems: [],
    acapella140Url: ACAPELLA_PATH
  };

  console.log('Generating arrangement...');
  const arrangement = generateRemixArrangement({
    flipPrep,
    seed: 'wublabz-remix'
  });

  const assets = {
    acapella140: acapellaBuffer
  };

  console.log('Rendering audio...');
  const rendered = renderArrangementMasterWithAudio(arrangement, assets, 44100);

  console.log('Encoding WAV...');
  const outWav = encodeWav(rendered, { bitDepth: 16 });
  
  console.log('Writing to disk...');
  writeFileSync(OUTPUT_PATH, outWav);

  const durationSeconds = rendered.channels[0].length / 44100;
  console.log(`\n--- Render Complete ---`);
  console.log(`Path: ${OUTPUT_PATH}`);
  console.log(`Duration: ${durationSeconds.toFixed(2)} seconds`);
  console.log(`Detected Key: D major`);
  console.log(`Detected BPM: 157`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
