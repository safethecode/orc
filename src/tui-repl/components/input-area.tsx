/** @jsxImportSource @opentui/react */
import { useCallback, useRef, useEffect } from "react";

interface Props {
  onSubmit: (text: string) => void;
}

export function InputArea({ onSubmit }: Props) {
  const textareaRef = useRef<any>(null);

  // Wire submit handler via ref (textarea onSubmit receives SubmitEvent, not value)
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.onSubmit = () => {
      const text = (ta.plainText ?? "").trim();
      if (!text) return;
      onSubmit(text);
      ta.setText("");
    };
  }, [onSubmit]);

  return (
    <box flexShrink={0} flexDirection="row" maxHeight={6}>
      <text fg="#bb9af7" bold>{"❯ "}</text>
      <textarea
        ref={textareaRef}
        wrapMode="word"
        maxHeight={6}
        placeholder="Type a message..."
        flexGrow={1}
        focused
        keyBindings={[
          { name: "enter", action: "submit" },
          { name: "enter", shift: true, action: "newline" },
        ]}
      />
    </box>
  );
}
