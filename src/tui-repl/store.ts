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
