import type { ContextChunk } from "../config/types.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { CodebaseMap } from "./codebase-map.ts";
import type { Database } from "bun:sqlite";

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "about",
  "that", "this", "it", "its", "and", "or", "but", "if", "not", "no",
]);

export class ContextBuilder {
  constructor(
    private memory: MemoryStore,
    private codemap: CodebaseMap,
    private db: Database,
  ) {}

  async buildContext(
    prompt: string,
    options?: { maxTokens?: number; includeFiles?: boolean },
  ): Promise<string> {
    const maxTokens = options?.maxTokens ?? 2000;
    const keywords = this.extractKeywords(prompt);

    if (keywords.length === 0) return "";

    const chunks: ContextChunk[] = [
      ...this.searchMemory(keywords),
      ...this.searchCodemap(keywords),
      ...this.searchInsights(keywords),
    ];

    const ranked = this.rankAndTruncate(chunks, maxTokens);
    return this.formatContext(ranked);
  }

  private extractKeywords(prompt: string): string[] {
    return prompt
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^\w]/g, ""))
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
      .slice(0, 15);
  }

  private searchMemory(keywords: string[]): ContextChunk[] {
    const chunks: ContextChunk[] = [];
    for (const kw of keywords.slice(0, 5)) {
      const entries = this.memory.search(kw, undefined, 3);
      for (const entry of entries) {
        const relevance = this.scoreRelevance(entry.key + " " + entry.value, keywords);
        chunks.push({
          source: `memory:${entry.namespace}/${entry.key}`,
          content: entry.value,
          relevance,
          type: "memory",
        });
      }
    }
    return this.dedup(chunks);
  }

  private searchCodemap(keywords: string[]): ContextChunk[] {
    const chunks: ContextChunk[] = [];
    for (const kw of keywords.slice(0, 5)) {
      const entries = this.codemap.search(kw, 3);
      for (const entry of entries) {
        const relevance = this.scoreRelevance(entry.path + " " + entry.purpose, keywords);
        chunks.push({
          source: entry.path,
          content: `${entry.path}: ${entry.purpose}`,
          relevance,
          type: "codebase_map",
        });
      }
    }
    return this.dedup(chunks);
  }

  private searchInsights(keywords: string[]): ContextChunk[] {
    const chunks: ContextChunk[] = [];
    const query = keywords.slice(0, 3).join(" ");
    const entries = this.memory.search(query, "insights", 3);
    for (const entry of entries) {
      chunks.push({
        source: `insight:${entry.key}`,
        content: entry.value,
        relevance: this.scoreRelevance(entry.value, keywords),
        type: "insight",
      });
    }
    return chunks;
  }

  private scoreRelevance(text: string, keywords: string[]): number {
    const lower = text.toLowerCase();
    let matches = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) matches++;
    }
    return keywords.length > 0 ? matches / keywords.length : 0;
  }

  private dedup(chunks: ContextChunk[]): ContextChunk[] {
    const seen = new Set<string>();
    return chunks.filter((c) => {
      if (seen.has(c.source)) return false;
      seen.add(c.source);
      return true;
    });
  }

  private rankAndTruncate(chunks: ContextChunk[], maxTokens: number): ContextChunk[] {
    chunks.sort((a, b) => b.relevance - a.relevance);

    const result: ContextChunk[] = [];
    let tokenEstimate = 0;

    for (const chunk of chunks) {
      const chunkTokens = Math.ceil(chunk.content.length / 4);
      if (tokenEstimate + chunkTokens > maxTokens) break;
      result.push(chunk);
      tokenEstimate += chunkTokens;
    }

    return result;
  }

  formatContext(chunks: ContextChunk[]): string {
    if (chunks.length === 0) return "";
    const lines = chunks.map((c) => `- [${c.type}:${c.source}] ${c.content}`);
    return `Relevant context:\n${lines.join("\n")}`;
  }
}
