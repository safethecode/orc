import * as readline from "node:readline/promises";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig } from "../config/types.ts";
import { routeTask, suggestAgent, type RouteResult } from "../core/router.ts";
import { buildCommand } from "../agents/provider.ts";
import { buildHarness } from "../agents/harness.ts";
import { AgentStreamer, type ToolUseEvent } from "./streamer.ts";
import { Conversation } from "./conversation.ts";
import { isCommand, handleCommand, COMMANDS, LANGUAGES } from "./commands.ts";
import { TIER_BUDGETS } from "../memory/token-optimizer.ts";
import { CancellationToken } from "../utils/cancellation.ts";
import { notify } from "../utils/notifications.ts";
import { RolloutRecorder } from "../session/rollout.ts";
import { eventBus } from "../core/events.ts";
import { diffFromGhost } from "../utils/ghost-commit.ts";
import * as renderer from "./renderer.ts";

export async function startRepl(
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
): Promise<void> {
  const conversation = new Conversation();
  let currentStreamer: AgentStreamer | null = null;
  let currentCancellation: CancellationToken | null = null;
  let hasInteraction = false;
  let pinnedAgent: string | null = null;

  // Deferred rollout: only create file when user actually sends a message
  const rollout = new RolloutRecorder(
    `${config.orchestrator.dataDir}/sessions`,
  );

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

  // Ctrl+C handling: abort running generation via cancellation token
  process.on("SIGINT", () => {
    if (currentCancellation && !currentCancellation.cancelled) {
      currentCancellation.cancel();
      process.stdout.write("\n");
      renderer.info("Generation aborted.");
    } else if (currentStreamer?.isRunning) {
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

  // Show last session hint if available
  const lastSnapshot = orchestrator.getStore().getLatestSnapshot();
  if (lastSnapshot) {
    const summary = lastSnapshot.summary || "no summary";
    renderer.info(
      `\x1b[2mPrevious session: ${lastSnapshot.turnCount} turns, ${lastSnapshot.createdAt} \u2014 "${summary}"\x1b[0m`,
    );
    renderer.info("\x1b[2mType /resume to continue or start fresh\x1b[0m");
  }

  // Prewarm DNS cache while user reads welcome screen
  orchestrator.getPrewarmer().prewarm().catch(() => {});

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
          getPinnedAgent: () => pinnedAgent,
          setPinnedAgent: (name) => { pinnedAgent = name; },
        });
        if (result === "quit") break;
        continue;
      }

      // Acquire sleep inhibitor during agent work
      orchestrator.getSleepInhibitor().acquire();

      const cancellation = new CancellationToken();
      currentCancellation = cancellation;

      await handleNaturalInput(
        trimmed,
        orchestrator,
        config,
        conversation,
        rollout,
        cancellation,
        (streamer) => { currentStreamer = streamer; },
        pinnedAgent,
      );
      hasInteraction = true;
      currentStreamer = null;
      currentCancellation = null;

      // Release sleep inhibitor after agent work
      orchestrator.getSleepInhibitor().release();

      // Desktop notification when terminal is likely unfocused
      notify(`orc: response ready`);

      // Prewarm for next request
      orchestrator.getPrewarmer().prewarm().catch(() => {});

      process.stdout.write("\n");
    }
  } finally {
    // Auto-save snapshot on exit (only if user actually interacted)
    if (hasInteraction && conversation.length > 0) {
      const snapshot = conversation.toSnapshot();
      orchestrator.getStore().saveSnapshot({
        id: crypto.randomUUID(),
        turnsJson: JSON.stringify(snapshot.turns),
        language: snapshot.language,
        summary: conversation.generateSummary(),
        turnCount: conversation.length,
      });
      eventBus.publish({ type: "session:save", turnCount: conversation.length });

      // Persist rollout (deferred: only written if there was interaction)
      rollout.persist();
    }

    // Show ghost commit diff summary on exit
    const ghostSha = orchestrator.getGhostSha();
    if (ghostSha) {
      const diff = await diffFromGhost(ghostSha);
      if (diff) {
        renderer.info(`\x1b[2mSession changes:\x1b[0m`);
        const lines = diff.split("\n").slice(0, 5);
        for (const line of lines) renderer.info(`  \x1b[2m${line}\x1b[0m`);
        if (diff.split("\n").length > 5) renderer.info(`  \x1b[2m...\x1b[0m`);
      }
    }

    orchestrator.getSleepInhibitor().release();
    rl.close();
    renderer.info("Goodbye.");
  }
}

