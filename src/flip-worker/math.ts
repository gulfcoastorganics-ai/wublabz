export function calculateStretchRate(targetBpm: number, detectedBpm: number): number {
  if (!Number.isFinite(targetBpm) || targetBpm <= 0) {
    throw new Error('targetBpm must be positive');
  }
  if (!Number.isFinite(detectedBpm) || detectedBpm <= 0) {
    throw new Error('detectedBpm must be positive');
  }
  return targetBpm / detectedBpm;
}
