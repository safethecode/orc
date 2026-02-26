import React from "react";
import { Box, Text } from "ink";

interface Props {
  logs: string[];
}

export function LogPanel({ logs }: Props) {
  const visible = logs.slice(-15);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      paddingX={1}
      height={17}
    >
      <Text bold color="yellow">Logs</Text>
      {visible.length === 0 ? (
        <Text dimColor>No logs yet.</Text>
      ) : (
        visible.map((log, i) => (
          <Text key={i} wrap="truncate">
            {log}
          </Text>
        ))
      )}
    </Box>
  );
}
