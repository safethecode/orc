import { AgentStreamer, type ToolUseEvent, type StreamResult, type ToolStartEvent, type ToolInputPreviewEvent } from "../repl/streamer.ts";
import { ConversationCompressor } from "./context-compressor.ts";
import type {
  QueryState,
  QueryEvent,
  Terminal,
  Transition,
  Recovery,
  QueryLoopParams,
} from "./terminal.ts";
import type { ConversationTurn } from "../config/types.ts";

const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
const DEFAULT_CONTEXT_WINDOW = 200_000;

function initState(params: QueryLoopParams): QueryState {
  return {
    messages: [],
    turnCount: 0,
    transition: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    lastResult: null,
    sessionId: undefined,
  };
}

function buildTerminal(result: StreamResult, state: QueryState): Terminal {
  return {
    reason: "completed",
    text: result.text,
    turnCount: state.turnCount,
    sessionId: state.sessionId ?? result.sessionId,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    },
  };
}

function checkRecovery(
  result: StreamResult,
  exitCode: number | null,
  state: QueryState,
): Recovery | null {
  const text = result.text.toLowerCase();
  const hasError = exitCode !== 0;

  // Prompt too long → compress and retry
  if (hasError && (text.includes("prompt_too_long") || text.includes("prompt is too long"))) {
    if (state.transition?.reason === "reactive_compact_retry") return null;
    if (state.hasAttemptedReactiveCompact) return null;
    return { type: "reactive_compact" };
  }

  // Max output tokens → resume message
  if (text.includes("max_output_tokens") || text.includes("output token limit")) {
    if (state.maxOutputTokensRecoveryCount >= MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) return null;
    return { type: "max_output_tokens_resume", attempt: state.maxOutputTokensRecoveryCount + 1 };
  }

  // Process crash/timeout with no output → retry
  if (hasError && !result.text.trim() && exitCode !== null) {
    const attempt = state.transition?.reason === "process_retry"
      ? (state.transition as { attempt: number }).attempt + 1
      : 1;
    if (attempt > 3) return null;
    return { type: "process_retry", attempt };
  }

  return null;
}

function applyRecovery(state: QueryState, recovery: Recovery): { state: QueryState; resumePrompt?: string } {
  switch (recovery.type) {
    case "reactive_compact":
      return {
        state: {
          ...state,
          hasAttemptedReactiveCompact: true,
          transition: { reason: "reactive_compact_retry" },
        },
      };

    case "max_output_tokens_resume":
      return {
        state: {
          ...state,
          maxOutputTokensRecoveryCount: recovery.attempt,
          transition: { reason: "max_output_tokens_recovery", attempt: recovery.attempt },
        },
        resumePrompt: "Output token limit hit. Resume directly from where you left off. Do not repeat previous content.",
      };

    case "process_retry":
      return {
        state: {
          ...state,
          transition: { reason: "process_retry", attempt: recovery.attempt },
        },
      };

    case "build_fix":
      return {
        state: {
          ...state,
          transition: { reason: "build_fix_retry", issues: recovery.issues },
        },
        resumePrompt: `[BUILD FAILED]\n\n## Build issues to fix\n${recovery.issues.map(i => `- ${i}`).join("\n")}\n\nFix all build issues while keeping the original task completed.`,
      };

    case "quality_fix":
      return {
        state: {
          ...state,
          transition: { reason: "quality_retry", issues: recovery.issues },
        },
        resumePrompt: `[QUALITY GATE FAILED]\n\n## Issues to fix\n${recovery.issues.map(i => `- ${i}`).join("\n")}\n\nFix ALL issues. The original task must still be fully completed.`,
      };
  }
}

export interface StreamerCallbacks {
  onToolUse?: (tool: ToolUseEvent) => { abort: boolean; pendingApproval?: { command: string; message: string }; pendingQuestion?: { question: string; options?: string[] } };
  onError?: (msg: string) => void;
}

