import * as readline from "node:readline/promises";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig } from "../config/types.ts";
import { routeTask, suggestAgent } from "../core/router.ts";
import { buildCommand } from "../agents/provider.ts";
import { AgentStreamer } from "./streamer.ts";
import { Conversation } from "./conversation.ts";
import { isCommand, handleCommand } from "./commands.ts";
import * as renderer from "./renderer.ts";

const PROMPT = "\x1b[1m> \x1b[0m";

export async function startRepl(
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
): Promise<void> {
  const conversation = new Conversation();
  let currentStreamer: AgentStreamer | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Ctrl+C handling: abort running generation, keep REPL alive
  process.on("SIGINT", () => {
    if (currentStreamer?.isRunning) {
      currentStreamer.abort();
      process.stdout.write("\n");
      renderer.info("Generation aborted.");
    } else {
      // Second Ctrl+C or no active generation → clean exit
      process.stdout.write("\n");
      rl.close();
    }
  });

  renderer.welcome();

  try {
    while (true) {
      let input: string;
      try {
        input = await rl.question(PROMPT);
      } catch {
        // EOF or closed
        break;
      }

      const trimmed = input.trim();
      if (!trimmed) continue;

      // Slash commands
      if (isCommand(trimmed)) {
        const result = await handleCommand(trimmed, {
          orchestrator,
          conversation,
        });
        if (result === "quit") break;
        continue;
      }

      // Natural language → route → spawn → stream
      await handleNaturalInput(
        trimmed,
        orchestrator,
        config,
        conversation,
        (streamer) => { currentStreamer = streamer; },
      );
      currentStreamer = null;
    }
  } finally {
    rl.close();
    renderer.info("Goodbye.");
  }
}

async function handleNaturalInput(
  input: string,
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
  conversation: Conversation,
  onStreamer: (s: AgentStreamer) => void,
): Promise<void> {
  // Route the task
  const route = routeTask(input, config.routing);
  const agentName = suggestAgent(route.tier);
  const profile = orchestrator.getRegistry().get(agentName);
  if (!profile) {
    renderer.error(`No profile found for agent "${agentName}".`);
    return;
  }

  const providerConfig = config.providers[profile.provider];
  if (!providerConfig) {
    renderer.error(`No provider config for "${profile.provider}".`);
    return;
  }

  // Show agent header (only show routing reason when keywords matched)
  if (route.reason) {
    renderer.agentHeader(agentName, route.model, route.reason);
  }

  // Build prompt with conversation context
  const fullPrompt = conversation.buildPrompt(input);

  // Add user turn to history
  conversation.add({
    role: "user",
    content: input,
    timestamp: new Date().toISOString(),
  });

  // Build command
  const cmd = buildCommand(providerConfig, profile, {
    prompt: fullPrompt,
    model: route.model,
    maxBudgetUsd: profile.maxBudgetUsd,
    systemPrompt: profile.systemPrompt,
  });

  // Stream execution
  const streamer = new AgentStreamer();
  onStreamer(streamer);

  streamer.on("text", (chunk: string) => {
    renderer.text(chunk);
  });

  try {
    const result = await streamer.run(cmd);

    // Show cost
    if (result.inputTokens > 0 || result.outputTokens > 0) {
      renderer.cost(result.costUsd, result.inputTokens, result.outputTokens);
    }

    // Add assistant turn to conversation
    conversation.add({
      role: "assistant",
      content: result.text,
      agentName,
      tier: route.model,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    renderer.error(`Agent execution failed: ${(e as Error).message}`);
  }
}
