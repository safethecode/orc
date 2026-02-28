import * as readline from "node:readline/promises";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig, AgentProfile, ModelTier, SubTask, ProviderName, DecompositionResult } from "../config/types.ts";
import { routeTask, suggestAgent, type RouteResult } from "../core/router.ts";
import { buildCommand } from "../agents/provider.ts";
import { buildHarness } from "../agents/harness.ts";
import { AgentStreamer, type ToolUseEvent, type StreamResult } from "./streamer.ts";
import { Conversation } from "./conversation.ts";
import { isCommand, handleCommand, COMMANDS, LANGUAGES } from "./commands.ts";
import { TIER_BUDGETS } from "../memory/token-optimizer.ts";
import { CancellationToken } from "../utils/cancellation.ts";
import { notify } from "../utils/notifications.ts";
import { RolloutRecorder } from "../session/rollout.ts";
import { eventBus } from "../core/events.ts";
import { diffFromGhost } from "../utils/ghost-commit.ts";
import { decompose } from "../core/decomposer.ts";
import { ResultCollector } from "../core/result-collector.ts";
import { ContextPropagator } from "../core/context-propagator.ts";
import { scoutSkills, type ScoutResult } from "./skill-scout.ts";
import { scoutMcp, type McpScoutResult } from "../mcp/mcp-scout.ts";
import { ScoutCache } from "./scout-cache.ts";
import { runQualityGate } from "./quality-gate.ts";
import { getPhaseModel } from "../core/phase-config.ts";
import { detectRecurringIssues, DEFAULT_QA_CONFIG } from "../core/qa-loop.ts";
import type { QAIssue, ExecutionPhase } from "../config/types.ts";
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

  // Session-level caches to avoid redundant Haiku scout calls
  const mcpScoutCache = new ScoutCache();
  const skillScoutCache = new ScoutCache();

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

  // Show connected MCP servers
  const mcpManager = orchestrator.getMcpManager();
  const mcpServers = mcpManager.getConnectedServers();
  if (mcpServers.length > 0) {
    renderer.mcpStatus(mcpServers, mcpManager.getToolCount());
  }

  // Show last session hint if available
  const lastSnapshot = orchestrator.getStore().getLatestSnapshot();
  if (lastSnapshot) {
    const summary = lastSnapshot.summary || "no summary";
    renderer.info(
      `\x1b[2mPrevious session: ${lastSnapshot.turnCount} turns, ${lastSnapshot.createdAt} \u2014 "${summary}"\x1b[0m`,
    );
    renderer.info("\x1b[2mType /resume to continue or start fresh\x1b[0m");
  }

  // Wire crash recovery signal handlers
  orchestrator.getCrashRecovery().bindSignalHandlers(async () => {
    await orchestrator.shutdown();
  });

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
        mcpScoutCache,
        skillScoutCache,
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
  mcpScoutCache: ScoutCache,
  skillScoutCache: ScoutCache,
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
    // Cost-aware routing: estimate cost and pass to router
    const costEstimator = orchestrator.getCostEstimator();
    const costEst = costEstimator.estimate(input);
    route = routeTask(input, config.routing, { costEstimate: costEst });

    // Budget enforcement (only when user explicitly enables)
    if (config.orchestrator.budgetEnabled && route.multiAgent
        && costEst.multiAgent.estimatedCostUsd > config.budget.defaultMaxPerTask) {
      renderer.info("Budget exceeded — downgrading to single agent");
      route.multiAgent = false;
    }

    // Show estimate for multi-agent decisions
    if (route.multiAgent) {
      renderer.costEstimate(
        costEst.singleAgent.estimatedCostUsd,
        costEst.multiAgent.estimatedCostUsd,
        costEst.recommendation,
      );
    }

    agentName = suggestAgent(route.tier);
  }

  if (route.multiAgent) {
    await handleMultiAgent(input, orchestrator, config, conversation, rollout, cancellation, onStreamer, mcpScoutCache, skillScoutCache);
    return;
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

  // Show agent header + spinner immediately
  renderer.agentHeader(agentName, route.model, route.reason);
  renderer.startSpinner(agentName, route.model);

  // Parallel Haiku scout: skill + MCP discovery (with cache)
  const skillIndex = orchestrator.getSkillIndex();
  const pseudoSubtask = { agentRole: profile.role ?? "coder", prompt: input } as SubTask;
  const cachedSkill = skillScoutCache.get<ScoutResult>(input);
  const cachedMcp = mcpScoutCache.get<McpScoutResult>(input);

  const emptySkill: ScoutResult = { needed: false, skills: [], durationMs: 0 };
  const emptyMcp: McpScoutResult = { needed: false, servers: [], durationMs: 0 };
  const [skillSettled, mcpSettled] = await Promise.allSettled([
    cachedSkill ? Promise.resolve(cachedSkill) : scoutSkills(pseudoSubtask, skillIndex, cancellation.signal).then(r => { skillScoutCache.set(input, r); return r; }),
    cachedMcp ? Promise.resolve(cachedMcp) : scoutMcp(input, cancellation.signal).then(r => { mcpScoutCache.set(input, r); return r; }),
  ]);
  const skillScoutResult = skillSettled.status === "fulfilled" ? skillSettled.value : emptySkill;
  const mcpScoutResult = mcpSettled.status === "fulfilled" ? mcpSettled.value : emptyMcp;

  // Merge Haiku-scouted skills with profile baseline skills
  const baselineEntries = (profile.skills ?? [])
    .map(name => skillIndex.getByName(name))
    .filter((e): e is NonNullable<typeof e> => e != null);

  const seen = new Set<string>();
  const allMatched: typeof baselineEntries = [];
  for (const entry of [...baselineEntries, ...(skillScoutResult.needed ? skillScoutResult.skills : [])]) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      allMatched.push(entry);
    }
  }

  const skillBodies = allMatched.length > 0 ? await skillIndex.resolve(allMatched) : [];

  // Render scout results (pause spinner for clean output)
  const hasScoutOutput = (allMatched.length > 0 && skillBodies.length > 0) || (mcpScoutResult.needed && mcpScoutResult.servers.length > 0);
  if (hasScoutOutput) renderer.stopSpinner();

  if (skillScoutResult.needed && skillScoutResult.skills.length > 0) {
    renderer.skillScout(skillScoutResult.skills.map(s => s.name), skillScoutResult.durationMs);
  }

  const mcpMgr = orchestrator.getMcpManager();
  if (mcpScoutResult.needed && mcpScoutResult.servers.length > 0) {
    const connected = await mcpMgr.connectOnDemand(mcpScoutResult.servers);
    if (connected.length > 0) {
      renderer.mcpScout(connected, mcpScoutResult.durationMs);
    }
  }

  // Restart spinner for prompt building + agent execution
  if (hasScoutOutput) renderer.startSpinner(agentName, route.model);

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
  systemPrompt += `\n\nYou are working in the project at: ${process.cwd()}`;
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

  // Inject relevant architectural decisions
  const decisions = orchestrator.getDecisions().getRelevantDecisions(input);
  if (decisions.length > 0) {
    systemPrompt += "\n\n" + orchestrator.getDecisions().formatForPrompt(decisions);
  }

  // Inject LSP capabilities context
  const lspActive = orchestrator.getLspManager().listActive();
  if (lspActive.length > 0) {
    systemPrompt += `\n\nLSP servers active: ${lspActive.join(", ")}. You can use go-to-definition, find-references, and diagnostics for structural code navigation.`;
  }

  // Tier-specific response length hint
  if (route.model === "haiku") {
    systemPrompt = systemPrompt
      ? `${systemPrompt}\nKeep responses concise and under 200 words.`
      : "Keep responses concise and under 200 words.";
  }

  // MCP integration: CLI passthrough for Claude, prompt injection for others
  const mcpServerNames = profile.mcpServers ?? (mcpMgr.getConnectedServers().length > 0 ? undefined : []);
  let mcpConfigPath: string | undefined;

  if (mcpMgr.getToolCount() > 0 && !(mcpServerNames && mcpServerNames.length === 0)) {
    if (profile.provider === "claude") {
      mcpConfigPath = mcpMgr.generateMcpConfigJson(mcpServerNames) ?? undefined;
    } else {
      const toolCtx = mcpMgr.formatToolsForPrompt(mcpServerNames);
      if (toolCtx) systemPrompt += "\n\n" + toolCtx;
    }
  }

  const cmd = buildCommand(providerConfig, profile, {
    prompt: fullPrompt,
    model: route.model,
    systemPrompt,
    maxTurns: profile.maxTurns,
    mcpConfig: mcpConfigPath,
  });

  // Retry loop with provider fallback
  const maxRetries = config.supervisor?.maxRetries ?? 2;
  const maxAttempts = maxRetries + 1;
  const selector = orchestrator.getSupervisor().getProviderSelector();
  let currentProfile = profile;
  let currentProviderConfig = providerConfig;
  let currentCmd = cmd;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (cancellation.cancelled) break;

    if (attempt > 0) {
      // Fallback to different provider
      const fallback = selector.select(
        { agentRole: currentProfile.role ?? "coder", prompt: input } as SubTask,
        { excluded: [currentProfile.provider as ProviderName] },
      );
      if (fallback.score > 0) {
        const fb = orchestrator.getRegistry().get(fallback.provider);
        if (fb) {
          currentProfile = fb;
          currentProviderConfig = config.providers[fb.provider] ?? currentProviderConfig;
          currentCmd = buildCommand(currentProviderConfig, currentProfile, {
            prompt: fullPrompt,
            model: route.model,
            systemPrompt,
            maxTurns: currentProfile.maxTurns,
            mcpConfig: mcpConfigPath,
          });
        }
      }
      renderer.retryAttempt(attempt, maxRetries, lastError ?? "unknown");
      renderer.startSpinner(agentName, route.model);
    }

    const streamer = new AgentStreamer();
    onStreamer(streamer);
    let hasContent = false;
    let boxOpen = false;

    // Real-time streaming: open box on first content, stream into it
    streamer.on("text_delta", (delta: string) => {
      if (!boxOpen) {
        renderer.stopSpinner();
        renderer.startBox(route.model);
        boxOpen = true;
      }
      hasContent = true;
      renderer.text(delta);
    });

    streamer.on("tool_use", (tool: ToolUseEvent) => {
      const inp = tool.input ?? {};
      const detail = (inp.file_path as string) ?? (inp.command as string) ?? (inp.pattern as string) ?? undefined;
      if (boxOpen) {
        renderer.toolUse(tool.name, detail, true);
      } else {
        renderer.updateSpinner(`${tool.name} ${detail ? detail.split("/").pop() : ""}`.trim());
      }
      eventBus.publish({ type: "agent:tool", agent: agentName, tool: tool.name, detail });
    });

    streamer.on("error", (msg: string) => {
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();
      renderer.error(msg);
      eventBus.publish({ type: "agent:error", agent: agentName, message: msg });
    });

    const startTime = Date.now();

    try {
      const result = await streamer.run(currentCmd, cancellation.signal);
      renderer.stopSpinner();
      const durationMs = Date.now() - startTime;

      if (boxOpen) {
        renderer.endBox();
      }

      // Quality gate
      if (result.text) {
        const critique = runQualityGate({ agentRole: currentProfile.role ?? "coder", prompt: input }, result.text);
        renderer.qualityGate(critique.passes, critique.issues);
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
      return; // Success — exit retry loop
    } catch (e) {
      lastError = (e as Error).message;
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();
      if (attempt === maxAttempts - 1) {
        renderer.error(`All ${maxAttempts} attempts failed: ${lastError}`);
      }
    }
  }
}

