#!/usr/bin/env bun

import { loadConfig } from "./config/loader.ts";
import { Orchestrator } from "./core/orchestrator.ts";
import { resolvePath } from "./config/loader.ts";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  const config = loadConfig();

  // Ensure data directory exists
  const { mkdirSync } = await import("fs");
  mkdirSync(config.orchestrator.dataDir, { recursive: true });
  mkdirSync(config.orchestrator.logDir, { recursive: true });

  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();

  switch (command) {
    case "spawn": {
      const agentName = args[1];
      if (!agentName) {
        console.error("Usage: orc spawn <agent-name>");
        process.exit(1);
      }
      const session = await orchestrator.spawnAgent(agentName);
      console.log(`Spawned agent "${agentName}" in session: ${session.name}`);
      break;
    }

    case "task": {
      const prompt = args.slice(1).join(" ");
      if (!prompt) {
        console.error("Usage: orc task <prompt>");
        process.exit(1);
      }
      const agentName = args[1] === "--agent" ? args[2] : undefined;
      const actualPrompt = agentName ? args.slice(3).join(" ") : prompt;

      // Use router to determine best agent if not specified
      const { routeTask, suggestAgent } = await import("./core/router.ts");
      const route = routeTask(actualPrompt, config.routing);
      const targetAgent = agentName ?? suggestAgent(route.tier);

      console.log(`Routing: ${route.tier} → ${route.model} (${route.reason})`);
      console.log(`Agent: ${targetAgent}`);

      const task = await orchestrator.handoff(targetAgent, actualPrompt, { waitForCompletion: false });
      console.log(`Task assigned: ${task.id}`);
      break;
    }

    case "status": {
      const agents = await orchestrator.listAgents();
      if (agents.length === 0) {
        console.log("No agents registered.");
      } else {
        console.log("\nAgent Status:");
        console.log("─".repeat(50));
        for (const agent of agents) {
          const taskInfo = agent.currentTask ? ` [task: ${agent.currentTask}]` : "";
          console.log(`  ${agent.name}: ${agent.status}${taskInfo}`);
        }
      }
      break;
    }

    case "stop": {
      const agentName = args[1];
      if (!agentName) {
        console.error("Usage: orc stop <agent-name>");
        process.exit(1);
      }
      await orchestrator.stopAgent(agentName);
      console.log(`Stopped agent: ${agentName}`);
      break;
    }

    case "dashboard": {
      const { renderDashboard } = await import("./tui/app.tsx");
      await renderDashboard(orchestrator, config);
      break;
    }

    case "list": {
      // List available agent profiles
      const { AgentRegistry } = await import("./agents/registry.ts");
      const registry = new AgentRegistry();
      const profileDir = new URL("../profiles", import.meta.url).pathname;
      try {
        await registry.loadProfiles(profileDir);
        const profiles = registry.list();
        console.log("\nAvailable Profiles:");
        console.log("─".repeat(50));
        for (const p of profiles) {
          console.log(`  ${p.name} (${p.provider}/${p.model}) - ${p.role}`);
        }
      } catch {
        console.log("No profiles found.");
      }
      break;
    }

    case "help": {
      console.log(`
orc - Terminal AI Agent Orchestrator

Commands:
  (no args)           Start interactive REPL
  spawn <agent>       Spawn an agent in a tmux session
  task <prompt>       Route and assign a task to an agent
  status              Show all agent statuses
  stop <agent>        Stop a running agent
  list                List available agent profiles
  dashboard           Open the TUI dashboard
  help                Show this help message
`);
      break;
    }

    case undefined: {
      // No args → interactive REPL
      const { startRepl } = await import("./repl/repl.ts");
      await startRepl(orchestrator, config);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error("Run 'orc help' for usage.");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
