/** @jsxImportSource @opentui/react */
import { useState, useRef, useEffect } from "react";

interface Props {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}

export function QuestionDialog({ question, options, onAnswer, onDismiss }: Props) {
  const textareaRef = useRef<any>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.onSubmit = () => {
      const text = (ta.plainText ?? "").trim();
      if (text) onAnswer(text);
    };
  }, [onAnswer]);

  return (
    <box
      flexDirection="column"
      border={["top"]}
      borderColor="#7aa2f7"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text fg="#7aa2f7" bold>{"  Agent Question"}</text>
      <text fg="#c0caf5" wrap="word">{`  ${question}`}</text>
      {options && options.length > 0 && (
        <box flexDirection="column" marginTop={1} paddingLeft={2}>
          {options.map((opt, i) => (
            <text
              key={opt}
              fg="#9ece6a"
              onClick={() => onAnswer(opt)}
            >
              {`  [${i + 1}] ${opt}`}
            </text>
          ))}
        </box>
      )}
      <box flexDirection="row" maxHeight={3} marginTop={1}>
        <text fg="#bb9af7" bold>{"❯ "}</text>
        <textarea
          ref={textareaRef}
          wrapMode="word"
          maxHeight={3}
          placeholder={options?.length ? "Type number or custom answer..." : "Type your answer..."}
          flexGrow={1}
          focused
          keyBindings={[
            { name: "enter", action: "submit" },
          ]}
        />
      </box>
      <text fg="#565f89">{"  esc to skip"}</text>
    </box>
  );
}
