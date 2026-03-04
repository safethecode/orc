/** @jsxImportSource @opentui/react */
import { useStore } from "../store.ts";

const TOOL_ICONS: Record<string, string> = {
  Read: "📖", Edit: "✏️", Write: "📝", Bash: "⚡", Grep: "🔍",
  Glob: "📁", WebFetch: "🌐", WebSearch: "🌐", Task: "🤖",
};

export function WorkerHud() {
  const { state } = useStore();
  const workers = state.status.workers;

  if (!workers.size) return null;

  const entries = Array.from(workers.entries());

  return (
    <box height={1} flexShrink={0} flexDirection="row" gap={2}>
      {entries.map(([name, w]) => {
        const icon = w.lastTool ? (TOOL_ICONS[w.lastTool] ?? "▸") : (w.state === "streaming" ? "▸" : "◉");
        const detail = w.lastTool ?? w.state;
        return (
          <box key={name} flexDirection="row">
            <text fg="#7dcfff">{name}</text>
            <text fg="#565f89">{` ${icon} ${detail}`}</text>
          </box>
        );
      })}
    </box>
  );
}
