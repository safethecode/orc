import type {
  SubTask,
  DecompositionResult,
  AggregatedResult,
  ExecutionPlan,
  TaskStatus,
  ProviderName,
  ProviderCapability,
  WorkerState,
  OrchestratorConfig,
  MultiTurnConfig,
  FeedbackLoopConfig,
} from "../config/types.ts";
import type { SessionManager } from "../session/manager.ts";
import type { CheckpointManager } from "./checkpoint.ts";
import type { RecoveryManager } from "./recovery.ts";
import type { BudgetController } from "./budget.ts";
import type { ConflictWatcher } from "./watcher.ts";
import type { OwnershipManager } from "./ownership.ts";
import type { ContextBuilder } from "../memory/context-builder.ts";
import type { Inbox } from "../messaging/inbox.ts";
import type { ContextCompressor } from "../messaging/context-compressor.ts";
import type { Store } from "../db/store.ts";
import { decompose, detectDomains } from "./decomposer.ts";
import { ProviderSelector } from "./provider-selector.ts";
import { WorkerPool } from "./worker-pool.ts";
import { ResultCollector } from "./result-collector.ts";
import { WorkerBus } from "./worker-bus.ts";
import { ContextPropagator } from "./context-propagator.ts";
import { FeedbackLoop } from "./feedback-loop.ts";
import { eventBus } from "./events.ts";

export interface SupervisorDeps {
  config: OrchestratorConfig;
  spawnWorker: (subtask: SubTask, maxTurns: number, enrichedPrompt: string) => Promise<{ agentName: string; sessionId: string }>;
  waitForResult: (agentName: string, timeoutMs: number) => Promise<{ result: string; tokenUsage: number; costUsd: number } | null>;
  stopWorker: (agentName: string) => Promise<void>;
  sessionManager: SessionManager;
  checkpointManager: CheckpointManager;
  recoveryManager: RecoveryManager;
  contextBuilder: ContextBuilder;
  inbox: Inbox;
  compressor: ContextCompressor;
  store: Store;
  budget?: BudgetController;
  conflictWatcher?: ConflictWatcher;
  ownership?: OwnershipManager;
}

export interface SupervisorOptions {
  workerTimeoutMs?: number;
  maxRetries?: number;
  costAware?: boolean;
  preferCheap?: boolean;
  preferredProviders?: ProviderName[];
}

export class Supervisor {
  private providerSelector: ProviderSelector;
  private pool: WorkerPool;
  private deps: SupervisorDeps;
  private options: Required<SupervisorOptions>;
  private workerBus: WorkerBus;
  private contextPropagator: ContextPropagator;
  private feedbackLoop: FeedbackLoop;
  private multiTurnConfig: Required<MultiTurnConfig>;

  constructor(deps: SupervisorDeps, options?: SupervisorOptions) {
    this.deps = deps;

    this.options = {
      workerTimeoutMs: options?.workerTimeoutMs ?? 300_000,
      maxRetries: options?.maxRetries ?? 2,
      costAware: options?.costAware ?? true,
      preferCheap: options?.preferCheap ?? false,
      preferredProviders: options?.preferredProviders ?? ["claude", "codex", "gemini", "kiro"],
    };

    // Build capability list from config
    const capabilities = this.buildCapabilities(deps.config);
    this.providerSelector = new ProviderSelector(capabilities, this.options.preferredProviders);

    this.pool = new WorkerPool({
      timeoutMs: this.options.workerTimeoutMs,
      maxRetries: this.options.maxRetries,
    });

    // Multi-turn config with defaults
    const mt = deps.config.supervisor?.multiTurn;
    this.multiTurnConfig = {
      defaultMaxTurns: mt?.defaultMaxTurns ?? 25,
      simpleMaxTurns: mt?.simpleMaxTurns ?? 5,
      standardMaxTurns: mt?.standardMaxTurns ?? 15,
      complexMaxTurns: mt?.complexMaxTurns ?? 50,
      checkpointIntervalTurns: mt?.checkpointIntervalTurns ?? 5,
      progressPollIntervalMs: mt?.progressPollIntervalMs ?? 3000,
      idleTimeoutMs: mt?.idleTimeoutMs ?? 120000,
    };

    // Initialize WorkerBus
    this.workerBus = new WorkerBus(deps.inbox, deps.sessionManager, deps.store);

    // Initialize ContextPropagator
    const cpConfig = deps.config.supervisor?.contextPropagation;
    this.contextPropagator = new ContextPropagator(
      deps.contextBuilder,
      this.workerBus,
      deps.compressor,
      { maxContextTokens: cpConfig?.maxContextTokens ?? 4000 },
    );

    // Initialize FeedbackLoop with worker bus + provider config for LLM quality gate
    const claudeProvider = deps.config.providers["claude"];
    this.feedbackLoop = new FeedbackLoop(
      deps.config.supervisor?.feedback,
      deps.sessionManager,
      this.pool,
      deps.checkpointManager,
      deps.recoveryManager,
      deps.store,
      this.workerBus,
      claudeProvider,
    );
  }

