/** @jsxImportSource @opentui/react */

interface Props {
  active: boolean;
}

export function PlanIndicator({ active }: Props) {
  if (!active) return null;

  return (
    <box height={1} flexShrink={0}>
      <text fg="#e0af68" bold>{"[plan] "}</text>
      <text fg="#565f89">read-only mode — agents cannot write files</text>
    </box>
  );
}
