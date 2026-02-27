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

    // Initialize FeedbackLoop
    this.feedbackLoop = new FeedbackLoop(
      deps.config.supervisor?.feedback,
      deps.sessionManager,
      this.pool,
      deps.checkpointManager,
      deps.recoveryManager,
      deps.store,
    );
  }

  async execute(taskId: string, prompt: string): Promise<AggregatedResult> {
    // 1. Decompose task
    const decomposition = decompose(prompt, taskId);

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

    // 5. Execute phase by phase
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
    }

    // 6. Aggregate and return
    const result = collector.aggregate();

    // 7. Cleanup
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

        // 7. Start feedback monitoring
        this.feedbackLoop.startMonitoring(worker.id, subtask);

        // 8. Wait for result
        const outcome = await this.deps.waitForResult(
          agentName,
          this.options.workerTimeoutMs,
        );

        // 9. Stop monitoring
        this.feedbackLoop.stopMonitoring(worker.id);

        if (outcome) {
          this.pool.markCompleted(worker.id, outcome.result, {
            tokenUsage: outcome.tokenUsage,
            costUsd: outcome.costUsd,
          });

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