async function handleMultiAgent(
  input: string,
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
  conversation: Conversation,
  rollout: RolloutRecorder,
  cancellation: CancellationToken,
  onStreamer: (s: AgentStreamer) => void,
  mcpScoutCache: ScoutCache,
  skillScoutCache: ScoutCache,
): Promise<void> {
  const taskId = `repl-${Date.now().toString(36)}`;

  // 1. Decompose
  const decomposition = decompose(input, taskId);

  // Single subtask fallback → run as normal single agent
  if (decomposition.subtasks.length <= 1) {
    const st = decomposition.subtasks[0];
    const agentName = suggestAgent(st.agentRole === "architect" ? "complex" : "medium");
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
    const route: RouteResult = {
      tier: "medium",
      model: (profile.model as ModelTier) ?? "sonnet",
      multiAgent: false,
      reason: "single subtask fallback",
    };
    renderer.agentHeader(agentName, route.model, route.reason);
    renderer.startSpinner(agentName, route.model);

    const harness = buildHarness({
      agentName,
      role: (profile.role ?? "coder") as import("../config/types.ts").AgentRole,
      provider: profile.provider as import("../config/types.ts").ProviderName,
      parentTaskId: "repl",
      isWorker: false,
    });
    const cmd = buildCommand(providerConfig, profile, {
      prompt: conversation.buildPrompt(input),
      model: route.model,
      systemPrompt: harness.systemPrompt + `\n\nYou are working in the project at: ${process.cwd()}`,
      maxTurns: profile.maxTurns,
    });

    const streamer = new AgentStreamer();
    onStreamer(streamer);
    let boxOpen = false;

    streamer.on("text_delta", (delta: string) => {
      if (!boxOpen) {
        renderer.stopSpinner();
        renderer.startBox(route.model);
        boxOpen = true;
      }
      renderer.text(delta);
    });
    streamer.on("tool_use", (tool: ToolUseEvent) => {
      const inp = tool.input ?? {};
      const detail = (inp.file_path as string) ?? (inp.command as string) ?? (inp.pattern as string) ?? undefined;
      if (boxOpen) {
        renderer.toolUse(tool.name, detail, true);
      } else {
        renderer.updateSpinner(`${tool.name} ${detail ? detail.split("/").pop() : ""}`.trim());
      }
    });
    streamer.on("error", (msg: string) => {
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();
      renderer.error(msg);
    });

    const startTime = Date.now();
    try {
      const result = await streamer.run(cmd, cancellation.signal);
      renderer.stopSpinner();
      const durationMs = Date.now() - startTime;
      if (boxOpen) renderer.endBox();
      renderer.cost(result.costUsd, result.inputTokens, result.outputTokens, durationMs);
      conversation.add({ role: "assistant", content: result.text, agentName, tier: route.model, timestamp: new Date().toISOString() });
      rollout.append({ type: "turn", timestamp: new Date().toISOString(), data: { role: "assistant", content: result.text } });
    } catch (e) {
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();
      renderer.error(`Agent execution failed: ${(e as Error).message}`);
    }
    return;
  }

  // 2. Assign provider/model per subtask using phase-aware model selection
  const selector = orchestrator.getSupervisor().getProviderSelector();
  for (const subtask of decomposition.subtasks) {
    // Map agent role to execution phase for model selection
    const roleToPhase: Record<string, ExecutionPhase> = {
      architect: "planning", planner: "planning", designer: "spec",
      coder: "coding", tester: "qa", reviewer: "review", fixer: "fix",
    };
    const phase = roleToPhase[subtask.agentRole] ?? "coding";
    const phaseModel = getPhaseModel(phase);

    const selection = selector.selectWithFallback(subtask, {
      requireToolUse: subtask.agentRole === "coder" || subtask.agentRole === "tester",
    });
    subtask.provider = selection.provider;
    // Prefer phase-config model tier, fall back to selector's pick
    subtask.model = phaseModel.model ?? selection.model;
  }

  // 3. Risk prediction
  const prediction = await orchestrator.getPredictor().predict(input);
  if (prediction.risks.length > 0) {
    renderer.riskAssessment(prediction.risks.map(r => `${r.likelihood}: ${r.description}`));
  }

  // 4. Show plan
  renderer.planSummary(decomposition.subtasks, decomposition.executionPlan);
  eventBus.publish({
    type: "supervisor:plan",
    taskId,
    phases: decomposition.executionPlan.phases.length,
    estimatedCost: 0,
  });

  // Record user turn
  const userTurn = { role: "user" as const, content: input, timestamp: new Date().toISOString() };
  conversation.add(userTurn);
  rollout.append({ type: "turn", timestamp: userTurn.timestamp, data: userTurn });

  // 5. Create ResultCollector + ContextPropagator + QA tracking
  const collector = new ResultCollector(taskId);
  const propagator = new ContextPropagator(
    orchestrator.getContextBuilder(),
    orchestrator.getWorkerBus(),
    orchestrator.getCompressor(),
  );
  const watcher = orchestrator.getConflictWatcher();
  watcher.clearDiffs();
  const qaHistory: QAIssue[][] = [];

  // 6. Execute phases
  for (const phase of decomposition.executionPlan.phases) {
    if (cancellation.cancelled) break;

    const phaseSubtasks = decomposition.subtasks.filter(
      st => phase.subtaskIds.includes(st.id),
    );
    renderer.phaseHeader(phase.name, phaseSubtasks.length, phase.parallelizable);

    if (phase.parallelizable && phaseSubtasks.length > 1) {
      const promises = phaseSubtasks.map(st =>
        executeSubtask(st, orchestrator, config, cancellation, onStreamer, mcpScoutCache, skillScoutCache, decomposition, collector, qaHistory, propagator),
      );
      await Promise.all(promises);
    } else {
      for (const st of phaseSubtasks) {
        if (cancellation.cancelled) break;
        await executeSubtask(st, orchestrator, config, cancellation, onStreamer, mcpScoutCache, skillScoutCache, decomposition, collector, qaHistory, propagator);
      }
    }
  }

  // 7. QA recurring issue detection
  const recurring = detectRecurringIssues(qaHistory, DEFAULT_QA_CONFIG.recurringIssueThreshold);
  if (recurring.length > 0) {
    renderer.riskAssessment(recurring.map(r => `recurring: [${r.severity}] ${r.description}`));
  }

  // 8. Conflict detection
  const conflicts = watcher.analyze();
  if (conflicts.length > 0) {
    renderer.conflictWarning(conflicts.map(c => `${c.severity}: ${c.description}`));
  }

  // 8. Aggregate results
  const aggregated = collector.aggregate();

  if (aggregated.subtaskResults.length > 1) {
    renderer.separator();
    renderer.info("Multi-agent total:");
    renderer.cost(aggregated.totalCost, aggregated.totalTokens, 0, aggregated.totalDurationMs);
    if (aggregated.conflicts.length > 0) {
      renderer.conflictWarning(aggregated.conflicts);
    }
  }

  // 9. Record in conversation — use the dominant tier from subtask results
  const tierCounts = new Map<string, number>();
  for (const sr of aggregated.subtaskResults) {
    const t = decomposition.subtasks.find(s => s.id === sr.subtaskId)?.model ?? "sonnet";
    tierCounts.set(t, (tierCounts.get(t) ?? 0) + 1);
  }
  const dominantTier = ([...tierCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "sonnet") as ModelTier;
  conversation.add({
    role: "assistant" as const,
    content: aggregated.mergedOutput,
    agentName: "multi-agent",
    tier: dominantTier,
    timestamp: new Date().toISOString(),
  });
  rollout.append({
    type: "turn",
    timestamp: new Date().toISOString(),
    data: { role: "assistant", content: aggregated.mergedOutput },
  });
}

async function executeSubtask(
  subtask: SubTask,
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
  cancellation: CancellationToken,
  onStreamer: (s: AgentStreamer) => void,
  mcpScoutCache: ScoutCache,
  skillScoutCache: ScoutCache,
  decomposition: DecompositionResult,
  collector: ResultCollector,
  qaHistory: QAIssue[][],
  propagator: ContextPropagator,
): Promise<void> {
  const agentName = `${subtask.agentRole}-${subtask.id.slice(-4)}`;
  const modelTier = subtask.model as ModelTier;
  const workerBus = orchestrator.getWorkerBus();
  const watcher = orchestrator.getConflictWatcher();

  renderer.agentHeader(agentName, modelTier, subtask.agentRole);
  renderer.startSpinner(agentName, modelTier);

  // Register with WorkerBus for inter-agent communication
  workerBus.registerWorker({
    agentName,
    subtaskId: subtask.id,
    role: subtask.agentRole,
    domain: subtask.agentRole,
    prompt: subtask.prompt.slice(0, 200),
  });

  // Parallel Haiku scout: skill + MCP discovery at the same time (with cache)
  const cacheKey = subtask.prompt;
  const cachedSkill = skillScoutCache.get<ScoutResult>(cacheKey);
  const cachedMcp = mcpScoutCache.get<McpScoutResult>(cacheKey);
  const emptySkillResult: ScoutResult = { needed: false, skills: [], durationMs: 0 };
  const emptyMcpResult: McpScoutResult = { needed: false, servers: [], durationMs: 0 };
  const [skillSettled, mcpSettled] = await Promise.allSettled([
    cachedSkill ? Promise.resolve(cachedSkill) : scoutSkills(subtask, orchestrator.getSkillIndex(), cancellation.signal).then(r => { skillScoutCache.set(cacheKey, r); return r; }),
    cachedMcp ? Promise.resolve(cachedMcp) : scoutMcp(subtask.prompt, cancellation.signal).then(r => { mcpScoutCache.set(cacheKey, r); return r; }),
  ]);
  const skillScoutResult = skillSettled.status === "fulfilled" ? skillSettled.value : emptySkillResult;
  const mcpScoutResult = mcpSettled.status === "fulfilled" ? mcpSettled.value : emptyMcpResult;

  // Render scout results (pause spinner for clean output)
  let skillBodies: string[] = [];
  const hasSubScoutOutput = (skillScoutResult.needed && skillScoutResult.skills.length > 0) || (mcpScoutResult.needed && mcpScoutResult.servers.length > 0);
  if (hasSubScoutOutput) renderer.stopSpinner();

  if (skillScoutResult.needed && skillScoutResult.skills.length > 0) {
    skillBodies = await orchestrator.getSkillIndex().resolve(skillScoutResult.skills);
    renderer.skillScout(skillScoutResult.skills.map(s => s.name), skillScoutResult.durationMs);
  }

  const mcpMgr = orchestrator.getMcpManager();
  if (mcpScoutResult.needed && mcpScoutResult.servers.length > 0) {
    const connected = await mcpMgr.connectOnDemand(mcpScoutResult.servers);
    if (connected.length > 0) {
      renderer.mcpScout(connected, mcpScoutResult.durationMs);
    }
  }

  if (hasSubScoutOutput) renderer.startSpinner(agentName, modelTier);

  // Build enriched prompt via shared ContextPropagator (replaces manual .slice(0, 2000))
  let enrichedPrompt: string;
  try {
    enrichedPrompt = await propagator.buildWorkerPrompt(subtask, decomposition, collector);
  } catch (e) {
    renderer.info(`context propagation failed: ${(e as Error).message} — using raw prompt`);
    eventBus.publish({ type: "agent:error", agent: agentName, message: `context propagation: ${(e as Error).message}` });
    enrichedPrompt = subtask.prompt;
  }

  // System prompt from harness
  const harness = buildHarness({
    agentName,
    role: subtask.agentRole as import("../config/types.ts").AgentRole,
    provider: subtask.provider as import("../config/types.ts").ProviderName,
    parentTaskId: subtask.parentTaskId,
    isWorker: true,
  });
  let systemPrompt = harness.systemPrompt;
  systemPrompt += `\n\nYou are working in the project at: ${process.cwd()}`;

  // Inject skill bodies
  if (skillBodies.length > 0) {
    systemPrompt += "\n\n" + skillBodies.join("\n\n");
  }

  // Inject relevant memories into worker prompt
  const memories = orchestrator.getMemory().getRelevantMemories(subtask.prompt, agentName, 3);
  const memoryCtx = orchestrator.getMemory().formatForPrompt(memories);
  if (memoryCtx) systemPrompt += "\n" + memoryCtx;

  // Inject architectural decisions into worker prompt
  const decisions = orchestrator.getDecisions().getRelevantDecisions(subtask.prompt);
  if (decisions.length > 0) {
    systemPrompt += "\n\n" + orchestrator.getDecisions().formatForPrompt(decisions);
  }

  // MCP integration: CLI passthrough for Claude, prompt injection for others
  let mcpConfigPath: string | undefined;
  if (mcpMgr.getToolCount() > 0) {
    if (subtask.provider === "claude") {
      mcpConfigPath = mcpMgr.generateMcpConfigJson() ?? undefined;
    } else {
      const toolCtx = mcpMgr.formatToolsForPrompt();
      if (toolCtx) systemPrompt += "\n\n" + toolCtx;
    }
  }

  const adHocProfile: AgentProfile = {
    name: agentName,
    provider: subtask.provider,
    model: subtask.model,
    role: subtask.agentRole,
    maxBudgetUsd: 0,
    requires: [],
    worktree: false,
    systemPrompt,
  };

  // Retry loop with provider fallback
  const maxRetries = config.supervisor?.maxRetries ?? 2;
  const maxAttempts = maxRetries + 1;
  const providerSelector = orchestrator.getSupervisor().getProviderSelector();
  let currentProvider = subtask.provider;
  let currentModel = subtask.model;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (cancellation.cancelled) break;

    if (attempt > 0) {
      const fallback = providerSelector.select(subtask, {
        excluded: [currentProvider as ProviderName],
      });
      if (fallback.score > 0) {
        currentProvider = fallback.provider;
        currentModel = fallback.model;
      }
      renderer.retryAttempt(attempt, maxRetries, lastError ?? "unknown");
    }

    const providerConfig = config.providers[currentProvider];
    if (!providerConfig) {
      renderer.error(`No provider config for "${currentProvider}"`);
      workerBus.unregisterWorker(agentName);
      return;
    }

    const cmd = buildCommand(providerConfig, { ...adHocProfile, provider: currentProvider, model: currentModel }, {
      prompt: enrichedPrompt,
      model: currentModel,
      systemPrompt,
      mcpConfig: mcpConfigPath,
    });

    const streamer = new AgentStreamer();
    onStreamer(streamer);
    let boxOpen = false;

    // Real-time streaming
    streamer.on("text_delta", (delta: string) => {
      if (!boxOpen) {
        renderer.stopSpinner();
        renderer.startBox(modelTier);
        boxOpen = true;
      }
      renderer.text(delta);
    });

    streamer.on("tool_use", (tool: ToolUseEvent) => {
      const detail = (tool.input?.file_path as string)
        ?? (tool.input?.command as string)
        ?? (tool.input?.pattern as string)
        ?? undefined;
      if (boxOpen) {
        renderer.toolUse(tool.name, detail, true);
      } else {
        renderer.updateSpinner(`${tool.name} ${detail ? detail.split("/").pop() : ""}`.trim());
      }
    });

    streamer.on("error", (msg: string) => {
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();
      renderer.error(msg);
    });

    renderer.startSpinner(agentName, modelTier);
    const startTime = Date.now();

    try {
      const result = await streamer.run(cmd, cancellation.signal);
      renderer.stopSpinner();
      const durationMs = Date.now() - startTime;

      if (boxOpen) renderer.endBox();

      // Quality gate + QA history tracking
      if (result.text) {
        const critique = runQualityGate({ agentRole: subtask.agentRole, prompt: subtask.prompt }, result.text);
        renderer.qualityGate(critique.passes, critique.issues);
        // Track issues for recurring issue detection
        if (critique.issues.length > 0) {
          qaHistory.push(critique.issues.map(desc => ({
            description: desc, severity: "major" as const, file: undefined, suggestion: undefined,
          })));
        }
      }

      renderer.cost(result.costUsd, result.inputTokens, result.outputTokens, durationMs);
      eventBus.publish({
        type: "agent:done", agent: agentName,
        cost: result.costUsd, inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, durationMs,
      });

      // Collect result for aggregation (full WorkerState shape)
      const workerState: import("../config/types.ts").WorkerState = {
        id: agentName,
        subtaskId: subtask.id,
        agentName,
        provider: currentProvider as ProviderName,
        model: currentModel,
        status: "completed",
        progress: 100,
        startedAt: new Date(startTime).toISOString(),
        lastActivityAt: new Date().toISOString(),
        result: result.text,
        error: null,
        tokenUsage: result.inputTokens + result.outputTokens,
        costUsd: result.costUsd,
        currentTurn: 1,
        maxTurns: 1,
        turnHistory: [],
        corrections: [],
        intermediateResults: [],
      };
      collector.collect(workerState, subtask.agentRole as import("../config/types.ts").AgentRole, subtask.agentRole);

      // Record conflict diff
      const collected = collector.getResult(subtask.id);
      if (collected) {
        watcher.recordDiff({
          agentName,
          taskId: subtask.parentTaskId,
          files: collected.files,
          summary: result.text.slice(0, 200),
        });

        // Broadcast artifacts via WorkerBus
        workerBus.broadcastArtifact(agentName, subtask.parentTaskId, {
          files: collected.files,
          apis: collector.extractApis(result.text),
          schemas: collector.extractSchemas(result.text),
        });
      }

      workerBus.unregisterWorker(agentName);
      return; // Success — exit retry loop
    } catch (e) {
      lastError = (e as Error).message;
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();
      if (attempt === maxAttempts - 1) {
        renderer.error(`All ${maxAttempts} attempts failed: ${lastError}`);
      }
    }
  }

  workerBus.unregisterWorker(agentName);
}
