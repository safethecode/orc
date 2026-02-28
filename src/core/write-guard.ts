/**
 * Write-Existing-File Guard — prevents agents from overwriting files
 * they haven't read first. Uses an LRU-capped Map to track which files
 * have been read during the current session.
 */
export class WriteGuard {
  /** LRU-capped Map tracking files that have been read this session (path -> timestamp) */
  private readFiles: Map<string, number> = new Map();
  private maxEntries: number;

  /** Path prefixes that are always allowed for writes without prior read */
  private allowedPrefixes = ["/tmp/", ".sisyphus/", ".orchestrator/", "node_modules/"];

  constructor(maxEntries?: number) {
    this.maxEntries = maxEntries ?? 500;
  }

  /** Mark a file as "read" — call this when tool_use has name="read" */
  markRead(filePath: string): void {
    const normalized = this.normalize(filePath);

    // If already tracked, delete first so re-insertion moves it to end (most recent)
    if (this.readFiles.has(normalized)) {
      this.readFiles.delete(normalized);
    }

    this.readFiles.set(normalized, Date.now());
    this.evict();
  }

  /** Check if writing to this file is allowed */
  checkWrite(filePath: string): "allow" | "block" {
    const normalized = this.normalize(filePath);

    // Always-allowed prefixes bypass the guard
    for (const prefix of this.allowedPrefixes) {
      if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)) {
        return "allow";
      }
    }

    // File must have been read first
    if (this.readFiles.has(normalized)) {
      return "allow";
    }

    return "block";
  }

  /** Get list of read files (for debugging) */
  getReadFiles(): string[] {
    return Array.from(this.readFiles.keys());
  }

  /** Reset tracking (new session) */
  reset(): void {
    this.readFiles.clear();
  }

  /** LRU eviction — removes oldest entries when over cap */
  private evict(): void {
    while (this.readFiles.size > this.maxEntries) {
      // Map iteration order is insertion order; first key is the oldest
      const oldest = this.readFiles.keys().next().value;
      if (oldest !== undefined) {
        this.readFiles.delete(oldest);
      }
    }
  }

  /** Normalize a file path for consistent comparison */
  private normalize(filePath: string): string {
    // Collapse consecutive slashes, remove trailing slash
    return filePath.replace(/\/+/g, "/").replace(/\/$/, "");
  }
}
