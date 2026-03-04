/** @jsxImportSource @opentui/react */
import { useState, useCallback } from "react";

interface Props {
  onSubmit: (text: string) => void;
}

export function InputArea({ onSubmit }: Props) {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed) {
        onSubmit(trimmed);
      }
      setValue("");
    },
    [onSubmit],
  );

  return (
    <box height={1} flexShrink={0} flexDirection="row">
      <text fg="#7aa2f7" bold>{"❯ "}</text>
      <input
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder="Type a message..."
        flexGrow={1}
        focused
      />
    </box>
  );
}
