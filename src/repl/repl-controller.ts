import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig, ModelTier, SubTask, ProviderName } from "../config/types.ts";
import type { RendererPort } from "./renderer-types.ts";
import { routeTask, suggestAgent, classifyWithSam, type RouteResult } from "../core/router.ts";
import { buildCommand } from "../agents/provider.ts";
import { buildHarness } from "../agents/harness.ts";
import { AgentStreamer, type ToolUseEvent, type StreamResult } from "./streamer.ts";
import { Conversation } from "./conversation.ts";
import { isCommand, handleCommand } from "./commands.ts";
import { TIER_BUDGETS } from "../memory/token-optimizer.ts";
import { CancellationToken } from "../utils/cancellation.ts";
import { RolloutRecorder } from "../session/rollout.ts";
import { eventBus } from "../core/events.ts";
import { decomposeWithSam } from "../core/decomposer.ts";
import { scoutSkills, type ScoutResult } from "./skill-scout.ts";
import { scoutMcp, type McpScoutResult } from "../mcp/mcp-scout.ts";
import { ScoutCache } from "./scout-cache.ts";
import { runQualityGate } from "./quality-gate.ts";
import { ContextCompactor } from "../core/compaction.ts";
import { RuntimeFallbackManager } from "../core/runtime-fallback.ts";
import { PlanMode } from "./plan-mode.ts";
import { FileRefResolver } from "./file-ref.ts";
import { HashlineEditor } from "../core/hashline.ts";
import { SessionForkManager } from "../core/session-fork.ts";
import { shouldBrainstorm, brainstorm } from "../core/brainstorm.ts";
import type { AgentRegistry } from "../agents/registry.ts";

/**
 * Extract an @agent mention from input, case-insensitive.
 * Agent names are simple words (no dots/slashes), file refs have path chars.
 */
