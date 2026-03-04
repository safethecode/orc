/** @jsxImportSource @opentui/react */
import type { ModelTier } from "../../config/types.ts";
import { TIER_HEX } from "../theme-adapter.ts";

interface Props {
  chunk: string;
  tier?: ModelTier | null;
}

export function StreamingBubble({ chunk, tier }: Props) {
  const borderColor = tier ? TIER_HEX[tier as keyof typeof TIER_HEX] ?? "#565f89" : "#565f89";

  return (
    <box flexDirection="column" paddingTop={1} paddingLeft={2}>
      <text fg={borderColor}>{"╭" + "─".repeat(58) + "╮"}</text>
      <box flexDirection="row">
        <text fg={borderColor}>{"│ "}</text>
        <box flexGrow={1} flexShrink={1}>
          <code content={chunk + "▍"} filetype="markdown" streaming />
        </box>
        <text fg={borderColor}>{" │"}</text>
      </box>
      <text fg={borderColor}>{"╰" + "─".repeat(58) + "╯"}</text>
    </box>
  );
}
