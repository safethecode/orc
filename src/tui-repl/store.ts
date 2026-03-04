import { createContext, useContext, useReducer, type Dispatch } from "react";
import type { ModelTier } from "../config/types.ts";

export type MessageType =
  | "welcome"
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "error"
  | "cost"
  | "separator";

export interface MessageMeta {
  agentName?: string;
  tier?: ModelTier;
  reason?: string;
  toolName?: string;
  toolDetail?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  passed?: boolean;
  issues?: string[];
}

export interface Message {
  id: string;
  type: MessageType;
  content: string;
  meta?: MessageMeta;
  timestamp: number;
}

let nextId = 0;
export function createMessage(
  type: MessageType,
  content: string,
  meta?: MessageMeta,
): Message {
  return {
    id: `msg-${++nextId}`,
    type,
    content,
    meta,
    timestamp: Date.now(),
  };
}

// ── State ────────────────────────────────────────────────────────────

export interface StoreState {
  messages: Message[];
  streamingChunk: string;
  streamingTier: ModelTier | null;
  isStreaming: boolean;
}

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "APPEND_MESSAGE"; message: Message }
  | { type: "STREAMING_START"; tier: ModelTier }
  | { type: "STREAMING_DELTA"; text: string }
  | { type: "STREAMING_COMMIT" }
  | { type: "CLEAR" };

function reducer(state: StoreState, action: Action): StoreState {
  switch (action.type) {
    case "APPEND_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "STREAMING_START":
      return { ...state, streamingChunk: "", streamingTier: action.tier, isStreaming: true };
    case "STREAMING_DELTA":
      return { ...state, streamingChunk: state.streamingChunk + action.text };
    case "STREAMING_COMMIT": {
      if (!state.streamingChunk) return { ...state, isStreaming: false, streamingTier: null };
      const msg = createMessage("assistant", state.streamingChunk, { tier: state.streamingTier ?? undefined });
      return {
        ...state,
        messages: [...state.messages, msg],
        streamingChunk: "",
        streamingTier: null,
        isStreaming: false,
      };
    }
    case "CLEAR":
      return { ...state, messages: [] };
    default:
      return state;
  }
}

const INITIAL_STATE: StoreState = {
  messages: [],
  streamingChunk: "",
  streamingTier: null,
  isStreaming: false,
};

// ── Context ──────────────────────────────────────────────────────────

interface StoreContextValue {
  state: StoreState;
  dispatch: Dispatch<Action>;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}

export { StoreContext, INITIAL_STATE, reducer };
