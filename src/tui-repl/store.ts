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
}

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "APPEND_MESSAGE"; message: Message }
  | { type: "CLEAR" };

function reducer(state: StoreState, action: Action): StoreState {
  switch (action.type) {
    case "APPEND_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "CLEAR":
      return { ...state, messages: [] };
    default:
      return state;
  }
}

const INITIAL_STATE: StoreState = { messages: [] };

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
