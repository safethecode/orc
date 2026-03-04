/** @jsxImportSource @opentui/react */
import { useStore } from "../store.ts";
import { UserMessage } from "./user-message.tsx";
import { AssistantMessage } from "./assistant-message.tsx";
import { StreamingBubble } from "./streaming-bubble.tsx";
import { ToolBadge } from "./tool-badge.tsx";
import { SystemInfo } from "./system-info.tsx";
import { ErrorMessage } from "./error-message.tsx";
import type { Message } from "../store.ts";

function renderMessage(msg: Message) {
  switch (msg.type) {
    case "welcome":
      return <text key={msg.id} fg="#7aa2f7" bold>{msg.content}</text>;
    case "user":
      return <UserMessage key={msg.id} content={msg.content} />;
    case "assistant":
      return <AssistantMessage key={msg.id} content={msg.content} tier={msg.meta?.tier} />;
    case "tool":
      return <ToolBadge key={msg.id} name={msg.meta?.toolName ?? ""} detail={msg.meta?.toolDetail} agent={msg.meta?.agentName} />;
    case "system":
      return <SystemInfo key={msg.id} content={msg.content} meta={msg.meta} />;
    case "error":
      return <ErrorMessage key={msg.id} content={msg.content} />;
    case "cost":
      return (
        <SystemInfo
          key={msg.id}
          content={`$${(msg.meta?.cost ?? 0).toFixed(4)} · ${msg.meta?.inputTokens ?? 0}→${msg.meta?.outputTokens ?? 0} tokens · ${((msg.meta?.durationMs ?? 0) / 1000).toFixed(1)}s`}
          meta={msg.meta}
        />
      );
    case "separator":
      return <text key={msg.id} fg="#3d4262">{"─".repeat(40)}</text>;
    default:
      return null;
  }
}

export function MessageArea() {
  const { state } = useStore();

  return (
    <scrollbox flexGrow={1} scrollY={-1}>
      {state.messages.map(renderMessage)}
      {state.isStreaming && <StreamingBubble chunk={state.streamingChunk} tier={state.streamingTier} />}
    </scrollbox>
  );
}
