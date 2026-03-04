/** @jsxImportSource @opentui/react */

interface Props {
  command: string;
  message: string;
  onApprove: () => void;
  onDeny: () => void;
}

export function ApprovalDialog({ command, message, onApprove, onDeny }: Props) {
  return (
    <box
      flexDirection="column"
      border={["top"]}
      borderColor="#e0af68"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text fg="#e0af68" bold>{"  ENFORCER: command-safety"}</text>
      <text fg="#c0caf5">{message}</text>
      <text fg="#565f89" wrap="word">{`  ${command.slice(0, 200)}`}</text>
      <box flexDirection="row" gap={2} marginTop={1}>
        <text
          fg="#1a1b26"
          bg="#9ece6a"
          bold
          onClick={onApprove}
        >
          {" [Y] Allow "}
        </text>
        <text
          fg="#1a1b26"
          bg="#f7768e"
          bold
          onClick={onDeny}
        >
          {" [N] Deny "}
        </text>
      </box>
    </box>
  );
}
