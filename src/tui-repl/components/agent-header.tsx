/** @jsxImportSource @opentui/react */
import type { ModelTier } from "../../config/types.ts";
import { TIER_HEX } from "../theme-adapter.ts";

const TIER_BG: Record<string, string> = {
  opus: "#bb9af7",
  sonnet: "#7dcfff",
  haiku: "#9ece6a",
};

interface Props {
  name: string;
  tier?: ModelTier;
  reason?: string;
}

export function AgentHeader({ name, tier, reason }: Props) {
  const color = tier ? TIER_HEX[tier as keyof typeof TIER_HEX] ?? "#c0caf5" : "#c0caf5";
  const bg = tier ? TIER_BG[tier] ?? undefined : undefined;

  return (
    <box flexDirection="row" gap={1} paddingTop={1} paddingLeft={2}>
      <text fg={color} bold>{name}</text>
      {tier && (
        <text fg="#1a1b26" bg={bg} bold>{` ${tier} `}</text>
      )}
      {reason && (
        <text fg="#565f89" italic>{reason}</text>
      )}
    </box>
  );
}
