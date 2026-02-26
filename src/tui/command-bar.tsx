import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  onCommand: (cmd: string) => void;
}

export function CommandBar({ onCommand }: Props) {
  const [input, setInput] = useState("");

  useInput((ch, key) => {
    if (key.return) {
      if (input.trim()) {
        onCommand(input.trim());
        setInput("");
      }
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
    }
  });

  return (
    <Box paddingX={1}>
      <Text bold color="green">&gt; </Text>
      <Text>{input}</Text>
      <Text color="gray">█</Text>
    </Box>
  );
}
