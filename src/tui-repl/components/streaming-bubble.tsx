/** @jsxImportSource @opentui/react */
import type { ModelTier } from "../../config/types.ts";
import { TIER_HEX } from "../theme-adapter.ts";
import { getMarkdownSyntaxStyle } from "../md-theme.ts";

interface Props {
  chunk: string;
  tier?: ModelTier | null;
}

export function StreamingBubble({ chunk, tier }: Props) {
  const borderColor = tier ? TIER_HEX[tier as keyof typeof TIER_HEX] ?? "#565f89" : "#565f89";

  return (
    <box
      flexDirection="column"
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <box
        border
        borderStyle="rounded"
        borderColor={borderColor}
        padding={1}
      >
        <markdown content={chunk + "▍"} syntaxStyle={getMarkdownSyntaxStyle()} conceal concealCode={false} streaming />
      </box>
    </box>
  );
}
