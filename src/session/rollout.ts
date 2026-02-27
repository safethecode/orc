import type { ConversationTurn } from "../config/types.ts";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RolloutEntry {
  type: "turn" | "meta" | "compact";
  timestamp: string;
  data: ConversationTurn | Record<string, unknown>;
}

export class RolloutRecorder {
  private buffer: RolloutEntry[] = [];
  private filePath: string | null = null;
  private created = false;

  constructor(private baseDir: string) {}

  append(entry: RolloutEntry): void {
    this.buffer.push(entry);
  }

  persist(): void {
    if (this.buffer.length === 0) return;

    if (!this.created) {
      const now = new Date();
      const y = now.getFullYear().toString();
      const m = (now.getMonth() + 1).toString().padStart(2, "0");
      const d = now.getDate().toString().padStart(2, "0");
      const ts = now.toISOString().replace(/[:.]/g, "-");
      const shortId = Math.random().toString(36).slice(2, 8);

      const dir = join(this.baseDir, y, m, d);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      this.filePath = join(dir, `rollout-${ts}-${shortId}.jsonl`);
      this.created = true;
    }

    const lines = this.buffer.map((e) => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(this.filePath!, lines);
    this.buffer = [];
  }

  static read(filePath: string): RolloutEntry[] {
    const content = readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RolloutEntry);
  }

  static list(
    baseDir: string,
    limit = 20,
  ): Array<{ path: string; date: string; size: number }> {
    const results: Array<{ path: string; date: string; size: number }> = [];
    if (!existsSync(baseDir)) return results;

    const years = readdirSync(baseDir).filter((f) => /^\d{4}$/.test(f)).sort().reverse();

    for (const y of years) {
      const yPath = join(baseDir, y);
      if (!statSync(yPath).isDirectory()) continue;

      const months = readdirSync(yPath).filter((f) => /^\d{2}$/.test(f)).sort().reverse();
      for (const m of months) {
        const mPath = join(yPath, m);
        if (!statSync(mPath).isDirectory()) continue;

        const days = readdirSync(mPath).filter((f) => /^\d{2}$/.test(f)).sort().reverse();
        for (const d of days) {
          const dPath = join(mPath, d);
          if (!statSync(dPath).isDirectory()) continue;

          const files = readdirSync(dPath)
            .filter((f) => f.endsWith(".jsonl"))
            .sort()
            .reverse();

          for (const f of files) {
            const fullPath = join(dPath, f);
            const stat = statSync(fullPath);
            results.push({
              path: fullPath,
              date: `${y}-${m}-${d}`,
              size: stat.size,
            });
            if (results.length >= limit) return results;
          }
        }
      }
    }

    return results;
  }

  getFilePath(): string | null {
    return this.filePath;
  }

  get hasPendingEntries(): boolean {
    return this.buffer.length > 0;
  }
}
