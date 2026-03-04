/** @jsxImportSource @opentui/react */
import { useStore } from "../store.ts";
import { WelcomeScreen } from "./welcome-screen.tsx";
import { UserMessage } from "./user-message.tsx";
import { AssistantMessage } from "./assistant-message.tsx";
import { AgentHeader } from "./agent-header.tsx";
import { StreamingBubble } from "./streaming-bubble.tsx";
import { ToolBadge } from "./tool-badge.tsx";
import { SystemInfo } from "./system-info.tsx";
import { ErrorMessage } from "./error-message.tsx";
import { CostDisplay } from "./cost-display.tsx";
import { HandoffDisplay } from "./handoff-display.tsx";
import { TaskListDisplay } from "./task-list-display.tsx";
import type { Message } from "../store.ts";

function renderMessage(msg: Message) {
  switch (msg.type) {
    case "welcome":
      return <WelcomeScreen key={msg.id} profiles={msg.content} meta={msg.meta} />;
    case "user":
      return <UserMessage key={msg.id} content={msg.content} />;
    case "assistant":
      return <AssistantMessage key={msg.id} content={msg.content} tier={msg.meta?.tier} />;
    case "agent_header":
      return <AgentHeader key={msg.id} name={msg.meta?.agentName ?? msg.content} tier={msg.meta?.tier} reason={msg.meta?.reason} />;
    case "tool":
      return <ToolBadge key={msg.id} name={msg.meta?.toolName ?? ""} detail={msg.meta?.toolDetail} agent={msg.meta?.agentName} />;
    case "system":
      return <SystemInfo key={msg.id} content={msg.content} meta={msg.meta} />;
    case "error":
      return <ErrorMessage key={msg.id} content={msg.content} />;
    case "cost":
      return <CostDisplay key={msg.id} meta={msg.meta} />;
    case "handoff":
      return <HandoffDisplay key={msg.id} from={msg.meta?.agentName ?? ""} to={msg.meta?.reason ?? ""} />;
    case "task_list":
      return <TaskListDisplay key={msg.id} meta={msg.meta} />;
    case "separator":
      return (
        <box key={msg.id} border={["top"]} borderColor="#565f89" />
      );
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
