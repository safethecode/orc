/** @jsxImportSource @opentui/react */

interface Props {
  content: string;
}

export function UserMessage({ content }: Props) {
  return (
    <box flexDirection="row" paddingTop={1}>
      <text fg="#9ece6a" bold>{"❯ "}</text>
      <text fg="#c0caf5">{content}</text>
    </box>
  );
}
