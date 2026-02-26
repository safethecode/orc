import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig } from "../config/types.ts";
import { AgentPanel } from "./agent-panel.tsx";
import { LogPanel } from "./log-panel.tsx";
import { CommandBar } from "./command-bar.tsx";

interface Props {
  orchestrator: Orchestrator;
  config: OrchestratorConfig;
}

export function Dashboard({ orchestrator, config }: Props) {
  const { exit } = useApp();
  const [agents, setAgents] = useState<Array<{ name: string; status: string; currentTask?: string }>>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      orchestrator.shutdown().then(() => exit());
    }
  });

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const agentList = await orchestrator.listAgents();
        setAgents(agentList);
      } catch (err) {
        setError(String(err));
      }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box borderStyle="double" paddingX={1}>
        <Text bold color="cyan"> ORC - Agent Orchestrator Dashboard </Text>
      </Box>

      <Box flexDirection="row" height={10}>
        {agents.length > 0 ? (
          agents.map((agent) => (
            <AgentPanel key={agent.name} agent={agent} />
          ))
        ) : (
          <Box paddingX={2} paddingY={1}>
            <Text dimColor>No agents running. Use 'orc spawn &lt;agent&gt;' to start one.</Text>
          </Box>
        )}
      </Box>

      <LogPanel logs={logs} />

      {error && (
        <Box paddingX={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <CommandBar
        onCommand={async (cmd) => {
          setLogs((prev) => [...prev.slice(-50), `> ${cmd}`]);
          try {
            const parts = cmd.trim().split(/\s+/);
            if (parts[0] === "spawn" && parts[1]) {
              await orchestrator.spawnAgent(parts[1]);
              setLogs((prev) => [...prev, `Spawned: ${parts[1]}`]);
            } else if (parts[0] === "stop" && parts[1]) {
              await orchestrator.stopAgent(parts[1]);
              setLogs((prev) => [...prev, `Stopped: ${parts[1]}`]);
            } else if (parts[0] === "quit" || parts[0] === "exit") {
              await orchestrator.shutdown();
              exit();
            } else {
              setLogs((prev) => [...prev, `Unknown command: ${parts[0]}`]);
            }
          } catch (err: unknown) {
            setLogs((prev) => [...prev, `Error: ${err instanceof Error ? err.message : String(err)}`]);
          }
        }}
      />

      <Box paddingX={1}>
        <Text dimColor>Press 'q' to quit | Commands: spawn, stop, quit</Text>
      </Box>
    </Box>
  );
}
