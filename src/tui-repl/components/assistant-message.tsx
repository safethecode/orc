/** @jsxImportSource @opentui/react */
import type { ModelTier } from "../../config/types.ts";
import { TIER_HEX } from "../theme-adapter.ts";

interface Props {
  content: string;
  tier?: ModelTier;
}

export function AssistantMessage({ content, tier }: Props) {
  const color = tier ? TIER_HEX[tier as keyof typeof TIER_HEX] ?? "#c0caf5" : "#c0caf5";

  return (
    <box flexDirection="column" paddingTop={1}>
      <code content={content} filetype="markdown" />
    </box>
  );
}
