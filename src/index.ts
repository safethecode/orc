#!/usr/bin/env bun

import { loadConfig } from "./config/loader.ts";
import { Orchestrator } from "./core/orchestrator.ts";

const args = process.argv.slice(2);

// ── Parse global flags ──────────────────────────────────────────────

let configPath: string | undefined;
let verbose = false;

// Strip global flags from args, leaving positional command + rest
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === "--version" || arg === "-v") {
    const { version } = await import("../package.json");
    console.log(version);
    process.exit(0);
  }

  if (arg === "--verbose") {
    verbose = true;
    continue;
  }

  if (arg === "--config") {
    configPath = args[++i];
    if (!configPath) {
      console.error("Error: --config requires a path argument");
      process.exit(1);
    }
    continue;
  }

  positional.push(arg);
}

if (!verbose && process.env.ORC_DEBUG === "1") {
  verbose = true;
}

const command = positional[0];

// ── Commands that don't need orchestrator ───────────────────────────

if (command === "help") {
  console.log(`
orc - Terminal AI Agent Orchestrator

Commands:
  (no args)           Start interactive REPL
  spawn <agent>       Spawn an agent in a tmux session
  task <prompt>       Route and assign a task to an agent
  status              Show all agent statuses
  stop <agent>        Stop a running agent
  agents              List available agent profiles
  dashboard           Open the TUI dashboard
  help                Show this help message

Flags:
  -v, --version       Print version and exit
  --config <path>     Override config file path
  --verbose           Show stack traces on error
`);
  process.exit(0);
}

// ── Boot orchestrator ───────────────────────────────────────────────

async function main() {
  const config = loadConfig(configPath);

  // Ensure data directory exists
  const { mkdirSync } = await import("fs");
  mkdirSync(config.orchestrator.dataDir, { recursive: true });
  mkdirSync(config.orchestrator.logDir, { recursive: true });

  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();

  // Also load profiles from project-local profiles/ directory
  const localProfileDir = new URL("../profiles", import.meta.url).pathname;
  try {
    await orchestrator.getRegistry().loadProfiles(localProfileDir);
  } catch {
    // local profiles directory may not exist
  }

  // ── Graceful shutdown on signals ────────────────────────────────
  const shutdown = async () => {
    await orchestrator.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  switch (command) {
    case "spawn": {
      const agentName = positional[1];
      if (!agentName) {
        console.error("Usage: orc spawn <agent-name>");
        process.exit(1);
      }
      const session = await orchestrator.spawnAgent(agentName);
      console.log(`Spawned agent "${agentName}" in session: ${session.name}`);
      break;
    }

    case "task": {
      const prompt = positional.slice(1).join(" ");
      if (!prompt) {
        console.error("Usage: orc task <prompt>");
        process.exit(1);
      }
      const agentName = positional[1] === "--agent" ? positional[2] : undefined;
      const actualPrompt = agentName ? positional.slice(3).join(" ") : prompt;

      // Use Sam (haiku) to classify, then route
      const { routeTask, classifyWithSam } = await import("./core/router.ts");
      const route = routeTask(actualPrompt, config.routing);
      let targetAgent: string;
      if (agentName) {
        targetAgent = agentName;
      } else {
        const classification = await classifyWithSam(actualPrompt);
        targetAgent = classification.agent;
        console.log(`Sam: ${classification.reason}`);
      }

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
      const agentName = positional[1];
      if (!agentName) {
        console.error("Usage: orc stop <agent-name>");
        process.exit(1);
      }
      await orchestrator.stopAgent(agentName);
      console.log(`Stopped agent: ${agentName}`);
      break;
    }

    case "dashboard": {
      // Dashboard is now part of the default TUI
      const { startTuiRepl } = await import("./tui-repl/start.tsx");
      await startTuiRepl(orchestrator, config);
      break;
    }

    case "agents":
    case "list": {
      // List available agent profiles from orchestrator's registry
      const profiles = orchestrator.getRegistry().list();
      if (profiles.length === 0) {
        console.log("No profiles found.");
      } else {
        console.log("\nAvailable Profiles:");
        console.log("─".repeat(50));
        for (const p of profiles) {
          console.log(`  ${p.name} (${p.provider}/${p.model}) - ${p.role}`);
        }
      }
      break;
    }

    case "serve": {
      const port = parseInt(positional[1] ?? "3000", 10);
      const server = Bun.serve({
        port,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/health") {
            return Response.json({ status: "ok", uptime: process.uptime() });
          }
          return new Response("Not Found", { status: 404 });
        },
      });
      console.log(`Server listening on port ${server.port}`);
      break;
    }

    case undefined: {
      const { startTuiRepl } = await import("./tui-repl/start.tsx");
      await startTuiRepl(orchestrator, config);
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
  if (verbose) {
    console.error(err.stack);
  }
  process.exit(1);
});
