/** @jsxImportSource @opentui/react */
import type { ModelTier } from "../../config/types.ts";
import { TIER_HEX } from "../theme-adapter.ts";
import { renderMarkdown } from "../markdown.ts";

interface Props {
  content: string;
  tier?: ModelTier;
}

export function AssistantMessage({ content, tier }: Props) {
  const borderColor = tier ? TIER_HEX[tier as keyof typeof TIER_HEX] ?? "#565f89" : "#565f89";
  const rendered = renderMarkdown(content);

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
        <text>{rendered}</text>
      </box>
    </box>
  );
}
