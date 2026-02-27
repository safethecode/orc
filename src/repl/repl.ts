import * as readline from "node:readline/promises";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig } from "../config/types.ts";
import { routeTask, suggestAgent } from "../core/router.ts";
import { buildCommand } from "../agents/provider.ts";
import { AgentStreamer, type ToolUseEvent } from "./streamer.ts";
import { Conversation } from "./conversation.ts";
import { isCommand, handleCommand, COMMANDS, LANGUAGES } from "./commands.ts";
import * as renderer from "./renderer.ts";

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
    completer: (line: string): [string[], string] => {
      if (line.startsWith("/lang ")) {
        const partial = line.slice(6).toLowerCase();
        const hits = LANGUAGES.filter((l) => l.startsWith(partial));
        return [hits.map((l) => `/lang ${l}`), line];
      }
      if (line.startsWith("/")) {
        const hits = COMMANDS.filter((c) => c.startsWith(line));
        return [hits.length ? hits : COMMANDS, line];
      }
      return [[], line];
    },
  });

  // ── Inline ghost hint for / commands ─────────────────────────────
  // Writes dim text AFTER the cursor on the SAME line. No \n ever.
  // Truncated to terminal width so it never wraps.
  let promptActive = false;
  const PROMPT_VIS = 2; // visible width of "❯ "

  process.stdin.on("keypress", (_str: string | undefined, key: { name?: string }) => {
    if (!promptActive) return;
    // On enter, readline handles the newline — nothing to do
    if (key?.name === "return" || key?.name === "enter") return;

    setImmediate(() => {
      const line = rl.line;

      // Only touch the terminal for / commands (ASCII-only, safe to use .length)
      // Non-slash input (Korean, etc.) is left entirely to readline
      if (!line.startsWith("/")) return;

      const endCol = PROMPT_VIS + line.length + 1; // 1-indexed
      const cursorCol = PROMPT_VIS + rl.cursor + 1;

      // Clear previous hint (everything past user input)
      process.stdout.write(`\x1b[${endCol}G\x1b[K`);

      let display: string;
      if (line.startsWith("/lang ")) {
        const partial = line.slice(6).toLowerCase();
        const hits = LANGUAGES.filter((l) => l.startsWith(partial));
        display = (hits.length ? hits : LANGUAGES).join(" · ");
      } else {
        const hits = COMMANDS.filter((c) => c.startsWith(line));
        display = (hits.length ? hits : COMMANDS).join("  ");
      }

      // Truncate to fit terminal width
      const termW = process.stdout.columns || 80;
      const available = termW - endCol - 2;
      if (available > 3) {
        const hint = display.length > available
          ? display.slice(0, available - 1) + "\u2026"
          : display;
        process.stdout.write(`  \x1b[2m${hint}\x1b[0m`);
      }

      // Restore cursor to where the user is typing
      process.stdout.write(`\x1b[${cursorCol}G`);
    });
  });

  // Ctrl+C handling: abort running generation, keep REPL alive
  process.on("SIGINT", () => {
    if (currentStreamer?.isRunning) {
      currentStreamer.abort();
      process.stdout.write("\n");
      renderer.info("Generation aborted.");
    } else {
      process.stdout.write("\n");
      rl.close();
      process.exit(0);
    }
  });

  // Clear screen and move cursor to top
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  // Welcome with profile names
  const profiles = orchestrator.getRegistry().list().map((p) => p.name);
  renderer.welcome(profiles);

  try {
    while (true) {
      let input: string;
      try {
        promptActive = true;
        input = await rl.question(renderer.PROMPT);
        promptActive = false;
      } catch {
        promptActive = false;
        break;
      }

      const trimmed = input.trim();
      if (!trimmed) continue;

      if (isCommand(trimmed)) {
        const result = await handleCommand(trimmed, {
          orchestrator,
          conversation,
        });
        if (result === "quit") break;
        continue;
      }

      await handleNaturalInput(
        trimmed,
        orchestrator,
        config,
        conversation,
        (streamer) => { currentStreamer = streamer; },
      );
      currentStreamer = null;
      process.stdout.write("\n");
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

  // Show agent header
  renderer.agentHeader(agentName, route.model, route.reason);

  // Start spinner while waiting for response
  renderer.startSpinner(agentName, route.model);

  const fullPrompt = conversation.buildPrompt(input);

  conversation.add({
    role: "user",
    content: input,
    timestamp: new Date().toISOString(),
  });

  let systemPrompt = profile.systemPrompt;
  const lang = conversation.getLanguage();
  if (lang) {
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\nAlways respond in ${lang}.`
      : `Always respond in ${lang}.`;
  }

  const cmd = buildCommand(providerConfig, profile, {
    prompt: fullPrompt,
    model: route.model,
    maxBudgetUsd: profile.maxBudgetUsd,
    systemPrompt,
  });

  const streamer = new AgentStreamer();
  onStreamer(streamer);

  let boxOpen = false;

  streamer.on("tool_use", (tool: ToolUseEvent) => {
    renderer.stopSpinner();
    const input = tool.input ?? {};
    const detail = (input.file_path as string) ?? (input.command as string) ?? (input.pattern as string) ?? undefined;
    renderer.toolUse(tool.name, detail);
  });

  streamer.on("text_complete", (fullText: string) => {
    if (!boxOpen) {
      renderer.stopSpinner();
      renderer.startBox(route.model);
      boxOpen = true;
    }
    renderer.text(fullText);
  });

  streamer.on("error", (msg: string) => {
    renderer.stopSpinner();
    renderer.error(msg);
  });

  const startTime = Date.now();

  try {
    const result = await streamer.run(cmd);
    renderer.stopSpinner();
    const durationMs = Date.now() - startTime;

    if (boxOpen) {
      renderer.endBox();
    }

    if (result.inputTokens > 0 || result.outputTokens > 0) {
      renderer.cost(result.costUsd, result.inputTokens, result.outputTokens, durationMs);
      const totalTokens = result.inputTokens + result.outputTokens;
      orchestrator.getBudget().recordUsage(agentName, "repl", totalTokens, result.costUsd);
    }

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
