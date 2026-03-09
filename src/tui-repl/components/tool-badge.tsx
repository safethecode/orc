/** @jsxImportSource @opentui/react */
import type { MessageMeta } from "../store.ts";

const TOOL_ICONS: Record<string, string> = {
  Read: "\u25CF",
  Edit: "\u25CF",
  Write: "\u25CF",
  Bash: "\u25CF",
  Grep: "\u25CF",
  Glob: "\u25CF",
  WebFetch: "\u25CF",
  WebSearch: "\u25CF",
  Task: "\u25CF",
};

const TOOL_COLORS: Record<string, string> = {
  Read: "#9ece6a",
  Edit: "#9ece6a",
  Write: "#9ece6a",
  Bash: "#e0af68",
  Grep: "#7aa2f7",
  Glob: "#7aa2f7",
};

interface Props {
  name: string;
  detail?: string;
  agent?: string;
  input?: Record<string, unknown>;
}

function shortPath(filePath?: string): string {
  if (!filePath) return "";
  const parts = filePath.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : filePath;
}

function computeDiffLines(oldStr: string, newStr: string): { type: "ctx" | "add" | "del"; text: string }[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const lines: { type: "ctx" | "add" | "del"; text: string }[] = [];

  // Simple diff: show removed then added
  for (const l of oldLines) {
    lines.push({ type: "del", text: l });
  }
  for (const l of newLines) {
    lines.push({ type: "add", text: l });
  }
  return lines;
}

function truncateLines(lines: { type: "ctx" | "add" | "del"; text: string }[], max: number) {
  if (lines.length <= max) return { lines, truncated: 0 };
  const half = Math.floor(max / 2);
  const top = lines.slice(0, half);
  const bottom = lines.slice(-half);
  return { lines: [...top, ...bottom], truncated: lines.length - max };
}

function EditDiff({ input }: { input: Record<string, unknown> }) {
  const filePath = input.file_path as string | undefined;
  const oldStr = input.old_string as string | undefined;
  const newStr = input.new_string as string | undefined;

  if (!oldStr && !newStr) return null;

  const allLines = computeDiffLines(oldStr ?? "", newStr ?? "");
  const { lines, truncated } = truncateLines(allLines, 12);
  const added = allLines.filter(l => l.type === "add").length;
  const removed = allLines.filter(l => l.type === "del").length;

  return (
    <box flexDirection="column" paddingLeft={2}>
      <box flexDirection="row" gap={1}>
        <text fg="#9ece6a">{"\u25CF"}</text>
        <text fg="#c0caf5" bold>{`Update(${shortPath(filePath)})`}</text>
      </box>
      <box flexDirection="column" paddingLeft={3}>
        <text fg="#565f89">{`\u2514 Added ${added} line${added !== 1 ? "s" : ""}, removed ${removed} line${removed !== 1 ? "s" : ""}`}</text>
        {lines.map((l, i) => {
          if (l.type === "del") {
            return <text key={i} fg="#f7768e">{`  - ${l.text}`}</text>;
          }
          if (l.type === "add") {
            return <text key={i} fg="#9ece6a">{`  + ${l.text}`}</text>;
          }
          return <text key={i} fg="#565f89">{`    ${l.text}`}</text>;
        })}
        {truncated > 0 && <text fg="#565f89">{`  ... ${truncated} more lines`}</text>}
      </box>
    </box>
  );
}

function WriteDiff({ input }: { input: Record<string, unknown> }) {
  const filePath = input.file_path as string | undefined;
  const content = input.content as string | undefined;
  const lineCount = content ? content.split("\n").length : 0;

  return (
    <box flexDirection="column" paddingLeft={2}>
      <box flexDirection="row" gap={1}>
        <text fg="#9ece6a">{"\u25CF"}</text>
        <text fg="#c0caf5" bold>{`Write(${shortPath(filePath)})`}</text>
      </box>
      <box paddingLeft={3}>
        <text fg="#565f89">{`\u2514 Created ${lineCount} line${lineCount !== 1 ? "s" : ""}`}</text>
      </box>
    </box>
  );
}

function ReadBadge({ input }: { input: Record<string, unknown> }) {
  const filePath = input.file_path as string | undefined;
  return (
    <box flexDirection="row" paddingLeft={2} gap={1}>
      <text fg="#9ece6a">{"\u25CF"}</text>
      <text fg="#565f89">{`Read ${shortPath(filePath)}`}</text>
    </box>
  );
}

function BashBadge({ input }: { input: Record<string, unknown> }) {
  const command = input.command as string | undefined;
  const display = command && command.length > 80 ? command.slice(0, 77) + "..." : command;
  return (
    <box flexDirection="row" paddingLeft={2} gap={1}>
      <text fg="#e0af68">{"\u25CF"}</text>
      <text fg="#565f89">{`Bash ${display ?? ""}`}</text>
    </box>
  );
}

export function ToolBadge({ name, detail, agent, input }: Props) {
  // Rich display for Edit/Write when input data is available
  if (input) {
    if (name === "Edit" && (input.old_string || input.new_string)) {
      return <EditDiff input={input} />;
    }
    if (name === "Write" && input.file_path) {
      return <WriteDiff input={input} />;
    }
    if (name === "Read" && input.file_path) {
      return <ReadBadge input={input} />;
    }
    if (name === "Bash" && input.command) {
      return <BashBadge input={input} />;
    }
  }

  // Fallback: simple badge
  const icon = TOOL_ICONS[name] ?? "\u25B8";
  const color = TOOL_COLORS[name] ?? "#565f89";
  const prefix = agent ? `${agent} ` : "";
  const suffix = detail ? ` ${detail.split("/").pop()}` : "";

  return (
    <box flexDirection="row" paddingLeft={2}>
      <text fg={color}>{icon}</text>
      <text fg="#565f89">{` ${prefix}${name}${suffix}`}</text>
    </box>
  );
}
