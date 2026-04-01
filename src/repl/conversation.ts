import type { ConversationTurn } from "../config/types.ts";
import {
  buildWindowedContext,
  estimateTokens,
  TIER_BUDGETS,
  type TokenBudget,
} from "../memory/token-optimizer.ts";

/**
 * Truncate a long content string, keeping head + tail with an omission notice.
 * Exported so ContextCompressor and other modules can reuse this logic.
 */
export function truncateTurnContent(content: string, maxLines = 15): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;

  const headCount = Math.ceil(maxLines * 0.67);
  const tailCount = maxLines - headCount;
  const head = lines.slice(0, headCount).join("\n");
  const tail = lines.slice(-tailCount).join("\n");
  const omitted = lines.length - maxLines;
  return `${head}\n\n[... ${omitted} lines omitted ...]\n\n${tail}`;
}

export class Conversation {
  private turns: ConversationTurn[] = [];
  private language: string | undefined;
  private tokenBudget: TokenBudget = TIER_BUDGETS.sonnet;
  private lastTier: string | undefined;

  setLanguage(lang: string): void {
    this.language = lang;
  }

  getLanguage(): string | undefined {
    return this.language;
  }

  setTokenBudget(budget: TokenBudget): void {
    this.tokenBudget = budget;
  }

  add(turn: ConversationTurn): void {
    // Inject model switch notice when tier changes
    if (turn.role === "assistant" && turn.tier && this.lastTier && turn.tier !== this.lastTier) {
      this.turns.push({
        role: "assistant",
        content: `[Model switched from ${this.lastTier} to ${turn.tier}]`,
        timestamp: new Date().toISOString(),
      });
    }
    if (turn.role === "assistant") this.lastTier = turn.tier;

    if (turn.role === "assistant" && turn.content.length > 2000) {
      this.turns.push({ ...turn, content: truncateTurnContent(turn.content) });
    } else {
      this.turns.push(turn);
    }
  }

  // Normalize: ensure tool call/output pairs are never split during windowing.
  // If an assistant turn references a tool call, the preceding user turn must also be included.
  getTurns(): ConversationTurn[] {
    return this.turns;
  }

  /**
   * Estimate the total token usage of the current conversation.
   */
  getTokenUsage(): number {
    let total = 0;
    for (const turn of this.turns) {
      total += estimateTokens(turn.content);
    }
    return total;
  }

  buildPrompt(userInput: string): string {
    if (this.turns.length === 0) return userInput;

    const windowed = buildWindowedContext(this.turns, this.tokenBudget);
    if (!windowed.context) return userInput;

    return `Previous conversation:\n${windowed.context}\n\nUser: ${userInput}`;
  }

  get length(): number {
    return this.turns.length;
  }

  clear(): void {
    this.turns = [];
  }

  lastAssistant(): ConversationTurn | undefined {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role === "assistant") return this.turns[i];
    }
    return undefined;
  }

  // ── Snapshot serialization ──────────────────────────────────────────

  toSnapshot(): { turns: ConversationTurn[]; language?: string } {
    return {
      turns: this.turns,
      language: this.language,
    };
  }

  static fromSnapshot(data: { turns: ConversationTurn[]; language?: string }): Conversation {
    const conv = new Conversation();
    conv.turns = data.turns;
    conv.language = data.language;
    return conv;
  }

  restore(snapshot: { turns: ConversationTurn[]; language?: string }): void {
    this.turns = snapshot.turns;
    this.language = snapshot.language;
  }

  generateSummary(): string {
    const userTurns = this.turns
      .filter((t) => t.role === "user")
      .slice(-3);
    return userTurns
      .map((t) => t.content.slice(0, 60).replace(/\n/g, " "))
      .join(", ");
  }

}
