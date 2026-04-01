# Orc Core Query Loop Redesign

## Overview

Redesign Orc's core execution loop to match Claude Code's state machine pattern, eliminating the "choppy" feel in both single-agent REPL and multi-agent orchestration.

**Approach:** Subprocess spawn architecture stays. The core loop becomes a while(true) state machine with phased execution, multi-stage context compression, structured error recovery, and streaming improvements.

## Problem Statement

Current issues:
1. **Streaming feels disconnected** — tool calls appear all-at-once after block completion instead of progressively
2. **Context management is primitive** — only windowed context (recent N turns), no compression chain
3. **Error recovery is flat** — retry counter with same approach, no per-error-type recovery paths
4. **Stage transitions are abrupt** — approval/question handling aborts streamer and restarts session, breaking flow
5. **No structured state tracking** — retry loop uses attempt counter, not typed transitions

## Architecture

### New Files

- `src/core/query-loop.ts` — State machine core loop (single-agent)
- `src/core/context-compressor.ts` — 4-stage compression chain
- `src/core/terminal.ts` — Terminal/Transition/QueryState type definitions

### Modified Files

- `src/repl/streamer.ts` — Add tool_start event, improve tool streaming
- `src/repl/conversation.ts` — Extract snip/microcompact as standalone methods
- `src/repl/repl-controller.ts` — Replace executeWithRetry with queryLoop
- `src/core/supervisor.ts` — Integrate context compression into worker execution
- `src/core/feedback-loop.ts` — Use transition-based monitoring

## Design

### 1. Core Query Loop State Machine (`query-loop.ts`)

```typescript
type QueryState = {
  messages: ConversationTurn[]
  turnCount: number
  transition: Transition | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  pendingApproval: PendingApproval | null
  pendingQuestion: PendingQuestion | null
}

type Transition =
  | { reason: 'next_turn' }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'build_fix_retry'; issues: string[] }
  | { reason: 'quality_retry'; issues: string[] }
  | { reason: 'approval_resume'; approved: boolean }
  | { reason: 'question_resume'; answer: string }

type Terminal = {
  reason: 'completed' | 'max_turns' | 'aborted' | 'error' | 'prompt_too_long'
  text: string
  turnCount: number
  sessionId?: string
  usage?: { inputTokens: number; outputTokens: number; costUsd: number }
}
```

**Loop structure:**

```typescript
async function* queryLoop(params: QueryLoopParams): AsyncGenerator<QueryEvent, Terminal> {
  let state: QueryState = initState(params)

  while (true) {
    // Phase 1: Context compression
    const compressed = await compressContext(state.messages, params.compressor)

    // Phase 2: Build command + stream subprocess
    const cmd = buildCommand(params, compressed.messages, state)
    const streamer = new AgentStreamer()
    // ... setup event handlers, yield streaming events ...
    const result = await streamer.run(cmd, params.signal)

    // Phase 3: Error recovery
    const recovery = checkRecovery(result, state)
    if (recovery) {
      state = applyRecovery(state, recovery)
      continue
    }

    // Phase 4: Post-execution checks (build, quality gate)
    const postCheck = await runPostChecks(result, params, state)
    if (postCheck.retry) {
      state = applyRetry(state, postCheck)
      continue
    }

    // Phase 5: Approval/Question handling (within loop, no abort)
    if (result.pendingApproval) {
      const approved = yield { type: 'approval_request', ...result.pendingApproval }
      state = { ...state, transition: { reason: 'approval_resume', approved } }
      continue
    }

    // Phase 6: Continue or terminate
    if (result.needsFollowUp) {
      state = { ...state, turnCount: state.turnCount + 1, transition: { reason: 'next_turn' } }
      continue
    }

    return buildTerminal(result, state)
  }
}
```

### 2. Context Compressor (`context-compressor.ts`)

Four compression stages executed in order:

