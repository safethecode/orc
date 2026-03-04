/** @jsxImportSource @opentui/react */

interface Props {
  content: string;
}

export function ErrorMessage({ content }: Props) {
  const clean = content.replace(/\x1b\[[0-9;]*m/g, "");

  return (
    <box>
      <text fg="#f7768e" bold>{clean}</text>
    </box>
  );
}
