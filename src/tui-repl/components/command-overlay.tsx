/** @jsxImportSource @opentui/react */
import { useState, useCallback } from "react";

const COMMANDS = [
  { name: "/clear", desc: "Clear messages" },
  { name: "/status", desc: "Show agent status" },
  { name: "/agents", desc: "List or pin agents" },
  { name: "/stop", desc: "Stop running agent" },
  { name: "/lang", desc: "Set response language" },
  { name: "/plan", desc: "Toggle plan mode" },
  { name: "/memory", desc: "View agent memory" },
  { name: "/stats", desc: "Session statistics" },
  { name: "/quit", desc: "Exit orc" },
];

interface Props {
  query: string;
  visible: boolean;
}

export function CommandOverlay({ query, visible }: Props) {
  if (!visible) return null;

  const filtered = query
    ? COMMANDS.filter(c => c.name.startsWith(query))
    : COMMANDS;

  if (filtered.length === 0) return null;

  return (
    <box flexDirection="column" height={Math.min(filtered.length, 8)}>
      {filtered.slice(0, 8).map((cmd, i) => (
        <box key={cmd.name} flexDirection="row">
          <text fg="#7aa2f7" bold>{cmd.name}</text>
          <text fg="#565f89">{`  ${cmd.desc}`}</text>
        </box>
      ))}
    </box>
  );
}
