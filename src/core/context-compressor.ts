import type { ConversationTurn } from "../config/types.ts";
import type { CompressResult, CompressStageResult } from "./terminal.ts";
import { ContextCompactor } from "./compaction.ts";
import { estimateTokens } from "../memory/token-optimizer.ts";

export interface CompressorConfig {
  contextWindow: number;
  snipThreshold: number;
  autocompactThreshold: number;
  protectedTools: string[];
}

const DEFAULT_CONFIG: CompressorConfig = {
  contextWindow: 200_000,
  snipThreshold: 0.7,
  autocompactThreshold: 0.85,
  protectedTools: ["skill", "lsp", "read"],
};

export class ConversationCompressor {
  private config: CompressorConfig;
  private compactor: ContextCompactor;

  constructor(config?: Partial<CompressorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.compactor = new ContextCompactor({
      maxTokens: this.config.contextWindow,
      preserveRecentTokens: Math.floor(this.config.contextWindow * 0.4),
      protectedTools: this.config.protectedTools,
      pruneOldOutputs: true,
    });
  }

  async compress(messages: ConversationTurn[]): Promise<CompressResult> {
    const stages: CompressStageResult[] = [];
    let current = messages;
    let totalFreed = 0;

    const tokensBefore = this.getTokenCount(current);
    const snipThreshold = Math.floor(this.config.contextWindow * this.config.snipThreshold);
    const autocompactThreshold = Math.floor(this.config.contextWindow * this.config.autocompactThreshold);

    // Stage 1: snip — remove oldest turns (cheapest)
    if (tokensBefore > snipThreshold) {
      const result = this.snip(current, snipThreshold);
      const freed = tokensBefore - this.getTokenCount(result.messages);
      if (freed > 0) {
        stages.push({
          stage: "snip",
          freedTokens: freed,
          turnsRemoved: result.turnsRemoved,
          turnsModified: 0,
        });
        totalFreed += freed;
        current = result.messages;
      }
    }

    // Stage 2: microcompact — truncate long tool results
    const tokensAfterSnip = this.getTokenCount(current);
    if (tokensAfterSnip > snipThreshold) {
      const result = this.microcompact(current);
      const freed = tokensAfterSnip - this.getTokenCount(result.messages);
      if (freed > 0) {
        stages.push({
          stage: "microcompact",
          freedTokens: freed,
          turnsRemoved: 0,
          turnsModified: result.turnsModified,
        });
        totalFreed += freed;
        current = result.messages;
      }
    }

    // Stage 3: autocompact — use existing ContextCompactor for heavy compression
    const tokensAfterMicro = this.getTokenCount(current);
    if (tokensAfterMicro > autocompactThreshold) {
      const result = this.autocompact(current);
      const freed = tokensAfterMicro - this.getTokenCount(result.messages);
      if (freed > 0) {
        stages.push({
          stage: "autocompact",
          freedTokens: freed,
          turnsRemoved: result.turnsRemoved,
          turnsModified: result.turnsModified,
        });
        totalFreed += freed;
        current = result.messages;
      }
    }

    return { messages: current, stages, totalFreedTokens: totalFreed };
  }

  reactiveCompact(messages: ConversationTurn[]): CompressResult {
    const tokensBefore = this.getTokenCount(messages);

    // Emergency: aggressive compaction using ContextCompactor with tight budget
    const emergencyCompactor = new ContextCompactor({
      maxTokens: Math.floor(this.config.contextWindow * 0.5),
      preserveRecentTokens: Math.floor(this.config.contextWindow * 0.25),
      protectedTools: this.config.protectedTools,
      pruneOldOutputs: true,
    });

    const { turns: compacted, result } = emergencyCompactor.compact(messages);

    const freed = tokensBefore - this.getTokenCount(compacted);

    return {
      messages: compacted,
      stages: [{
        stage: "reactive_compact",
        freedTokens: freed,
        turnsRemoved: result.originalTurns - result.compactedTurns,
        turnsModified: result.prunedToolOutputs,
      }],
      totalFreedTokens: freed,
    };
  }

  needsCompression(messages: ConversationTurn[]): boolean {
    const tokens = this.getTokenCount(messages);
    return tokens > Math.floor(this.config.contextWindow * this.config.snipThreshold);
  }

  getTokenCount(messages: ConversationTurn[]): number {
    let total = 0;
    for (const msg of messages) {
      total += estimateTokens(msg.content);
    }
    return total;
  }

  // ── Stage implementations ──────────────────────────────────────────

  private snip(
    messages: ConversationTurn[],
    targetTokens: number,
  ): { messages: ConversationTurn[]; turnsRemoved: number } {
    let tokens = this.getTokenCount(messages);
    let removeCount = 0;

    // Remove oldest turns one by one until under threshold
    // Keep at least the 3 most recent turns
    const minKeep = Math.min(3, messages.length);
    const maxRemove = messages.length - minKeep;

    while (tokens > targetTokens && removeCount < maxRemove) {
      tokens -= estimateTokens(messages[removeCount].content);
      removeCount++;
    }

    if (removeCount === 0) {
      return { messages, turnsRemoved: 0 };
    }

    // Generate a brief notice about snipped turns
    const snipNotice: ConversationTurn = {
      role: "assistant",
      content: `[${removeCount} earlier turn(s) removed to save context]`,
      timestamp: new Date().toISOString(),
    };

    return {
      messages: [snipNotice, ...messages.slice(removeCount)],
      turnsRemoved: removeCount,
    };
  }

  private microcompact(
    messages: ConversationTurn[],
  ): { messages: ConversationTurn[]; turnsModified: number } {
    let modified = 0;

    const result = messages.map((turn) => {
      // Only compact assistant turns with long content
      if (turn.content.length <= 2000) return turn;

      const lines = turn.content.split("\n");
      if (lines.length <= 20) return turn;

      modified++;

      // Keep first 10 lines + last 5 lines
      const head = lines.slice(0, 10).join("\n");
      const tail = lines.slice(-5).join("\n");
      const omitted = lines.length - 15;

      return {
        ...turn,
        content: `${head}\n\n[... ${omitted} lines omitted ...]\n\n${tail}`,
      };
    });

    return { messages: result, turnsModified: modified };
  }

  private autocompact(
    messages: ConversationTurn[],
  ): { messages: ConversationTurn[]; turnsRemoved: number; turnsModified: number } {
    const { turns, result } = this.compactor.compact(messages);
    return {
      messages: turns,
      turnsRemoved: result.originalTurns - result.compactedTurns,
      turnsModified: result.prunedToolOutputs,
    };
  }
}
