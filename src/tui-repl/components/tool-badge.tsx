/** @jsxImportSource @opentui/react */

const TOOL_ICONS: Record<string, string> = {
  Read: "📖",
  Edit: "✏️",
  Write: "📝",
  Bash: "⚡",
  Grep: "🔍",
  Glob: "📁",
  WebFetch: "🌐",
  WebSearch: "🌐",
  Task: "🤖",
};

interface Props {
  name: string;
  detail?: string;
  agent?: string;
}

export function ToolBadge({ name, detail, agent }: Props) {
  const icon = TOOL_ICONS[name] ?? "▸";
  const prefix = agent ? `${agent} ` : "";
  const suffix = detail ? ` ${detail.split("/").pop()}` : "";

  return (
    <box flexDirection="row" paddingLeft={2}>
      <text fg="#e0af68">{icon === "▸" ? "▸" : icon}</text>
      <text fg="#565f89">{` ${prefix}${name}${suffix}`}</text>
    </box>
  );
}
