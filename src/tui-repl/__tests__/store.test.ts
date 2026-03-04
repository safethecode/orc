import { describe, it, expect } from "bun:test";
import { INITIAL_STATE, reducer, createMessage } from "../store.ts";
import type { ModelTier } from "../../config/types.ts";

describe("store reducer", () => {
  it("appends message", () => {
    const msg = createMessage("user", "hello");
    const state = reducer(INITIAL_STATE, { type: "APPEND_MESSAGE", message: msg });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("hello");
  });

  it("starts streaming", () => {
    const state = reducer(INITIAL_STATE, { type: "STREAMING_START", tier: "sonnet" as ModelTier });
    expect(state.isStreaming).toBe(true);
    expect(state.streamingTier).toBe("sonnet");
    expect(state.streamingChunk).toBe("");
  });

  it("accumulates streaming deltas", () => {
    let state = reducer(INITIAL_STATE, { type: "STREAMING_START", tier: "sonnet" as ModelTier });
    state = reducer(state, { type: "STREAMING_DELTA", text: "hel" });
    state = reducer(state, { type: "STREAMING_DELTA", text: "lo" });
    expect(state.streamingChunk).toBe("hello");
  });

  it("commits streaming to message", () => {
    let state = reducer(INITIAL_STATE, { type: "STREAMING_START", tier: "sonnet" as ModelTier });
    state = reducer(state, { type: "STREAMING_DELTA", text: "response" });
    state = reducer(state, { type: "STREAMING_COMMIT" });
    expect(state.isStreaming).toBe(false);
    expect(state.streamingChunk).toBe("");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].type).toBe("assistant");
    expect(state.messages[0].content).toBe("response");
  });

  it("commits empty streaming without adding message", () => {
    let state = reducer(INITIAL_STATE, { type: "STREAMING_START", tier: "sonnet" as ModelTier });
    state = reducer(state, { type: "STREAMING_COMMIT" });
    expect(state.messages).toHaveLength(0);
    expect(state.isStreaming).toBe(false);
  });

  it("updates status", () => {
    const state = reducer(INITIAL_STATE, {
      type: "STATUS_UPDATE",
      partial: { agentState: "thinking", agentName: "coder", tier: "sonnet" as ModelTier },
    });
    expect(state.status.agentState).toBe("thinking");
    expect(state.status.agentName).toBe("coder");
    expect(state.status.tier).toBe("sonnet");
  });

  it("clears messages", () => {
    let state = reducer(INITIAL_STATE, { type: "APPEND_MESSAGE", message: createMessage("user", "hello") });
    state = reducer(state, { type: "CLEAR" });
    expect(state.messages).toHaveLength(0);
  });
});
