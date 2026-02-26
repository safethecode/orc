import type { Orchestrator } from "../core/orchestrator.ts";
import type { Conversation } from "./conversation.ts";
import * as renderer from "./renderer.ts";

export const COMMANDS = ["/status", "/stop", "/clear", "/lang", "/help", "/quit"];

export const LANGUAGES = [
  "korean", "english", "japanese", "chinese",
  "spanish", "french", "german", "portuguese",
  "russian", "arabic", "italian", "dutch",
];

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
        renderer.info("no agents running");
      } else {
        process.stdout.write("\n");
        renderer.separator();
        for (const agent of agents) {
          const taskInfo = agent.currentTask ? `  \x1b[90mtask: ${agent.currentTask}\x1b[0m` : "";
          const statusColor = agent.status === "running" ? "\x1b[32m" : "\x1b[90m";
          renderer.info(`${statusColor}●\x1b[0m ${agent.name} \x1b[90m${agent.status}\x1b[0m${taskInfo}`);
        }
        renderer.separator();
      }
      return "continue";
    }

    case "stop": {
      const agentName = args[0];
      if (!agentName) {
        renderer.error("usage: /stop <agent-name>");
        return "continue";
      }
      try {
        await ctx.orchestrator.stopAgent(agentName);
        renderer.info(`✓ stopped ${agentName}`);
      } catch (e) {
        renderer.error((e as Error).message);
      }
      return "continue";
    }

    case "clear": {
      ctx.conversation.clear();
      renderer.info("✓ conversation cleared");
      return "continue";
    }

    case "lang": {
      const lang = args[0];
      if (!lang) {
        const current = ctx.conversation.getLanguage();
        process.stdout.write("\n");
        renderer.info(current ? `current: \x1b[1m${current}\x1b[0m` : "no language set (default)");
        renderer.info(`\x1b[2m${LANGUAGES.join(" · ")}\x1b[0m`);
        renderer.info("\x1b[2musage: /lang <language>\x1b[0m");
        process.stdout.write("\n");
      } else {
        ctx.conversation.setLanguage(lang);
        renderer.info(`✓ language set to ${lang}`);
      }
      return "continue";
    }

    case "help": {
      process.stdout.write("\n");
      renderer.info("\x1b[1m/status\x1b[0m\x1b[2m           agent statuses");
      renderer.info("\x1b[1m/stop\x1b[0m \x1b[2m<agent>     stop a running agent");
      renderer.info("\x1b[1m/clear\x1b[0m\x1b[2m            clear conversation");
      renderer.info("\x1b[1m/lang\x1b[0m \x1b[2m<language>   set response language");
      renderer.info("\x1b[1m/help\x1b[0m\x1b[2m             this help");
      renderer.info("\x1b[1m/quit\x1b[0m\x1b[2m             exit");
      process.stdout.write("\n");
      return "continue";
    }

    case "quit":
    case "exit":
    case "q": {
      return "quit";
    }

    case "": {
      // bare "/" — show available commands
      process.stdout.write("\n");
      renderer.info(`\x1b[2m${COMMANDS.join("  ")}\x1b[0m`);
      process.stdout.write("\n");
      return "continue";
    }

    default: {
      renderer.error(`unknown command: /${cmd}`);
      return "continue";
    }
  }
}
