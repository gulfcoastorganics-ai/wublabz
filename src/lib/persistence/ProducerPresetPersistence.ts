export function saveProducerPreset<T>(key: string, preset: T): void {
  const storage = (globalThis as any).localStorage;
  if (!storage) return;
  storage.setItem(key, JSON.stringify(preset));
}

export function loadProducerPreset<T>(key: string, fallback: T): T {
  const storage = (globalThis as any).localStorage;
  if (!storage) return fallback;
  const raw = storage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
