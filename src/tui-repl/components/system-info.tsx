/** @jsxImportSource @opentui/react */
import type { MessageMeta } from "../store.ts";

interface Props {
  content: string;
  meta?: MessageMeta;
}

export function SystemInfo({ content }: Props) {
  // Strip ANSI escape codes that may leak from old renderer calls
  const clean = content.replace(/\x1b\[[0-9;]*m/g, "");

  return (
    <box>
      <text fg="#565f89" dim>{clean}</text>
    </box>
  );
}
