import type {
  SubTask,
  DecompositionResult,
  AggregatedResult,
  ExecutionPlan,
  ProviderName,
  ProviderCapability,
  WorkerState,
  OrchestratorConfig,
} from "../config/types.ts";
import { decompose } from "./decomposer.ts";
import { ProviderSelector } from "./provider-selector.ts";
import { WorkerPool } from "./worker-pool.ts";
import { ResultCollector } from "./result-collector.ts";
import { eventBus } from "./events.ts";

export interface SupervisorDeps {
  config: OrchestratorConfig;
  spawnWorker: (subtask: SubTask) => Promise<{ agentName: string; sessionId: string }>;
  waitForResult: (agentName: string, timeoutMs: number) => Promise<{ result: string; tokenUsage: number; costUsd: number } | null>;
  stopWorker: (agentName: string) => Promise<void>;
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

    // 4. Execute phase by phase
    const collector = new ResultCollector(taskId);

    for (const phase of plan.phases) {
      const phaseSubtasks = decomposition.subtasks.filter(
        st => phase.subtaskIds.includes(st.id)
      );

      if (phase.parallelizable) {
        await this.executeParallel(phaseSubtasks, collector);
      } else {
        await this.executeSequential(phaseSubtasks, collector);
      }
    }

    // 5. Aggregate and return
    const result = collector.aggregate();

    // 6. Cleanup
    this.pool.clear();

    return result;
  }

  getPool(): WorkerPool {
    return this.pool;
  }

  getProviderSelector(): ProviderSelector {
    return this.providerSelector;
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
  ): Promise<void> {
    const promises = subtasks.map(st => this.executeSubtask(st, collector));
    await Promise.allSettled(promises);
  }

  private async executeSequential(
    subtasks: SubTask[],
    collector: ResultCollector,
  ): Promise<void> {
    for (const subtask of subtasks) {
      await this.executeSubtask(subtask, collector);
    }
  }

  private async executeSubtask(
    subtask: SubTask,
    collector: ResultCollector,
  ): Promise<void> {
    eventBus.publish({
      type: "supervisor:dispatch",
      taskId: subtask.parentTaskId,
      subtaskId: subtask.id,
      provider: subtask.provider,
      model: subtask.model,
    });

    let lastError: string | null = null;
    const maxAttempts = this.options.maxRetries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Spawn worker via deps callback
        const { agentName } = await this.deps.spawnWorker(subtask);

        // Track in pool
        const worker = this.pool.spawn(subtask, agentName);
        this.pool.markRunning(worker.id);

        // Wait for result
        const outcome = await this.deps.waitForResult(
          agentName,
          this.options.workerTimeoutMs,
        );

        if (outcome) {
          this.pool.markCompleted(worker.id, outcome.result, {
            tokenUsage: outcome.tokenUsage,
            costUsd: outcome.costUsd,
          });

          // Collect result
          const updatedWorker = this.pool.get(worker.id);
          if (updatedWorker) {
            collector.collect(updatedWorker);
          }

          // Stop the worker session
          await this.deps.stopWorker(agentName).catch(() => {});
          return; // Success
        }

        // No result → timeout
        this.pool.markFailed(worker.id, "No result received");
        lastError = "No result received";
        await this.deps.stopWorker(agentName).catch(() => {});

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        lastError = errMsg;

        // Find the worker and mark failed
        const existingWorker = this.pool.getBySubtask(subtask.id);
        if (existingWorker) {
          this.pool.markFailed(existingWorker.id, errMsg);
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
    subtask.status = "failed";
    subtask.result = lastError;
  }

  private buildCapabilities(config: OrchestratorConfig): ProviderCapability[] {
    const capabilities: ProviderCapability[] = [];

    for (const [name, provider] of Object.entries(config.providers)) {
      const caps = (provider as any).capabilities;
      if (caps) {
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
