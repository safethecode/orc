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
      // Enter to submit
      if (key === "enter") {
        const trimmed = value.trim();
        if (trimmed) {
          onSubmit(trimmed);
          setValue("");
        }
        return;
      }
      // Cmd+Enter or Ctrl+Enter for newline
      if (key === "ctrl+enter" || key === "cmd+enter") {
        setValue(value + "\n");
      }
    },
    [value, onSubmit],
  );

  return (
    <box height={3} flexShrink={0} flexDirection="column">
      <box height={1}>
        <text fg="#7aa2f7" bold>{"❯ "}</text>
        <text fg="#565f89" dim>
          {value ? "" : "Enter to send, Cmd+Enter for newline"}
        </text>
      </box>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={setValue}
        onKeyPress={handleKeyPress}
        height={2}
        focused
      />
    </box>
  );
}
