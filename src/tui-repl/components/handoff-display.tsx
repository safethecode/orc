/** @jsxImportSource @opentui/react */

interface Props {
  from: string;
  to: string;
}

export function HandoffDisplay({ from, to }: Props) {
  return (
    <box flexDirection="row" gap={1} paddingLeft={2}>
      <text fg="#e0af68" bold>{"↗"}</text>
      <text fg="#565f89">handoff</text>
      <text fg="#c0caf5">{from}</text>
      <text fg="#565f89">{"→"}</text>
      <text fg="#c0caf5">{to}</text>
    </box>
  );
}
