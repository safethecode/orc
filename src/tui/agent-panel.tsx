import React from "react";
import { Box, Text } from "ink";

interface Props {
  agent: {
    name: string;
    status: string;
    currentTask?: string;
  };
}

const statusColors: Record<string, string> = {
  idle: "gray",
  running: "green",
  paused: "yellow",
  error: "red",
  terminated: "redBright",
};

export function AgentPanel({ agent }: Props) {
  const color = statusColors[agent.status] ?? "white";

  return (
    <Box
      borderStyle="round"
      flexDirection="column"
      paddingX={1}
      paddingY={0}
      minWidth={20}
    >
      <Text bold>{agent.name}</Text>
      <Text color={color}>{agent.status}</Text>
      {agent.currentTask && (
        <Text dimColor>Task: {agent.currentTask.slice(0, 8)}...</Text>
      )}
    </Box>
  );
}
