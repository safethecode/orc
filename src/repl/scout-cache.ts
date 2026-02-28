export class ScoutCache {
  private cache = new Map<string, { result: unknown; timestamp: number }>();
  private ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get<T>(key: string): T | null {
    const normalized = this.normalize(key);
    const entry = this.cache.get(normalized);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(normalized);
      return null;
    }
    return entry.result as T;
  }

  set(key: string, result: unknown): void {
    this.cache.set(this.normalize(key), { result, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }

  private normalize(key: string): string {
    return key.toLowerCase().trim().replace(/\s+/g, " ");
  }
}
