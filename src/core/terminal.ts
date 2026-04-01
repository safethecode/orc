import type { ConversationTurn } from "../config/types.ts";
import type { StreamResult, ToolUseEvent } from "../repl/streamer.ts";

// ── Transition: tracks why the loop continued ─────────────────────────

export type Transition =
  | { reason: "next_turn" }
  | { reason: "reactive_compact_retry" }
  | { reason: "max_output_tokens_recovery"; attempt: number }
  | { reason: "build_fix_retry"; issues: string[] }
  | { reason: "quality_retry"; issues: string[] }
  | { reason: "approval_resume"; command: string }
  | { reason: "question_resume"; answer: string }
  | { reason: "process_retry"; attempt: number };

// ── Terminal: why the loop exited ─────────────────────────────────────

export interface Terminal {
  reason:
    | "completed"
    | "max_turns"
    | "aborted"
    | "error"
    | "prompt_too_long"
    | "context_exhausted";
  text: string;
  turnCount: number;
  sessionId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

// ── QueryState: mutable state carried across loop iterations ──────────

export interface QueryState {
  messages: ConversationTurn[];
  turnCount: number;
  transition: Transition | undefined;
  maxOutputTokensRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  lastResult: StreamResult | null;
  sessionId: string | undefined;
}

// ── QueryEvent: yielded to the consumer during loop execution ─────────

export type QueryEvent =
  | { type: "text_delta"; text: string }
  | { type: "text_complete"; text: string }
  | { type: "tool_start"; name: string; id?: string }
  | { type: "tool_input_preview"; id: string; preview: string }
  | { type: "tool_use"; tool: ToolUseEvent }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: "error"; message: string }
  | { type: "error_recovery"; recovery: Recovery; transition: Transition }
  | { type: "context_compact"; stage: string; freedTokens: number }
  | { type: "approval_request"; command: string; message: string }
  | { type: "question_request"; question: string; options?: string[] }
  | { type: "turn_start"; turnCount: number }
  | { type: "turn_end"; turnCount: number };

// ── Recovery: error recovery decision ─────────────────────────────────

export type Recovery =
  | { type: "reactive_compact" }
  | { type: "max_output_tokens_resume"; attempt: number }
  | { type: "process_retry"; attempt: number }
  | { type: "build_fix"; issues: string[] }
  | { type: "quality_fix"; issues: string[] };

// ── CompressResult: output from context compression ───────────────────

export interface CompressResult {
  messages: ConversationTurn[];
  stages: CompressStageResult[];
  totalFreedTokens: number;
}

export interface CompressStageResult {
  stage: "snip" | "microcompact" | "autocompact" | "reactive_compact";
  freedTokens: number;
  turnsRemoved: number;
  turnsModified: number;
}

// ── QueryLoopParams: input to the query loop ──────────────────────────

export interface QueryLoopParams {
  prompt: string;
  buildCommand: (messages: ConversationTurn[], state: QueryState) => string[];
  signal?: AbortSignal;
  maxTurns?: number;
  onApproval?: (command: string, message: string) => Promise<boolean>;
  onQuestion?: (question: string, options?: string[]) => Promise<string | null>;
  contextWindow?: number;
  compressThresholds?: {
    snipAt: number;
    autocompactAt: number;
  };
}
