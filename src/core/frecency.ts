// ── Frecency Tracker ────────────────────────────────────────────────
// Tracks file access patterns for smarter autocomplete and suggestions.
// Score = frequency * exp(-timeSinceLastAccess / halfLife)
// Persists to ~/.orchestrator/frecency.jsonl in append-only format.

import { homedir } from "node:os";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

export interface FrecencyEntry {
  path: string;
  frequency: number;
  lastAccess: number; // timestamp ms
  score: number;      // computed frecency score
}

interface EntryData {
  frequency: number;
  lastAccess: number;
}

export class FrecencyTracker {
  private entries: Map<string, EntryData> = new Map();
  private storePath: string;
  private maxEntries = 1000;
  private halfLifeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savePending = false;

  constructor(storePath?: string) {
    this.storePath = storePath ?? `${homedir()}/.orchestrator/frecency.jsonl`;
  }

  /** Record a file access */
  record(filePath: string): void {
    const existing = this.entries.get(filePath);

    if (existing) {
      existing.frequency++;
      existing.lastAccess = Date.now();
    } else {
      this.entries.set(filePath, {
        frequency: 1,
        lastAccess: Date.now(),
      });
    }

    // Evict if over cap
    if (this.entries.size > this.maxEntries) {
      this.evict();
    }

    // Debounced save
    this.debounceSave();
  }

  /** Rank a list of files by frecency score (highest first) */
  rank(files: string[]): string[] {
    return files
      .map((f) => ({ path: f, score: this.getScore(f) }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.path);
  }

  /** Get frecency score for a file */
  getScore(filePath: string): number {
    const entry = this.entries.get(filePath);
    if (!entry) return 0;
    return this.computeScore(entry.frequency, entry.lastAccess);
  }

  /**
   * Compute score: frequency * exp(-timeSinceLastAccess / halfLife)
   * Recently accessed files with high frequency score highest.
   */
  private computeScore(frequency: number, lastAccess: number): number {
    const elapsed = Date.now() - lastAccess;
    const decay = Math.exp(-elapsed / this.halfLifeMs);
    return frequency * decay;
  }

  /** Load entries from disk (JSONL format) */
  async load(): Promise<void> {
    const file = Bun.file(this.storePath);
    if (!(await file.exists())) return;

    try {
      const text = await file.text();
      const lines = text.trim().split("\n");

      // JSONL: each line is { path, frequency, lastAccess }
      // Later lines for the same path override earlier ones
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { path: string; frequency: number; lastAccess: number };
          this.entries.set(record.path, {
            frequency: record.frequency,
            lastAccess: record.lastAccess,
          });
        } catch {
          // Skip corrupted lines
        }
      }
    } catch {
      // File read error — start fresh
    }
  }

  /** Save all entries to disk (full rewrite in JSONL format) */
  async save(): Promise<void> {
    this.savePending = false;

    if (this.entries.size === 0) return;

    await mkdir(dirname(this.storePath), { recursive: true });

    const lines: string[] = [];
    for (const [path, data] of this.entries) {
      lines.push(JSON.stringify({
        path,
        frequency: data.frequency,
        lastAccess: data.lastAccess,
      }));
    }

    await Bun.write(this.storePath, lines.join("\n") + "\n");
  }

  /** Evict lowest-scored entries when over cap */
  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;

    // Score all entries and sort ascending (lowest scores first)
    const scored: Array<{ path: string; score: number }> = [];
    for (const [path, data] of this.entries) {
      scored.push({ path, score: this.computeScore(data.frequency, data.lastAccess) });
    }

    scored.sort((a, b) => a.score - b.score);

    // Remove entries until we're at capacity
    const removeCount = this.entries.size - this.maxEntries;
    for (let i = 0; i < removeCount; i++) {
      this.entries.delete(scored[i].path);
    }
  }

  /** Debounce save calls — coalesce multiple record() calls into one disk write */
  private debounceSave(): void {
    if (this.savePending) return;
    this.savePending = true;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.save().catch(() => {
        // Silently ignore save errors
      });
    }, 1000);
  }

  /** Get top N file paths sorted by frecency score */
  getTopFiles(n: number): string[] {
    return this.getAll().slice(0, n).map((e) => e.path);
  }

  /** Get all entries as sorted FrecencyEntry array (for inspection/debugging) */
  getAll(): FrecencyEntry[] {
    const result: FrecencyEntry[] = [];
    for (const [path, data] of this.entries) {
      result.push({
        path,
        frequency: data.frequency,
        lastAccess: data.lastAccess,
        score: this.computeScore(data.frequency, data.lastAccess),
      });
    }
    return result.sort((a, b) => b.score - a.score);
  }
}
