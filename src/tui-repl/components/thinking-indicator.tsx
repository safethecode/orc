/** @jsxImportSource @opentui/react */
import { useState, useEffect } from "react";
import { useStore } from "../store.ts";

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

function formatElapsed(startMs: number): string {
  if (!startMs) return "";
  const sec = Math.floor((Date.now() - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${sec % 60}s`;
}

export function ThinkingIndicator() {
  const { state } = useStore();
  const { agentState, agentName, phase, currentTool, elapsedStart, cost } = state.status;
  const inputTokens = (state as any).status.inputTokens ?? 0;
  const outputTokens = (state as any).status.outputTokens ?? 0;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(id);
  }, []);

  const isActive = agentState !== "idle" && !state.isStreaming;
  if (!isActive) return null;

  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const isPreAgent = phase === "routing" || phase === "classifying" || phase === "decomposing";

  let label: string;
  if (isPreAgent) {
    label = `${phase.charAt(0).toUpperCase() + phase.slice(1)}...`;
  } else if (agentName) {
    const capitalized = agentName.charAt(0).toUpperCase() + agentName.slice(1);
    label = `${capitalized} is thinking...`;
  } else {
    label = "Thinking...";
  }

  const elapsed = formatElapsed(elapsedStart);
  const tokens = inputTokens + outputTokens;
  const stats = [elapsed, tokens > 0 ? `${tokens.toLocaleString()} tokens` : ""].filter(Boolean).join(", ");
  const toolLine = currentTool && !isPreAgent ? currentTool : "";

  return (
    <box paddingLeft={2} paddingTop={1} flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg="#7aa2f7">{`${spinner} ${label}`}</text>
        {stats && <text fg="#565f89">{`(${stats})`}</text>}
      </box>
      {toolLine && (
        <box paddingLeft={2}>
          <text fg="#565f89">{`│ ${toolLine}`}</text>
        </box>
      )}
    </box>
  );
}
