import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig, ModelTier, SubTask, ProviderName, DecompositionResult } from "../config/types.ts";
import { decomposeWithSam } from "../core/decomposer.ts";
import { detectLintConfig, formatLintForPrompt } from "../core/lint-detector.ts";
import type { RendererPort } from "./renderer-types.ts";
import { getLayoutManager } from "./renderer.ts";
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

[DESIGN PLAN-FIRST MODE — Phase 1 — HIGHEST PRIORITY]
You are in PLAN phase. Output your design specification as plain text.

ABSOLUTE RULES:
- DO NOT call any tools (no Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, or ANY tool)
- DO NOT write code or modify files
- ONLY output text — your design plan

Include in your plan:
1. **Reference**: Specific products/patterns to follow (e.g., "Linear's issue list + Vercel's dashboard nav")
2. **Layout**: Visual structure, grid system, spacing
3. **Colors**: Exact hex palette and usage
4. **Typography**: Font family, sizes, weights
5. **Components**: Every component with brief description
6. **Interactions**: Hover states, transitions, animations
7. **Responsive**: Breakpoint adaptations

The user will review this plan. Output it as readable text now.`;

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
    // Detect lint config once at startup
    detectLintConfig(process.cwd()).then(config => {
      if (config) (this as any)._cachedLintConfig = config;
    }).catch(() => {});

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
    // Cancel all supervisor workers
    this.orchestrator.cancelAllWorkers("User aborted (ESC)").catch(() => {});
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

    // During background execution: let normal routing handle it.
    // If user was @design, sticky agent keeps routing to design.
    // User can explicitly @Sam for status questions.
    const savedPin: string | null = null;

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
      // Background agents (multi or single) handle their own cleanup
      if (!this.multiAgentRunning && !this.singleAgentRunning) {
        this.renderer.phaseUpdate("done");
        this.renderer.notifyIdle();
        this.currentStreamer = null;
        this.currentCancellation = null;
      }
      if (savedPin !== null) this.pinnedAgent = savedPin;
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
    r.startSpinner("routing", "sonnet");

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
      // Start scouting in parallel with classification — don't wait for profile
      const scoutPromise = Promise.allSettled([
        this.skillScoutCache.get<ScoutResult>(input) ?? scoutSkills({ agentRole: "coder", prompt: input } as SubTask, this.orchestrator.getSkillIndex(), cancellation.signal).then(sr => { this.skillScoutCache.set(input, sr); return sr; }),
        this.mcpScoutCache.get<McpScoutResult>(input) ?? scoutMcp(input, cancellation.signal).then(mr => { this.mcpScoutCache.set(input, mr); return mr; }),
      ]);

      const classification = await classifyWithSam(input, this.lastAgent ?? undefined);
      agentName = classification.agent;
      r.info(classification.reason);

      if (classification.type === "conversation") {
        route.multiAgent = false;
      } else if (classification.agents && classification.agents.length > 1) {
        route.multiAgent = true;
      }

      if (classification.lang) {
        this.conversation.setLanguage(classification.lang);
      }

      // Store early scout results for later use
      (this as any)._earlyScoutPromise = scoutPromise;
    }

    if (route.multiAgent) {
      r.stopSpinner();
      r.startSpinner("orc", "supervisor" as any);
      // Run multi-agent in background so REPL stays responsive
      this.runMultiAgentBackground(input, cancellation);
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

    // Scout skills + MCP (use early results if available from parallel classification)
    const earlyScout = (this as any)._earlyScoutPromise as Promise<PromiseSettledResult<any>[]> | undefined;
    (this as any)._earlyScoutPromise = undefined;
    const [skillSettled, mcpSettled] = earlyScout
      ? await earlyScout
      : await Promise.allSettled([
          this.skillScoutCache.get<ScoutResult>(input) ?? scoutSkills({ agentRole: profile.role ?? "coder", prompt: input } as SubTask, this.orchestrator.getSkillIndex(), cancellation.signal).then(sr => { this.skillScoutCache.set(input, sr); return sr; }),
          this.mcpScoutCache.get<McpScoutResult>(input) ?? scoutMcp(input, cancellation.signal).then(mr => { this.mcpScoutCache.set(input, mr); return mr; }),
        ]);
    const emptySkill: ScoutResult = { needed: false, skills: [], durationMs: 0 };
    const emptyMcp: McpScoutResult = { needed: false, servers: [], durationMs: 0 };
    const skillScoutResult = skillSettled.status === "fulfilled" ? skillSettled.value : emptySkill;
    const mcpScoutResult = mcpSettled.status === "fulfilled" ? mcpSettled.value : emptyMcp;

    const skillIndex = this.orchestrator.getSkillIndex();
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

    // Inject live worker state if supervisor has active/completed workers
    const workerState = this.getWorkerStateContext();
    if (workerState) {
      systemPrompt += `\n\n${workerState}`;
    }

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

    // Run single-agent in background so REPL stays responsive
    const isDesignAgent = (profile.role ?? "").toLowerCase().includes("design");
    this.singleAgentRunning = true;
    const execution = isDesignAgent
      ? this.executeDesignPreview(agentName, route, profile, providerConfig, systemPrompt, fullPrompt, mcpConfigPath, cancellation, input, sessionId)
      : this.executeWithRetry(cmd, agentName, route, profile, providerConfig, systemPrompt, fullPrompt, mcpConfigPath, cancellation, input, sessionId);

    execution
      .catch(err => this.renderer.error(`Agent error: ${(err as Error).message}`))
      .finally(() => {
        this.singleAgentRunning = false;
        this.renderer.stopSpinner();
        this.renderer.phaseUpdate("done");
        this.renderer.notifyIdle();
        this.currentStreamer = null;
        this.currentCancellation = null;
      });
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
      mcpConfig: mcpConfigPath,
      sessionId,
    });

    r.info("Design preview: Generating plan...");
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
    streamer.on("tool_use", (tool: ToolUseEvent) => {
      if (boxOpen) { r.endBox(); boxOpen = false; }
      const detail = tool.input?.file_path
        ? `(${String(tool.input.file_path).split("/").pop()})`
        : tool.input?.command ? `(${String(tool.input.command).slice(0, 60)})` : "";
      r.dim(`  \x1b[33m●\x1b[0m \x1b[1m${tool.name}\x1b[0m\x1b[2m${detail}\x1b[0m`);
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

    // Save design plan for visual verify and quality gate comparison
    const designPlanPath = `${process.cwd()}/.orchestrator/design-plan.md`;
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(`${process.cwd()}/.orchestrator`, { recursive: true });
      await Bun.write(designPlanPath, planResult.text);
    } catch { /* non-blocking */ }

    // Ask for approval
    const answer = await this.askUser(
      "이 디자인 설계안을 승인하시겠습니까?",
      ["승인 — 이대로 구현", "거부 — 취소"],
    );

    if (!answer || answer.includes("거부") || answer.includes("취소")) {
      r.info("Design preview: Plan rejected.");
      this.conversation.add({ role: "assistant" as const, content: planResult.text, agentName, tier: route.model, timestamp: new Date().toISOString() });
      return;
    }

    // Phase 2: Execute with approved plan (session has full Phase 1 context)
    r.info("Design preview: Executing approved plan...");
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
    const maxErrorRetries = this.config.supervisor?.maxRetries ?? 2;
    const maxQualityRetries = Infinity; // Keep retrying until quality gate passes
    let totalAttempts = Infinity; // No hard limit — quality gate drives termination
    let errorRetries = 0;
    let qualityRetries = 0;
    let currentCmd = initialCmd;
    let currentProfile = profile;
    let currentProviderConfig = providerConfig;
    let lastError: string | null = null;

    const enforcer = this.orchestrator.getHarnessEnforcer();

    let preRetryDiffHash = "";

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (cancellation.cancelled) break;

      if (attempt > 0) {
        // Snapshot git state before retry to detect if retry actually changes anything
        try {
          const proc = Bun.spawnSync(["git", "diff", "--stat"], { stdout: "pipe", stderr: "pipe" });
          preRetryDiffHash = new TextDecoder().decode(proc.stdout).trim();
        } catch {}
        r.retryAttempt(attempt, maxErrorRetries, lastError ?? "unknown");
        r.startSpinner(agentName, route.model);
      }

      const streamer = new AgentStreamer();
      this.currentStreamer = streamer;
      let boxOpen = false;
      let toolUseCount = 0;
      let toolGroupCount = 0;
      let toolGroupShown = 0;
      const MAX_TOOLS_VISIBLE = 3;
      let pendingApproval: { command: string; message: string } | null = null;
      let pendingQuestion: { question: string; options?: string[] } | null = null;

      const flushToolGroup = () => {
        if (toolGroupCount > toolGroupShown) {
          r.dim(`  \x1b[2m+${toolGroupCount - toolGroupShown} more tool uses\x1b[0m`);
        }
      };

      streamer.on("text_delta", (delta: string) => {
        if (!boxOpen) {
          flushToolGroup();
          toolGroupCount = 0;
          toolGroupShown = 0;
          r.stopSpinner();
          r.startBox(route.model);
          boxOpen = true;
        }
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
        toolGroupCount++;
        const inp = tool.input ?? {};
        const detail = (inp.file_path as string) ?? (inp.command as string) ?? (inp.pattern as string) ?? undefined;
        r.stopSpinner();
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

        if (toolGroupShown < MAX_TOOLS_VISIBLE) {
          r.toolUse(tool.name, detail, false, inp);
          toolGroupShown++;
        }
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

        // Build/test verification (before LLM quality gate)
        if (toolUseCount > 0) {
          const buildIssues = await this.runSingleAgentBuildCheck();
          if (buildIssues.length > 0 && errorRetries < maxErrorRetries) {
            r.qualityGate(false, buildIssues);
            r.info("Auto-retry: Build/test failed, sending fix prompt...");
            const reinforced = `[BUILD FAILED]\n\n## Original Task\n${input}\n\n## Build issues to fix\n${buildIssues.map(i => `- ${i}`).join("\n")}\n\nFix all build issues while keeping the original task completed.`;
            currentCmd = buildCommand(currentProviderConfig, currentProfile, {
              prompt: reinforced,
              model: currentProfile.model,
              systemPrompt,
              maxTurns: currentProfile.maxTurns,
              mcpConfig: mcpConfigPath,
              resumeSession: sessionId,
            });
            lastError = "build/test failed";
            continue;
          }
        }

        // Quality gate (LLM-based)
        flushToolGroup();
        if (result.text) {
          r.info("Evaluating quality...");
          // Load saved design plan for design role quality evaluation
          let designPlan: string | undefined;
          if ((currentProfile.role ?? "").toLowerCase().includes("design")) {
            try { designPlan = await Bun.file(`${process.cwd()}/.orchestrator/design-plan.md`).text(); } catch { /* no plan saved */ }
          }
          const critique = await runQualityGate({ agentRole: currentProfile.role ?? "coder", prompt: input, toolUseCount, designPlan }, result.text);
          r.qualityGate(critique.passes, critique.issues);

          // Auto-retry on intent without action (agent described what it would do but used no tools)
          if (!critique.passes && critique.issues.includes("Intent without action: declared actions but used zero tools") && errorRetries < maxErrorRetries) {
            r.info("Auto-retry: Agent declared intent but used no tools...");
            const reinforced = `[IMPORTANT: Your previous response only described what to do without doing it.]\n\n## Original Task\n${input}\n\nYou MUST use tools (Read, Edit, Bash, etc.) to complete this task. Do not describe — act.`;
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
          if (!critique.passes && critique.issues.includes("Result is suspiciously short") && errorRetries < maxErrorRetries) {
            r.info("Auto-retry: Response too short...");
            const reinforced = `[IMPORTANT: Your previous attempt was incomplete.]\n\n## Original Task\n${input}\n\nYou MUST use tools to actually complete this task fully. Do not just acknowledge — take action.`;
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

          // Visual verification for design agents — screenshot + compare
          if ((currentProfile.role ?? "").toLowerCase().includes("design") && toolUseCount > 0) {
            const { detectDevServer, visualVerify } = await import("../core/visual-verify.ts");
            const server = await detectDevServer();
            if (server.running) {
              r.info(`visual verify: checking ${server.url}...`);
              const visual = await visualVerify(designPlan ?? input, { url: server.url });
              if (visual.screenshotPath) {
                r.info(`screenshot: ${visual.screenshotPath}`);
              }
              if (!visual.matches && visual.issues.length > 0) {
                critique.passes = false;
                critique.issues.push(...visual.issues.map(i => `[VISUAL] ${i}`));
                r.qualityGate(false, visual.issues);
              }
            }
          }

          // Auto-retry on design quality violations
          if (!critique.passes && (currentProfile.role ?? "").toLowerCase().includes("design") && errorRetries < maxErrorRetries) {
            const designIssues = critique.issues.filter((i: string) =>
              i.includes("reference declaration") || i.includes("Gradient") ||
              i.includes("Rainbow") || i.includes("Glassmorphism") ||
              i.includes("border-radius") || i.includes("scale()") ||
              i.includes("shadows") || i.includes("SVG icons")
            );
            if (designIssues.length > 0) {
              r.info(`auto-retry: design violations — ${designIssues.join(", ")}`);
              const reinforced = `[DESIGN VIOLATION]\n\n## Original Task\n${input}\n\n## Violations to fix\n${designIssues.map((i: string) => `- ${i}`).join("\n")}\n\nFix ALL violations while keeping the original task completed. Reference-First Protocol is MANDATORY.`;
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

          // Auto-retry on any quality gate failure — keep going until passed
          if (!critique.passes && critique.issues.length > 0) {
            qualityRetries++;
            // Check if the retry actually changed anything meaningful
            let noRealChanges = false;
            let currentDiffStat = "";
            if (attempt > 0 && preRetryDiffHash) {
              try {
                const proc = Bun.spawnSync(["git", "diff", "--stat"], { stdout: "pipe", stderr: "pipe" });
                currentDiffStat = new TextDecoder().decode(proc.stdout).trim();
                noRealChanges = currentDiffStat === preRetryDiffHash;
              } catch {}
            }
            // Get actual git diff to show agent what the current state is
            let diffContext = "";
            try {
              const proc = Bun.spawnSync(["git", "diff", "--name-only"], { stdout: "pipe", stderr: "pipe" });
              const changedFiles = new TextDecoder().decode(proc.stdout).trim();
              if (changedFiles) diffContext = `\n\n## Files currently modified (git diff)\n${changedFiles}`;
              else diffContext = "\n\n## git diff shows NO files were modified. You have not made any changes yet.";
            } catch {}
            const unchangedWarning = noRealChanges
              ? "\n\n**CRITICAL: Your previous retry made ZERO file changes. git diff confirms nothing changed. You MUST use the Edit tool to actually modify files. Do NOT describe what you would do — DO IT NOW.**"
              : "";
            r.info(`auto-retry (#${qualityRetries}): quality gate failed — ${critique.issues.slice(0, 2).join(", ")}`);
            if (noRealChanges) r.error("⚠ Previous retry made no file changes — reinforcing...");
            const reinforced = `[QUALITY GATE FAILED — Retry #${qualityRetries}]\n\n## Original Task (DO NOT forget this)\n${input}\n\n## Issues to fix\n${critique.issues.map((i: string) => `- ${i}`).join("\n")}${diffContext}${unchangedWarning}\n\nRead the files you created/modified and fix ALL issues above. The original task must still be fully completed.`;
            currentCmd = buildCommand(currentProviderConfig, currentProfile, {
              prompt: reinforced,
              model: currentProfile.model,
              systemPrompt,
              maxTurns: currentProfile.maxTurns,
              mcpConfig: mcpConfigPath,
              resumeSession: sessionId,
            });
            lastError = "quality gate failed";
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
        errorRetries++;
        r.stopSpinner();
        if (boxOpen) r.endBox();
        if (errorRetries > maxErrorRetries) {
          r.error(`All ${errorRetries} error retries exhausted: ${lastError}`);
          break;
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
  private async runSingleAgentBuildCheck(): Promise<string[]> {
    const issues: string[] = [];
    const cwd = process.cwd();
    const TIMEOUT_NS = 30_000_000_000;
    let scripts: Record<string, string> = {};
    try {
      const pkg = await Bun.file(`${cwd}/package.json`).json();
      scripts = pkg.scripts ?? {};
    } catch { return issues; }

    if (scripts.typecheck || scripts["type-check"]) {
      const name = scripts.typecheck ? "typecheck" : "type-check";
      try {
        const proc = Bun.spawnSync(["pnpm", name], { cwd, stderr: "pipe", stdout: "pipe", timeout: TIMEOUT_NS });
        if (proc.exitCode !== 0) {
          const output = (new TextDecoder().decode(proc.stdout).trim() + "\n" + new TextDecoder().decode(proc.stderr).trim()).trim();
          if (output) issues.push(`Typecheck failed:\n${output}`);
        }
      } catch {}
    }

    if (scripts.lint) {
      try {
        const proc = Bun.spawnSync(["pnpm", "lint"], { cwd, stderr: "pipe", stdout: "pipe", timeout: TIMEOUT_NS });
        if (proc.exitCode !== 0) {
          const output = (new TextDecoder().decode(proc.stdout).trim() + "\n" + new TextDecoder().decode(proc.stderr).trim()).trim();
          if (output) issues.push(`Lint failed:\n${output}`);
        }
      } catch {}
    }

    return issues;
  }

  private getWorkerStateContext(): string | null {
    try {
      const pool = this.orchestrator.getSupervisor().getWorkerPool();
      const all = pool.getAll();
      if (all.length === 0) return null;
      const lines = all.map(w => {
        const status = w.status === "running" ? "🟢 running" : w.status === "completed" ? "✅ done" : `❌ ${w.status}`;
        const result = w.result ? ` — ${w.result.slice(0, 100)}` : "";
        return `- ${w.agentName} (${w.provider}): ${status}${result}`;
      });
      return `## Current Multi-Agent Worker State\n${lines.join("\n")}`;
    } catch {
      return null;
    }
  }

  private multiAgentRunning = false;
  private singleAgentRunning = false;

  private runMultiAgentBackground(input: string, cancellation: CancellationToken): void {
    this.multiAgentRunning = true;
    this.handleMultiAgent(input, cancellation)
      .catch(err => this.renderer.error(`Multi-agent: ${(err as Error).message}`))
      .finally(() => {
        this.multiAgentRunning = false;
        this.renderer.stopSpinner();
        this.renderer.phaseUpdate("done");
        this.renderer.notifyIdle();
        this.currentCancellation = null;
      });
  }

  isAgentRunning(): boolean {
    return this.multiAgentRunning || this.singleAgentRunning;
  }

  private async handleMultiAgent(
    input: string,
    cancellation: CancellationToken,
  ): Promise<void> {
    const r = this.renderer;

    const lang = this.conversation.getLanguage();
    const profileContext = this.orchestrator.buildProfileContext();
    const claudeProvider = this.config.providers.claude;

    // Run brainstorm + decomposition in parallel — no extra wait time
    r.phaseUpdate("planning");
    const brainstormPromise = (claudeProvider && shouldBrainstorm(input, "complex") && !cancellation.cancelled)
      ? brainstorm(input, claudeProvider, { name: "brainstorm", provider: "claude", model: "sonnet", role: "coder" } as any, cancellation.signal, (round, label) => {
          r.updateSpinner(`deliberation ${round}: ${label}...`);
        }).catch(() => null)
      : Promise.resolve(null);

    const decomposePromise = decomposeWithSam(input, "preview", lang ?? undefined, profileContext);

    const [bsResult, decomposition] = await Promise.all([brainstormPromise, decomposePromise]);

    if (cancellation.cancelled) return;

    // Show brainstorm result if available
    const brainstormContext = bsResult?.synthesized ?? "";
    if (brainstormContext) {
      r.brainstormStatus(3, bsResult!.durationMs);
    }

    // Show decomposition plan then proceed (ESC cancels during execution)
    r.stopSpinner();
    r.separator();
    r.info("\x1b[1mSam\x1b[0m\x1b[2m: 다음과 같이 나누겠습니다:\x1b[0m");
    for (const st of decomposition.subtasks) {
      const depInfo = st.dependencies.length > 0 ? ` \x1b[2m(depends on ${st.dependencies.length})\x1b[0m` : "";
      r.info(`  \x1b[36m${st.agentRole}\x1b[0m — ${st.prompt.slice(0, 100)}${st.prompt.length > 100 ? "…" : ""}${depInfo}`);
    }
    r.info(`\x1b[2m${decomposition.subtasks.length} subtasks, ${decomposition.executionPlan.phases.length} phases, strategy: ${decomposition.executionPlan.strategy}\x1b[0m`);
    r.separator();
    r.startSpinner("orc", "supervisor" as any);

    // 2. Execute with supervisor
    const unsubscribe = this.subscribeSupervisorEvents();

    try {
      const supervisorInput = brainstormContext ? input + "\n\n## Deliberation Result\n" + brainstormContext : input;
      const result = await this.orchestrator.executeWithSupervisor(supervisorInput, { lang: lang ?? undefined });

      if (cancellation.cancelled) return;

      // Add detailed result to conversation so Sam has context for follow-ups
      const subtaskSummary = result.subtaskResults.map(sr =>
        `[${sr.role}] ${sr.agentName}: ${sr.result?.slice(0, 300) || "(no output)"}`,
      ).join("\n\n");
      const conversationContent = [
        `## Multi-agent execution completed`,
        `Tasks: ${result.subtaskResults.length}, Success: ${result.success}`,
        `Cost: $${result.totalCost.toFixed(2)}, Tokens: ${result.totalTokens}`,
        result.mergedOutput ? `\n## Merged Output\n${result.mergedOutput}` : "",
        subtaskSummary ? `\n## Worker Results\n${subtaskSummary}` : "",
      ].filter(Boolean).join("\n");
      this.conversation.add({
        role: "assistant",
        content: conversationContent,
        agentName: "multi-agent",
        tier: "sonnet" as ModelTier,
        timestamp: new Date().toISOString(),
      });

      // Show cost summary
      if (result.totalTokens > 0) {
        r.cost(result.totalCost, result.totalInputTokens, result.totalOutputTokens, result.totalDurationMs);
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
    const lm = getLayoutManager();
    // Track tool calls per worker for collapsible display
    const workerTools = new Map<string, { count: number; shown: number; lastSection: string }>();
    const MAX_VISIBLE_TOOLS = 3;

    const flushHidden = (workerId: string) => {
      const tracker = workerTools.get(workerId);
      if (tracker && tracker.count > tracker.shown) {
        r.dim(`  \x1b[2m  +${tracker.count - tracker.shown} more tool uses\x1b[0m`);
      }
    };

    let totalWorkers = 0;
    let completedWorkers = 0;
    let failedWorkers = 0;

    const handlers: Array<[string, (e: any) => void]> = [
      ["supervisor:plan", (e) => {
        r.phaseUpdate("planning", `${e.phases} phases`);
        lm?.setSubtaskCount(e.phases);
      }],
      ["supervisor:dispatch", (e) => {
        totalWorkers++;
        r.dim(`[${e.role}] ${e.provider}/${e.model} — ${e.prompt}`);
        r.taskUpdate(e.subtaskId, "running");
        lm?.setSubtaskCount(totalWorkers);
      }],
      ["worker:spawn", (e) => {
        r.workerStart(e.workerId, e.workerId, e.model);
        workerTools.set(e.workerId, { count: 0, shown: 0, lastSection: "" });
        lm?.workerStarted(e.workerId, e.model ?? "sonnet");
        lm?.updateAgentState("tool_use");
      }],
      ["worker:progress", (e) => {
        r.workerUpdate(e.workerId, { progress: e.progress });
      }],
      ["worker:turn", (e) => {
        if (e.toolUsed) {
          const wId = e.workerId as string;
          const tracker = workerTools.get(wId) ?? { count: 0, shown: 0, lastSection: "" };
          tracker.count++;
          if (tracker.shown < MAX_VISIBLE_TOOLS) {
            const input = e.toolInput as Record<string, unknown> | undefined;
            const detail = formatToolDetail(e.toolUsed, input);
            r.dim(`    \x1b[33m●\x1b[0m \x1b[1m${e.toolUsed}\x1b[0m\x1b[2m${detail}\x1b[0m`);
            tracker.shown++;
          }
          workerTools.set(wId, tracker);
          lm?.workerUpdate(wId, "tool_use", e.toolUsed);
        }
      }],
      ["worker:complete", (e) => {
        completedWorkers++;
        flushHidden(e.workerId);
        const sec = e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : "";
        r.info(`\x1b[32m✓\x1b[0m ${e.workerId} \x1b[2mcompleted${sec ? ` (${sec})` : ""}\x1b[0m`);
        r.dim(`  Progress: ${completedWorkers}/${totalWorkers} done${failedWorkers ? `, ${failedWorkers} failed` : ""}`);
        r.workerDone(e.workerId);
        r.taskUpdate(e.workerId, "passed", e.durationMs);
        workerTools.delete(e.workerId);
        lm?.workerDone(e.workerId);
      }],
      ["worker:text", (e) => {
        const clean = (e.text as string).replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|[\x00-\x08\x0e-\x1f]/g, "").trim();
        if (!clean || clean.length <= 3 || /^\[[\d;]+[A-Z]/.test(clean)) return;
        const wId = e.agentName as string;
        const tracker = workerTools.get(wId);
        // Detect section headings (### or ## or numbered steps)
        if (/^#{2,3}\s|^\d+\.\s|^Step\s/i.test(clean)) {
          if (tracker) {
            flushHidden(wId);
            tracker.count = 0;
            tracker.shown = 0;
            tracker.lastSection = clean;
          }
          r.dim(`  \x1b[36m${wId}\x1b[0m · ${clean.slice(0, 120)}`);
        } else {
          r.dim(`  ${wId} · ${clean.slice(0, 120)}`);
        }
      }],
      ["worker:stderr", (e) => {
        r.error(`[${e.agentName}] ${e.error}`);
      }],
      ["worker:fail", (e) => {
        failedWorkers++;
        flushHidden(e.workerId);
        r.workerDone(e.workerId);
        lm?.workerDone(e.workerId);
        r.taskUpdate(e.workerId, "failed");
        r.error(`Worker failed: ${e.error}`);
        r.dim(`  Progress: ${completedWorkers}/${totalWorkers} done, ${failedWorkers} failed`);
        workerTools.delete(e.workerId);
      }],
      ["worker:cost", (e) => {
        r.updateCostLive(e.costUsd);
      }],
      ["feedback:quality_gate", (e) => {
        r.qualityGate(e.passed, e.issues);
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

    // Inject lint rules so agent writes compliant code
    if ((this as any)._cachedLintConfig) {
      sp += "\n\n" + formatLintForPrompt((this as any)._cachedLintConfig);
    }

    const lang = this.conversation.getLanguage();
    if (lang && lang !== "en") sp += `\n\n[LANGUAGE] The user writes in ${lang}. Always respond in the same language.`;

    const memories = o.getMemory().getRelevantMemories(input, profile.name, 5);
    const memoryCtx = o.getMemory().formatForPrompt(memories);
    if (memoryCtx) sp += "\n" + memoryCtx;

    const decisions = o.getDecisions().getRelevantDecisions(input);
    if (decisions.length > 0) sp += "\n\n" + o.getDecisions().formatForPrompt(decisions);

    if (this.planMode.isActive()) sp += "\n\n" + this.planMode.getSystemPromptAddition();

    if (route.model === "sonnet") sp += "\nKeep responses concise and under 200 words.";

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
