export function saveProducerPreset<T>(key: string, preset: T): boolean {
  const storage = (globalThis as any).localStorage;
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(preset));
    return true;
  } catch {
    // Storage can be unavailable or quota-limited in restricted browser contexts.
    return false;
  }
}

export function loadProducerPreset<T>(key: string, fallback: T): T {
  const storage = (globalThis as any).localStorage;
  if (!storage) return fallback;
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
