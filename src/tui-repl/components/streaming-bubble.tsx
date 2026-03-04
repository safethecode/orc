/** @jsxImportSource @opentui/react */
import type { ModelTier } from "../../config/types.ts";

interface Props {
  chunk: string;
  tier?: ModelTier | null;
}

export function StreamingBubble({ chunk, tier }: Props) {
  return (
    <box flexDirection="column" paddingTop={1}>
      <code content={chunk + "▍"} filetype="markdown" streaming />
    </box>
  );
}
