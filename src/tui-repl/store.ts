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
  toolInput?: Record<string, unknown>;
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
    inputTokens?: number;
    outputTokens?: number;
  }>;
  taskDescription?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
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
  taskId: string;
  inputTokens: number;
  outputTokens: number;
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

export interface ApprovalRequest {
  command: string;
  message: string;
}

export interface QuestionRequest {
  question: string;
  options?: string[];
}

export interface StoreState {
  messages: Message[];
  streamingChunk: string;
  streamingTier: ModelTier | null;
  isStreaming: boolean;
  status: StatusBarState;
  approval: ApprovalRequest | null;
  question: QuestionRequest | null;
}

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "APPEND_MESSAGE"; message: Message }
  | { type: "UPDATE_WELCOME_META"; partial: Partial<MessageMeta> }
  | { type: "UPDATE_TASK_LIST"; taskId: string; status: string; durationMs?: number }
  | { type: "REGISTER_WORKER"; name: string; entry: WorkerEntry }
  | { type: "UPDATE_WORKER"; name: string; partial: Partial<WorkerEntry> }
  | { type: "REMOVE_WORKER"; name: string }
  | { type: "UPDATE_TASK_TOKENS"; taskId: string; inputTokens: number; outputTokens: number }
  | { type: "STREAMING_START"; tier: ModelTier }
  | { type: "STREAMING_DELTA"; text: string }
  | { type: "STREAMING_COMMIT" }
  | { type: "STATUS_UPDATE"; partial: Partial<StatusBarState> }
  | { type: "SHOW_APPROVAL"; command: string; message: string }
  | { type: "RESOLVE_APPROVAL" }
  | { type: "SHOW_QUESTION"; question: string; options?: string[] }
  | { type: "RESOLVE_QUESTION" }
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
    case "REGISTER_WORKER": {
      const workers = new Map(state.status.workers);
      workers.set(action.name, action.entry);
      return { ...state, status: { ...state.status, workers } };
    }
    case "UPDATE_WORKER": {
      const workers = new Map(state.status.workers);
      const existing = workers.get(action.name);
      if (!existing) return state;
      workers.set(action.name, { ...existing, ...action.partial });
      return { ...state, status: { ...state.status, workers } };
    }
    case "REMOVE_WORKER": {
      const workers = new Map(state.status.workers);
      workers.delete(action.name);
      return { ...state, status: { ...state.status, workers } };
    }
    case "UPDATE_TASK_TOKENS": {
      const idx = state.messages.findLastIndex((m) => m.type === "task_list");
      if (idx === -1) return state;
      const msg = state.messages[idx];
      const items = msg.meta?.taskItems?.map((item) =>
        item.id === action.taskId
          ? { ...item, inputTokens: action.inputTokens, outputTokens: action.outputTokens }
          : item,
      );
      let totalInput = 0;
      let totalOutput = 0;
      for (const item of items ?? []) {
        totalInput += item.inputTokens ?? 0;
        totalOutput += item.outputTokens ?? 0;
      }
      const updated = [...state.messages];
      updated[idx] = { ...msg, meta: { ...msg.meta, taskItems: items, totalInputTokens: totalInput, totalOutputTokens: totalOutput } };
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
    case "SHOW_APPROVAL":
      return { ...state, approval: { command: action.command, message: action.message } };
    case "RESOLVE_APPROVAL":
      return { ...state, approval: null };
    case "SHOW_QUESTION":
      return { ...state, question: { question: action.question, options: action.options } };
    case "RESOLVE_QUESTION":
      return { ...state, question: null };
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
  approval: null,
  question: null,
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
