import { startFlipPrepWorker } from './server.js';

startFlipPrepWorker().catch((error) => {
  console.error(error);
  process.exit(1);
});
