/** @jsxImportSource @opentui/react */
import { useState, useRef, useCallback } from "react";

interface Props {
  onSubmit: (text: string) => void;
}

export function InputArea({ onSubmit }: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<any>(null);

  const handleKeyPress = useCallback(
    (key: string) => {
      // Cmd+Enter or Ctrl+Enter to submit
      if (key === "ctrl+enter" || key === "cmd+enter") {
        const trimmed = value.trim();
        if (trimmed) {
          onSubmit(trimmed);
          setValue("");
        }
      }
    },
    [value, onSubmit],
  );

  return (
    <box height={5} flexShrink={0} flexDirection="column">
      <box height={1}>
        <text fg="#7aa2f7" bold>{"❯ "}</text>
        <text fg="#565f89" dim>
          {value ? "" : "Message… (Cmd+Enter to send)"}
        </text>
      </box>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={setValue}
        onKeyPress={handleKeyPress}
        height={4}
        focused
      />
    </box>
  );
}
