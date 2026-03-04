/** @jsxImportSource @opentui/react */

interface Props {
  content: string;
}

export function ErrorMessage({ content }: Props) {
  const clean = content.replace(/\x1b\[[0-9;]*m/g, "");

  return (
    <box flexDirection="row" paddingLeft={2}>
      <text fg="#f7768e" bold>{"✗ "}</text>
      <text fg="#f7768e">{clean}</text>
    </box>
  );
}
