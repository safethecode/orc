/** @jsxImportSource @opentui/react */

interface Props {
  profiles: string;
}

export function WelcomeScreen({ profiles }: Props) {
  const names = profiles.split(", ").filter(Boolean);

  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row" gap={1} paddingLeft={2}>
        <text fg="#c0caf5" bold>orc</text>
        <text fg="#565f89">interactive orchestrator</text>
      </box>
      <box flexDirection="row" paddingLeft={2}>
        <text fg="#565f89">{"agents: "}</text>
        <text fg="#7dcfff">{names.join(", ")}</text>
      </box>
      <box height={1}>
        <text fg="#565f89">{"─".repeat(60)}</text>
      </box>
      <box paddingLeft={2}>
        <text fg="#565f89">{"type naturally or "}</text>
        <text fg="#c0caf5">/help</text>
        <text fg="#565f89">{" for commands"}</text>
      </box>
    </box>
  );
}
