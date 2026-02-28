import { join } from "node:path";
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
import { Scheduler } from "./scheduler.ts";
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
import { ContextBuilder } from "../memory/context-builder.ts";
import { DynamicSecurityProfile } from "../sandbox/dynamic-profile.ts";
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
import { McpClientManager } from "../mcp/client-manager.ts";
import { LspManager } from "../lsp/index.ts";
import { GitSnapshotManager } from "./git-snapshot.ts";
import { PermissionManager } from "./permissions.ts";
import { HashlineEditor } from "./hashline.ts";
import type { WorkerBus } from "./worker-bus.ts";
import type { SubTask } from "../config/types.ts";
import type { Database } from "bun:sqlite";

const MAX_AGENT_DEPTH = 5;

export class Orchestrator {
  private sessionManager: SessionManager;
  private store!: Store;
  private db!: Database;
  private ownership!: OwnershipManager;
  private worktree: WorktreeManager;
  private inbox!: Inbox;
  private compressor: ContextCompressor;
  private scheduler: Scheduler;
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
  private ghostSha: string | null = null;
  private agentDepth = 0;
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.sessionManager = new SessionManager(config.orchestrator.sessionPrefix);
    this.scheduler = new Scheduler(config.orchestrator.maxConcurrentAgents);
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
    this.contextBuilder = new ContextBuilder(this.memory, this.codemap, db);
    this.predictor = new TaskPredictor(this.memory, this.store);
    this.promptCache = new PromptCache(db);
    this.decisions = new DecisionRegistry(this.store);
    this.conflictWatcher = new ConflictWatcher(this.store);
    this.portManager = new PortManager(this.store);
    this.crashRecovery = new CrashRecovery(this.store);
    this.costEstimator = new CostEstimator(this.store);
    this.checkpointManager = new CheckpointManager(this.store, process.cwd());

    // Initialize Supervisor with dependency injection (avoids circular import)
    this.supervisor = new Supervisor(
      {
        config: this.config,
        spawnWorker: async (subtask: SubTask, maxTurns: number, enrichedPrompt: string) => {
          const agentName = `worker-${subtask.id.slice(0, 8)}`;
          const providerConfig = this.config.providers[subtask.provider];
          if (!providerConfig) throw new Error(`Unknown provider: ${subtask.provider}`);

          const harness = buildHarness({
            agentName,
            role: subtask.agentRole,
            provider: subtask.provider,
            parentTaskId: subtask.parentTaskId,
            isWorker: true,
          });

          const profile: import("../config/types.ts").AgentProfile = {
            name: agentName,
            provider: subtask.provider,
            model: subtask.model,
            role: subtask.agentRole,
            maxBudgetUsd: this.config.budget.defaultMaxPerTask,
            requires: [],
            worktree: false,
            systemPrompt: harness.systemPrompt,
            maxTurns,
          };

          this.registry.register(profile);
          const session = await this.spawnAgent(agentName);

          await this.sessionManager.sendInput(agentName, enrichedPrompt);

          return { agentName, sessionId: session.name };
        },
        waitForResult: async (agentName: string, timeoutMs: number) => {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            const tasks = this.store.listTasks({ agentName, status: "completed" });
            if (tasks.length > 0) {
              const t = tasks[0];
              return { result: t.result ?? "", tokenUsage: t.tokenUsage, costUsd: t.costUsd };
            }
            const failed = this.store.listTasks({ agentName, status: "failed" });
            if (failed.length > 0) {
              throw new Error(failed[0].result ?? "Task failed");
            }
            await new Promise(r => setTimeout(r, 2000));
          }
          return null;
        },
        stopWorker: async (agentName: string) => {
          await this.stopAgent(agentName);
        },
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
        preferredProviders: this.config.supervisor?.preferredProviders ?? ["claude", "codex", "gemini", "kiro"],
      },
    );

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

    // Ghost commit: snapshot working tree at session start
    this.ghostSha = await createGhostCommit("orc session start");

    // Background memory consolidation
    if (this.consolidator.shouldConsolidate()) {
      this.consolidator.consolidate().catch(() => {});
    }
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

    const command = buildCommand(providerConfig, profile, {
      prompt: profile.systemPrompt,
      model: profile.model,
      systemPrompt: profile.systemPrompt,
      maxTurns: profile.maxTurns,
    });

    const session = await this.sessionManager.spawnSession(profile, command.join(" "));

    this.store.registerAgent(profile.name, profile.provider, profile.model);
    this.store.updateAgentStatus(profile.name, "running");
    this.health.registerAgent(profile.name);

    if (profile.worktree) {
      const taskId = crypto.randomUUID();
      await this.worktree.create(profile.name, taskId);
    }

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
    this.store.unlockByAgent(agentName);
    this.ownership.release(agentName);
    await this.worktree.removeByAgent(agentName);
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

  getScheduler(): Scheduler {
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

  async shutdown(): Promise<void> {
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

    this.scheduler.clear();
    await this.mcpManager.disconnect();
  }
}