function extractAgentMention(
  input: string,
  registry: AgentRegistry,
): { agent: string; cleanedInput: string } | null {
  const match = input.match(/(?:^|\s)@([a-zA-Z][\w-]*)\b/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
  if (!registry.has(name) && !registry.has(capitalized)) return null;
  const resolved = registry.has(name) ? name : capitalized;
  const cleanedInput = input.replace(match[0], "").trim();
  return { agent: resolved, cleanedInput };
}

// ── Approval callback: abstracts interactive approval for both TUI and readline ──

export interface ApprovalCallback {
  (command: string, message: string): Promise<boolean>;
}

// ── Controller ──────────────────────────────────────────────────────

export interface ReplControllerOptions {
  orchestrator: Orchestrator;
  config: OrchestratorConfig;
  renderer: RendererPort;
  approve?: ApprovalCallback;
}

export class ReplController {
  private orchestrator: Orchestrator;
  private config: OrchestratorConfig;
  private renderer: RendererPort;
  private approve: ApprovalCallback;

  private conversation = new Conversation();
  private planMode = new PlanMode();
  private fileRef = new FileRefResolver(process.cwd());
  private forkManager = new SessionForkManager();
  private rollout: RolloutRecorder;
  private mcpScoutCache = new ScoutCache();
  private skillScoutCache = new ScoutCache();

  private currentStreamer: AgentStreamer | null = null;
  private currentCancellation: CancellationToken | null = null;
  private pinnedAgent: string | null = null;
  private lastAgent: string | null = null;

  constructor(opts: ReplControllerOptions) {
    this.orchestrator = opts.orchestrator;
    this.config = opts.config;
    this.renderer = opts.renderer;
    this.approve = opts.approve ?? (() => Promise.resolve(false));
    this.rollout = new RolloutRecorder(`${opts.config.orchestrator.dataDir}/sessions`);
    this.fileRef.warmCache().catch(() => {});
  }

  /** Display welcome info on startup */
  async initialize(): Promise<void> {
    const profiles = this.orchestrator.getRegistry().list().map(p => p.name);
    this.renderer.welcome(profiles);

    const mcpManager = this.orchestrator.getMcpManager();
    const mcpServers = mcpManager.getConnectedServers();
    if (mcpServers.length > 0) {
      this.renderer.mcpStatus(mcpServers, mcpManager.getToolCount());
    }

    const formatters = this.orchestrator.getFormatter().listDetected();
    if (formatters.length > 0) {
      this.renderer.info(`Formatters: ${formatters.join(", ")}`);
    }

    this.orchestrator.getPrewarmer().prewarm().catch(() => {});
  }

  /** Abort the currently running agent */
  abort(): void {
    if (this.currentCancellation && !this.currentCancellation.cancelled) {
      this.currentCancellation.cancel();
    }
    if (this.currentStreamer?.isRunning) {
      this.currentStreamer.abort();
    }
    this.renderer.stopSpinner();
    this.renderer.notifyIdle();
  }

  /** Main entry: handle a line of user input */
  async handle(input: string): Promise<"quit" | void> {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Commands
    if (isCommand(trimmed)) {
      const result = await handleCommand(trimmed, {
        orchestrator: this.orchestrator,
        conversation: this.conversation,
        renderer: this.renderer,
        planMode: this.planMode,
        forkManager: this.forkManager,
        getPinnedAgent: () => this.pinnedAgent,
        setPinnedAgent: (name) => { this.pinnedAgent = name; },
        consumePendingSnapshot: () => null,
      });
      if (result === "quit") return "quit";
      return;
    }

    // Extract @agent mention before file-ref resolution
    let mentionedAgent: string | null = null;
    let resolvedInput = trimmed;
    if (trimmed.includes("@")) {
      const mention = extractAgentMention(trimmed, this.orchestrator.getRegistry());
      if (mention) {
        mentionedAgent = mention.agent;
        resolvedInput = mention.cleanedInput;
        this.renderer.info(`\x1b[36m→ @${mention.agent}\x1b[0m`);
      } else {
        // Only resolve @file references if no agent mention found
        const refResult = await this.fileRef.resolve(trimmed);
        if (refResult.filesIncluded.length > 0) {
          resolvedInput = refResult.resolvedInput;
          this.renderer.info(`@files: ${refResult.filesIncluded.join(", ")}`);
        }
      }
    }

    // Reset doom loop
    this.orchestrator.getDoomLoop().reset();

    // Run agent
    const cancellation = new CancellationToken();
    this.currentCancellation = cancellation;

    try {
      await this.handleNaturalInput(resolvedInput, cancellation, mentionedAgent);
    } finally {
      this.renderer.phaseUpdate("done");
      this.renderer.notifyIdle();
      this.currentStreamer = null;
      this.currentCancellation = null;
      this.orchestrator.getPrewarmer().prewarm().catch(() => {});
    }
  }

  /** Route and execute agent for natural language input */
  private async handleNaturalInput(
    input: string,
    cancellation: CancellationToken,
    mentionedAgent?: string | null,
  ): Promise<void> {
    const r = this.renderer;
    let route: RouteResult;
    let agentName: string;

    r.phaseUpdate("routing");
    r.startSpinner("orc", "haiku");

    if (this.pinnedAgent) {
      const pinnedProfile = this.orchestrator.getRegistry().get(this.pinnedAgent);
      if (!pinnedProfile) {
        r.error(`Pinned profile "${this.pinnedAgent}" not found.`);
        return;
      }
      route = { tier: "medium", model: pinnedProfile.model as ModelTier, multiAgent: false, reason: `pinned to ${this.pinnedAgent}` };
      agentName = this.pinnedAgent;
    } else if (mentionedAgent) {
      const mentionedProfile = this.orchestrator.getRegistry().get(mentionedAgent);
      if (!mentionedProfile) {
        r.error(`Agent "${mentionedAgent}" not found.`);
        return;
      }
      route = { tier: "medium", model: mentionedProfile.model as ModelTier, multiAgent: false, reason: `mentioned @${mentionedAgent}` };
      agentName = mentionedAgent;
    } else {
      const costEst = this.orchestrator.getCostEstimator().estimate(input);
      route = routeTask(input, this.config.routing, { costEstimate: costEst });

      const categoryRouter = this.orchestrator.getCategoryRouter();
      const category = categoryRouter.classify(input);
      const categoryConfig = categoryRouter.getCategory(category);
      if (categoryConfig && categoryConfig.tier !== route.model) {
        route.model = categoryConfig.tier;
        route.reason += ` [category: ${category}]`;
      }

      if (route.multiAgent) {
        r.costEstimate(costEst.singleAgent.estimatedCostUsd, costEst.multiAgent.estimatedCostUsd, costEst.recommendation);
      }

      r.phaseUpdate("classifying");
      const classification = await classifyWithSam(input, this.lastAgent ?? undefined);
      agentName = classification.agent;
      r.info(classification.reason);

      if (classification.type === "conversation") {
        route.multiAgent = false;
      } else if (classification.agents && classification.agents.length > 1) {
        route.multiAgent = true;
      }
    }

    if (route.multiAgent) {
      await this.handleMultiAgent(input, cancellation);
      return;
    }

    const profile = this.orchestrator.getRegistry().get(agentName);
    if (!profile) { r.error(`No profile for "${agentName}".`); return; }

    const providerConfig = this.config.providers[profile.provider];
    if (!providerConfig) { r.error(`No provider config for "${profile.provider}".`); return; }

    const displayModel = (profile.model as ModelTier) ?? route.model;
    route.model = displayModel;
    r.phaseUpdate("executing", agentName);
    eventBus.publish({ type: "agent:start", agent: agentName, tier: displayModel, reason: route.reason });
    r.agentHeader(agentName, displayModel, route.reason);
    r.startSpinner(agentName, displayModel);

    // Scout skills + MCP
    const skillIndex = this.orchestrator.getSkillIndex();
    const pseudoSubtask = { agentRole: profile.role ?? "coder", prompt: input } as SubTask;
    const [skillSettled, mcpSettled] = await Promise.allSettled([
      this.skillScoutCache.get<ScoutResult>(input) ?? scoutSkills(pseudoSubtask, skillIndex, cancellation.signal).then(sr => { this.skillScoutCache.set(input, sr); return sr; }),
      this.mcpScoutCache.get<McpScoutResult>(input) ?? scoutMcp(input, cancellation.signal).then(mr => { this.mcpScoutCache.set(input, mr); return mr; }),
    ]);
    const emptySkill: ScoutResult = { needed: false, skills: [], durationMs: 0 };
    const emptyMcp: McpScoutResult = { needed: false, servers: [], durationMs: 0 };
    const skillScoutResult = skillSettled.status === "fulfilled" ? skillSettled.value : emptySkill;
    const mcpScoutResult = mcpSettled.status === "fulfilled" ? mcpSettled.value : emptyMcp;

    const baselineEntries = (profile.skills ?? [])
      .map(name => skillIndex.getByName(name))
      .filter((e): e is NonNullable<typeof e> => e != null);
    const seen = new Set<string>();
    const allMatched: typeof baselineEntries = [];
    for (const entry of [...baselineEntries, ...(skillScoutResult.needed ? skillScoutResult.skills : [])]) {
      if (!seen.has(entry.name)) { seen.add(entry.name); allMatched.push(entry); }
    }
    const skillBodies = allMatched.length > 0 ? await skillIndex.resolve(allMatched) : [];

    if (skillScoutResult.needed && skillScoutResult.skills.length > 0) {
      r.stopSpinner();
      r.skillScout(skillScoutResult.skills.map(s => s.name), skillScoutResult.durationMs);
      r.startSpinner(agentName, route.model);
    }

    const mcpMgr = this.orchestrator.getMcpManager();
    if (mcpScoutResult.needed && mcpScoutResult.servers.length > 0) {
      const connected = await mcpMgr.connectOnDemand(mcpScoutResult.servers);
      if (connected.length > 0) {
        r.stopSpinner();
        r.mcpScout(connected, mcpScoutResult.durationMs);
        r.startSpinner(agentName, route.model);
      }
    }

    // Auto-compact
    const compactor = new ContextCompactor();
    if (compactor.needsCompaction(this.conversation.getTurns())) {
      const { turns, result } = compactor.compact(this.conversation.getTurns());
      this.conversation.clear();
      for (const t of turns) this.conversation.add(t);
      r.info(`auto-compacted: ${result.originalTurns} → ${result.compactedTurns} turns`);
    }

    // Build prompt
    this.conversation.setTokenBudget(TIER_BUDGETS[route.model] ?? TIER_BUDGETS.sonnet);
    const fullPrompt = this.conversation.buildPrompt(input);

    const userTurn = { role: "user" as const, content: input, timestamp: new Date().toISOString() };
    this.conversation.add(userTurn);
    this.forkManager.addTurn(userTurn);
    this.rollout.append({ type: "turn", timestamp: userTurn.timestamp, data: userTurn });

    // Build system prompt
    let systemPrompt = this.buildSystemPrompt(profile, input, route, skillBodies);

    // MCP config
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

    // Deliberation
    if (shouldBrainstorm(input, route.tier) && !cancellation.cancelled) {
      r.updateSpinner("deliberation...");
      try {
        const bsResult = await brainstorm(input, providerConfig, profile, cancellation.signal, (round, label) => {
          r.updateSpinner(`deliberation round ${round}: ${label}...`);
        });
        if (bsResult.synthesized) {
          systemPrompt += "\n\n" + bsResult.synthesized;
          r.stopSpinner();
          r.brainstormStatus(3, bsResult.durationMs);
          r.startSpinner(agentName, route.model);
        }
      } catch { /* deliberation non-fatal */ }
    }

    const cmd = buildCommand(providerConfig, profile, {
      prompt: fullPrompt,
      model: profile.model,
      systemPrompt,
      maxTurns: profile.maxTurns,
      mcpConfig: mcpConfigPath,
    });

    // Execute with retry
    await this.executeWithRetry(cmd, agentName, route, profile, providerConfig, systemPrompt, fullPrompt, mcpConfigPath, cancellation, input);
  }

  /** Execute streamer with retry and fallback */
  private async executeWithRetry(
    initialCmd: string[],
    agentName: string,
    route: RouteResult,
    profile: any,
    providerConfig: any,
    systemPrompt: string,
    fullPrompt: string,
    mcpConfigPath: string | undefined,
    cancellation: CancellationToken,
    input: string,
  ): Promise<void> {
    const r = this.renderer;
    const maxRetries = this.config.supervisor?.maxRetries ?? 2;
    const maxAttempts = maxRetries + 1;
    let currentCmd = initialCmd;
    let currentProfile = profile;
    let currentProviderConfig = providerConfig;
    let lastError: string | null = null;

    const enforcer = this.orchestrator.getHarnessEnforcer();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (cancellation.cancelled) break;

      if (attempt > 0) {
        r.retryAttempt(attempt, maxRetries, lastError ?? "unknown");
        r.startSpinner(agentName, route.model);
      }

      const streamer = new AgentStreamer();
      this.currentStreamer = streamer;
      let boxOpen = false;
      let pendingApproval: { command: string; message: string } | null = null;

      streamer.on("text_delta", (delta: string) => {
        if (!boxOpen) { r.stopSpinner(); r.startBox(route.model); boxOpen = true; }
        r.text(delta);
      });

      streamer.on("text_complete", () => {
        if (boxOpen) { r.endBox(); boxOpen = false; }
        r.startSpinner(agentName, route.model);
      });

      streamer.on("usage", (usage: { costUsd: number }) => {
        r.updateCostLive(usage.costUsd);
      });

      streamer.on("tool_use", (tool: ToolUseEvent) => {
        const inp = tool.input ?? {};
        const detail = (inp.file_path as string) ?? (inp.command as string) ?? (inp.pattern as string) ?? undefined;
        r.stopSpinner();
        if (boxOpen) r.toolUse(tool.name, detail, true);
        else r.toolUse(tool.name, detail, false);
        r.startSpinner(agentName, route.model);
        eventBus.publish({ type: "agent:tool", agent: agentName, tool: tool.name, detail });

        // Harness enforcer: pre-execution validation
        const enforcement = enforcer.check(tool.name, inp as Record<string, unknown>);

        if (enforcement.askRequired) {
          const cmd = (inp.command as string) ?? tool.name;
          const v = enforcement.violations.find(v => v.severity === "ask");
          pendingApproval = { command: cmd, message: v?.message ?? cmd };
          r.stopSpinner();
          if (boxOpen) { r.endBox(); boxOpen = false; }
          streamer.abort();
          return;
        }

        if (!enforcement.allowed) {
          for (const v of enforcement.violations.filter(v => v.severity === "block")) {
            r.error(`ENFORCER [${v.ruleId}]: ${v.message}`);
          }
        }

        for (const v of enforcement.violations.filter(v => v.severity === "warn")) {
          r.info(`${v.ruleId}: ${v.message}`);
        }

        enforcer.record(tool.name, inp as Record<string, unknown>);
      });

      streamer.on("error", (msg: string) => {
        r.stopSpinner();
        if (boxOpen) r.endBox();
        r.error(msg);
      });

      const startTime = Date.now();
      try {
        const result = await streamer.run(currentCmd, cancellation.signal);
        r.stopSpinner();
        const durationMs = Date.now() - startTime;
        if (boxOpen) r.endBox();

        // Enforcer approval flow: abort-ask-retry
        if (pendingApproval) {
          const { command, message } = pendingApproval;
          r.error(`ENFORCER [command-safety]: ${message}`);
          r.info(command.slice(0, 200));

          const approved = await this.approve(command, message);
          if (approved) {
            enforcer.approve(command);
            r.info("Approved. Retrying...");
            pendingApproval = null;
            attempt--; // Retry same attempt
            continue;
          } else {
            r.info("Denied. Command was not executed.");
            this.conversation.add({ role: "assistant" as const, content: "(user denied the command)", agentName, tier: route.model, timestamp: new Date().toISOString() });
            return;
          }
        }

        // Quality gate
        if (result.text) {
          const critique = runQualityGate({ agentRole: currentProfile.role ?? "coder", prompt: input }, result.text);
          r.qualityGate(critique.passes, critique.issues);

          // Auto-retry on suspiciously short response from non-conversational agents
          if (!critique.passes && critique.issues.includes("Result is suspiciously short") && attempt < maxAttempts - 1) {
            r.info("auto-retry: response too short, reinforcing prompt...");
            const reinforced = input + "\n\n[IMPORTANT: Your previous attempt produced an incomplete response. You MUST use tools (Read, Edit, Bash, etc.) to actually complete the task. Do not just acknowledge — take action immediately.]";
            this.conversation.setTokenBudget(TIER_BUDGETS[(currentProfile.model as ModelTier) ?? "sonnet"] ?? TIER_BUDGETS.sonnet);
            const retryPrompt = this.conversation.buildPrompt(reinforced);
            currentCmd = buildCommand(currentProviderConfig, currentProfile, {
              prompt: retryPrompt,
              model: currentProfile.model,
              systemPrompt,
              maxTurns: currentProfile.maxTurns,
              mcpConfig: mcpConfigPath,
            });
            lastError = "suspiciously short response";
            continue;
          }
        }

        if (result.inputTokens > 0 || result.outputTokens > 0) {
          r.cost(result.costUsd, result.inputTokens, result.outputTokens, durationMs);
          eventBus.publish({ type: "agent:done", agent: agentName, cost: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens, durationMs });
        }

        const assistantTurn = { role: "assistant" as const, content: result.text, agentName, tier: route.model, timestamp: new Date().toISOString() };
        this.conversation.add(assistantTurn);
        this.forkManager.addTurn(assistantTurn);
        this.rollout.append({ type: "turn", timestamp: assistantTurn.timestamp, data: assistantTurn });
        this.lastAgent = agentName;
        break; // success
      } catch (e) {
        // If aborted for approval, don't count as error
        if (pendingApproval) {
          const { command, message } = pendingApproval;
          r.error(`ENFORCER [command-safety]: ${message}`);
          r.info(command.slice(0, 200));

          const approved = await this.approve(command, message);
          if (approved) {
            enforcer.approve(command);
            r.info("Approved. Retrying...");
            pendingApproval = null;
            attempt--; // Retry same attempt
            continue;
          } else {
            r.info("Denied. Command was not executed.");
            this.conversation.add({ role: "assistant" as const, content: "(user denied the command)", agentName, tier: route.model, timestamp: new Date().toISOString() });
            return;
          }
        }

        lastError = (e as Error).message;
        r.stopSpinner();
        if (boxOpen) r.endBox();
        if (attempt === maxAttempts - 1) {
          r.error(`All ${maxAttempts} attempts failed: ${lastError}`);
        }
      }
    }
  }

  /** Multi-agent decomposition and parallel execution */
  private async handleMultiAgent(
    input: string,
    cancellation: CancellationToken,
  ): Promise<void> {
    const r = this.renderer;
    r.phaseUpdate("decomposing");
    const taskId = `repl-${Date.now().toString(36)}`;
    const decomposition = await decomposeWithSam(input, taskId);

    if (decomposition.subtasks.length <= 1) {
      const st = decomposition.subtasks[0];
      const name = suggestAgent(st.agentRole === "architect" ? "complex" : "medium");
      const profile = this.orchestrator.getRegistry().get(name);
      if (!profile) { r.error(`No profile for "${name}".`); return; }
      const providerConfig = this.config.providers[profile.provider];
      if (!providerConfig) { r.error(`No provider config for "${profile.provider}".`); return; }

      r.agentHeader(name, profile.model as ModelTier, "single subtask");
      r.startSpinner(name, profile.model as ModelTier);

      this.conversation.setTokenBudget(TIER_BUDGETS[(profile.model as ModelTier) ?? "sonnet"] ?? TIER_BUDGETS.sonnet);
      const prompt = this.conversation.buildPrompt(input);
      const harness = buildHarness({ agentName: name, role: st.agentRole as any, provider: profile.provider as any, parentTaskId: taskId, isWorker: false });
      const cmd = buildCommand(providerConfig, profile, { prompt, model: profile.model, systemPrompt: harness.systemPrompt, maxTurns: profile.maxTurns });

      await this.executeWithRetry(cmd, name, { tier: "medium", model: profile.model as ModelTier, multiAgent: false, reason: "decomposed" }, profile, providerConfig, harness.systemPrompt, prompt, undefined, cancellation, input);
      return;
    }

    r.planSummary(decomposition.subtasks, { phases: [{ subtaskIds: decomposition.subtasks.map(s => s.id), parallel: true }], estimatedDurationMin: 0 } as any);
    r.taskList(decomposition.subtasks.map(st => ({
      id: st.id,
      label: st.prompt.slice(0, 60),
      role: st.agentRole,
    })), input.slice(0, 80));

    // Execute subtasks in parallel
    r.phaseUpdate("executing", `0/${decomposition.subtasks.length} tasks`);
    const collected = new Map<string, { text: string; cost: number; inputTokens: number; outputTokens: number }>();
    let completedCount = 0;

    await Promise.all(
      decomposition.subtasks.map(async (st) => {
        const name = suggestAgent(st.agentRole === "architect" ? "complex" : "medium");
        const profile = this.orchestrator.getRegistry().get(name);
        if (!profile) return;
        const providerConfig = this.config.providers[profile.provider];
        if (!providerConfig) return;

        const harness = buildHarness({ agentName: name, role: st.agentRole as any, provider: profile.provider as any, parentTaskId: taskId, isWorker: true });
        // Build context from already-completed siblings
        const siblingCtx = [...collected.values()]
          .map((c) => c.text)
          .filter(Boolean)
          .join("\n---\n");
        const prompt = (siblingCtx ? siblingCtx + "\n\n" : "") + st.prompt;
        const cmd = buildCommand(providerConfig, profile, {
          prompt,
          model: profile.model,
          systemPrompt: harness.systemPrompt,
          maxTurns: profile.maxTurns,
        });

        const workerName = `${name}-${st.id}`;
        r.workerStart(workerName, st.id, profile.model);

        const streamer = new AgentStreamer();
        streamer.on("tool_use", (tool: ToolUseEvent) => {
          const detail = (tool.input?.file_path as string) ?? (tool.input?.command as string) ?? undefined;
          r.workerToolUse(workerName, tool.name, detail);
        });

        r.taskUpdate(st.id, "running");
        const workerStartTime = Date.now();
        try {
          const result = await streamer.run(cmd, cancellation.signal);
          collected.set(st.id, { text: result.text, cost: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
          completedCount++;
          r.workerDone(workerName);
          r.taskUpdate(st.id, "passed", Date.now() - workerStartTime);
          if (result.inputTokens > 0) {
            r.taskTokens(st.id, result.inputTokens, result.outputTokens);
            r.cost(result.costUsd, result.inputTokens, result.outputTokens);
          }
          r.phaseUpdate("executing", `${completedCount}/${decomposition.subtasks.length} tasks`);
        } catch (e) {
          r.workerDone(workerName);
          r.taskUpdate(st.id, "failed", Date.now() - workerStartTime);
          r.error(`Worker ${name} failed: ${(e as Error).message}`);
        }
      }),
    );

    // Summarize results
    const combined = [...collected.values()].map(c => c.text).filter(Boolean).join("\n\n---\n\n");
    if (combined) {
      const turn = { role: "assistant" as const, content: combined, agentName: "multi-agent", tier: "sonnet" as ModelTier, timestamp: new Date().toISOString() };
      this.conversation.add(turn);
    }
  }

  /** Build system prompt with all context injections */
  private buildSystemPrompt(profile: any, input: string, route: RouteResult, skillBodies: string[]): string {
    const o = this.orchestrator;
    const harness = buildHarness({
      agentName: profile.name,
      role: (profile.role ?? "coder") as any,
      provider: profile.provider as any,
      parentTaskId: "repl",
      isWorker: false,
    });
    // Project context (CLAUDE.md, CONVENTIONS.md) goes FIRST for highest priority
    const ctxInjector = o.getContextInjector();
    const ctxFiles = ctxInjector.collect(process.cwd());
    const ctxContent = ctxFiles.length > 0 ? ctxInjector.formatForPrompt(ctxFiles) : "";

    let sp = "";
    if (ctxContent) sp += ctxContent + "\n\n";

    sp += harness.systemPrompt;
    sp += `\n\nYou are working in the project at: ${process.cwd()}`;
    if (profile.systemPrompt) sp += "\n\n" + profile.systemPrompt;

    // Codebase scan: persistent project structure overview
    const scanResult = o.getCodebaseScanner().getScanResult();
    if (scanResult) {
      sp += "\n\n" + o.getCodebaseScanner().formatForPrompt(scanResult, profile.role);
    }

    if (skillBodies.length > 0) sp += "\n\n" + skillBodies.join("\n\n");

    const lang = this.conversation.getLanguage();
    if (lang) sp += `\n\nAlways respond in ${lang}.`;

    const memories = o.getMemory().getRelevantMemories(input, profile.name, 5);
    const memoryCtx = o.getMemory().formatForPrompt(memories);
    if (memoryCtx) sp += "\n" + memoryCtx;

    const decisions = o.getDecisions().getRelevantDecisions(input);
    if (decisions.length > 0) sp += "\n\n" + o.getDecisions().formatForPrompt(decisions);

    if (this.planMode.isActive()) sp += "\n\n" + this.planMode.getSystemPromptAddition();

    if (route.model === "haiku") sp += "\nKeep responses concise and under 200 words.";

    return sp;
  }

  get conversationLength(): number {
    return this.conversation.length;
  }
}