```typescript
class ContextCompressor {
  // Stage 1: Remove oldest turns (cheap, no LLM)
  snip(messages: ConversationTurn[], threshold: number): SnipResult

  // Stage 2: Truncate long tool results / assistant responses
  microcompact(messages: ConversationTurn[]): MicrocompactResult

  // Stage 3: LLM-powered summarization of old messages
  async autocompact(messages: ConversationTurn[], provider: ProviderConfig): AutocompactResult

  // Stage 4: Emergency compression on prompt-too-long
  async reactiveCompact(messages: ConversationTurn[], provider: ProviderConfig): ReactiveCompactResult

  // Orchestrator: run the chain in order
  async compress(messages: ConversationTurn[], opts: CompressOptions): CompressResult
}
```

**Compression thresholds (configurable per model tier):**
- Snip: when estimated tokens > 70% of context window
- Autocompact: when estimated tokens > 85% of context window
- Reactive: on 413 error only

**Token estimation:**
- Use existing `estimateTokens()` from token-optimizer
- Track `freedTokens` at each stage for next-stage decisions

### 3. Streamer Improvements (`streamer.ts`)

New events:
```typescript
// Emitted at content_block_start when tool_use type detected
emit("tool_start", { name: string, id: string })

// Emitted during input_json_delta with partial info
emit("tool_input_preview", { id: string, preview: string })
```

Changes to processMessage:
- On `content_block_start` with `type: "tool_use"`: immediately emit `tool_start` with name
- On `input_json_delta`: attempt partial parse, emit preview of file_path or command
- On `content_block_stop`: emit full `tool_use` as before

### 4. Error Recovery Chain

Recovery decisions based on error type + transition history:

```typescript
function checkRecovery(result: StreamResult, state: QueryState): Recovery | null {
  // Prompt too long → compress and retry
  if (result.error?.includes('prompt_too_long')) {
    if (state.transition?.reason === 'reactive_compact_retry') return null // already tried
    return { type: 'reactive_compact' }
  }

  // Max output tokens → resume message
  if (result.error?.includes('max_output_tokens')) {
    if (state.maxOutputTokensRecoveryCount >= 3) return null
    return { type: 'max_output_tokens_resume', attempt: state.maxOutputTokensRecoveryCount + 1 }
  }

  // Process crash/timeout → retry with backoff
  if (result.exitCode !== 0 && !result.text) {
    return { type: 'process_retry' }
  }

  return null
}
```

### 5. REPL Integration

`repl-controller.ts` changes:
- Replace `executeWithRetry()` with call to `queryLoop()`
- Consume queryLoop's async generator events for UI updates
- Approval/question handled via generator yield/next pattern
- Multi-agent path: supervisor uses same queryLoop per worker (via StreamerWorkerStrategy)

```typescript
// In handleNaturalInput:
for await (const event of queryLoop(params)) {
  switch (event.type) {
    case 'text_delta': renderer.appendText(event.text); break
    case 'tool_start': renderer.showToolSpinner(event.name); break
    case 'tool_use': renderer.showToolComplete(event); break
    case 'approval_request': /* show approval UI, send response */ break
    case 'error_recovery': renderer.showRecovery(event); break
    case 'context_compact': renderer.showCompaction(event); break
  }
}
```

### 6. Supervisor Integration

- Workers get `ContextCompressor` instance from orchestrator
- Each worker's feedback loop uses transition tracking
- `executeSubtask()` wraps streaming in same queryLoop pattern
- Context compression applies per-worker (not globally)

## Implementation Order

1. Type definitions (terminal.ts)
2. Context compressor (context-compressor.ts)
3. Conversation snip/microcompact extraction
4. Streamer tool_start event
5. Core query loop (query-loop.ts)
6. REPL controller integration
7. Supervisor integration
8. Tests

## Success Criteria

- Single-agent REPL conversation flows without "choppy" transitions
- Tool calls appear progressively (name shown before input fully parsed)
- Long conversations don't lose context (compression chain activates)
- Errors auto-recover without user intervention where possible
- Multi-agent workers benefit from same improvements
- No regression in existing functionality (routing, quality gate, design flow)