async function handleNaturalInput(
  input: string,
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
  conversation: Conversation,
  rollout: RolloutRecorder,
  cancellation: CancellationToken,
  onStreamer: (s: AgentStreamer) => void,
  pinned: string | null,
): Promise<void> {
  let route: RouteResult;
  let agentName: string;

  if (pinned) {
    const pinnedProfile = orchestrator.getRegistry().get(pinned);
    if (!pinnedProfile) {
      renderer.error(`Pinned profile "${pinned}" not found. Use /agents auto to reset.`);
      return;
    }
    const model = pinnedProfile.model as import("../config/types.ts").ModelTier;
    route = { tier: "medium", model, multiAgent: false, reason: `pinned to ${pinned}` };
    agentName = pinned;
  } else {
    route = routeTask(input, config.routing);
    agentName = suggestAgent(route.tier);
  }

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

  // Publish event
  eventBus.publish({ type: "agent:start", agent: agentName, tier: route.model, reason: route.reason });

  // Show agent header
  renderer.agentHeader(agentName, route.model, route.reason);

  // Dynamic skill matching (before spinner — dim output must not overlap spinner)
  // Build match context from conversation history + current input
  const recentTurns = conversation.getTurns().slice(-6);
  const matchContext = recentTurns.map(t => t.content).join(" ") + " " + input;

  const skillIndex = orchestrator.getSkillIndex();
  const dynamicMatched = skillIndex.match(matchContext, 3);

  // Profile explicit skills as guaranteed baseline
  const baselineEntries = (profile.skills ?? [])
    .map(name => skillIndex.getByName(name))
    .filter((e): e is NonNullable<typeof e> => e != null);

  // Merge: baseline first, then dynamic (deduped)
  const seen = new Set<string>();
  const allMatched: typeof baselineEntries = [];
  for (const entry of [...baselineEntries, ...dynamicMatched]) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      allMatched.push(entry);
    }
  }

  let skillBodies: string[] = [];
  if (allMatched.length > 0) {
    skillBodies = await skillIndex.resolve(allMatched);
    renderer.dim(`  skills: ${allMatched.map(s => s.name).join(", ")}`);
  }

  // Start spinner while waiting for response
  renderer.startSpinner(agentName, route.model);

  // Set tier-specific token budget before building prompt
  conversation.setTokenBudget(TIER_BUDGETS[route.model] ?? TIER_BUDGETS.sonnet);
  const fullPrompt = conversation.buildPrompt(input);

  // Record user turn
  const userTurn = {
    role: "user" as const,
    content: input,
    timestamp: new Date().toISOString(),
  };
  conversation.add(userTurn);
  rollout.append({ type: "turn", timestamp: userTurn.timestamp, data: userTurn });

  const harness = buildHarness({
    agentName,
    role: (profile.role ?? "coder") as import("../config/types.ts").AgentRole,
    provider: profile.provider as import("../config/types.ts").ProviderName,
    parentTaskId: "repl",
    isWorker: false,
  });
  let systemPrompt = harness.systemPrompt;
  if (profile.systemPrompt) systemPrompt += "\n\n" + profile.systemPrompt;

  // Append pre-resolved skill bodies
  if (skillBodies.length > 0) {
    systemPrompt += "\n\n" + skillBodies.join("\n\n");
  }

  const lang = conversation.getLanguage();
  if (lang) {
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\nAlways respond in ${lang}.`
      : `Always respond in ${lang}.`;
  }

  // Inject relevant memories into system prompt
  const memories = orchestrator.getMemory().getRelevantMemories(input, agentName, 5);
  const memoryCtx = orchestrator.getMemory().formatForPrompt(memories);
  if (memoryCtx) {
    systemPrompt = systemPrompt ? `${systemPrompt}\n${memoryCtx}` : memoryCtx;
    eventBus.publish({ type: "memory:inject", count: memories.length });
  }

  // Tier-specific response length hint
  if (route.model === "haiku") {
    systemPrompt = systemPrompt
      ? `${systemPrompt}\nKeep responses concise and under 200 words.`
      : "Keep responses concise and under 200 words.";
  }

  const cmd = buildCommand(providerConfig, profile, {
    prompt: fullPrompt,
    model: route.model,
    maxBudgetUsd: profile.maxBudgetUsd,
    systemPrompt,
    maxTurns: profile.maxTurns ?? 10,
  });

  const streamer = new AgentStreamer();
  onStreamer(streamer);

  let boxOpen = false;

  streamer.on("tool_use", (tool: ToolUseEvent) => {
    renderer.stopSpinner();
    const input = tool.input ?? {};
    const detail = (input.file_path as string) ?? (input.command as string) ?? (input.pattern as string) ?? undefined;
    renderer.toolUse(tool.name, detail);
    eventBus.publish({ type: "agent:tool", agent: agentName, tool: tool.name, detail });
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
    eventBus.publish({ type: "agent:error", agent: agentName, message: msg });
  });

  const startTime = Date.now();

  try {
    const result = await streamer.run(cmd, cancellation.signal);
    renderer.stopSpinner();
    const durationMs = Date.now() - startTime;

    if (boxOpen) {
      renderer.endBox();
    }

    if (result.inputTokens > 0 || result.outputTokens > 0) {
      renderer.cost(result.costUsd, result.inputTokens, result.outputTokens, durationMs);
      eventBus.publish({
        type: "agent:done", agent: agentName,
        cost: result.costUsd, inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, durationMs,
      });
    }

    const assistantTurn = {
      role: "assistant" as const,
      content: result.text,
      agentName,
      tier: route.model,
      timestamp: new Date().toISOString(),
    };
    conversation.add(assistantTurn);
    rollout.append({ type: "turn", timestamp: assistantTurn.timestamp, data: assistantTurn });
  } catch (e) {
    renderer.error(`Agent execution failed: ${(e as Error).message}`);
  }
}