/**
 * Core query loop: a while(true) state machine that drives the agentic interaction.
 *
 * Phases per iteration:
 *   1. Context compression (snip → microcompact → autocompact)
 *   2. Build command + stream subprocess
 *   3. Error recovery (prompt-too-long, max-tokens, timeout)
 *   4. Post-execution checks (build, quality)
 *   5. Approval/Question handling
 *   6. Continue or terminate
 */
export async function* queryLoop(
  params: QueryLoopParams,
  callbacks?: StreamerCallbacks,
): AsyncGenerator<QueryEvent, Terminal> {
  const contextWindow = params.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const thresholds = params.compressThresholds ?? {
    snipAt: 0.7,
    autocompactAt: 0.85,
  };
  const compressor = new ConversationCompressor({
    contextWindow,
    snipThreshold: thresholds.snipAt,
    autocompactThreshold: thresholds.autocompactAt,
  });

  let state = initState(params);
  let resumePrompt: string | undefined;

  while (true) {
    // ── Phase 1: Context compression ────────────────────────────────

    yield { type: "turn_start", turnCount: state.turnCount };

    if (compressor.needsCompression(state.messages)) {
      const result = await compressor.compress(state.messages);
      state.messages = result.messages;
      for (const stage of result.stages) {
        yield { type: "context_compact", stage: stage.stage, freedTokens: stage.freedTokens };
      }
    }

    // On reactive compact retry, apply emergency compression
    if (state.transition?.reason === "reactive_compact_retry") {
      const result = compressor.reactiveCompact(state.messages);
      state.messages = result.messages;
      for (const stage of result.stages) {
        yield { type: "context_compact", stage: stage.stage, freedTokens: stage.freedTokens };
      }
    }

    // ── Phase 2: Build command + stream subprocess ──────────────────

    const prompt = resumePrompt ?? params.prompt;
    const cmd = params.buildCommand(state.messages, state);
    resumePrompt = undefined;

    const streamer = new AgentStreamer();
    let toolUseCount = 0;
    let pendingApproval: { command: string; message: string } | null = null as { command: string; message: string } | null;
    let pendingQuestion: { question: string; options?: string[] } | null = null as { question: string; options?: string[] } | null;
    let abortedByInterception = false;

    // Wire streaming events to yield QueryEvents
    const textChunks: string[] = [];

    streamer.on("text_delta", (delta: string) => {
      textChunks.push(delta);
    });

    streamer.on("tool_start", (event: ToolStartEvent) => {
      // Will be yielded via the events array
    });

    streamer.on("tool_input_preview", (event: ToolInputPreviewEvent) => {
      // Will be yielded via the events array
    });

    // Collect events for ordered yielding after streaming
    const streamEvents: QueryEvent[] = [];
    let lastTextFlush = 0;

    streamer.on("text_delta", (delta: string) => {
      streamEvents.push({ type: "text_delta", text: delta });
    });

    // Remove duplicate text_delta handler — use only the streamEvents one
    streamer.removeAllListeners("text_delta");
    streamer.on("text_delta", (delta: string) => {
      streamEvents.push({ type: "text_delta", text: delta });
    });

    streamer.on("text_complete", (text: string) => {
      streamEvents.push({ type: "text_complete", text });
    });

    streamer.on("tool_start", (event: ToolStartEvent) => {
      streamEvents.push({ type: "tool_start", name: event.name, id: event.id });
    });

    streamer.on("tool_input_preview", (event: ToolInputPreviewEvent) => {
      streamEvents.push({ type: "tool_input_preview", id: event.id, preview: event.preview });
    });

    streamer.on("tool_use", (tool: ToolUseEvent) => {
      toolUseCount++;
      streamEvents.push({ type: "tool_use", tool });

      // Delegate tool interception to callbacks
      if (callbacks?.onToolUse) {
        const result = callbacks.onToolUse(tool);
        if (result.abort) {
          abortedByInterception = true;
          if (result.pendingApproval) pendingApproval = result.pendingApproval;
          if (result.pendingQuestion) pendingQuestion = result.pendingQuestion;
          streamer.abort();
        }
      }
    });

    streamer.on("usage", (u: { inputTokens: number; outputTokens: number; costUsd: number }) => {
      streamEvents.push({ type: "usage", ...u });
    });

    streamer.on("error", (msg: string) => {
      streamEvents.push({ type: "error", message: msg });
      callbacks?.onError?.(msg);
    });

    // Run the subprocess
    let result: StreamResult;
    let exitCode: number | null = null;
    try {
      result = await streamer.run(cmd, params.signal);
      // Capture exit code from the process
      exitCode = (streamer as any).proc?.exitCode ?? null;
    } catch (e) {
      // Process failed entirely
      const errorMsg = (e as Error).message ?? String(e);
      yield { type: "error", message: errorMsg };

      const recovery = checkRecovery(
        { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0 },
        1,
        state,
      );
      if (recovery) {
        const applied = applyRecovery(state, recovery);
        state = applied.state;
        resumePrompt = applied.resumePrompt;
        yield { type: "error_recovery", recovery, transition: state.transition! };
        continue;
      }

      return {
        reason: "error",
        text: errorMsg,
        turnCount: state.turnCount,
      };
    }

    // Yield all collected stream events
    for (const event of streamEvents) {
      yield event;
    }

    // Track session ID
    if (result.sessionId) {
      state.sessionId = result.sessionId;
    }

    yield { type: "turn_end", turnCount: state.turnCount };

    // ── Phase 3: Error recovery ─────────────────────────────────────

    if (params.signal?.aborted) {
      return {
        reason: "aborted",
        text: result.text,
        turnCount: state.turnCount,
        sessionId: state.sessionId,
      };
    }

    const recovery = checkRecovery(result, exitCode ?? (result.text ? 0 : 1), state);
    if (recovery) {
      const applied = applyRecovery(state, recovery);
      state = applied.state;
      resumePrompt = applied.resumePrompt;
      state.lastResult = result;
      yield { type: "error_recovery", recovery, transition: state.transition! };
      continue;
    }

    // ── Phase 4: Approval/Question handling (in-loop, no session break) ─

    if (pendingApproval && params.onApproval) {
      const approved = await params.onApproval(pendingApproval.command, pendingApproval.message);
      if (approved) {
        state.transition = { reason: "approval_resume", command: pendingApproval.command };
        resumePrompt = `The user approved the command: \`${pendingApproval.command}\`. Execute it now and continue from where you left off.`;
        state.lastResult = result;
        pendingApproval = null;
        continue;
      } else {
        return {
          reason: "completed",
          text: "(user denied the command)",
          turnCount: state.turnCount,
        };
      }
    }

    if (pendingQuestion && params.onQuestion) {
      const answer = await params.onQuestion(pendingQuestion.question, pendingQuestion.options);
      if (answer) {
        state.transition = { reason: "question_resume", answer };
        resumePrompt = `[The agent asked: "${pendingQuestion.question}" — User answered: "${answer}". Continue with this answer.]`;
        state.lastResult = result;
        pendingQuestion = null;
        continue;
      } else {
        return {
          reason: "completed",
          text: result.text,
          turnCount: state.turnCount,
        };
      }
    }

    // ── Phase 5: State update + loop continuation ───────────────────

    state.lastResult = result;
    state.turnCount++;

    // Reset recovery counters on successful turn
    state.maxOutputTokensRecoveryCount = 0;
    state.hasAttemptedReactiveCompact = false;
    state.transition = { reason: "next_turn" };

    // Check max turns
    if (params.maxTurns && state.turnCount >= params.maxTurns) {
      return {
        reason: "max_turns",
        text: result.text,
        turnCount: state.turnCount,
        sessionId: state.sessionId,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
        },
      };
    }

    // If no tool use and no interception, this is a natural end
    if (toolUseCount === 0 && !abortedByInterception) {
      return buildTerminal(result, state);
    }

    // Add assistant response to message history for next iteration
    if (result.text) {
      state.messages.push({
        role: "assistant",
        content: result.text,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
