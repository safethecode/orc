import type { ConversationTurn } from "../config/types.ts";

export interface CompactionConfig {
  maxTokens: number;
  preserveRecentTokens: number;
  protectedTools: string[];
  pruneOldOutputs: boolean;
}

export interface CompactionResult {
  originalTurns: number;
  compactedTurns: number;
  originalTokens: number;
  compactedTokens: number;
  summary: string;
  prunedToolOutputs: number;
}

/**
 * Token-aware context compaction. Preserves recent conversation turns intact,
 * truncates old tool outputs, and generates a structured summary of pruned
 * content so the agent retains essential context without exceeding the token
 * budget.
 */
export class ContextCompactor {
  private config: CompactionConfig;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = {
      maxTokens: 100_000,
      preserveRecentTokens: 40_000,
      protectedTools: ["skill", "lsp", "read"],
      pruneOldOutputs: true,
      ...config,
    };
  }

  /**
   * Compact a conversation by preserving recent turns, truncating old tool
   * outputs, and prepending a summary of pruned content.
   */
  compact(turns: ConversationTurn[]): {
    turns: ConversationTurn[];
    result: CompactionResult;
  } {
    if (turns.length === 0) {
      return {
        turns: [],
        result: {
          originalTurns: 0,
          compactedTurns: 0,
          originalTokens: 0,
          compactedTokens: 0,
          summary: "",
          prunedToolOutputs: 0,
        },
      };
    }

    const originalTokens = this.getTokenUsage(turns);
    const originalTurns = turns.length;

    // Step 1: Walk backward from the latest turn, marking recent turns to keep
    let recentTokens = 0;
    let recentBoundary = turns.length; // index where "recent" starts

    for (let i = turns.length - 1; i >= 0; i--) {
      const turnTokens = this.estimateTokens(turns[i].content);
      if (recentTokens + turnTokens > this.config.preserveRecentTokens) {
        recentBoundary = i + 1;
        break;
      }
      recentTokens += turnTokens;
      if (i === 0) {
        recentBoundary = 0;
      }
    }

    // Recent turns are kept intact
    const recentTurns = turns.slice(recentBoundary);

    // Older turns get processed
    const olderTurns = turns.slice(0, recentBoundary);

    if (olderTurns.length === 0) {
      // Everything fits within the recent window
      return {
        turns: [...recentTurns],
        result: {
          originalTurns,
          compactedTurns: recentTurns.length,
          originalTokens,
          compactedTokens: originalTokens,
          summary: "",
          prunedToolOutputs: 0,
        },
      };
    }

    // Step 2: Process older turns
    const keptOlderTurns: ConversationTurn[] = [];
    const prunedTurns: ConversationTurn[] = [];
    let prunedToolOutputs = 0;

    for (const turn of olderTurns) {
      const isProtected = this.isProtectedTurn(turn);

      if (isProtected) {
        // Protected tool outputs are always kept but may be truncated
        if (turn.content.length > 2000) {
          keptOlderTurns.push({
            ...turn,
            content: turn.content.slice(0, 500) + "\n\n...[truncated, protected tool output]",
          });
          prunedToolOutputs++;
        } else {
          keptOlderTurns.push(turn);
        }
      } else if (this.config.pruneOldOutputs && turn.content.length > 2000) {
        // Long tool outputs get truncated aggressively
        keptOlderTurns.push({
          ...turn,
          content: turn.content.slice(0, 500) + "\n\n...[truncated]",
        });
        prunedTurns.push(turn);
        prunedToolOutputs++;
      } else if (turn.content.length > 800) {
        // Medium-length turns get compressed
        keptOlderTurns.push({
          ...turn,
          content: turn.content.slice(0, 200) + "\n\n...[compressed, see conversation summary]",
        });
        prunedTurns.push(turn);
      } else {
        // Short turns are kept as-is
        keptOlderTurns.push(turn);
      }
    }

    // Step 3: Generate summary of pruned content
    const summary = this.generateSummary(prunedTurns);

    // Step 4: Build the compacted turn list
    const compactedTurns: ConversationTurn[] = [];

    if (summary) {
      compactedTurns.push({
        role: "assistant",
        content: summary,
        timestamp: new Date().toISOString(),
      });
    }

    compactedTurns.push(...keptOlderTurns, ...recentTurns);

    const compactedTokens = this.getTokenUsage(compactedTurns);

    return {
      turns: compactedTurns,
      result: {
        originalTurns,
        compactedTurns: compactedTurns.length,
        originalTokens,
        compactedTokens,
        summary,
        prunedToolOutputs,
      },
    };
  }

  /**
   * Estimate token count for a string.
   * Uses ~4 chars per token for English prose, ~3 for code-heavy content.
   */
  estimateTokens(text: string): number {
    if (!text) return 0;

    // Heuristic: if the text has lots of symbols/braces, it's likely code
    const codeIndicators = (text.match(/[{}();=<>]/g) || []).length;
    const codeRatio = codeIndicators / Math.max(text.length, 1);

    // Code-heavy content: ~3 chars/token; prose: ~4 chars/token
    const charsPerToken = codeRatio > 0.03 ? 3 : 4;

    return Math.ceil(text.length / charsPerToken);
  }

  /**
   * Generate a structured summary of pruned turns, extracting key information
   * like user requests, files mentioned, decisions, and errors.
   */
  generateSummary(prunedTurns: ConversationTurn[]): string {
    if (prunedTurns.length === 0) return "";

    const userRequests: string[] = [];
    const filesMentioned = new Set<string>();
    const decisions: string[] = [];
    const errors: string[] = [];

    for (const turn of prunedTurns) {
      const content = turn.content;

      // Extract user requests
      if (turn.role === "user") {
        const firstLine = content.split("\n")[0].trim();
        if (firstLine) {
          userRequests.push(
            firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine,
          );
        }
      }

      // Extract file paths (common patterns)
      const filePaths = content.match(
        /(?:^|\s|["'`])([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})(?:\s|["'`]|$|:|\))/gm,
      );
      if (filePaths) {
        for (const raw of filePaths) {
          const cleaned = raw.trim().replace(/^["'`]|["'`:]$/g, "").trim();
          if (
            cleaned.includes("/") &&
            !cleaned.startsWith("http") &&
            cleaned.length < 120
          ) {
            filesMentioned.add(cleaned);
          }
        }
      }

      // Extract decisions (look for decision-like language in assistant turns)
      if (turn.role === "assistant") {
        const decisionPatterns = [
          /(?:I'll|I will|Let's|We should|Going to|Decided to)\s+(.{10,100})/gi,
          /(?:Decision|Approach|Strategy):\s*(.{10,100})/gi,
        ];
        for (const pattern of decisionPatterns) {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const dec = match[1].trim().replace(/\.\s*$/, "");
            if (dec.length > 10) {
              decisions.push(dec.length > 120 ? dec.slice(0, 120) + "..." : dec);
            }
            if (decisions.length >= 5) break;
          }
          if (decisions.length >= 5) break;
        }
      }

      // Extract errors
      const errorPatterns = [
        /(?:error|Error|ERROR)[:]\s*(.{10,150})/g,
        /(?:failed|Failed|FAILED)[:]\s*(.{10,150})/g,
      ];
      for (const pattern of errorPatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const err = match[1].trim();
          errors.push(err.length > 120 ? err.slice(0, 120) + "..." : err);
          if (errors.length >= 3) break;
        }
        if (errors.length >= 3) break;
      }
    }

    // Build the summary
    const sections: string[] = [
      "[CONVERSATION SUMMARY - Earlier context was compacted]",
      "",
    ];

    if (userRequests.length > 0) {
      sections.push("User requests:");
      for (const req of userRequests.slice(0, 10)) {
        sections.push(`  - ${req}`);
      }
      sections.push("");
    }

    if (filesMentioned.size > 0) {
      const files = [...filesMentioned].slice(0, 20);
      sections.push(`Files discussed: ${files.join(", ")}`);
      sections.push("");
    }

    if (decisions.length > 0) {
      sections.push("Key decisions:");
      for (const dec of decisions) {
        sections.push(`  - ${dec}`);
      }
      sections.push("");
    }

    if (errors.length > 0) {
      sections.push("Errors encountered:");
      for (const err of errors) {
        sections.push(`  - ${err}`);
      }
      sections.push("");
    }

    sections.push(
      `[${prunedTurns.length} turn(s) were compacted to save context space]`,
    );

    return sections.join("\n");
  }

  /** Check if compaction is needed based on total token usage. */
  needsCompaction(turns: ConversationTurn[]): boolean {
    return this.getTokenUsage(turns) > this.config.maxTokens;
  }

  /** Get total estimated token usage across all turns. */
  getTokenUsage(turns: ConversationTurn[]): number {
    let total = 0;
    for (const turn of turns) {
      total += this.estimateTokens(turn.content);
    }
    return total;
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  /**
   * Check if a turn contains output from a protected tool.
   * We look for tool name markers in the content since ConversationTurn
   * does not carry structured tool metadata.
   */
  private isProtectedTurn(turn: ConversationTurn): boolean {
    for (const tool of this.config.protectedTools) {
      // Check for common tool-output markers
      if (
        turn.content.includes(`[${tool}]`) ||
        turn.content.includes(`tool: ${tool}`) ||
        turn.content.includes(`Tool: ${tool}`)
      ) {
        return true;
      }
    }
    return false;
  }
}
