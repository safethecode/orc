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

export class Orchestrator {
  private sessionManager: SessionManager;
  private store!: Store;
  private budget!: BudgetController;
  private scheduler: Scheduler;
  private registry: AgentRegistry;
  private logger: Logger;
  private tracer: Tracer;
  private health: HealthChecker;
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.sessionManager = new SessionManager(config.orchestrator.sessionPrefix);
    this.scheduler = new Scheduler(config.orchestrator.maxConcurrentAgents);
    this.registry = new AgentRegistry();
    this.logger = new Logger(config.orchestrator.logDir);
    this.tracer = new Tracer();
    this.health = new HealthChecker(config.orchestrator.sessionPrefix, (status) => {
      this.logger.error(status.agentName, "", `Agent unhealthy: ${status.consecutiveFailures} consecutive failures`);
    });
  }

  async initialize(): Promise<void> {
    const db = initDb(this.config.orchestrator.db);
    this.store = new Store(db);
    this.budget = new BudgetController(this.store, this.config.budget);

    const profileDir = `${this.config.orchestrator.dataDir}/profiles`;
    try {
      await this.registry.loadProfiles(profileDir);
    } catch {
      // profiles directory may not exist yet
    }

    this.health.start();
  }

  async spawnAgent(profileName: string): Promise<SessionInfo> {
    const profile = this.registry.get(profileName);
    if (!profile) {
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
    await this.sessionManager.destroySession(agentName);
    this.store.unlockByAgent(agentName);
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
    const msgId = crypto.randomUUID();
    this.store.addMessage({
      id: msgId,
      from,
      to,
      content,
      taskRef: options?.taskRef,
    });

    const session = this.sessionManager.getSession(to);
    if (session) {
      await this.sessionManager.sendInput(to, `[Message from ${from}]: ${content}`);
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

  async shutdown(): Promise<void> {
    this.health.stop();
    await this.sessionManager.destroyAll();

    const agents = this.store.listAgents();
    for (const agent of agents) {
      if (agent.status !== "terminated") {
        this.store.updateAgentStatus(agent.name, "terminated");
      }
    }

    this.scheduler.clear();
  }
}