  async execute(taskId: string, prompt: string): Promise<AggregatedResult> {
    // 0. Budget circuit breaker — abort before spending if budget exhausted
    if (this.deps.budget) {
      const budgetCheck = this.deps.budget.canProceed(
        `supervisor-${taskId.slice(0, 8)}`,
        this.deps.config.budget.defaultMaxPerTask,
      );
      if (!budgetCheck.allowed) {
        return {
          taskId, subtaskResults: [], mergedOutput: `Budget exceeded: ${budgetCheck.reason}`,
          totalTokens: 0, totalCost: 0, totalDurationMs: 0, conflicts: [], success: false,
        };
      }
    }

    // 1. Decompose task
    const decomposition = decompose(prompt, taskId);

    // 1.5. Single-agent fallback — skip supervisor overhead for trivial decompositions
    if (decomposition.subtasks.length <= 1) {
      eventBus.publish({
        type: "supervisor:plan",
        taskId,
        phases: 0,
        estimatedCost: decomposition.estimatedTotalCost,
      });
      return this.executeSingleFallback(taskId, decomposition);
    }

    // 2. Select optimal provider+model for each subtask
    this.assignProviders(decomposition.subtasks);

    // 3. Publish execution plan
    const plan = decomposition.executionPlan;
    eventBus.publish({
      type: "supervisor:plan",
      taskId,
      phases: plan.phases.length,
      estimatedCost: decomposition.estimatedTotalCost,
    });

    // 4. Initialize worker bus for this task
    this.workerBus.clearTask(taskId);

    // 5. Subscribe to turn events for progress + stuck detection
    const unsubscribeTurnEvents = this.subscribeTurnEvents(taskId);

    // 6. Execute phase by phase
    const collector = new ResultCollector(taskId);

    for (const phase of plan.phases) {
      const phaseSubtasks = decomposition.subtasks.filter(
        st => phase.subtaskIds.includes(st.id)
      );

      if (phase.parallelizable) {
        await this.executeParallel(phaseSubtasks, collector, decomposition);
      } else {
        await this.executeSequential(phaseSubtasks, collector, decomposition);
      }

      // After each phase: run conflict analysis on completed results
      this.analyzePhaseConflicts(phaseSubtasks, collector);
    }

    // 7. Aggregate and return
    const result = collector.aggregate();

    // 8. Cleanup
    unsubscribeTurnEvents();
    this.feedbackLoop.stopAll();
    this.workerBus.clearTask(taskId);
    this.pool.clear();

    return result;
  }

  getPool(): WorkerPool {
    return this.pool;
  }

  getProviderSelector(): ProviderSelector {
    return this.providerSelector;
  }

  getWorkerBus(): WorkerBus {
    return this.workerBus;
  }

  private assignProviders(subtasks: SubTask[]): void {
    for (const subtask of subtasks) {
      const selection = this.providerSelector.selectWithFallback(subtask, {
        preferCheap: this.options.preferCheap,
        requireToolUse: subtask.agentRole === "coder" || subtask.agentRole === "tester",
      });

      subtask.provider = selection.provider;
      subtask.model = selection.model;
    }
  }

  private async executeParallel(
    subtasks: SubTask[],
    collector: ResultCollector,
    decomposition: DecompositionResult,
  ): Promise<void> {
    const promises = subtasks.map(st => this.executeSubtask(st, collector, decomposition));
    await Promise.allSettled(promises);
  }

  private async executeSequential(
    subtasks: SubTask[],
    collector: ResultCollector,
    decomposition: DecompositionResult,
  ): Promise<void> {
    for (const subtask of subtasks) {
      await this.executeSubtask(subtask, collector, decomposition);
    }
  }

