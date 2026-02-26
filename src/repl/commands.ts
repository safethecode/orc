import type { Orchestrator } from "../core/orchestrator.ts";
import type { Conversation } from "./conversation.ts";
import * as renderer from "./renderer.ts";

export interface CommandContext {
  orchestrator: Orchestrator;
  conversation: Conversation;
}

export function isCommand(input: string): boolean {
  return input.startsWith("/");
}

export async function handleCommand(
  input: string,
  ctx: CommandContext,
): Promise<"continue" | "quit"> {
  const [cmd, ...args] = input.slice(1).split(/\s+/);

  switch (cmd) {
    case "status": {
      const agents = await ctx.orchestrator.listAgents();
      if (agents.length === 0) {
        renderer.info("No agents registered.");
      } else {
        renderer.info("\nAgent Status:");
        renderer.info("\u2500".repeat(50));
        for (const agent of agents) {
          const taskInfo = agent.currentTask ? ` [task: ${agent.currentTask}]` : "";
          renderer.info(`  ${agent.name}: ${agent.status}${taskInfo}`);
        }
      }
      return "continue";
    }

    case "stop": {
      const agentName = args[0];
      if (!agentName) {
        renderer.error("Usage: /stop <agent-name>");
        return "continue";
      }
      try {
        await ctx.orchestrator.stopAgent(agentName);
        renderer.info(`Stopped agent: ${agentName}`);
      } catch (e) {
        renderer.error(`Failed to stop agent: ${(e as Error).message}`);
      }
      return "continue";
    }

    case "clear": {
      ctx.conversation.clear();
      renderer.info("Conversation cleared.");
      return "continue";
    }

    case "help": {
      renderer.info(`
Commands:
  /status           Show all agent statuses
  /stop <agent>     Stop a running agent
  /clear            Clear conversation history
  /help             Show this help
  /quit             Exit the REPL
`);
      return "continue";
    }

    case "quit":
    case "exit":
    case "q": {
      return "quit";
    }

    default: {
      renderer.error(`Unknown command: /${cmd}. Type /help for available commands.`);
      return "continue";
    }
  }
}
