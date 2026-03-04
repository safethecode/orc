/** @jsxImportSource @opentui/react */
import { useState, useCallback, useRef, useEffect } from "react";

interface Props {
  onSubmit: (text: string) => void;
}

export function InputArea({ onSubmit }: Props) {
  const [value, setValue] = useState("");
  const inputRef = useRef<any>(null);

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
      setValue("");
      // Force-clear the underlying input renderable
      if (inputRef.current?.value !== undefined) {
        inputRef.current.value = "";
      }
    },
    [onSubmit],
  );

  return (
    <box height={1} flexShrink={0} flexDirection="row">
      <text fg="#bb9af7" bold>{"❯ "}</text>
      <input
        ref={inputRef}
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