  private async executeSubtask(
    subtask: SubTask,
    collector: ResultCollector,
    decomposition: DecompositionResult,
  ): Promise<void> {
    eventBus.publish({
      type: "supervisor:dispatch",
      taskId: subtask.parentTaskId,
      subtaskId: subtask.id,
      provider: subtask.provider,
      model: subtask.model,
    });

    // 1. Calculate max turns based on complexity
    const maxTurns = this.calculateMaxTurns(subtask);

    // 2. Build enriched prompt with context propagation
    let enrichedPrompt: string;
    try {
      enrichedPrompt = await this.contextPropagator.buildWorkerPrompt(
        subtask, decomposition, collector,
      );
    } catch {
      enrichedPrompt = subtask.prompt;
    }

    // 3. Infer domain for this subtask
    const domain = this.inferDomain(subtask);

    let lastError: string | null = null;
    const maxAttempts = this.options.maxRetries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Budget check before each attempt
      if (this.deps.budget) {
        const check = this.deps.budget.canProceed(
          `worker-${subtask.id.slice(0, 8)}`,
          this.deps.config.budget.defaultMaxPerTask,
        );
        if (!check.allowed) {
          subtask.status = "failed";
          subtask.result = `Budget exceeded: ${check.reason}`;
          return;
        }
      }

      try {
        // 4. Spawn worker via deps callback
        const { agentName } = await this.deps.spawnWorker(subtask, maxTurns, enrichedPrompt);

        // 5. Track in pool with maxTurns
        const worker = this.pool.spawn(subtask, agentName, maxTurns);
        this.pool.markRunning(worker.id);

        // 6. Register worker in bus for sibling communication
        this.workerBus.registerWorker({
          agentName,
          subtaskId: subtask.id,
          role: subtask.agentRole,
          domain,
          prompt: subtask.prompt.slice(0, 200),
        });

        // 6.5. Declare file ownership based on domain
        if (this.deps.ownership) {
          const ownershipResult = this.deps.ownership.declare({
            agentName,
            taskId: subtask.parentTaskId,
            owns: [`src/${domain}/**`],
            reads: ["src/shared/**", "src/config/**"],
          });
          if (!ownershipResult.allowed) {
            const conflictInfo = ownershipResult.conflicts
              .map(c => `${c.pattern} held by ${c.heldBy}`)
              .join(", ");
            eventBus.publish({
              type: "conflict:detected",
              id: `own-${Date.now().toString(36)}`,
              severity: "warning",
              agents: [agentName, ...ownershipResult.conflicts.map(c => c.heldBy)],
            });
            // Log but don't block — domain inference is heuristic
            this.pool.addIntermediateResult(worker.id, `Ownership conflict: ${conflictInfo}`);
          }
        }

        // 7. Start feedback monitoring
        this.feedbackLoop.startMonitoring(worker.id, subtask);

        // 8. Wait for result (event-driven with polling fallback)
        const outcome = await this.waitForWorkerCompletion(
          worker.id, agentName, this.options.workerTimeoutMs,
        );

        // 9. Stop monitoring
        this.feedbackLoop.stopMonitoring(worker.id);

        if (outcome) {
          // Only mark completed if FeedbackLoop hasn't already done so
          const currentState = this.pool.get(worker.id);
          if (currentState?.status !== "completed") {
            this.pool.markCompleted(worker.id, outcome.result, {
              tokenUsage: outcome.tokenUsage,
              costUsd: outcome.costUsd,
            });
          }

          // Collect result with role and domain
          const updatedWorker = this.pool.get(worker.id);
          if (updatedWorker) {
            collector.collect(updatedWorker, subtask.agentRole, domain);
          }

          // 10. Quality gate (if enabled)
          const feedbackConfig = this.deps.config.supervisor?.feedback;
          if (feedbackConfig?.qualityGateOnComplete) {
            const critique = await this.feedbackLoop.runQualityGate(subtask, outcome.result);
            if (!critique.passes && feedbackConfig?.qaLoopOnFail) {
              await this.feedbackLoop.runQALoop(subtask, critique);
            }
          }

          // 11. Broadcast artifacts to sibling workers
          const busConfig = this.deps.config.supervisor?.workerBus;
          if (busConfig?.broadcastArtifacts && updatedWorker) {
            this.workerBus.broadcastArtifact(agentName, subtask.parentTaskId, {
              files: collector.getResult(subtask.id)?.files,
              apis: collector.extractApis(outcome.result),
              schemas: collector.extractSchemas(outcome.result),
            });
          }

          // 12. Cleanup worker registration
          this.workerBus.unregisterWorker(agentName);
          await this.deps.stopWorker(agentName).catch(() => {});
          return; // Success
        }

        // No result → timeout
        this.pool.markFailed(worker.id, "No result received");
        lastError = "No result received";
        this.workerBus.unregisterWorker(agentName);
        await this.deps.stopWorker(agentName).catch(() => {});

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        lastError = errMsg;

        // Find the worker and mark failed
        const existingWorker = this.pool.getBySubtask(subtask.id);
        if (existingWorker) {
          this.pool.markFailed(existingWorker.id, errMsg);
          this.feedbackLoop.stopMonitoring(existingWorker.id);

          // Use feedback loop's failure handling
          this.feedbackLoop.handleFailure(existingWorker.id, subtask, err instanceof Error ? err : new Error(errMsg));
        }
      }

      // Check if we should retry
      if (attempt < maxAttempts - 1) {
        // Try with a different provider on retry
        const excluded: ProviderName[] = [subtask.provider];
        const fallback = this.providerSelector.select(subtask, {
          excluded,
          preferCheap: this.options.preferCheap,
        });

        if (fallback.score > 0) {
          subtask.provider = fallback.provider;
          subtask.model = fallback.model;

          eventBus.publish({
            type: "provider:fallback",
            subtaskId: subtask.id,
            from: excluded[0],
            to: fallback.provider,
            reason: `Retry attempt ${attempt + 1}: ${lastError}`,
          });
        }
      }
    }

