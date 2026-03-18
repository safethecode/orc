import { join, relative } from "node:path";
import { homedir } from "node:os";
import type {
  OrchestratorConfig,
  AgentProfile,
  HandoffOptions,
  AssignOptions,
  SendMessageOptions,
  Task,
  SessionInfo,
} from "../config/types.ts";
import { SessionManager } from "../session/manager.ts";
import { Store } from "../db/store.ts";
import { initDb } from "../db/schema.ts";
import { routeTask, suggestAgent } from "./router.ts";
import { PriorityScheduler } from "./scheduler.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { SkillIndex } from "../agents/skill-index.ts";
import { buildCommand } from "../agents/provider.ts";
import { buildHarness } from "../agents/harness.ts";
import { Logger } from "../logging/logger.ts";
import { Tracer } from "../logging/tracer.ts";
import { HealthChecker } from "../logging/health.ts";
import { checkRequirements } from "../agents/preflight.ts";
import { OwnershipManager } from "./ownership.ts";
import { WorktreeManager } from "../session/worktree.ts";
import { Inbox } from "../messaging/inbox.ts";
import { ContextCompressor } from "../messaging/context-compressor.ts";
import { MemoryStore } from "../memory/memory-store.ts";
import { MemoryConsolidator } from "../memory/consolidator.ts";
import { eventBus } from "./events.ts";
import { SleepInhibitor } from "../utils/sleep-inhibitor.ts";
import { createGhostCommit } from "../utils/ghost-commit.ts";
import { ConnectionPrewarmer } from "../session/prewarmer.ts";
import { RecoveryManager } from "./recovery.ts";
import { TaskLogger } from "../logging/task-logger.ts";
import { CodebaseMap } from "../memory/codebase-map.ts";
import { CodebaseScanner } from "../memory/codebase-scanner.ts";
import { CodebaseContentCollector } from "../memory/codebase-content.ts";
import { ContextBuilder } from "../memory/context-builder.ts";
import { DynamicSecurityProfile } from "../sandbox/dynamic-profile.ts";
import { initParser } from "../sandbox/safety.ts";
import { AccountManager } from "../agents/account-manager.ts";
import { TaskPredictor } from "./predictor.ts";
import { PromptCache } from "./prompt-cache.ts";
import { DecisionRegistry } from "./decision-registry.ts";
import { ConflictWatcher } from "./watcher.ts";
import { PortManager } from "./port-manager.ts";
import { CrashRecovery } from "./crash-recovery.ts";
import { CostEstimator } from "./cost-estimator.ts";
import { CheckpointManager } from "./checkpoint.ts";
import { Supervisor } from "./supervisor.ts";
import { TmuxWorkerStrategy } from "./tmux-worker-strategy.ts";
import { StreamerWorkerStrategy } from "./streamer-worker-strategy.ts";
import { McpClientManager } from "../mcp/client-manager.ts";
import { LspManager } from "../lsp/index.ts";
import { GitSnapshotManager } from "./git-snapshot.ts";
import { PermissionManager } from "./permissions.ts";
import { HashlineEditor } from "./hashline.ts";
import { AutoFormatter } from "./formatter.ts";
import { CustomToolLoader } from "./custom-tools.ts";
import { FileWatcher } from "./file-watcher.ts";
import { DoomLoopDetector } from "./doom-loop.ts";
import { ThemeManager } from "../repl/theme.ts";
import { ModelRegistry } from "./model-registry.ts";
import { PluginManager } from "./plugin-system.ts";
import { SessionSharer } from "./session-share.ts";
import { OAuthMcpAuth } from "./oauth-mcp.ts";
import { AstGrep } from "./ast-grep.ts";
import { InputHandler } from "../repl/input-handler.ts";
import { PlanningPipeline } from "./planning-pipeline.ts";
import { BoulderManager } from "./boulder.ts";
import { NotepadManager } from "./notepad.ts";
import { CommentChecker } from "./comment-checker.ts";
import { RalphLoop } from "./ralph-loop.ts";
import { RuntimeFallbackManager } from "./runtime-fallback.ts";
import { TmuxVisualizer } from "./tmux-viz.ts";
import { IntentGate } from "./intent-gate.ts";
import { CategoryRouter } from "./category-router.ts";
import type { WorkerBus } from "./worker-bus.ts";
import type { SubTask } from "../config/types.ts";
import type { Database } from "bun:sqlite";
import { WriteGuard } from "./write-guard.ts";
import { NonInteractiveGuard } from "./non-interactive-env.ts";
import { ToolOutputTruncator } from "./tool-truncator.ts";
import { VcsMonitor } from "./vcs-monitor.ts";
import { ThinkMode } from "./think-mode.ts";
import { FrecencyTracker } from "./frecency.ts";
import { SessionNotifier } from "./session-notification.ts";
import { PromptStash } from "./prompt-stash.ts";
import { GitWorktreeManager } from "./git-worktree.ts";
import { SessionRecoveryManager } from "./session-recovery.ts";
import { BackgroundAgentManager } from "./background-agent.ts";
import { TodoContinuationEnforcer } from "./todo-continuation.ts";
import { UnstableBabysitter } from "./unstable-babysitter.ts";
import { FastworkMode } from "./fastwork.ts";
import { UltrathinkMode } from "./ultrathink.ts";
import { QuestionManager } from "./question-tool.ts";
import { CodeSearchEngine } from "./code-search.ts";
import { WebSearchEngine } from "./web-search.ts";
import { BuiltinCodeSearch } from "./code-search-builtin.ts";
import { StatisticsTracker } from "./statistics.ts";
import { ContextInjector } from "./context-injector.ts";
import { SessionToolkit } from "./session-tools.ts";
import { MultiEditTool } from "./multiedit-tool.ts";
import { BatchToolExecutor } from "./batch-tool.ts";
import { RetryWithBackoff } from "./retry-backoff.ts";
import { RateLimitScheduler } from "./rate-limit-scheduler.ts";
import { AgentFallbackChain } from "./agent-fallback-chain.ts";
import { ModelVariantManager } from "./model-variants.ts";
import { InterleavedThinkingParser } from "./interleaved-thinking.ts";
import { CustomCommandLoader } from "./custom-commands.ts";
import { PersistentTaskManager } from "./persistent-tasks.ts";
import { DoctorDiagnostics } from "./doctor.ts";
import { HandoffGenerator } from "./handoff.ts";
import { GitHubIntegration } from "./github-integration.ts";
import { AcpServer } from "./acp.ts";
import { SdkServer } from "./sdk-server.ts";
import { CopilotAuth } from "./copilot-auth.ts";
import { RefactorEngine } from "./refactor-command.ts";
import { BenchmarkRunner } from "../benchmark/runner.ts";
import { ReportGenerator } from "../benchmark/report-generator.ts";
import { DeadLetterQueue } from "./dead-letter-queue.ts";
import { StuckDetector } from "./stuck-detector.ts";
import { EscalationManager } from "./escalation-manager.ts";
import { DistributedTracer } from "./distributed-trace.ts";
import { HarnessEnforcer } from "./harness-enforcer.ts";
import { autoCommit, installCommitHook, startCommitWatcher } from "./auto-commit.ts";

