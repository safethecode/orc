/** @jsxImportSource @opentui/react */

interface Props {
  name: string;
  detail?: string;
  agent?: string;
}

export function ToolBadge({ name, detail, agent }: Props) {
  const prefix = agent ? `${agent}: ` : "";
  const suffix = detail ? ` ${detail.split("/").pop()}` : "";

  return (
    <box flexDirection="row">
      <text fg="#565f89">{`  ${prefix}→ ${name}${suffix}`}</text>
    </box>
  );
}
