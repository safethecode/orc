import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { CacheEntry, CacheStats, ModelTier } from "../config/types.ts";

// Token cost per 1K tokens (approximate USD)
const COST_PER_1K: Record<string, number> = {
  haiku: 0.00025,
  sonnet: 0.003,
  opus: 0.015,
};

function hashPrompt(prompt: string, model: string): string {
  return createHash("sha256").update(`${model}:${prompt}`).digest("hex").slice(0, 32);
}

function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/\s+/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<TIMESTAMP>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>")
    .trim();
}

function bigramSimilarity(a: string, b: string): number {
  const getBigrams = (s: string): Set<string> => {
    const bigrams = new Set<string>();
    const lower = s.toLowerCase();
    for (let i = 0; i < lower.length - 1; i++) {
      bigrams.add(lower.slice(i, i + 2));
    }
    return bigrams;
  };

  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class PromptCache {
  private maxEntries: number;
  private similarityThreshold: number;

  constructor(
    private db: Database,
    options?: { maxEntries?: number; similarityThreshold?: number },
  ) {
    this.maxEntries = options?.maxEntries ?? 500;
    this.similarityThreshold = options?.similarityThreshold ?? 0.85;
  }

  get(prompt: string, model: ModelTier): CacheEntry | null {
    const normalized = normalizePrompt(prompt);
    const hash = hashPrompt(normalized, model);

    // Exact match first
    const row = this.db.prepare(`SELECT * FROM prompt_cache WHERE hash = ?`).get(hash) as Record<string, unknown> | null;
    if (row) {
      this.db.prepare(`UPDATE prompt_cache SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE hash = ?`).run(hash);
      return this.mapEntry(row);
    }

    // Semantic similarity search: check recent entries for the same model
    const candidates = this.db.prepare(
      `SELECT * FROM prompt_cache WHERE model = ? ORDER BY last_hit_at DESC LIMIT 50`,
    ).all(model) as Record<string, unknown>[];

    for (const candidate of candidates) {
      const sim = bigramSimilarity(normalized, normalizePrompt(candidate.prompt as string));
      if (sim >= this.similarityThreshold) {
        this.db.prepare(`UPDATE prompt_cache SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE hash = ?`).run(candidate.hash as string);
        return this.mapEntry(candidate);
      }
    }

    return null;
  }

  set(prompt: string, model: ModelTier, response: string, tokens: number): void {
    const normalized = normalizePrompt(prompt);
    const hash = hashPrompt(normalized, model);

    this.db.prepare(
      `INSERT OR REPLACE INTO prompt_cache (hash, prompt, response, model, tokens) VALUES (?, ?, ?, ?, ?)`,
    ).run(hash, normalized, response, model, tokens);

    // Evict if over capacity
    this.evict();
  }

  getStats(): CacheStats {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(hit_count), 0) as hits, COALESCE(SUM(tokens * hit_count), 0) as tokens_saved FROM prompt_cache`,
    ).get() as Record<string, unknown>;

    const totalEntries = row.cnt as number;
    const totalHits = row.hits as number;
    const totalTokensSaved = row.tokens_saved as number;

    // Estimate cost saved across models
    const modelRows = this.db.prepare(
      `SELECT model, SUM(tokens * hit_count) as saved FROM prompt_cache GROUP BY model`,
    ).all() as Array<{ model: string; saved: number }>;

    let costSaved = 0;
    for (const mr of modelRows) {
      costSaved += ((mr.saved ?? 0) / 1000) * (COST_PER_1K[mr.model] ?? 0.003);
    }

    return {
      totalEntries,
      hitRate: totalEntries > 0 ? totalHits / Math.max(1, totalEntries + totalHits) : 0,
      tokensSaved: totalTokensSaved,
      costSaved,
    };
  }

  private evict(): void {
    const count = (this.db.prepare(`SELECT COUNT(*) as cnt FROM prompt_cache`).get() as { cnt: number }).cnt;
    if (count > this.maxEntries) {
      this.db.prepare(
        `DELETE FROM prompt_cache WHERE hash IN (SELECT hash FROM prompt_cache ORDER BY last_hit_at ASC LIMIT ?)`,
      ).run(count - this.maxEntries);
    }
  }

  clear(): void {
    this.db.prepare(`DELETE FROM prompt_cache`).run();
  }

  private mapEntry(row: Record<string, unknown>): CacheEntry {
    return {
      hash: row.hash as string,
      prompt: row.prompt as string,
      response: row.response as string,
      model: row.model as ModelTier,
      tokens: row.tokens as number,
      hitCount: row.hit_count as number,
      createdAt: row.created_at as string,
      lastHitAt: row.last_hit_at as string,
    };
  }
}
