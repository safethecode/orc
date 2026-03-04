/** @jsxImportSource @opentui/react */
import { useStore } from "../store.ts";
import { TIER_HEX } from "../theme-adapter.ts";

export function WorkerHud() {
  const { state } = useStore();
  const workers = state.status.workers;

  if (!workers.size) return null;

  const entries = Array.from(workers.entries());
  const summary = entries
    .map(([name, w]) => {
      const icon = w.state === "streaming" ? "▸" : w.state === "tool_use" ? "⚡" : "◉";
      return `${icon} ${name}`;
    })
    .join("  ");

  return (
    <box height={1} flexShrink={0}>
      <text fg="#565f89">{summary}</text>
    </box>
  );
}
