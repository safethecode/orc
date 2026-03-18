import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig, ModelTier, SubTask, ProviderName } from "../config/types.ts";
import type { RendererPort } from "./renderer-types.ts";
import { routeTask, classifyWithSam, type RouteResult } from "../core/router.ts";
import { buildCommand } from "../agents/provider.ts";
import { buildHarness } from "../agents/harness.ts";
import { AgentStreamer, type ToolUseEvent, type StreamResult } from "./streamer.ts";
import { Conversation } from "./conversation.ts";
import { isCommand, handleCommand } from "./commands.ts";
import { TIER_BUDGETS } from "../memory/token-optimizer.ts";
import { CancellationToken } from "../utils/cancellation.ts";
import { RolloutRecorder } from "../session/rollout.ts";
import { eventBus } from "../core/events.ts";
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

function formatToolDetail(tool: string, input?: Record<string, unknown>): string {
  if (!input) return "";
  switch (tool) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return input.file_path ? `(${String(input.file_path).split("/").pop()})` : "";
    case "Bash":
      return input.command ? `(${String(input.command).slice(0, 60)})` : "";
    case "Glob":
      return input.pattern ? `(${input.pattern})` : "";
    case "Grep":
      return input.pattern ? `(${input.pattern})` : "";
    case "TodoWrite":
      return input.todos ? ` ${Array.isArray(input.todos) ? input.todos.length : 0} items` : "";
    default:
      return "";
  }
}

const DESIGN_PLAN_PROMPT = `

[DESIGN PLAN-FIRST MODE — Phase 1]
You are in PLAN phase. Do NOT write any code or modify any files.
Your task is to produce a detailed design specification:

1. **Reference**: Name the specific products/patterns you will follow (e.g., "Linear's issue list + Vercel's dashboard nav")
2. **Layout**: Describe the visual structure, grid system, and spacing
3. **Colors**: List the exact color palette (hex values) and where each color is used
4. **Typography**: Font family, sizes, and weights for each text level
5. **Components**: List every component you will create with a brief description
6. **Interactions**: Describe hover states, transitions, and animations
7. **Responsive**: How the layout adapts across breakpoints

Be specific and concrete. The user will review this plan before you implement it.
DO NOT use any tools. DO NOT write any code. Text output only.`;

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

export interface AskUserCallback {
  (question: string, options?: string[]): Promise<string>;
}

// ── Controller ──────────────────────────────────────────────────────

export interface ReplControllerOptions {
  orchestrator: Orchestrator;
  config: OrchestratorConfig;
  renderer: RendererPort;
  approve?: ApprovalCallback;
  askUser?: AskUserCallback;
}

export class ReplController {
  private orchestrator: Orchestrator;
  private config: OrchestratorConfig;
  private renderer: RendererPort;
  private approve: ApprovalCallback;
  private askUser: AskUserCallback;

  private conversation = new Conversation();
  private planMode = new PlanMode();
  private fileRef = new FileRefResolver(process.cwd());
  private forkManager = new SessionForkManager();
  private rollout: RolloutRecorder;
  private mcpScoutCache = new ScoutCache();
  private skillScoutCache = new ScoutCache();

  private currentStreamer: AgentStreamer | null = null;
  private activeStreamers = new Set<AgentStreamer>();
  private activeWorkerNames = new Set<string>();
  private currentCancellation: CancellationToken | null = null;
  private pinnedAgent: string | null = null;
  private lastAgent: string | null = null;
  private stickyAgent: string | null = null;  // Set by @mention, persists until new @mention

