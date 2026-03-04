import { createContext, useContext, useReducer, type Dispatch } from "react";
import type { ModelTier } from "../config/types.ts";

export type MessageType =
  | "welcome"
  | "user"
  | "assistant"
  | "agent_header"
  | "tool"
  | "system"
  | "error"
  | "cost"
  | "handoff"
  | "separator"
  | "task_list";

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
  // Welcome panel metadata
  version?: string;
  cwd?: string;
  defaultTier?: string;
  mcpServers?: string[];
  formatters?: string[];
  // Task list metadata
  taskItems?: Array<{
    id: string;
    label: string;
    role: string;
    status: "pending" | "running" | "passed" | "failed" | "reviewing";
    durationMs?: number;
  }>;
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

export type AgentState = "idle" | "thinking" | "streaming" | "tool_use";

export interface WorkerEntry {
  state: AgentState;
  model: string;
  startedAt: number;
  lastTool?: string;
}

export type WorkflowPhase = "idle" | "routing" | "classifying" | "decomposing" | "executing" | "reviewing" | "done";

export interface StatusBarState {
  agentState: AgentState;
  agentName: string;
  tier: ModelTier | null;
  cost: number;
  elapsedStart: number;
  workers: Map<string, WorkerEntry>;
  phase: WorkflowPhase;
  phaseDetail: string;
}

export interface StoreState {
  messages: Message[];
  streamingChunk: string;
  streamingTier: ModelTier | null;
  isStreaming: boolean;
  status: StatusBarState;
}

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "APPEND_MESSAGE"; message: Message }
  | { type: "UPDATE_WELCOME_META"; partial: Partial<MessageMeta> }
  | { type: "UPDATE_TASK_LIST"; taskId: string; status: string; durationMs?: number }
  | { type: "STREAMING_START"; tier: ModelTier }
  | { type: "STREAMING_DELTA"; text: string }
  | { type: "STREAMING_COMMIT" }
  | { type: "STATUS_UPDATE"; partial: Partial<StatusBarState> }
  | { type: "CLEAR" };

function reducer(state: StoreState, action: Action): StoreState {
  switch (action.type) {
    case "APPEND_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "UPDATE_WELCOME_META": {
      const idx = state.messages.findIndex((m) => m.type === "welcome");
      if (idx === -1) return state;
      const updated = [...state.messages];
      updated[idx] = { ...updated[idx], meta: { ...updated[idx].meta, ...action.partial } };
      return { ...state, messages: updated };
    }
    case "UPDATE_TASK_LIST": {
      const idx = state.messages.findLastIndex((m) => m.type === "task_list");
      if (idx === -1) return state;
      const msg = state.messages[idx];
      const items = msg.meta?.taskItems?.map((item) =>
        item.id === action.taskId
          ? { ...item, status: action.status as any, durationMs: action.durationMs ?? item.durationMs }
          : item,
      );
      const updated = [...state.messages];
      updated[idx] = { ...msg, meta: { ...msg.meta, taskItems: items } };
      return { ...state, messages: updated };
    }
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
    case "STATUS_UPDATE":
      return { ...state, status: { ...state.status, ...action.partial } };
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
  status: {
    agentState: "idle",
    agentName: "",
    tier: null,
    cost: 0,
    elapsedStart: 0,
    workers: new Map(),
    phase: "idle",
    phaseDetail: "",
  },
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
