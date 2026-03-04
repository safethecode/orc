/** @jsxImportSource @opentui/react */
import { useState, useEffect } from "react";
import { useStore } from "../store.ts";

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

export function ThinkingIndicator() {
  const { state } = useStore();
  const { agentState, agentName, phase } = state.status;
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
    label = `${phase}...`;
  } else if (agentName) {
    label = `${agentName} is thinking...`;
  } else {
    label = "thinking...";
  }

  return (
    <box paddingLeft={2} paddingTop={1}>
      <text fg="#7aa2f7">{`${spinner} ${label}`}</text>
    </box>
  );
}
