import type { Store } from "../db/store.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { ConversationTurn } from "../config/types.ts";

export interface ConsolidationResult {
  extracted: number;
  consolidated: number;
}

const EXTRACTION_PATTERNS = [
  /(?:project|app|system|codebase)\s+uses?\s+(.+)/i,
  /(?:is|are)\s+configured\s+(?:as|to|with)\s+(.+)/i,
  /(?:prefers?|preference)\s+(.+)/i,
  /(?:set\s+to|defaults?\s+to)\s+(.+)/i,
  /(?:tech\s+stack|stack)\s+(?:is|includes?)\s+(.+)/i,
  /(?:runtime|framework|language)\s+(?:is|:)\s+(.+)/i,
  /(?:always|never|must)\s+(.+)/i,
];

const CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class MemoryConsolidator {
  private lastConsolidationAt = 0;

  constructor(
    private store: Store,
    private memory: MemoryStore,
  ) {}

  async extractFromSessions(
    maxSnapshots = 16,
  ): Promise<Map<string, string>> {
    const extracted = new Map<string, string>();
    const snapshots = this.store.listSnapshots(undefined, maxSnapshots);

    for (const snap of snapshots) {
      const full = this.store.getLatestSnapshot(snap.sessionName);
      if (!full?.turnsJson) continue;

      let turns: ConversationTurn[];
      try {
        turns = JSON.parse(full.turnsJson);
      } catch {
        continue;
      }

      for (const turn of turns) {
        if (turn.role !== "assistant") continue;

        const sentences = turn.content.split(/[.\n]/).filter(Boolean);
        for (const sentence of sentences) {
          const trimmed = sentence.trim();
          if (trimmed.length < 10 || trimmed.length > 200) continue;

          for (const pattern of EXTRACTION_PATTERNS) {
            const match = trimmed.match(pattern);
            if (match) {
              const key = trimmed
                .slice(0, 60)
                .replace(/[^a-zA-Z0-9\s-]/g, "")
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "-");
              if (key.length > 5) {
                extracted.set(key, trimmed);
              }
              break;
            }
          }
        }
      }
    }

    return extracted;
  }

  async consolidate(): Promise<ConsolidationResult> {
    const extracted = await this.extractFromSessions();
    let consolidated = 0;

    for (const [key, value] of extracted) {
      const existing = this.memory.search(key, "global", 1);
      const alreadyExists = existing.some(
        (e) => e.key === key && e.value === value,
      );

      if (!alreadyExists) {
        this.memory.set("global", key, value, "auto-consolidation");
        consolidated++;
      }
    }

    this.lastConsolidationAt = Date.now();

    return {
      extracted: extracted.size,
      consolidated,
    };
  }

  shouldConsolidate(): boolean {
    const elapsed = Date.now() - this.lastConsolidationAt;
    if (elapsed < CONSOLIDATION_INTERVAL_MS) return false;

    const snapshots = this.store.listSnapshots(undefined, 1);
    if (snapshots.length === 0) return false;

    const newest = new Date(snapshots[0].createdAt).getTime();
    return newest > this.lastConsolidationAt;
  }
}
