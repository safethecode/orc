/** @jsxImportSource @opentui/react */
import type { MessageMeta } from "../store.ts";

interface Props {
  meta?: MessageMeta;
}

const STATUS_ICON: Record<string, string> = {
  pending: "\u25CB",
  running: "\u21BB",
  passed: "\u2713",
  failed: "\u2717",
  reviewing: "\u25C9",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "#565f89",
  running: "#7aa2f7",
  passed: "#9ece6a",
  failed: "#f7768e",
  reviewing: "#e0af68",
};

function formatDuration(ms?: number): string {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TaskListDisplay({ meta }: Props) {
  const items = meta?.taskItems ?? [];
  if (items.length === 0) return null;

  const total = items.length;
  const done = items.filter((i) => i.status === "passed" || i.status === "failed").length;

  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <box flexDirection="row" gap={1}>
        <text fg="#7aa2f7" bold>{"\uD83D\uDCCB"}</text>
        <text fg="#c0caf5" bold>{`Plan (${done}/${total} tasks)`}</text>
      </box>
      {items.map((item, i) => {
        const icon = STATUS_ICON[item.status] ?? "\u25CB";
        const color = STATUS_COLOR[item.status] ?? "#565f89";
        const dur = formatDuration(item.durationMs);
        return (
          <box key={item.id} flexDirection="row" paddingLeft={1}>
            <text fg={color}>{` ${icon} ${i + 1}. `}</text>
            <text fg={item.status === "pending" ? "#565f89" : "#c0caf5"}>{item.label}</text>
            <text fg="#565f89">{`  ${item.role}`}</text>
            {dur && <text fg="#565f89">{`  ${dur}`}</text>}
            {item.status === "running" && <text fg="#7aa2f7">{" running"}</text>}
            {item.status === "reviewing" && <text fg="#e0af68">{" reviewing"}</text>}
          </box>
        );
      })}
    </box>
  );
}