    // All attempts failed — record failure
    const failedStatus: TaskStatus = "failed";
    subtask.status = failedStatus;
    subtask.result = lastError;
  }

  private analyzePhaseConflicts(subtasks: SubTask[], collector: ResultCollector): void {
    if (!this.deps.conflictWatcher) return;

    // Record diffs from completed subtasks in this phase
    for (const subtask of subtasks) {
      const result = collector.getResult(subtask.id);
      if (!result) continue;

      this.deps.conflictWatcher.recordDiff({
        agentName: result.agentName,
        taskId: subtask.parentTaskId,
        files: result.files,
        summary: result.result.slice(0, 500),
      });
    }

    // Analyze for logical conflicts
    const conflicts = this.deps.conflictWatcher.analyze();
    for (const conflict of conflicts) {
      eventBus.publish({
        type: "conflict:detected",
        id: conflict.id,
        severity: conflict.severity,
        agents: [conflict.agentA, conflict.agentB],
      });
    }
  }

  private async executeSingleFallback(
    taskId: string,
    decomposition: DecompositionResult,
  ): Promise<AggregatedResult> {
    const subtask = decomposition.subtasks[0];
    if (!subtask) {
      return {
        taskId, subtaskResults: [], mergedOutput: "No subtasks generated",
        totalTokens: 0, totalCost: 0, totalDurationMs: 0, conflicts: [], success: false,
      };
    }

    this.assignProviders([subtask]);
    const collector = new ResultCollector(taskId);
    await this.executeSubtask(subtask, collector, decomposition);

    const result = collector.aggregate();
    this.pool.clear();
    return result;
  }

  private subscribeTurnEvents(taskId: string): () => void {
    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const turnCounts = new Map<string, number>();

    const onTurn = (e: { workerId: string; turn: number; maxTurns: number; toolUsed?: string }) => {
      const { workerId, turn, maxTurns } = e;

      // Update progress percentage
      const progress = Math.round((turn / maxTurns) * 100);
      this.pool.updateProgress(workerId, progress);

      // Track turns for auto-checkpoint
      turnCounts.set(workerId, turn);
      if (turn > 0 && turn % this.multiTurnConfig.checkpointIntervalTurns === 0) {
        this.deps.checkpointManager.create(taskId, workerId, `auto-turn-${turn}`).catch(() => {});
      }

      // Reset idle timer
      const existing = idleTimers.get(workerId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        eventBus.publish({
          type: "worker:idle_timeout",
          workerId,
          idleMs: this.multiTurnConfig.idleTimeoutMs,
        });
      }, this.multiTurnConfig.idleTimeoutMs);
      idleTimers.set(workerId, timer);
    };

    // Handle idle timeout — nudge stuck workers
    const onIdleTimeout = (e: { workerId: string; idleMs: number }) => {
      const worker = this.pool.get(e.workerId);
      if (!worker || worker.status !== "running") return;

      this.feedbackLoop.sendCorrection(
        e.workerId,
        `[Supervisor]: No activity detected for ${Math.round(e.idleMs / 1000)}s. Are you stuck? Please continue with the task or report your status.`,
      ).catch(() => {});
    };

    eventBus.on("worker:turn", onTurn as (e: unknown) => void);
    eventBus.on("worker:idle_timeout", onIdleTimeout as (e: unknown) => void);

    // Return cleanup function
    return () => {
      eventBus.removeListener("worker:turn", onTurn as (e: unknown) => void);
      eventBus.removeListener("worker:idle_timeout", onIdleTimeout as (e: unknown) => void);
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      turnCounts.clear();
    };
  }

  private waitForWorkerCompletion(
    workerId: string,
    agentName: string,
    timeoutMs: number,
  ): Promise<{ result: string; tokenUsage: number; costUsd: number } | null> {
    return new Promise((resolve) => {
      let settled = false;

      const settle = (value: { result: string; tokenUsage: number; costUsd: number } | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      // EventBus listeners for instant completion
      const onComplete = (e: { workerId: string; tokenUsage: number; costUsd: number }) => {
        if (e.workerId !== workerId) return;
        const worker = this.pool.get(workerId);
        if (worker?.result) {
          settle({ result: worker.result, tokenUsage: e.tokenUsage, costUsd: e.costUsd });
        }
      };

      const onFail = (e: { workerId: string; error: string }) => {
        if (e.workerId !== workerId) return;
        settle(null);
      };

      eventBus.on("worker:complete", onComplete as (e: unknown) => void);
      eventBus.on("worker:fail", onFail as (e: unknown) => void);

      // Polling fallback — check pool state (updated by FeedbackLoop) + DB directly
      const pollInterval = setInterval(() => {
        if (settled) return;
        // Pool may have been updated by FeedbackLoop detecting session death
        const worker = this.pool.get(workerId);
        if (worker?.status === "completed" && worker.result) {
          settle({ result: worker.result, tokenUsage: worker.tokenUsage, costUsd: worker.costUsd });
          return;
        }
        if (worker?.status === "failed") {
          settle(null);
          return;
        }
        // Direct DB check — worker may write result without event
        try {
          const tasks = this.deps.store.listTasks({ agentName, status: "completed" });
          if (tasks.length > 0) {
            const t = tasks[0];
            settle({ result: t.result ?? "", tokenUsage: t.tokenUsage, costUsd: t.costUsd });
            return;
          }
          const failed = this.deps.store.listTasks({ agentName, status: "failed" });
          if (failed.length > 0) settle(null);
        } catch { /* ignore DB errors */ }
      }, 2000);

      // Timeout
      const timer = setTimeout(() => settle(null), timeoutMs);

      const cleanup = () => {
        eventBus.removeListener("worker:complete", onComplete as (e: unknown) => void);
        eventBus.removeListener("worker:fail", onFail as (e: unknown) => void);
        clearInterval(pollInterval);
        clearTimeout(timer);
      };
    });
  }

  private calculateMaxTurns(subtask: SubTask): number {
    // Check if complexity hints exist in the prompt
    const prompt = subtask.prompt.toLowerCase();
    const domains = detectDomains(subtask.prompt);

    // Multi-domain or complex keywords → complex
    if (domains.length >= 3 || /architect|design|migrate|optimize/i.test(prompt)) {
      return this.multiTurnConfig.complexMaxTurns;
    }

    // Simple keywords
    if (/format|rename|typo|lint|style|fix\s+typo/i.test(prompt)) {
      return this.multiTurnConfig.simpleMaxTurns;
    }

    // Standard by default
    return this.multiTurnConfig.standardMaxTurns;
  }

  private inferDomain(subtask: SubTask): string {
    const domains = detectDomains(subtask.prompt);
    return domains[0] ?? "general";
  }

  private buildCapabilities(config: OrchestratorConfig): ProviderCapability[] {
    const capabilities: ProviderCapability[] = [];

    for (const [name, provider] of Object.entries(config.providers)) {
      if (provider.capabilities) {
        const caps = provider.capabilities;
        capabilities.push({
          name: name as ProviderName,
          models: caps.models ?? [],
          strengths: caps.strengths ?? [],
          weaknesses: caps.weaknesses ?? [],
          maxContextTokens: caps.maxContextTokens ?? 128000,
          supportsStreaming: caps.supportsStreaming ?? false,
          supportsToolUse: caps.supportsToolUse ?? false,
          costTier: caps.costTier ?? "medium",
        });
      } else {
        // Minimal fallback for providers without capabilities in config
        capabilities.push({
          name: name as ProviderName,
          models: [provider.defaultModel ?? name].filter(Boolean) as string[],
          strengths: ["code-generation"],
          weaknesses: [],
          maxContextTokens: 128000,
          supportsStreaming: false,
          supportsToolUse: false,
          costTier: "medium",
        });
      }
    }

    return capabilities;
  }
}