  constructor(opts: ReplControllerOptions) {
    this.orchestrator = opts.orchestrator;
    this.config = opts.config;
    this.renderer = opts.renderer;
    this.approve = opts.approve ?? (() => Promise.resolve(false));
    this.askUser = opts.askUser ?? (() => Promise.resolve(""));
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

  /** Abort the currently running agent(s) */
  abort(): void {
    if (this.currentCancellation && !this.currentCancellation.cancelled) {
      this.currentCancellation.cancel();
    }
    if (this.currentStreamer?.isRunning) {
      this.currentStreamer.abort();
    }
    // Kill all multi-agent worker streamers
    for (const s of this.activeStreamers) {
      if (s.isRunning) s.abort();
    }
    this.activeStreamers.clear();
    // Clean up worker UI indicators
    for (const name of this.activeWorkerNames) {
      this.renderer.workerDone(name);
    }
    this.activeWorkerNames.clear();
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
    let route!: RouteResult;
    let agentName!: string;

    r.phaseUpdate("routing");
    r.startSpinner("routing", "haiku");

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
      this.stickyAgent = mentionedAgent; // Persist until next @mention
    } else if (this.stickyAgent) {
      // Continue with last @mentioned agent unless Sam sees a clear domain switch
      const stickyProfile = this.orchestrator.getRegistry().get(this.stickyAgent);
      if (!stickyProfile) {
        this.stickyAgent = null;
      } else {
        r.phaseUpdate("classifying");
        const classification = await classifyWithSam(input, this.stickyAgent);
        // Only switch away if Sam explicitly returns a DIFFERENT single agent
        if (classification.agent === this.stickyAgent || classification.type === "conversation") {
          route = { tier: "medium", model: stickyProfile.model as ModelTier, multiAgent: false, reason: `sticky @${this.stickyAgent}` };
          agentName = this.stickyAgent;
        } else {
          // Sam wants a different agent — respect it but keep sticky
          const costEst = this.orchestrator.getCostEstimator().estimate(input);
          route = routeTask(input, this.config.routing, { costEstimate: costEst });
          agentName = classification.agent;
          r.info(classification.reason);
          if (classification.agents && classification.agents.length > 1) {
            route.multiAgent = true;
          }
        }
        // Store detected language for system prompt injection
        if (classification.lang) {
          this.conversation.setLanguage(classification.lang);
        }
      }
    }

    if (!route) {
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

      // Store detected language for system prompt injection
      if (classification.lang) {
        this.conversation.setLanguage(classification.lang);
      }
    }

    if (route.multiAgent) {
      r.stopSpinner();
      r.startSpinner("orc", "supervisor" as any);
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

    const sessionId = crypto.randomUUID();
    const cmd = buildCommand(providerConfig, profile, {
      prompt: fullPrompt,
      model: profile.model,
      systemPrompt,
      maxTurns: profile.maxTurns,
      mcpConfig: mcpConfigPath,
      sessionId,
    });

    // Design agents: plan-first preview flow
    const isDesignAgent = (profile.role ?? "").toLowerCase().includes("design");
    if (isDesignAgent) {
      await this.executeDesignPreview(agentName, route, profile, providerConfig, systemPrompt, fullPrompt, mcpConfigPath, cancellation, input, sessionId);
    } else {
      await this.executeWithRetry(cmd, agentName, route, profile, providerConfig, systemPrompt, fullPrompt, mcpConfigPath, cancellation, input, sessionId);
    }
  }

  /** Design agent 2-phase flow: plan first, then execute on approval */
  private async executeDesignPreview(
    agentName: string,
    route: RouteResult,
    profile: any,
    providerConfig: any,
    systemPrompt: string,
    fullPrompt: string,
    mcpConfigPath: string | undefined,
    cancellation: CancellationToken,
    input: string,
    sessionId: string,
  ): Promise<void> {
    const r = this.renderer;

    // Phase 1: Plan-only run (maxTurns=1, no tool use)
    const planSystemPrompt = systemPrompt + DESIGN_PLAN_PROMPT;
    const planCmd = buildCommand(providerConfig, profile, {
      prompt: fullPrompt,
      model: profile.model,
      systemPrompt: planSystemPrompt,
      maxTurns: 1,
      mcpConfig: mcpConfigPath,
      sessionId,
    });

    r.info("design preview: generating plan...");
    const streamer = new AgentStreamer();
    this.currentStreamer = streamer;
    let boxOpen = false;

    streamer.on("text_delta", (delta: string) => {
      if (!boxOpen) { r.stopSpinner(); r.startBox(route.model); boxOpen = true; }
      r.text(delta);
    });
    streamer.on("text_complete", () => {
      if (boxOpen) { r.endBox(); boxOpen = false; }
    });

    let planResult: StreamResult;
    try {
      planResult = await streamer.run(planCmd, cancellation.signal);
    } catch {
      r.stopSpinner();
      if (boxOpen) r.endBox();
      r.error("design preview: plan generation failed.");
      return;
    }
    r.stopSpinner();
    if (boxOpen) r.endBox();

    if (planResult.inputTokens > 0) {
      r.cost(planResult.costUsd, planResult.inputTokens, planResult.outputTokens);
    }

    if (!planResult.text.trim() || cancellation.cancelled) return;

    // Ask for approval
    const answer = await this.askUser(
      "이 디자인 설계안을 승인하시겠습니까?",
      ["승인 — 이대로 구현", "거부 — 취소"],
    );

    if (!answer || answer.includes("거부") || answer.includes("취소")) {
      r.info("design preview: plan rejected.");
      this.conversation.add({ role: "assistant" as const, content: planResult.text, agentName, tier: route.model, timestamp: new Date().toISOString() });
      return;
    }

    // Phase 2: Execute with approved plan (session has full Phase 1 context)
    r.info("design preview: executing approved plan...");
    r.startSpinner(agentName, route.model);

    const execPrompt = "The user approved your design plan. Execute it now. Implement exactly as described.";
    const execCmd = buildCommand(providerConfig, profile, {
      prompt: execPrompt,
      model: profile.model,
      systemPrompt,
      maxTurns: profile.maxTurns,
      mcpConfig: mcpConfigPath,
      resumeSession: sessionId,
    });

    await this.executeWithRetry(execCmd, agentName, route, profile, providerConfig, systemPrompt, execPrompt, mcpConfigPath, cancellation, input, sessionId);
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
    sessionId?: string,
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
      let toolUseCount = 0;
      let pendingApproval: { command: string; message: string } | null = null;
      let pendingQuestion: { question: string; options?: string[] } | null = null;

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
        toolUseCount++;
        const inp = tool.input ?? {};
        const detail = (inp.file_path as string) ?? (inp.command as string) ?? (inp.pattern as string) ?? undefined;
        r.stopSpinner();
        // Close text box first so tool badge appears between text blocks
        if (boxOpen) { r.endBox(); boxOpen = false; }

        // Intercept AskUserQuestion — abort and relay to user
        if (tool.name === "AskUserQuestion") {
          const questions = inp.questions as Array<{ question: string; options?: Array<{ label: string }> }> | undefined;
          const q = questions?.[0];
          const questionText = q?.question ?? (inp.question as string) ?? "Agent has a question";
          const options = q?.options?.map((o: any) => o.label);
          pendingQuestion = { question: questionText, options };
          r.info(`❓ ${questionText}`);
          if (options?.length) r.info(`   ${options.map((o: string, i: number) => `${i + 1}. ${o}`).join("  ")}`);
          streamer.abort();
          return;
        }

        // Non-interactive env guard for bash commands
        if (tool.name === "bash" && inp.command) {
          const niGuard = this.orchestrator.getNonInteractiveGuard();
          if (niGuard.isInteractive(inp.command as string)) {
            const warning = niGuard.getWarning(inp.command as string);
            r.error(`\x1b[33m⚠ non-interactive:\x1b[0m ${warning}`);
          }
        }

        r.toolUse(tool.name, detail, false, inp);
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

            // Preserve Claude's partial output in conversation
            if (result.text) {
              const partialTurn = { role: "assistant" as const, content: result.text, agentName, tier: route.model, timestamp: new Date().toISOString() };
              this.conversation.add(partialTurn);
              this.forkManager.addTurn(partialTurn);
            }

            // Continue session with approval context
            const approvalMsg = `The user approved the command: \`${command}\`. Execute it now and continue from where you left off.`;
            currentCmd = buildCommand(currentProviderConfig, currentProfile, {
              prompt: approvalMsg,
              model: currentProfile.model,
              systemPrompt,
              maxTurns: currentProfile.maxTurns,
              mcpConfig: mcpConfigPath,
              resumeSession: sessionId,
            });
            attempt--; // Retry same attempt
            continue;
          } else {
            r.info("Denied. Command was not executed.");
            this.conversation.add({ role: "assistant" as const, content: "(user denied the command)", agentName, tier: route.model, timestamp: new Date().toISOString() });
            return;
          }
        }

