import type { ConversationTurn } from "../config/types.ts";

export interface TokenBudget {
  maxContextTokens: number;
  reserveForResponse: number;
  reserveForSystem: number;
}

export const TIER_BUDGETS: Record<string, TokenBudget> = {
  haiku:  { maxContextTokens: 2000, reserveForResponse: 2000, reserveForSystem: 300 },
  sonnet: { maxContextTokens: 4000, reserveForResponse: 4000, reserveForSystem: 500 },
  opus:   { maxContextTokens: 8000, reserveForResponse: 8000, reserveForSystem: 800 },
};

export interface WindowedContext {
  context: string;
  includedTurns: number;
  totalTurns: number;
  estimatedTokens: number;
  droppedSummary: string | null;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function buildWindowedContext(
  turns: ConversationTurn[],
  budget: TokenBudget,
): WindowedContext {
  if (turns.length === 0) {
    return { context: "", includedTurns: 0, totalTurns: 0, estimatedTokens: 0, droppedSummary: null };
  }

  const available = budget.maxContextTokens - budget.reserveForSystem;
  const formatted: string[] = [];
  let tokenCount = 0;
  let startIdx = turns.length;

  // Always include last 2 turns (immediate context)
  const minTurns = Math.min(2, turns.length);

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const prefix = turn.role === "user" ? "User" : `Assistant (${turn.agentName ?? "unknown"})`;
    const line = `${prefix}: ${turn.content}`;
    const lineTokens = estimateTokens(line);

    if (tokenCount + lineTokens > available && turns.length - i > minTurns) {
      // Tool pair normalization: never split a user turn from the following assistant turn
      // If we're about to exclude a user turn but already included the next assistant turn,
      // also exclude that assistant turn to keep pairs intact
      if (turn.role === "user" && formatted.length > 0 && i + 1 < turns.length && turns[i + 1].role === "assistant") {
        const assistantLine = formatted.shift();
        if (assistantLine) tokenCount -= estimateTokens(assistantLine);
        startIdx = i + 2;
      }
      break;
    }

    formatted.unshift(line);
    tokenCount += lineTokens;
    startIdx = i;
  }

  // Generate summary of dropped turns
  let droppedSummary: string | null = null;
  if (startIdx > 0) {
    const droppedUserTurns = turns
      .slice(0, startIdx)
      .filter((t) => t.role === "user")
      .slice(-3);

    if (droppedUserTurns.length > 0) {
      const topics = droppedUserTurns
        .map((t) => t.content.slice(0, 60).replace(/\n/g, " "))
        .join("; ");
      droppedSummary = `[Earlier topics: ${topics}]`;
    }
  }

  const contextParts: string[] = [];
  if (droppedSummary) contextParts.push(droppedSummary);
  contextParts.push(formatted.join("\n\n"));

  return {
    context: contextParts.join("\n\n"),
    includedTurns: formatted.length,
    totalTurns: turns.length,
    estimatedTokens: tokenCount + (droppedSummary ? estimateTokens(droppedSummary) : 0),
    droppedSummary,
  };
}
