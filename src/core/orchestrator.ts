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
import { BudgetController } from "./budget.ts";
import { routeTask, suggestAgent } from "./router.ts";
import { Scheduler } from "./scheduler.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { buildCommand } from "../agents/provider.ts";
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
import type { Database } from "bun:sqlite";

const MAX_AGENT_DEPTH = 5;

export class Orchestrator {
  private sessionManager: SessionManager;
  private store!: Store;
  private db!: Database;
  private budget!: BudgetController;
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
    this.budget = new BudgetController(this.store, this.config.budget);
    this.ownership = new OwnershipManager(this.store);
    this.memory = new MemoryStore(db);
    this.consolidator = new MemoryConsolidator(this.store, this.memory);
    this.inbox = new Inbox(this.store, db);

    this.inbox.on("message", async ({ to, message }: { to: string; message: { from: string; content: string } }) => {
      const session = this.sessionManager.getSession(to);
      if (session) {
        await this.sessionManager.sendInput(to, `[Message from ${message.from}]: ${message.content}`);
      }
    });

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
      maxBudgetUsd: profile.maxBudgetUsd,
      systemPrompt: profile.systemPrompt,
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
    const route = routeTask(prompt, this.config.routing);

    const profile = this.registry.get(agentName);
    const agentLimit = profile?.maxBudgetUsd ?? this.config.budget.defaultMaxPerTask;
    const budgetCheck = this.budget.canProceed(agentName, agentLimit);
    if (!budgetCheck.allowed) {
      throw new Error(`Budget exceeded: ${budgetCheck.reason}`);
    }
    if (budgetCheck.reason) {
      this.logger.budgetWarning(agentName, "", agentLimit, agentLimit);
    }

    const taskId = crypto.randomUUID();
    this.store.createTask({
      id: taskId,
      prompt,
      tier: route.model,
    });

    if (route.multiAgent) {
      const subTaskIds = await this.decomposeTask(prompt, taskId);
      for (const subId of subTaskIds) {
        const subTask = this.store.getTask(subId)!;
        const subRoute = routeTask(subTask.prompt, this.config.routing);
        const subAgent = suggestAgent(subRoute.tier);
        await this.assign(subAgent, subTask.prompt);
      }
      this.store.updateTask(taskId, { status: "running", startedAt: new Date().toISOString() });
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
            if (current.tokenUsage > 0 || current.costUsd > 0) {
              this.budget.recordUsage(agentName, taskId, current.tokenUsage, current.costUsd);
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

  getBudget(): BudgetController {
    return this.budget;
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

  private async decomposeTask(prompt: string, parentTaskId: string): Promise<string[]> {
    const parts = prompt
      .split(/\b(?:and then|after that|then have|followed by|once done)\b/i)
      .map((p) => p.trim())
      .filter(Boolean);

    const taskIds: string[] = [];
    for (const part of parts) {
      const route = routeTask(part, this.config.routing);
      const taskId = crypto.randomUUID();
      this.store.createTask({ id: taskId, prompt: part, tier: route.model, parentTaskId });
      taskIds.push(taskId);
    }
    return taskIds;
  }

  async shutdown(): Promise<void> {
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
  }
}