        // AskUserQuestion flow: relay question to user, retry with answer
        if (pendingQuestion) {
          const { question, options } = pendingQuestion;
          const answer = await this.askUser(question, options);
          pendingQuestion = null;
          if (answer) {
            // Continue session with user's answer
            const withAnswer = `[The agent asked: "${question}" — User answered: "${answer}". Continue with this answer.]`;
            currentCmd = buildCommand(currentProviderConfig, currentProfile, {
              prompt: withAnswer,
              model: currentProfile.model,
              systemPrompt,
              maxTurns: currentProfile.maxTurns,
              mcpConfig: mcpConfigPath,
              resumeSession: sessionId,
            });
            attempt--; // Don't count as retry
            continue;
          } else {
            r.info("No answer provided.");
            return;
          }
        }

        // Quality gate
        if (result.text) {
          r.info("evaluating quality...");
          const critique = await runQualityGate({ agentRole: currentProfile.role ?? "coder", prompt: input, toolUseCount }, result.text);
          r.qualityGate(critique.passes, critique.issues);

          // Auto-retry on intent without action (agent described what it would do but used no tools)
          if (!critique.passes && critique.issues.includes("Intent without action: declared actions but used zero tools") && attempt < maxAttempts - 1) {
            r.info("auto-retry: agent declared intent but used no tools, reinforcing...");
            const reinforced = "[IMPORTANT: Your previous response only described what you would do without actually doing it. You MUST use tools (Read, Edit, Bash, etc.) to complete the task. Do not describe — act.]";
            currentCmd = buildCommand(currentProviderConfig, currentProfile, {
              prompt: reinforced,
              model: currentProfile.model,
              systemPrompt,
              maxTurns: currentProfile.maxTurns,
              mcpConfig: mcpConfigPath,
              resumeSession: sessionId,
            });
            lastError = "intent without action";
            continue;
          }

          // Auto-retry on suspiciously short response from non-conversational agents
          if (!critique.passes && critique.issues.includes("Result is suspiciously short") && attempt < maxAttempts - 1) {
            r.info("auto-retry: response too short, reinforcing prompt...");
            const reinforced = "[IMPORTANT: Your previous attempt produced an incomplete response. You MUST use tools (Read, Edit, Bash, etc.) to actually complete the task. Do not just acknowledge — take action immediately.]";
            currentCmd = buildCommand(currentProviderConfig, currentProfile, {
              prompt: reinforced,
              model: currentProfile.model,
              systemPrompt,
              maxTurns: currentProfile.maxTurns,
              mcpConfig: mcpConfigPath,
              resumeSession: sessionId,
            });
            lastError = "suspiciously short response";
            continue;
          }

          // Auto-retry on design quality violations
          if (!critique.passes && (currentProfile.role ?? "").toLowerCase().includes("design") && attempt < maxAttempts - 1) {
            const designIssues = critique.issues.filter((i: string) =>
              i.includes("reference declaration") || i.includes("Gradient") ||
              i.includes("Rainbow") || i.includes("Glassmorphism") ||
              i.includes("border-radius") || i.includes("scale()") ||
              i.includes("shadows") || i.includes("SVG icons")
            );
            if (designIssues.length > 0) {
              r.info(`auto-retry: design violations — ${designIssues.join(", ")}`);
              const reinforced = "[DESIGN VIOLATION] Your previous output violates production design rules:\n" +
                designIssues.map((i: string) => `- ${i}`).join("\n") +
                "\n\nFix ALL issues. Reference-First Protocol is MANDATORY. No gradients, no glassmorphism, no rainbow badges, no oversized radius, no scale() hover, no heavy shadows, no hand-written SVG.";
              currentCmd = buildCommand(currentProviderConfig, currentProfile, {
                prompt: reinforced,
                model: currentProfile.model,
                systemPrompt,
                maxTurns: currentProfile.maxTurns,
                mcpConfig: mcpConfigPath,
                resumeSession: sessionId,
              });
              lastError = "design quality violations";
              continue;
            }
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

            // Continue session with approval context
            const approvalMsg = `The user approved the command: \`${command}\`. Execute it now and continue from where you left off.`;
            currentCmd = buildCommand(currentProviderConfig, currentProfile, {
              prompt: approvalMsg,
              model: currentProfile.model,
              systemPrompt,
              maxTurns: currentProfile.maxTurns,
              mcpConfig: mcpConfigPath,
              resumeSession: sessionId,
            });
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

  /**
   * Multi-agent execution via Supervisor pipeline.
   * Delegates to Orchestrator.executeWithSupervisor() which uses the full
   * pipeline: decompose → context propagation → feedback loop → quality gate
   * → QA agent → conflict resolution → result aggregation.
   */
  private async handleMultiAgent(
    input: string,
    cancellation: CancellationToken,
  ): Promise<void> {
    const r = this.renderer;
    r.phaseUpdate("decomposing");

    // Subscribe to eventBus for real-time rendering of Supervisor events
    const unsubscribe = this.subscribeSupervisorEvents();

    try {
      const result = await this.orchestrator.executeWithSupervisor(input);

      if (cancellation.cancelled) return;

      // Add combined result to conversation
      if (result.mergedOutput) {
        this.conversation.add({
          role: "assistant",
          content: result.mergedOutput,
          agentName: "multi-agent",
          tier: "sonnet" as ModelTier,
          timestamp: new Date().toISOString(),
        });
      }

      // Show cost summary
      if (result.totalTokens > 0) {
        r.cost(result.totalCost, result.totalTokens, 0, result.totalDurationMs);
      }

      // Show conflicts if any
      if (result.conflicts.length > 0) {
        r.conflictWarning(result.conflicts.map(c =>
          typeof c === "string" ? c : `Conflict: ${c.description ?? c.id ?? "unknown"}`,
        ));
      }

      // Quality gate summary
      if (result.success) {
        r.phaseUpdate("complete", `${result.subtaskResults.length} tasks done`);
      } else {
        r.phaseUpdate("complete", `${result.subtaskResults.length} tasks (some failed)`);
      }
    } catch (err) {
      r.error(`Multi-agent execution failed: ${(err as Error).message}`);
    } finally {
      unsubscribe();
    }
  }

  /** Bridge eventBus events from Supervisor to REPL renderer */
  private subscribeSupervisorEvents(): () => void {
    const r = this.renderer;
    const handlers: Array<[string, (e: any) => void]> = [
      ["supervisor:plan", (e) => {
        r.phaseUpdate("planning", `${e.phases} phases`);
      }],
      ["supervisor:dispatch", (e) => {
        r.dim(`[${e.role}] ${e.provider}/${e.model} — ${e.prompt}`);
        r.taskUpdate(e.subtaskId, "running");
      }],
      ["worker:spawn", (e) => {
        r.workerStart(e.workerId, e.workerId, e.model);
      }],
      ["worker:progress", (e) => {
        r.workerUpdate(e.workerId, { progress: e.progress });
      }],
      ["worker:turn", (e) => {
        if (e.toolUsed) {
          const input = e.toolInput as Record<string, unknown> | undefined;
          const detail = formatToolDetail(e.toolUsed, input);
          r.dim(`  \x1b[33m●\x1b[0m \x1b[1m${e.toolUsed}\x1b[0m\x1b[2m${detail}\x1b[0m`);
        }
      }],
      ["worker:complete", (e) => {
        const sec = e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : "";
        r.info(`\x1b[32m✓\x1b[0m ${e.workerId} \x1b[2mcompleted${sec ? ` (${sec})` : ""}\x1b[0m`);
        r.workerDone(e.workerId);
        r.taskUpdate(e.workerId, "passed", e.durationMs);
      }],
      ["worker:text", (e) => {
        r.dim(`  ${e.agentName} · ${e.text}`);
      }],
      ["worker:stderr", (e) => {
        r.error(`[${e.agentName}] ${e.error}`);
      }],
      ["worker:fail", (e) => {
        r.workerDone(e.workerId);
        r.taskUpdate(e.workerId, "failed");
        r.error(`Worker failed: ${e.error}`);
      }],
      ["feedback:assessment", (e) => {
        if (e.action !== "continue") {
          r.dim(`[feedback] ${e.action}: ${e.reason}`);
        }
      }],
      ["feedback:quality_gate", (e) => {
        r.qualityGate(e.passed, e.issues);
      }],
      ["feedback:correction", (e) => {
        r.dim(`[correction] ${e.workerId}: ${e.message.slice(0, 80)}`);
      }],
      ["conflict:detected", (e) => {
        r.conflictWarning([`Conflict between ${e.agents.join(", ")}`]);
      }],
      ["conflict:resolved", (e) => {
        r.dim(`[conflict resolved] ${e.id}`);
      }],
      ["provider:fallback", (e) => {
        r.dim(`[fallback] ${e.subtaskId}: ${e.from} → ${e.to} (${e.reason})`);
      }],
      ["result:merged", (e) => {
        r.phaseUpdate("merging", `${e.totalSubtasks} tasks, ${e.conflicts} conflicts`);
      }],
    ];

    for (const [event, handler] of handlers) {
      eventBus.on(event, handler);
    }

    return () => {
      for (const [event, handler] of handlers) {
        eventBus.removeListener(event, handler);
      }
    };
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

    // Codebase content: inject relevant source file contents
    const contentCollector = o.getCodebaseContent();
    const codebaseContent = contentCollector.collect(input);
    if (codebaseContent.files.length > 0 || codebaseContent.allPaths.length > 0) {
      sp += "\n\n" + contentCollector.formatForPrompt(codebaseContent);
    }

    if (skillBodies.length > 0) sp += "\n\n" + skillBodies.join("\n\n");

    const lang = this.conversation.getLanguage();
    if (lang && lang !== "en") sp += `\n\n[LANGUAGE] The user writes in ${lang}. Always respond in the same language.`;

    const memories = o.getMemory().getRelevantMemories(input, profile.name, 5);
    const memoryCtx = o.getMemory().formatForPrompt(memories);
    if (memoryCtx) sp += "\n" + memoryCtx;

    const decisions = o.getDecisions().getRelevantDecisions(input);
    if (decisions.length > 0) sp += "\n\n" + o.getDecisions().formatForPrompt(decisions);

    if (this.planMode.isActive()) sp += "\n\n" + this.planMode.getSystemPromptAddition();

    if (route.model === "haiku") sp += "\nKeep responses concise and under 200 words.";

    if ((profile.role ?? "").toLowerCase().includes("design")) {
      sp += `\n\n[DESIGN ENFORCER — AUTO-VERIFIED]
Your output will be automatically scanned for these violations. If ANY are found, your entire output is rejected and you must redo:
1. MISSING REFERENCE: You MUST write "This UI follows [X]'s [pattern] + [Y]'s [pattern]" before any code
2. GRADIENT: No linear-gradient or radial-gradient except on progress bars
3. RAINBOW BADGES: Max 3 colors total (gray + red + green). All other statuses = gray
4. GLASSMORPHISM: No backdrop-blur-lg/xl, no glass effects
5. BORDER-RADIUS: Max rounded-xl (12px). Never rounded-2xl or rounded-full on containers
6. HOVER: bg-color shift only. Never scale(), translateY(), or shadow changes on hover
7. SHADOWS: Use border instead. No shadow-lg, shadow-xl, shadow-2xl
8. ICONS: Import from lucide-react. Never write <svg> manually
Violations trigger automatic retry with a penalty prompt. Pass on first attempt.`;
    }

    return sp;
  }

  get conversationLength(): number {
    return this.conversation.length;
  }
}
