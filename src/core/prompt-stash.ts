import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface StashEntry {
  text: string;
  timestamp: string;
  index: number;
}

export class PromptStash {
  private entries: StashEntry[] = [];
  private storePath: string;
  private maxEntries = 50;

  constructor(storePath?: string) {
    this.storePath = storePath ?? `${process.env.HOME}/.orchestrator/stash.jsonl`;
  }

  push(text: string): void {
    const entry: StashEntry = {
      text,
      timestamp: new Date().toISOString(),
      index: this.entries.length,
    };

    this.entries.push(entry);

    // Evict oldest entries if over capacity
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
      this.reindex();
    }
  }

  pop(): StashEntry | null {
    const entry = this.entries.pop() ?? null;
    return entry;
  }

  list(): StashEntry[] {
    return [...this.entries];
  }

  remove(index: number): boolean {
    const idx = this.entries.findIndex((e) => e.index === index);
    if (idx === -1) return false;

    this.entries.splice(idx, 1);
    this.reindex();
    return true;
  }

  clear(): void {
    this.entries = [];
  }

  async load(): Promise<void> {
    try {
      const file = Bun.file(this.storePath);
      if (!(await file.exists())) return;

      const content = await file.text();
      const lines = content.split("\n").filter((line) => line.trim());

      this.entries = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as StashEntry;
          this.entries.push(parsed);
        } catch {
          // Skip malformed lines
        }
      }

      this.reindex();
    } catch {
      // File doesn't exist or unreadable — start empty
      this.entries = [];
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });

    const lines = this.entries.map((entry) => JSON.stringify(entry));
    const content = lines.length > 0 ? lines.join("\n") + "\n" : "";

    await Bun.write(this.storePath, content);
  }

  private reindex(): void {
    for (let i = 0; i < this.entries.length; i++) {
      this.entries[i].index = i;
    }
  }
}
