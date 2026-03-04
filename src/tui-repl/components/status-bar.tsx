/** @jsxImportSource @opentui/react */
import { useState, useEffect } from "react";
import { useStore } from "../store.ts";
import { TIER_HEX } from "../theme-adapter.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATE_ICONS: Record<string, string> = {
  idle: "○",
  thinking: "◉",
  streaming: "▸",
  tool_use: "⚡",
};

function formatElapsed(startMs: number): string {
  if (!startMs) return "";
  const sec = Math.floor((Date.now() - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export function StatusBar() {
  const { state } = useStore();
  const { agentState, agentName, tier, cost, elapsedStart } = state.status;
  const [frame, setFrame] = useState(0);

  // Spinner + elapsed ticker (80ms for smooth spinner)
  useEffect(() => {
    if (agentState === "idle") return;
    const id = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(id);
  }, [agentState]);

  const isActive = agentState !== "idle";
  const icon = isActive
    ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
    : (STATE_ICONS[agentState] ?? "○");
  const tierColor = tier ? TIER_HEX[tier as keyof typeof TIER_HEX] ?? "#565f89" : "#565f89";
  const elapsed = formatElapsed(elapsedStart);
  const costStr = cost > 0 ? `$${cost.toFixed(4)}` : "";

  const left = agentName ? `${icon} ${agentName} (${tier ?? ""})` : `${icon} idle`;
  const right = [costStr, elapsed].filter(Boolean).join(" · ");

  return (
    <box height={1} flexShrink={0} flexDirection="row">
      <text fg={tierColor}>{left}</text>
      <box flexGrow={1} />
      <text fg="#565f89">{right}</text>
    </box>
  );
}
