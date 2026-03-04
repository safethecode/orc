/** @jsxImportSource @opentui/react */
import type { MessageMeta } from "../store.ts";

interface Props {
  content: string;
  meta?: MessageMeta;
}

interface InfoStyle {
  icon: string;
  color: string;
}

function classify(content: string): InfoStyle {
  const lower = content.toLowerCase();

  if (lower.startsWith("mcp:") || lower.startsWith("mcp scout:"))
    return { icon: "\uD83D\uDD0C", color: "#9ece6a" };
  if (lower.startsWith("skills:") || lower.startsWith("skill"))
    return { icon: "\u26A1", color: "#e0af68" };
  if (lower.startsWith("formatters:"))
    return { icon: "\uD83D\uDCE6", color: "#7dcfff" };
  if (lower.startsWith("quality:"))
    return { icon: "\u2714", color: "#9ece6a" };
  if (lower.startsWith("plan:") || lower.startsWith("phase"))
    return { icon: "\uD83D\uDCCB", color: "#7aa2f7" };
  if (lower.startsWith("research") || lower.startsWith("study"))
    return { icon: "\uD83D\uDD0D", color: "#bb9af7" };
  if (lower.startsWith("deliberation") || lower.startsWith("brainstorm"))
    return { icon: "\uD83E\uDDE0", color: "#bb9af7" };
  if (lower.startsWith("retry"))
    return { icon: "\u21BB", color: "#e0af68" };
  if (lower.startsWith("conflicts:") || lower.startsWith("risks:"))
    return { icon: "\u26A0", color: "#f7768e" };
  if (lower.startsWith("golden"))
    return { icon: "\u2B50", color: "#e0af68" };
  if (lower.startsWith("cost estimate"))
    return { icon: "\uD83D\uDCB0", color: "#9ece6a" };
  if (lower.includes("compaction") || lower.includes("compact"))
    return { icon: "\uD83D\uDCE6", color: "#565f89" };

  return { icon: "\u00B7", color: "#565f89" };
}

export function SystemInfo({ content }: Props) {
  const clean = content.replace(/\x1b\[[0-9;]*m/g, "");
  const { icon, color } = classify(clean);

  return (
    <box paddingLeft={2}>
      <text fg={color}>{icon} {clean}</text>
    </box>
  );
}