const MAX_AGENT_DEPTH = 5;

export class Orchestrator {
  private sessionManager: SessionManager;
  private store!: Store;
  private db!: Database;
  private ownership!: OwnershipManager;
  private worktree: WorktreeManager;
  private inbox!: Inbox;
  private compressor: ContextCompressor;
  private scheduler: PriorityScheduler;
  private registry: AgentRegistry;
  private logger: Logger;
  private tracer: Tracer;
  private health: HealthChecker;
  private memory!: MemoryStore;
  private consolidator!: MemoryConsolidator;
  private sleepInhibitor: SleepInhibitor;
  private prewarmer: ConnectionPrewarmer;
  private recovery: RecoveryManager;
  private taskLogger: TaskLogger;
  private codemap!: CodebaseMap;
  private codebaseScanner!: CodebaseScanner;
  private codebaseContent: CodebaseContentCollector;
  private contextBuilder!: ContextBuilder;
  private dynamicSecurity: DynamicSecurityProfile;
  private accountManager: AccountManager;
  private predictor!: TaskPredictor;
  private promptCache!: PromptCache;
  private decisions!: DecisionRegistry;
  private conflictWatcher!: ConflictWatcher;
  private portManager!: PortManager;
  private crashRecovery!: CrashRecovery;
  private costEstimator!: CostEstimator;
  private checkpointManager!: CheckpointManager;
  private supervisor!: Supervisor;
  private skillIndex: SkillIndex;
  private mcpManager: McpClientManager;
  private lspManager: LspManager;
  private gitSnapshots: GitSnapshotManager;
  private permissions: PermissionManager;
  private formatter: AutoFormatter;
  private customTools: CustomToolLoader;
  private fileWatcher: FileWatcher;
  private doomLoop: DoomLoopDetector;
  private themeManager: ThemeManager;
  private modelRegistry: ModelRegistry;
  private pluginManager: PluginManager;
  private sessionSharer: SessionSharer;
  private oauthMcp: OAuthMcpAuth;
  private astGrep: AstGrep;
  private inputHandler: InputHandler;
  private planningPipeline: PlanningPipeline;
  private boulderManager: BoulderManager;
  private notepadManager: NotepadManager;
  private commentChecker: CommentChecker;
  private ralphLoop: RalphLoop;
  private runtimeFallback: RuntimeFallbackManager;
  private tmuxViz: TmuxVisualizer;
  private intentGate: IntentGate;
  private categoryRouter: CategoryRouter;
  private writeGuard: WriteGuard;
  private nonInteractiveGuard: NonInteractiveGuard;
  private toolTruncator: ToolOutputTruncator;
  private vcsMonitor: VcsMonitor;
  private thinkMode: ThinkMode;
  private frecency: FrecencyTracker;
  private notifier: SessionNotifier;
  private promptStash: PromptStash;
  private gitWorktree: GitWorktreeManager;
  private sessionRecovery: SessionRecoveryManager;
  private backgroundAgent: BackgroundAgentManager;
  private todoContinuation: TodoContinuationEnforcer;
  private babysitter: UnstableBabysitter;
  private fastwork: FastworkMode;
  private ultrathink: UltrathinkMode;
  private questionTool: QuestionManager;
  private codeSearch: CodeSearchEngine;
  private webSearch: WebSearchEngine;
  private builtinCodeSearch: BuiltinCodeSearch;
  private statistics: StatisticsTracker;
  private contextInjector: ContextInjector;
  private sessionTools: SessionToolkit;
  private multiEdit: MultiEditTool;
  private batchTool: BatchToolExecutor;
  private retryBackoff: RetryWithBackoff;
  private rateLimitScheduler: RateLimitScheduler;
  private fallbackChain: AgentFallbackChain;
  private modelVariants: ModelVariantManager;
  private thinkingParser: InterleavedThinkingParser;
  private customCommands: CustomCommandLoader;
  private persistentTasks: PersistentTaskManager;
  private doctor: DoctorDiagnostics;
  private handoff_: HandoffGenerator;
  private github: GitHubIntegration;
  private acpServer: AcpServer;
  private sdkServer: SdkServer;
  private copilotAuth: CopilotAuth;
  private refactorEngine: RefactorEngine;
  private benchmarkRunner: BenchmarkRunner;
  private reportGenerator: ReportGenerator;
  private dlq: DeadLetterQueue;
  private stuckDetector: StuckDetector;
  private escalationManager: EscalationManager;
  private distributedTracer: DistributedTracer;
  private harnessEnforcer: HarnessEnforcer;
  private agentEnforcers: Map<string, HarnessEnforcer> = new Map();
  private ghostSha: string | null = null;
  private agentDepth = 0;
  private commitWatchers: Map<string, () => void> = new Map();
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.sessionManager = new SessionManager(config.orchestrator.sessionPrefix);
    this.scheduler = new PriorityScheduler(config.orchestrator.maxConcurrentAgents);
    this.registry = new AgentRegistry();
    this.logger = new Logger(config.orchestrator.logDir);
    this.tracer = new Tracer();
    this.worktree = new WorktreeManager(process.cwd());
    this.compressor = new ContextCompressor();
    this.sleepInhibitor = new SleepInhibitor();
    this.prewarmer = new ConnectionPrewarmer();
    this.recovery = new RecoveryManager();
    this.taskLogger = new TaskLogger();
    this.dynamicSecurity = new DynamicSecurityProfile();
    this.skillIndex = new SkillIndex();
    this.mcpManager = new McpClientManager();
    this.lspManager = new LspManager(process.cwd());
    this.gitSnapshots = new GitSnapshotManager(process.cwd());
    this.permissions = new PermissionManager(config.permissions);
    this.formatter = new AutoFormatter();
    this.customTools = new CustomToolLoader(process.cwd());
    this.fileWatcher = new FileWatcher(process.cwd());
    this.doomLoop = new DoomLoopDetector(config.doomLoop);
    this.themeManager = new ThemeManager(config.theme);
    this.modelRegistry = new ModelRegistry();
    this.pluginManager = new PluginManager(process.cwd());
    this.sessionSharer = new SessionSharer();
    this.oauthMcp = new OAuthMcpAuth(config.orchestrator.dataDir);
    this.astGrep = new AstGrep();
    this.inputHandler = new InputHandler();
    this.planningPipeline = new PlanningPipeline();
    this.boulderManager = new BoulderManager(process.cwd());
    this.notepadManager = new NotepadManager(process.cwd());
    this.commentChecker = new CommentChecker();
    this.ralphLoop = new RalphLoop();
    this.runtimeFallback = new RuntimeFallbackManager();
    this.tmuxViz = new TmuxVisualizer();
    this.intentGate = new IntentGate();
    this.categoryRouter = new CategoryRouter(config.categories);
    this.writeGuard = new WriteGuard();
    this.nonInteractiveGuard = new NonInteractiveGuard();
    this.toolTruncator = new ToolOutputTruncator();
    this.vcsMonitor = new VcsMonitor(process.cwd());
    this.thinkMode = new ThinkMode();
    this.frecency = new FrecencyTracker();
    this.notifier = new SessionNotifier();
    this.promptStash = new PromptStash();
    this.gitWorktree = new GitWorktreeManager(process.cwd());
    this.sessionRecovery = new SessionRecoveryManager();
    this.backgroundAgent = new BackgroundAgentManager();
    this.todoContinuation = new TodoContinuationEnforcer();
    this.babysitter = new UnstableBabysitter();
    this.fastwork = new FastworkMode();
    this.ultrathink = new UltrathinkMode();
    this.questionTool = new QuestionManager();
    this.codeSearch = new CodeSearchEngine();
    this.webSearch = new WebSearchEngine();
    this.builtinCodeSearch = new BuiltinCodeSearch();
    this.statistics = new StatisticsTracker();
    this.contextInjector = new ContextInjector();
    this.sessionTools = new SessionToolkit();
    this.multiEdit = new MultiEditTool();
    this.batchTool = new BatchToolExecutor();
    this.retryBackoff = new RetryWithBackoff();
    this.rateLimitScheduler = new RateLimitScheduler();
    this.fallbackChain = new AgentFallbackChain();
    this.modelVariants = new ModelVariantManager();
    this.thinkingParser = new InterleavedThinkingParser();
    this.customCommands = new CustomCommandLoader(process.cwd());
    this.persistentTasks = new PersistentTaskManager();
    this.doctor = new DoctorDiagnostics();
    this.handoff_ = new HandoffGenerator();
    this.github = new GitHubIntegration();
    this.acpServer = new AcpServer();
    this.sdkServer = new SdkServer();
    this.copilotAuth = new CopilotAuth();
    this.refactorEngine = new RefactorEngine(config.refactor);
    this.benchmarkRunner = new BenchmarkRunner({
      providers: Object.keys(config.providers ?? {}),
      harnessComparison: true,
      parallel: false,
      timeoutMs: 600_000,
      maxCostUsd: 5.0,
      evaluator: "auto",
    });
    this.reportGenerator = new ReportGenerator();
    this.dlq = new DeadLetterQueue();
    this.stuckDetector = new StuckDetector();
    this.escalationManager = new EscalationManager();
    this.distributedTracer = new DistributedTracer();
    this.harnessEnforcer = new HarnessEnforcer("coder");
    this.codebaseContent = new CodebaseContentCollector(process.cwd());
    this.accountManager = new AccountManager();
    this.health = new HealthChecker(config.orchestrator.sessionPrefix, async (status) => {
      this.logger.error(status.agentName, "", `Agent unhealthy: ${status.consecutiveFailures} consecutive failures`);
      if (status.consecutiveFailures >= 3) {
        try {
          await this.stopAgent(status.agentName);
          this.store.updateAgentStatus(status.agentName, "error");
        } catch { /* already dead */ }
      }
    });
  }

  async initialize(): Promise<void> {
    const db = initDb(this.config.orchestrator.db);
    this.db = db;
    this.store = new Store(db);
    this.ownership = new OwnershipManager(this.store);
    this.memory = new MemoryStore(db);
    this.consolidator = new MemoryConsolidator(this.store, this.memory);
    this.inbox = new Inbox(this.store, db);
    this.codemap = new CodebaseMap(db);
    this.codebaseScanner = new CodebaseScanner(process.cwd(), this.memory);
    this.contextBuilder = new ContextBuilder(this.memory, this.codemap, db);
    this.predictor = new TaskPredictor(this.memory, this.store);
    this.promptCache = new PromptCache(db);
    this.decisions = new DecisionRegistry(this.store);
    this.conflictWatcher = new ConflictWatcher(this.store);
    this.portManager = new PortManager(this.store);
    this.crashRecovery = new CrashRecovery(this.store);
    this.costEstimator = new CostEstimator(this.store);
    this.checkpointManager = new CheckpointManager(this.store, process.cwd());

    // Initialize Supervisor with TmuxWorkerStrategy (CLI/headless path)
    const tmuxStrategy = new TmuxWorkerStrategy(
      this.config,
      this.sessionManager,
      this.store,
      this.registry,
      (name) => this.spawnAgent(name),
      (name) => this.stopAgent(name),
    );

    this.supervisor = new Supervisor(
      {
        config: this.config,
        workerStrategy: tmuxStrategy,
        sessionManager: this.sessionManager,
        checkpointManager: this.checkpointManager,
        recoveryManager: this.recovery,
        contextBuilder: this.contextBuilder,
        inbox: this.inbox,
        compressor: this.compressor,
        store: this.store,
        conflictWatcher: this.conflictWatcher,
        ownership: this.ownership,
        profileContext: this.buildProfileContext(),
      },
      {
        workerTimeoutMs: this.config.supervisor?.workerTimeout ?? 300_000,
        maxRetries: this.config.supervisor?.maxRetries ?? 2,
        costAware: this.config.supervisor?.costAware ?? true,
        preferredProviders: this.config.supervisor?.preferredProviders ?? ["claude"],
      },
    );

    // Wire distributed tracer into supervisor
    this.supervisor.setTracer(this.distributedTracer);

    // Wire stuck detection human escalation to terminal notifications
    this.escalationManager.onHumanEscalation((event, actions) => {
      const title = "Orc: Worker Stuck";
      const body = `Worker ${event.workerId} stuck (${event.reason}) for ${Math.round(event.staleDurationMs / 1000)}s. ${event.suggestedAction}`;
      this.notifier.notify(title, body);
      // Terminal bell for immediate attention
      process.stdout.write("\x07");
    });

    // Wire DLQ: capture failed workers that have exhausted retries
    eventBus.on("worker:fail", (event) => {
      if (event.type !== "worker:fail") return;
      const pool = this.supervisor.getWorkerPool();
      const worker = pool.get(event.workerId);
      if (worker && !pool.canRetry(event.workerId)) {
        this.dlq.enqueue({
          taskId: worker.subtaskId,
          subtaskId: worker.subtaskId,
          workerId: worker.id,
          agentName: worker.agentName,
          provider: worker.provider,
          model: worker.model,
          prompt: "",
          error: event.error,
          reason: "max_retries_exceeded",
          attempts: worker.maxTurns,
          metadata: {
            tokenUsage: worker.tokenUsage,
            costUsd: worker.costUsd,
            turnHistory: worker.turnHistory.map(
              (t) => `turn ${t.currentTurn}: ${t.lastToolUse ?? "no tool"}`,
            ),
            corrections: worker.corrections,
            intermediateResults: worker.intermediateResults,
          },
        });
      }
    });

    // Wire DLQ: capture timeout events
    eventBus.on("worker:timeout", (event) => {
      if (event.type !== "worker:timeout") return;
      const pool = this.supervisor.getWorkerPool();
      const worker = pool.get(event.workerId);
      if (worker) {
        this.dlq.enqueue({
          taskId: worker.subtaskId,
          subtaskId: worker.subtaskId,
          workerId: worker.id,
          agentName: worker.agentName,
          provider: worker.provider,
          model: worker.model,
          prompt: "",
          error: worker.error ?? `Timed out after ${event.elapsedMs}ms`,
          reason: "timeout_exhausted",
          attempts: worker.currentTurn,
          metadata: {
            tokenUsage: worker.tokenUsage,
            costUsd: worker.costUsd,
            turnHistory: worker.turnHistory.map(
              (t) => `turn ${t.currentTurn}: ${t.lastToolUse ?? "no tool"}`,
            ),
            corrections: worker.corrections,
            intermediateResults: worker.intermediateResults,
          },
        });
      }
    });

    // Recover from any previous crash
    await this.crashRecovery.recoverFromCrash();

    // Bind signal handlers for graceful shutdown
    this.crashRecovery.bindSignalHandlers(() => this.shutdown());

    this.inbox.on("message", async ({ to, message }: { to: string; message: { from: string; content: string } }) => {
      const session = this.sessionManager.getSession(to);
      if (session) {
        await this.sessionManager.sendInput(to, `[Message from ${message.from}]: ${message.content}`);
      }
    });

    // Initialize tree-sitter bash parser for safety classification (non-blocking)
    try {
      await initParser();
    } catch {
      // Parser init is optional — regex fallback is always available
    }

    // Scan skills index for dynamic task-based matching
    await this.skillIndex.scan([
      join(process.cwd(), ".claude", "skills"),
      join(homedir(), ".claude", "skills"),
    ]);

    // Connect to configured MCP servers
    if (this.config.mcp?.servers && Object.keys(this.config.mcp.servers).length > 0) {
      await this.mcpManager.connect(this.config.mcp);
    }

    const profileDir = `${this.config.orchestrator.dataDir}/profiles`;
    try {
      await this.registry.loadProfiles(profileDir);
    } catch {
      // profiles directory may not exist yet
    }

    this.health.start();

    // Detect available formatters for auto-formatting
    await this.formatter.detect(process.cwd());

    // Load custom user-defined tools
    await this.customTools.loadAll();

    // Load custom themes from user dir
    await this.themeManager.loadFromDir(`${this.config.orchestrator.dataDir}/themes`);

    // Load user plugins
    await this.pluginManager.loadAll();

    // Load saved notepads from disk
    await this.notepadManager.loadAll();

    // Start file watcher for external change detection
    this.fileWatcher.on("change", (event: import("./file-watcher.ts").FileChangeEvent) => {
      eventBus.publish({ type: "file:change", file: event.file, changeType: event.type });
    });
    this.fileWatcher.start();

    // Install commit-msg hook to enforce co-author tag on all commits
    await installCommitHook(process.cwd()).catch(() => {});

    // Ghost commit: snapshot working tree at session start
    this.ghostSha = await createGhostCommit("orc session start");

    // Background memory consolidation
    if (this.consolidator.shouldConsolidate()) {
      this.consolidator.consolidate().catch(() => {});
    }

    // Wire SDK server message handler
    this.sdkServer.onMessage(async (_sessionId: string, content: string) => {
      const task = await this.handoff("coder", content, { waitForCompletion: true, timeout: 120_000 });
      return task.result ?? "Task completed without output.";
    });

    // Wire ACP server message handler
    this.acpServer.onMessage(async (_sessionId: string, content: string) => {
      const task = await this.handoff("coder", content, { waitForCompletion: true, timeout: 120_000 });
      return task.result ?? "Task completed without output.";
    });

    // Wire ACP cancel handler
    this.acpServer.onCancel(async (_sessionId: string) => {
      // Cancel all running tasks for this session
      const running = this.store.listTasks({ status: "running" });
      for (const task of running) {
        if (task.agentName) {
          await this.stopAgent(task.agentName).catch(() => {});
          this.store.updateTask(task.id, { status: "failed", result: "Cancelled by user" });
        }
      }
      return running.length > 0;
    });

    // Wire ACP IDE integration handlers
    this.acpServer.onDiagnostics(async (filePath: string) => {
      const diagnostics = await this.lspManager.getDiagnostics(filePath);
      return diagnostics.map((d) => ({
        line: d.line,
        message: d.message,
        severity: d.severity,
      }));
    });

    this.acpServer.onSymbols(async (filePath: string) => {
      const symbols = await this.lspManager.documentSymbols(filePath);
      return symbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        line: s.line,
      }));
    });

    this.acpServer.onAgentList(async () => {
      return this.registry.list().map((p) => ({
        name: p.name,
        description: p.role ?? "",
      }));
    });

    this.acpServer.onAgentSwitch(async (name: string) => {
      return this.registry.get(name) !== undefined;
    });

    this.acpServer.onModelList(async () => {
      return this.modelRegistry.list().map((m) => ({
        name: m.id,
        description: m.provider,
      }));
    });

    this.acpServer.onModelSwitch(async (name: string) => {
      return this.modelRegistry.get(name) !== undefined;
    });

    // Wire refactor engine executor
    this.refactorEngine.onExecute(async (plan: string, files: string[]) => {
      const fileList = files.map((f) => relative(process.cwd(), f)).join(", ");
      const prompt = [
        "Apply the following refactoring plan. Only modify these files:",
        fileList,
        "",
        plan,
      ].join("\n");
      const task = await this.handoff("coder", prompt, { waitForCompletion: true, timeout: 300_000 });
      if (task.status === "failed") {
        throw new Error(task.result ?? "Refactoring execution failed");
      }
      return files;
    });
  }

  async spawnAgent(profileName: string): Promise<SessionInfo> {
    // Agent depth limit to prevent infinite recursion
    if (this.agentDepth >= MAX_AGENT_DEPTH) {
      throw new Error(`Agent nesting depth exceeded (max ${MAX_AGENT_DEPTH})`);
    }
    this.agentDepth++;

    const profile = this.registry.get(profileName);
    if (!profile) {
      this.agentDepth--;
      throw new Error(`Unknown agent profile: "${profileName}"`);
    }

    const preflight = await checkRequirements(profile.requires);
    if (!preflight.passed) {
      const failed = preflight.checks
        .filter((c) => !c.available)
        .map((c) => c.tool)
        .join(", ");
      throw new Error(`Preflight failed for "${profileName}": missing ${failed}`);
    }

    const providerConfig = this.config.providers[profile.provider];
    if (!providerConfig) {
      throw new Error(`Unknown provider: "${profile.provider}"`);
    }

    const systemPrompt = appendGlobalRules(profile.systemPrompt);

    const command = buildCommand(providerConfig, profile, {
      prompt: systemPrompt,
      model: profile.model,
      systemPrompt,
      workdir: process.cwd(),
    });

    const session = await this.sessionManager.spawnSession(profile, command.join(" "));

    this.store.registerAgent(profile.name, profile.provider, profile.model);
    this.store.updateAgentStatus(profile.name, "running");
    this.health.registerAgent(profile.name);

    // Create per-agent HarnessEnforcer with correct role
    const agentEnforcer = new HarnessEnforcer(profile.role ?? "coder");
    this.agentEnforcers.set(profile.name, agentEnforcer);

    if (profile.worktree) {
      const taskId = crypto.randomUUID();
      await this.worktree.create(profile.name, taskId);
    }

    // Start periodic commit watcher for this agent
    const watchCwd = profile.worktree
      ? (await this.worktree.list()).find((w) => w.agentName === profile.name)?.path ?? process.cwd()
      : process.cwd();
    const stopWatcher = startCommitWatcher(profile.name, watchCwd, (result) => {
      this.logger.log({
        ts: new Date().toISOString(),
        agent: profile.name,
        task: "",
        event: "auto_commit",
        data: { hash: result.hash, message: result.message },
      });
    });
    this.commitWatchers.set(profile.name, stopWatcher);

    this.logger.log({
      ts: new Date().toISOString(),
      agent: profile.name,
      task: "",
      event: "session_created",
      data: { session: session.name },
    });

    return session;
  }

  async stopAgent(agentName: string): Promise<void> {
    this.agentDepth = Math.max(0, this.agentDepth - 1);
    await this.sessionManager.destroySession(agentName);

    // Stop the periodic commit watcher for this agent
    const stopWatcher = this.commitWatchers.get(agentName);
    if (stopWatcher) {
      stopWatcher();
      this.commitWatchers.delete(agentName);
    }

    // Final auto-commit for any remaining uncommitted changes
    const worktrees = await this.worktree.list();
    const agentWorktree = worktrees.find((w) => w.agentName === agentName);
    const commitCwd = agentWorktree?.path ?? process.cwd();

    const commitResult = await autoCommit(agentName, commitCwd);
    if (commitResult.committed) {
      this.logger.log({
        ts: new Date().toISOString(),
        agent: agentName,
        task: "",
        event: "auto_commit",
        data: { hash: commitResult.hash, message: commitResult.message },
      });
    }

    this.store.unlockByAgent(agentName);
    this.ownership.release(agentName);
    await this.worktree.removeByAgent(agentName);
    this.agentEnforcers.delete(agentName);
    this.store.updateAgentStatus(agentName, "terminated");
    this.health.unregisterAgent(agentName);

    this.logger.log({
      ts: new Date().toISOString(),
      agent: agentName,
      task: "",
      event: "session_destroyed",
    });
  }

  async handoff(
    agentName: string,
    prompt: string,
    options?: HandoffOptions,
  ): Promise<Task> {
    // Cost-aware routing: estimate before deciding single vs multi
    const costEstimate = this.costEstimator.estimate(prompt);
    eventBus.publish({
      type: "cost:estimate",
      recommendation: costEstimate.recommendation,
      singleCost: costEstimate.singleAgent.estimatedCostUsd,
      multiCost: costEstimate.multiAgent.estimatedCostUsd,
    });

    const route = routeTask(prompt, this.config.routing, { costEstimate });

    const taskId = crypto.randomUUID();
    this.store.createTask({
      id: taskId,
      prompt,
      tier: route.model,
    });

    if (route.multiAgent) {
      this.store.updateTask(taskId, { status: "running", startedAt: new Date().toISOString() });

      // Use Supervisor for intelligent multi-agent orchestration
      const aggregated = await this.supervisor.execute(taskId, prompt);

      this.store.updateTask(taskId, {
        status: aggregated.success ? "completed" : "failed",
        result: aggregated.mergedOutput,
        tokenUsage: aggregated.totalTokens,
        costUsd: aggregated.totalCost,
        completedAt: new Date().toISOString(),
      });

      return this.store.getTask(taskId)!;
    }

    this.store.updateTask(taskId, {
      agentName,
      status: "assigned",
      startedAt: new Date().toISOString(),
    });

    const task = this.store.getTask(taskId)!;
    const span = this.tracer.startSpan(taskId, agentName, taskId);

    await this.scheduler.acquire(task);

    try {
      const session = this.sessionManager.getSession(agentName);
      if (!session) {
        await this.spawnAgent(agentName);
      }

      this.logger.taskStart(agentName, taskId);
      await this.sessionManager.sendInput(agentName, prompt);

      this.store.updateTask(taskId, { status: "running" });

      if (options?.waitForCompletion) {
        const timeout = options.timeout ?? 300_000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
          const current = this.store.getTask(taskId);
          if (
            current &&
            (current.status === "completed" || current.status === "failed")
          ) {
            // Auto-continue if agent finished with remaining TODOs
            if (current.status === "completed" && current.result) {
              // Check output quality via per-agent enforcer
              const enforcer = this.agentEnforcers.get(agentName);
              if (enforcer) {
                const outputCheck = enforcer.checkOutput(current.result);
                if (outputCheck.injection) {
                  this.store.updateTask(taskId, { status: "running" });
                  await this.sessionManager.sendInput(agentName, outputCheck.injection);
                  continue;
                }
              }

              if (this.todoContinuation.shouldContinue(current.result)) {
                const detection = this.todoContinuation.detect(current.result);
                const continuationPrompt = this.todoContinuation.buildContinuationPrompt(detection);
                this.todoContinuation.recordContinuation();
                this.store.updateTask(taskId, { status: "running" });
                await this.sessionManager.sendInput(agentName, continuationPrompt);
                continue;
              }
            }

            this.tracer.endSpan(
              span.spanId,
              current.status === "completed" ? "completed" : "error",
            );
            return current;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }

        this.store.updateTask(taskId, { status: "failed", result: "Timed out" });
        this.tracer.endSpan(span.spanId, "error");
      }
    } finally {
      this.scheduler.release(taskId);
    }

    return this.store.getTask(taskId)!;
  }

  async assign(
    agentName: string,
    prompt: string,
    options?: AssignOptions,
  ): Promise<string> {
    const task = await this.handoff(agentName, prompt, {
      waitForCompletion: false,
      timeout: options?.timeout,
    });
    return task.id;
  }

  async sendMessage(
    from: string,
    to: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    let finalContent = content;
    if (content.length > 5000) {
      const compressed = this.compressor.compress(content);
      finalContent = compressed.summary;
    }

    const msgId = crypto.randomUUID();
    this.store.addMessage({
      id: msgId,
      from,
      to,
      content: finalContent,
      taskRef: options?.taskRef,
    });

    const session = this.sessionManager.getSession(to);
    if (session) {
      await this.sessionManager.sendInput(to, `[Message from ${from}]: ${finalContent}`);
    }
  }

  async getTaskStatus(taskId: string): Promise<Task | null> {
    return this.store.getTask(taskId);
  }

  async listAgents(): Promise<
    Array<{ name: string; status: string; currentTask?: string }>
  > {
    const agents = this.store.listAgents();
    return agents.map((agent) => {
      const tasks = this.store.listTasks({
        agentName: agent.name,
        status: "running",
      });
      return {
        name: agent.name,
        status: agent.status,
        currentTask: tasks[0]?.id,
      };
    });
  }

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  getSkillIndex(): SkillIndex {
    return this.skillIndex;
  }

  getMcpManager(): McpClientManager {
    return this.mcpManager;
  }

  getConfig(): OrchestratorConfig {
    return this.config;
  }

  getOwnership(): OwnershipManager {
    return this.ownership;
  }

  getWorktree(): WorktreeManager {
    return this.worktree;
  }

  getInbox(): Inbox {
    return this.inbox;
  }

  getTracer(): Tracer {
    return this.tracer;
  }

  getScheduler(): PriorityScheduler {
    return this.scheduler;
  }

  getHealth(): HealthChecker {
    return this.health;
  }

  getStore(): Store {
    return this.store;
  }

  getMemory(): MemoryStore {
    return this.memory;
  }

  getConsolidator(): MemoryConsolidator {
    return this.consolidator;
  }

  getSleepInhibitor(): SleepInhibitor {
    return this.sleepInhibitor;
  }

  getPrewarmer(): ConnectionPrewarmer {
    return this.prewarmer;
  }

  getEventBus() {
    return eventBus;
  }

  getGhostSha(): string | null {
    return this.ghostSha;
  }

  getRecovery(): RecoveryManager {
    return this.recovery;
  }

  getTaskLogger(): TaskLogger {
    return this.taskLogger;
  }

  getCodebaseMap(): CodebaseMap {
    return this.codemap;
  }

  getCodebaseScanner(): CodebaseScanner {
    return this.codebaseScanner;
  }

  getCodebaseContent(): CodebaseContentCollector {
    return this.codebaseContent;
  }

  getContextBuilder(): ContextBuilder {
    return this.contextBuilder;
  }

  getDynamicSecurity(): DynamicSecurityProfile {
    return this.dynamicSecurity;
  }

  getAccountManager(): AccountManager {
    return this.accountManager;
  }

  getPredictor(): TaskPredictor {
    return this.predictor;
  }

  getPromptCache(): PromptCache {
    return this.promptCache;
  }

  getDecisions(): DecisionRegistry {
    return this.decisions;
  }

  getConflictWatcher(): ConflictWatcher {
    return this.conflictWatcher;
  }

  getPortManager(): PortManager {
    return this.portManager;
  }

  getCrashRecovery(): CrashRecovery {
    return this.crashRecovery;
  }

  getCostEstimator(): CostEstimator {
    return this.costEstimator;
  }

  getCheckpointManager(): CheckpointManager {
    return this.checkpointManager;
  }

  getSupervisor(): Supervisor {
    return this.supervisor;
  }

  /**
   * Execute a multi-agent task using the Supervisor pipeline with AgentStreamer
   * workers (subprocess-based, suitable for REPL with real-time streaming).
   * This activates the full pipeline: decompose → context propagation →
   * feedback loop → quality gate → QA → conflict resolution.
   */
  async executeWithSupervisor(
    prompt: string,
  ): Promise<import("../config/types.ts").AggregatedResult> {
    const taskId = `repl-${Date.now().toString(36)}`;
    this.store.createTask({ id: taskId, prompt, tier: "sonnet" });
    this.store.updateTask(taskId, { status: "running", startedAt: new Date().toISOString() });

    const streamerStrategy = new StreamerWorkerStrategy(this.config, this.registry, this.store);

    const supervisor = new Supervisor(
      {
        config: this.config,
        workerStrategy: streamerStrategy,
        sessionManager: this.sessionManager,
        checkpointManager: this.checkpointManager,
        recoveryManager: this.recovery,
        contextBuilder: this.contextBuilder,
        inbox: this.inbox,
        compressor: this.compressor,
        store: this.store,
        conflictWatcher: this.conflictWatcher,
        ownership: this.ownership,
      },
      {
        workerTimeoutMs: this.config.supervisor?.workerTimeout ?? 300_000,
        maxRetries: this.config.supervisor?.maxRetries ?? 2,
        costAware: this.config.supervisor?.costAware ?? true,
        preferredProviders: this.config.supervisor?.preferredProviders ?? ["claude"],
      },
    );

    supervisor.setTracer(this.distributedTracer);
    return supervisor.execute(taskId, prompt);
  }

  /**
   * Cancel a running worker by its worker ID (supports partial ID matching).
   * Stops monitoring, kills the session, and marks as cancelled.
   */
  async cancelWorker(workerId: string, reason: string): Promise<boolean> {
    return this.supervisor.cancelWorker(workerId, reason);
  }

  /**
   * Cancel all active workers.
   * Returns the number of workers cancelled.
   */
  async cancelAllWorkers(reason: string): Promise<number> {
    return this.supervisor.cancelAll(reason);
  }

  getWorkerBus(): WorkerBus {
    return this.supervisor.getWorkerBus();
  }

  getCompressor(): ContextCompressor {
    return this.compressor;
  }

  getLspManager(): LspManager {
    return this.lspManager;
  }

  getGitSnapshots(): GitSnapshotManager {
    return this.gitSnapshots;
  }

  getPermissions(): PermissionManager {
    return this.permissions;
  }

  getFormatter(): AutoFormatter {
    return this.formatter;
  }

  getCustomTools(): CustomToolLoader {
    return this.customTools;
  }

  getFileWatcher(): FileWatcher {
    return this.fileWatcher;
  }

  getDoomLoop(): DoomLoopDetector {
    return this.doomLoop;
  }

  getThemeManager(): ThemeManager {
    return this.themeManager;
  }

  getModelRegistry(): ModelRegistry {
    return this.modelRegistry;
  }

  getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  getSessionSharer(): SessionSharer {
    return this.sessionSharer;
  }

  getOAuthMcp(): OAuthMcpAuth {
    return this.oauthMcp;
  }

  getAstGrep(): AstGrep {
    return this.astGrep;
  }

  getInputHandler(): InputHandler {
    return this.inputHandler;
  }

  getPlanningPipeline(): PlanningPipeline {
    return this.planningPipeline;
  }

  getBoulderManager(): BoulderManager {
    return this.boulderManager;
  }

  getNotepadManager(): NotepadManager {
    return this.notepadManager;
  }

  getCommentChecker(): CommentChecker {
    return this.commentChecker;
  }

  getRalphLoop(): RalphLoop {
    return this.ralphLoop;
  }

  getRuntimeFallback(): RuntimeFallbackManager {
    return this.runtimeFallback;
  }

  getTmuxViz(): TmuxVisualizer {
    return this.tmuxViz;
  }

  getIntentGate(): IntentGate {
    return this.intentGate;
  }

  getCategoryRouter(): CategoryRouter {
    return this.categoryRouter;
  }

  getWriteGuard(): WriteGuard {
    return this.writeGuard;
  }

  getNonInteractiveGuard(): NonInteractiveGuard {
    return this.nonInteractiveGuard;
  }

  getToolTruncator(): ToolOutputTruncator {
    return this.toolTruncator;
  }

  getVcsMonitor(): VcsMonitor {
    return this.vcsMonitor;
  }

  getThinkMode(): ThinkMode {
    return this.thinkMode;
  }

  getFrecency(): FrecencyTracker {
    return this.frecency;
  }

  getNotifier(): SessionNotifier {
    return this.notifier;
  }

  getPromptStash(): PromptStash {
    return this.promptStash;
  }

  getGitWorktree(): GitWorktreeManager {
    return this.gitWorktree;
  }

  getSessionRecovery(): SessionRecoveryManager {
    return this.sessionRecovery;
  }

  getBackgroundAgent(): BackgroundAgentManager {
    return this.backgroundAgent;
  }

  getTodoContinuation(): TodoContinuationEnforcer {
    return this.todoContinuation;
  }

  getBabysitter(): UnstableBabysitter {
    return this.babysitter;
  }

  getFastwork(): FastworkMode {
    return this.fastwork;
  }

  getUltrathink(): UltrathinkMode {
    return this.ultrathink;
  }

  getQuestionTool(): QuestionManager {
    return this.questionTool;
  }

  getCodeSearch(): CodeSearchEngine {
    return this.codeSearch;
  }

  getWebSearch(): WebSearchEngine {
    return this.webSearch;
  }

  getBuiltinCodeSearch(): BuiltinCodeSearch {
    return this.builtinCodeSearch;
  }

  getStatistics(): StatisticsTracker {
    return this.statistics;
  }

  getContextInjector(): ContextInjector {
    return this.contextInjector;
  }

  getSessionTools(): SessionToolkit {
    return this.sessionTools;
  }

  getMultiEdit(): MultiEditTool {
    return this.multiEdit;
  }

  getBatchTool(): BatchToolExecutor {
    return this.batchTool;
  }

  getRetryBackoff(): RetryWithBackoff {
    return this.retryBackoff;
  }

  getRateLimitScheduler(): RateLimitScheduler {
    return this.rateLimitScheduler;
  }

  getFallbackChain(): AgentFallbackChain {
    return this.fallbackChain;
  }

  getModelVariants(): ModelVariantManager {
    return this.modelVariants;
  }

  getThinkingParser(): InterleavedThinkingParser {
    return this.thinkingParser;
  }

  getCustomCommands(): CustomCommandLoader {
    return this.customCommands;
  }

  getPersistentTasks(): PersistentTaskManager {
    return this.persistentTasks;
  }

  getDoctor(): DoctorDiagnostics {
    return this.doctor;
  }

  getHandoffGenerator(): HandoffGenerator {
    return this.handoff_;
  }

  getGitHub(): GitHubIntegration {
    return this.github;
  }

  getAcpServer(): AcpServer {
    return this.acpServer;
  }

  getSdkServer(): SdkServer {
    return this.sdkServer;
  }

  getCopilotAuth(): CopilotAuth {
    return this.copilotAuth;
  }

  getRefactorEngine(): RefactorEngine {
    return this.refactorEngine;
  }

  getStuckDetector(): StuckDetector {
    return this.stuckDetector;
  }

  getEscalationManager(): EscalationManager {
    return this.escalationManager;
  }

  getDistributedTracer(): DistributedTracer {
    return this.distributedTracer;
  }

  getDeadLetterQueue(): DeadLetterQueue {
    return this.dlq;
  }

  getBenchmarkRunner(): BenchmarkRunner {
    return this.benchmarkRunner;
  }

  getReportGenerator(): ReportGenerator {
    return this.reportGenerator;
  }

  getHarnessEnforcer(): HarnessEnforcer {
    return this.harnessEnforcer;
  }

  getAgentEnforcer(agentName: string): HarnessEnforcer | undefined {
    return this.agentEnforcers.get(agentName);
  }

  async shutdown(): Promise<void> {
    // Stop all commit watchers
    for (const stop of this.commitWatchers.values()) stop();
    this.commitWatchers.clear();

    this.fileWatcher.stop();
    this.vcsMonitor.stop();
    this.gitWorktree.cleanupAll().catch(() => {});
    await this.statistics.flush().catch(() => {});
    await this.tmuxViz.cleanup().catch(() => {});
    await this.pluginManager.emit("session:end", { data: {}, projectDir: process.cwd() }).catch(() => {});
    await this.lspManager.shutdownAll();
    this.checkpointManager.stopAll();
    this.health.stop();
    this.sleepInhibitor.release();
    this.prewarmer.cancel();
    await this.sessionManager.destroyAll();
    await this.worktree.cleanup();
    this.compressor.clear();

    const agents = this.store.listAgents();
    for (const agent of agents) {
      if (agent.status !== "terminated") {
        this.store.updateAgentStatus(agent.name, "terminated");
      }
    }

    this.rateLimitScheduler.clear();
    this.scheduler.clear();
    await this.mcpManager.disconnect();
  }
}

// ── Global rules injected into every agent's system prompt ──────────────

const GLOBAL_COMMIT_RULES = `

## Commit Rules (Global)

- Commit atomically after each logical unit of work. Do NOT batch — commit as you go.
- Karma convention: \`<type>: <subject>\` (feat, fix, refactor, test, docs, chore). Lowercase, imperative, no period.
- One logical change per commit.
- Always add: \`Co-Authored-By: orc-agent <hello@sson.tech>\`
- Push after each commit.
- You are responsible for your own commits. Do NOT delegate to other agents.
- If you finish without committing, the orchestrator will auto-commit your changes. Prefer committing yourself for better messages.`;

function appendGlobalRules(systemPrompt: string): string {
  return systemPrompt + GLOBAL_COMMIT_RULES;
}
