/** @jsxImportSource @opentui/react */
import type { MessageMeta } from "../store.ts";

interface Props {
  meta?: MessageMeta;
}

export function CostDisplay({ meta }: Props) {
  if (!meta) return null;

  const usd = meta.cost ?? 0;
  const price = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  const input = (meta.inputTokens ?? 0).toLocaleString();
  const output = (meta.outputTokens ?? 0).toLocaleString();
  const duration = meta.durationMs ? `  │  ${(meta.durationMs / 1000).toFixed(1)}s` : "";

  return (
    <box paddingLeft={2}>
      <text fg="#565f89">{`${price}  │  ${input} → ${output} tokens${duration}`}</text>
    </box>
  );
}
