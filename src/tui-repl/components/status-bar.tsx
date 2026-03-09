/** @jsxImportSource @opentui/react */
import { useState, useEffect } from "react";
import { useStore } from "../store.ts";
import { TIER_HEX, SPINNER_FRAMES } from "../theme-adapter.ts";

function formatElapsed(startMs: number): string {
  if (!startMs) return "";
  const sec = Math.floor((Date.now() - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export function StatusBar() {
  const { state } = useStore();
  const { agentState, agentName, tier, cost, elapsedStart, phase, phaseDetail } = state.status;
  const [frame, setFrame] = useState(0);

  // Spinner + elapsed ticker
  useEffect(() => {
    if (agentState === "idle") return;
    const id = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(id);
  }, [agentState]);

  const isActive = agentState !== "idle";
  const tierColor = tier ? TIER_HEX[tier as keyof typeof TIER_HEX] ?? "#565f89" : "#565f89";

  if (!isActive) {
    // Idle state
    return (
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1}>
        <text fg="#565f89">{"○ idle"}</text>
        <text fg="#3d4262">{" │ "}</text>
        <text fg="#565f89">/help for commands</text>
        <text fg="#3d4262">{" │ "}</text>
        <text fg="#565f89">Ctrl+L to clear</text>
        <box flexGrow={1} />
      </box>
    );
  }

  // Active state
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const elapsed = formatElapsed(elapsedStart);
  const costStr = cost > 0 ? `$${cost.toFixed(4)}` : "";
  const isPreAgent = phase === "routing" || phase === "classifying" || phase === "decomposing";

  if (isPreAgent) {
    return (
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1}>
        <text fg="#7aa2f7">{spinner}</text>
        <text fg="#7aa2f7">{` ${phase}...`}</text>
        <box flexGrow={1} />
        <text fg="#3d4262">{" │ "}</text>
        <text fg="#e0af68">esc to abort</text>
      </box>
    );
  }

  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1}>
      <text fg={tierColor}>{spinner}</text>
      <text fg={tierColor}>{` ${agentName}`}</text>
      {tier && <text fg="#565f89">{` (${tier})`}</text>}
      {phase && phase !== "idle" && phase !== "done" && (
        <box flexDirection="row">
          <text fg="#3d4262">{" │ "}</text>
          <text fg="#7aa2f7">{phase}</text>
          {phaseDetail ? <text fg="#565f89">{` ${phaseDetail}`}</text> : null}
        </box>
      )}
      {costStr && (
        <box flexDirection="row">
          <text fg="#3d4262">{" │ "}</text>
          <text fg="#565f89">{costStr}</text>
        </box>
      )}
      {elapsed && (
        <box flexDirection="row">
          <text fg="#3d4262">{" │ "}</text>
          <text fg="#565f89">{elapsed}</text>
        </box>
      )}
      <text fg="#3d4262">{" │ "}</text>
      <text fg="#e0af68">esc to abort</text>
      <box flexGrow={1} />
    </box>
  );
}
