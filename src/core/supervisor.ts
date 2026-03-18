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
import type { ConflictWatcher } from "./watcher.ts";
import type { OwnershipManager } from "./ownership.ts";
import type { ContextBuilder } from "../memory/context-builder.ts";
import type { Inbox } from "../messaging/inbox.ts";
import type { ContextCompressor } from "../messaging/context-compressor.ts";
import type { Store } from "../db/store.ts";
import { decompose, decomposeWithSam, detectDomains } from "./decomposer.ts";
import { ProviderSelector } from "./provider-selector.ts";
import { WorkerPool } from "./worker-pool.ts";
import { ResultCollector } from "./result-collector.ts";
import { WorkerBus } from "./worker-bus.ts";
import { ContextPropagator } from "./context-propagator.ts";
import { FeedbackLoop } from "./feedback-loop.ts";
import { TodoContinuationEnforcer } from "./todo-continuation.ts";
import { eventBus } from "./events.ts";
import { reviewSpec, reviewQuality } from "./review-gate.ts";
import type { DistributedTracer, TraceContext } from "./distributed-trace.ts";
import type { WorkerExecutionStrategy, WorkerHandle } from "./worker-strategy.ts";

export interface SupervisorDeps {
  config: OrchestratorConfig;
  workerStrategy: WorkerExecutionStrategy;
  sessionManager: SessionManager;
  checkpointManager: CheckpointManager;
  recoveryManager: RecoveryManager;
  contextBuilder: ContextBuilder;
  inbox: Inbox;
  compressor: ContextCompressor;
  store: Store;
  conflictWatcher?: ConflictWatcher;
  ownership?: OwnershipManager;
  profileContext?: string;
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
  private todoContinuation: TodoContinuationEnforcer;
  private tracer: DistributedTracer | null = null;
  private conflictResolutions: Array<{ resolution: string; chosenApproach: string; corrections: string[] }> = [];
  private workerHandles = new Map<string, WorkerHandle>();

  constructor(deps: SupervisorDeps, options?: SupervisorOptions) {
    this.deps = deps;

    this.options = {
      workerTimeoutMs: options?.workerTimeoutMs ?? 300_000,
      maxRetries: options?.maxRetries ?? 2,
      costAware: options?.costAware ?? true,
      preferCheap: options?.preferCheap ?? false,
      preferredProviders: options?.preferredProviders ?? ["claude"],
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

    // Initialize TodoContinuation for worker output checking
    this.todoContinuation = new TodoContinuationEnforcer();

    // Initialize WorkerBus
    this.workerBus = new WorkerBus(deps.inbox, deps.sessionManager, deps.store);

    // Initialize ContextPropagator
    const cpConfig = deps.config.supervisor?.contextPropagation;
    this.contextPropagator = new ContextPropagator(
      deps.contextBuilder,
      this.workerBus,
      deps.compressor,
      { maxContextTokens: cpConfig?.maxContextTokens ?? 16000 },
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

    // Wire worker strategy into feedback loop for strategy-aware monitoring
    this.feedbackLoop.setWorkerStrategy(deps.workerStrategy);
  }

  async execute(taskId: string, prompt: string): Promise<AggregatedResult> {
    // Start root trace for this execution
    const rootCtx = this.tracer?.startTrace("supervisor.execute", "supervisor", {
      taskId,
      promptLength: prompt.length,
    }) ?? null;

    try {
      // 0. Clear stale ownership from previous executions
      if (this.deps.ownership) {
        for (const entry of this.deps.store.getAllOwnership()) {
          this.deps.ownership.release(entry.agentName);
        }
      }

      // 1. Decompose task
      const decomposeCtx = rootCtx
        ? this.tracer!.startSpan(rootCtx, "decomposer.decompose", "decomposer", { taskId })
        : null;

      const decomposition = await decomposeWithSam(prompt, taskId, undefined, this.deps.profileContext);

      if (decomposeCtx) {
        // Add domain detection as child span
        const domainCtx = this.tracer!.startSpan(decomposeCtx, "domain.detect", "decomposer", { taskId });
        const domains = detectDomains(prompt);
        this.tracer!.addTags(domainCtx.spanId, { domainCount: domains.length, domains: domains.join(",") });
        this.tracer!.endSpan(domainCtx.spanId, "ok");

        this.tracer!.addTags(decomposeCtx.spanId, {
          subtaskCount: decomposition.subtasks.length,
          strategy: decomposition.executionPlan.strategy,
        });
        this.tracer!.endSpan(decomposeCtx.spanId, "ok");
      }

      // 1.5. Single-agent fallback — skip supervisor overhead for trivial decompositions
      if (decomposition.subtasks.length <= 1) {
        eventBus.publish({
          type: "supervisor:plan",
          taskId,
          phases: 0,
          estimatedCost: decomposition.estimatedTotalCost,
        });
        const result = await this.executeSingleFallback(taskId, decomposition, rootCtx);
        if (rootCtx) {
          this.tracer!.addTags(rootCtx.spanId, { singleAgent: true, success: result.success });
          this.tracer!.endSpan(rootCtx.spanId, result.success ? "ok" : "error");
        }
        return result;
      }

      // 2. Select optimal provider+model for each subtask
      const providerCtx = rootCtx
        ? this.tracer!.startSpan(rootCtx, "provider.select", "provider-selector", { taskId })
        : null;
      this.assignProviders(decomposition.subtasks);
      if (providerCtx) {
        this.tracer!.endSpan(providerCtx.spanId, "ok");
      }

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
          await this.executeParallel(phaseSubtasks, collector, decomposition, rootCtx);
        } else {
          await this.executeSequential(phaseSubtasks, collector, decomposition, rootCtx);
        }

        // After each phase: run conflict analysis on completed results, then clear diffs to avoid re-detection
        await this.analyzePhaseConflicts(phaseSubtasks, collector);
        this.deps.conflictWatcher?.clearDiffs();
      }

      // 6.5. QA Agent — only if workers produced real results
      const allResults = collector.getAllResults();
      const successfulResults = allResults.filter(r => r.result && r.result.trim().length > 0);
      if (decomposition.subtasks.length > 1 && successfulResults.length > 0) {
        const resultSections = successfulResults.map(r =>
          `### ${r.agentName} (${r.role})\n${r.result}`
        ).join("\n\n---\n\n");

        const qaPrompt = [
          `## Original User Request`,
          prompt,
          ``,
          `## Completed Phase Results`,
          resultSections,
          ``,
          `Verify the original request was fully achieved. Read actual files, run commands/tests. End with [QA:PASS] or [QA:FAIL reason="..."].`,
        ].join("\n");

        const qaSubtask: SubTask = {
          id: `st-qa-${Date.now().toString(36)}`,
          prompt: qaPrompt,
          parentTaskId: taskId,
          dependencies: decomposition.subtasks.map(st => st.id),
          provider: "claude" as ProviderName,
          model: "sonnet",
          agentRole: "qa",
          priority: 999,
          status: "queued" as TaskStatus,
          result: null,
          estimatedTokens: 20000,
          actualTokens: 0,
          startedAt: null,
          completedAt: null,
        };

        await this.executeSubtask(qaSubtask, collector, decomposition, rootCtx);
      }

      // 7. Aggregate and return
      const mergeCtx = rootCtx
        ? this.tracer!.startSpan(rootCtx, "result.merge", "result-collector", { taskId })
        : null;
      const result = collector.aggregate();
      if (mergeCtx) {
        this.tracer!.addTags(mergeCtx.spanId, {
          subtaskResults: result.subtaskResults.length,
          conflicts: result.conflicts.length,
          totalTokens: result.totalTokens,
        });
        this.tracer!.endSpan(mergeCtx.spanId, "ok");
      }

      // 8. Cleanup
      unsubscribeTurnEvents();
      this.feedbackLoop.stopAll();
      this.workerBus.clearTask(taskId);
      this.pool.clear();

      if (rootCtx) {
        this.tracer!.addTags(rootCtx.spanId, {
          success: result.success,
          totalTokens: result.totalTokens,
          totalCost: result.totalCost,
        });
        this.tracer!.endSpan(rootCtx.spanId, result.success ? "ok" : "error");
      }

      return result;
    } catch (err) {
      if (rootCtx) {
        this.tracer!.endSpan(
          rootCtx.spanId,
          "error",
          err instanceof Error ? err.message : String(err),
        );
      }
      throw err;
    }
  }

  /**
   * Cancel a specific subtask by its subtask ID.
   * Stops monitoring, kills the worker session, and marks as cancelled.
   */
  async cancelSubtask(subtaskId: string, reason: string): Promise<boolean> {
    const worker = this.pool.getBySubtask(subtaskId);
    if (!worker) return false;

    // Stop feedback monitoring
    this.feedbackLoop.stopMonitoring(worker.id);

    // Kill the worker (best-effort; may already be dead)
    const handle = this.workerHandles.get(worker.agentName);
    if (handle) {
      try { await this.deps.workerStrategy.stop(handle); } catch { /* may already be dead */ }
      this.workerHandles.delete(worker.agentName);
    }

    // Mark cancelled in pool
    this.pool.cancel(worker.id, reason);

    return true;
  }

  /**
   * Cancel a specific worker by its worker ID.
   * Stops monitoring, kills the worker session, and marks as cancelled.
   */
  async cancelWorker(workerId: string, reason: string): Promise<boolean> {
    const worker = this.pool.get(workerId);
    if (!worker) return false;

    // Stop feedback monitoring
    this.feedbackLoop.stopMonitoring(worker.id);

    // Kill the worker (best-effort)
    const handle = this.workerHandles.get(worker.agentName);
    if (handle) {
      try { await this.deps.workerStrategy.stop(handle); } catch { /* may already be dead */ }
      this.workerHandles.delete(worker.agentName);
    }

    // Mark cancelled in pool
    const result = this.pool.cancel(workerId, reason);
    return result !== undefined;
  }

  /**
   * Cancel all active workers, optionally for a specific task.
   * Returns the number of workers cancelled.
   */
  async cancelAll(reason: string): Promise<number> {
    const active = this.pool.getActive();
    let cancelled = 0;

    for (const worker of active) {
      this.feedbackLoop.stopMonitoring(worker.id);
      const handle = this.workerHandles.get(worker.agentName);
      if (handle) {
        try { await this.deps.workerStrategy.stop(handle); } catch { /* may already be dead */ }
        this.workerHandles.delete(worker.agentName);
      }
      const result = this.pool.cancel(worker.id, reason);
      if (result) cancelled++;
    }

    return cancelled;
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

  getWorkerPool(): WorkerPool {
    return this.pool;
  }

  setTracer(tracer: DistributedTracer): void {
    this.tracer = tracer;
  }

  setCodebaseContext(context: string): void {
    this.contextPropagator.setCodebaseContext(context);
  }

  setLanguage(lang: string): void {
    this.contextPropagator.setLanguage(lang);
  }

  setPreferredProviders(providers: ProviderName[]): void {
    this.options.preferredProviders = providers;
    const capabilities = this.buildCapabilities(this.deps.config);
    this.providerSelector = new ProviderSelector(capabilities, providers);
  }

  getPreferredProviders(): ProviderName[] {
    return this.options.preferredProviders;
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
    parentCtx?: TraceContext | null,
  ): Promise<void> {
    const promises = subtasks.map(st => this.executeSubtask(st, collector, decomposition, parentCtx));
    await Promise.allSettled(promises);
  }

  private async executeSequential(
    subtasks: SubTask[],
    collector: ResultCollector,
    decomposition: DecompositionResult,
    parentCtx?: TraceContext | null,
  ): Promise<void> {
    for (const subtask of subtasks) {
      await this.executeSubtask(subtask, collector, decomposition, parentCtx);
    }
  }

  private async executeSubtask(
    subtask: SubTask,
    collector: ResultCollector,
    decomposition: DecompositionResult,
    parentCtx?: TraceContext | null,
  ): Promise<void> {
    // Start a worker span if tracing is active
    const workerSpanCtx = (parentCtx && this.tracer)
      ? this.tracer.startSpan(parentCtx, "worker.run", "worker-pool", {
          subtaskId: subtask.id,
          provider: subtask.provider,
          model: subtask.model,
          role: subtask.agentRole,
        })
      : null;

    eventBus.publish({
      type: "supervisor:dispatch",
      taskId: subtask.parentTaskId,
      subtaskId: subtask.id,
      provider: subtask.provider,
      model: subtask.model,
      role: subtask.agentRole,
      prompt: subtask.prompt.slice(0, 120),
    });

    // 1. Calculate max turns based on complexity
    const maxTurns = this.calculateMaxTurns(subtask);

    // 2. Build enriched prompt with context propagation
    let enrichedPrompt: string;
    try {
      enrichedPrompt = await this.contextPropagator.buildWorkerPrompt(
        subtask, decomposition, collector, this.conflictResolutions,
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
        const spawnCtx = (workerSpanCtx && this.tracer)
          ? this.tracer.startSpan(workerSpanCtx, "session.spawn", "session-manager", {
              subtaskId: subtask.id,
              attempt,
            })
          : null;

        const handle = await this.deps.workerStrategy.spawn(subtask, maxTurns, enrichedPrompt);
        const { agentName } = handle;
        this.workerHandles.set(agentName, handle);

        if (spawnCtx && this.tracer) {
          this.tracer.endSpan(spawnCtx.spanId, "ok");
        }

        // 5. Track in pool with maxTurns
        const worker = this.pool.spawn(subtask, agentName, maxTurns);
        // Attach trace context to worker state
        if (workerSpanCtx) {
          worker.traceContext = { traceId: workerSpanCtx.traceId, spanId: workerSpanCtx.spanId };
        }
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

        // 7. Bridge strategy completion → pool events
        this.deps.workerStrategy.waitForResult(handle, this.options.workerTimeoutMs).then(
          (strategyResult) => {
            const current = this.pool.get(worker.id);
            if (!current || current.status === "completed" || current.status === "failed" || current.status === "cancelled") return;
            if (strategyResult) {
              this.pool.markCompleted(worker.id, strategyResult.result, {
                tokenUsage: strategyResult.tokenUsage,
                costUsd: strategyResult.costUsd,
              });
            } else {
              const reason = ("getLastError" in this.deps.workerStrategy)
                ? (this.deps.workerStrategy as any).getLastError(handle) ?? "Worker exited without result"
                : "Worker exited without result";
              this.pool.markFailed(worker.id, reason);
            }
          },
          (err) => {
            const current = this.pool.get(worker.id);
            if (!current || current.status === "completed" || current.status === "failed" || current.status === "cancelled") return;
            this.pool.markFailed(worker.id, err instanceof Error ? err.message : "Worker process error");
          },
        );

        // 8. Start feedback monitoring
        this.feedbackLoop.registerWorkerHandle(agentName, handle);
        this.feedbackLoop.startMonitoring(worker.id, subtask);

        // 9. Wait for result (event-driven with polling fallback)
        let outcome = await this.waitForWorkerCompletion(
          worker.id, agentName, this.options.workerTimeoutMs,
        );

        // 10. Stop monitoring
        this.feedbackLoop.stopMonitoring(worker.id);

        if (outcome) {
          // Auto-continue if worker finished with remaining TODOs
          if (this.todoContinuation.shouldContinue(outcome.result)) {
            const detection = this.todoContinuation.detect(outcome.result);
            const continuationPrompt = this.todoContinuation.buildContinuationPrompt(detection);
            this.todoContinuation.recordContinuation();
            const wHandle = this.workerHandles.get(agentName);
            if (wHandle) await this.deps.workerStrategy.sendInput(wHandle, continuationPrompt);

            // Wait again for updated result
            const continued = await this.waitForWorkerCompletion(
              worker.id, agentName, this.options.workerTimeoutMs,
            );
            if (continued) {
              outcome = continued;
            }
          }

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
            const qgCtx = (workerSpanCtx && this.tracer)
              ? this.tracer.startSpan(workerSpanCtx, "quality.gate", "feedback-loop", {
                  subtaskId: subtask.id,
                })
              : null;

            const critique = await this.feedbackLoop.runQualityGate(subtask, outcome.result);

            if (qgCtx && this.tracer) {
              this.tracer.addTags(qgCtx.spanId, { passed: critique.passes, issues: critique.issues.length });
              this.tracer.endSpan(qgCtx.spanId, critique.passes ? "ok" : "error");
            }

            if (!critique.passes && feedbackConfig?.qaLoopOnFail) {
              await this.feedbackLoop.runQALoop(subtask, critique);
            }
          }

          // 10.5. Two-stage review gate
          const reviewGateConfig = this.deps.config.supervisor?.reviewGate;
          if (reviewGateConfig?.enabled && subtask.agentRole !== "qa") {
            try {
              const specReview = await reviewSpec(subtask.prompt, outcome.result);
              eventBus.publish({ type: "review:complete", subtaskId: subtask.id, stage: "spec", passed: specReview.passed });
              if (!specReview.passed) {
                eventBus.publish({ type: "review:issues", subtaskId: subtask.id, issues: specReview.issues });
              }

              if (specReview.passed) {
                const qualReview = await reviewQuality(outcome.result);
                eventBus.publish({ type: "review:complete", subtaskId: subtask.id, stage: "quality", passed: qualReview.passed });
                if (!qualReview.passed) {
                  eventBus.publish({ type: "review:issues", subtaskId: subtask.id, issues: qualReview.issues });
                }
              }
            } catch {
              // Review gate failure is non-blocking — log and continue
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

          // 11.5. Send structured injection to still-running sibling workers
          const siblingUpdate = this.formatSiblingInjection(subtask, outcome.result, collector);
          for (const [runningName] of this.workerBus.getRunningWorkers(subtask.parentTaskId, agentName)) {
            const sibHandle = this.workerHandles.get(runningName);
            if (sibHandle) this.deps.workerStrategy.sendInput(sibHandle, siblingUpdate).catch(() => {});
          }

          // 12. Collect result
          const collectCtx = (workerSpanCtx && this.tracer)
            ? this.tracer.startSpan(workerSpanCtx, "result.collect", "result-collector", {
                subtaskId: subtask.id,
              })
            : null;
          if (collectCtx && this.tracer) {
            this.tracer.addTags(collectCtx.spanId, {
              tokenUsage: outcome.tokenUsage,
              costUsd: outcome.costUsd,
            });
            this.tracer.endSpan(collectCtx.spanId, "ok");
          }

          // 13. Cleanup worker registration
          this.cleanupWorker(agentName, handle, subtask);

          // End worker span successfully
          if (workerSpanCtx && this.tracer) {
            this.tracer.addTags(workerSpanCtx.spanId, {
              tokenUsage: outcome.tokenUsage,
              costUsd: outcome.costUsd,
              agentName,
            });
            this.tracer.endSpan(workerSpanCtx.spanId, "ok");
          }
          return; // Success
        }

        // No result → timeout
        this.pool.markFailed(worker.id, "No result received");
        lastError = "No result received";
        this.cleanupWorker(agentName, handle, subtask);

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        lastError = errMsg;

        // Find the worker and mark failed
        const existingWorker = this.pool.getBySubtask(subtask.id);
        if (existingWorker) {
          this.pool.markFailed(existingWorker.id, errMsg);
          this.feedbackLoop.stopMonitoring(existingWorker.id);
          this.feedbackLoop.handleFailure(existingWorker.id, subtask, err instanceof Error ? err : new Error(errMsg));
        }
        this.cleanupWorker(agentName, handle, subtask);
      }

      // Check if we should retry
      if (attempt < maxAttempts - 1) {
        // Try a different provider, but only from available providers
        const currentProvider = subtask.provider;
        const fallback = this.providerSelector.select(subtask, {
          excluded: [currentProvider],
          preferCheap: this.options.preferCheap,
        });

        // Only switch if fallback is a different available provider with a real score
        if (fallback.score > 0 && fallback.provider !== currentProvider) {
          subtask.provider = fallback.provider;
          subtask.model = fallback.model;
          eventBus.publish({
            type: "provider:fallback",
            subtaskId: subtask.id,
            from: currentProvider,
            to: fallback.provider,
            reason: `Retry attempt ${attempt + 1}: ${lastError}`,
          });
        } else {
          // No alternative — retry same provider
          eventBus.publish({
            type: "provider:fallback",
            subtaskId: subtask.id,
            from: currentProvider,
            to: currentProvider,
            reason: `Retry attempt ${attempt + 1} (same provider): ${lastError}`,
          });
        }
      }
    }

    // All attempts failed — record failure
    const failedStatus: TaskStatus = "failed";
    subtask.status = failedStatus;
    subtask.result = lastError;

    // End worker span with error
    if (workerSpanCtx && this.tracer) {
      this.tracer.endSpan(workerSpanCtx.spanId, "error", lastError ?? "All attempts failed");
    }
  }

  private async analyzePhaseConflicts(subtasks: SubTask[], collector: ResultCollector): Promise<void> {
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

      // Auto-resolve critical conflicts via LLM
      if (conflict.severity === "critical") {
        const aResult = collector.getAllResults().find(r => r.agentName === conflict.agentA)?.result ?? "";
        const bResult = collector.getAllResults().find(r => r.agentName === conflict.agentB)?.result ?? "";
        const resolution = await this.deps.conflictWatcher.autoResolve(conflict, aResult, bResult);
        this.conflictResolutions.push(resolution);
        this.deps.conflictWatcher.resolve(conflict.id);
        eventBus.publish({
          type: "conflict:resolved",
          id: conflict.id,
        });
      }
    }
  }

  getConflictResolutions(): Array<{ resolution: string; chosenApproach: string; corrections: string[] }> {
    return this.conflictResolutions;
  }

  private async executeSingleFallback(
    taskId: string,
    decomposition: DecompositionResult,
    parentCtx?: TraceContext | null,
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
    await this.executeSubtask(subtask, collector, decomposition, parentCtx);

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
        if (worker?.result != null) {
          settle({ result: worker.result, tokenUsage: e.tokenUsage, costUsd: e.costUsd });
        }
      };

      const onFail = (e: { workerId: string; error: string }) => {
        if (e.workerId !== workerId) return;
        settle(null);
      };

      const onCancel = (e: { workerId: string; reason: string }) => {
        if (e.workerId !== workerId) return;
        settle(null);
      };

      eventBus.on("worker:complete", onComplete as (e: unknown) => void);
      eventBus.on("worker:fail", onFail as (e: unknown) => void);
      eventBus.on("worker:cancel", onCancel as (e: unknown) => void);

      // Polling fallback — check pool state (updated by FeedbackLoop) + DB directly
      const pollInterval = setInterval(() => {
        if (settled) return;
        // Pool may have been updated by FeedbackLoop detecting session death
        const worker = this.pool.get(workerId);
        if (worker?.status === "completed" && worker.result != null) {
          settle({ result: worker.result, tokenUsage: worker.tokenUsage, costUsd: worker.costUsd });
          return;
        }
        if (worker?.status === "failed" || worker?.status === "cancelled") {
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
        eventBus.removeListener("worker:cancel", onCancel as (e: unknown) => void);
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

  private cleanupWorker(agentName: string, handle: WorkerHandle | null, subtask: SubTask): void {
    this.workerBus.unregisterWorker(agentName);
    if (this.deps.ownership) {
      this.deps.ownership.release(agentName, subtask.parentTaskId);
    }
    if (handle) {
      this.deps.workerStrategy.stop(handle).catch(() => {});
      this.workerHandles.delete(agentName);
    }
  }

  private inferDomain(subtask: SubTask): string {
    const domains = detectDomains(subtask.prompt);
    return domains[0] ?? "general";
  }

  private formatSiblingInjection(subtask: SubTask, result: string, collector: ResultCollector): string {
    const summary = result.length > 2000 ? result.slice(0, 2000) + "\n...[truncated]" : result;
    const files = collector.getResult(subtask.id)?.files ?? [];
    const apis = collector.extractApis(result);
    return [
      `\n[SIBLING_COMPLETE: ${subtask.agentRole}/${subtask.id}]`,
      `Files: ${files.join(", ") || "none"}`,
      `APIs: ${apis.join(", ") || "none"}`,
      `Summary:\n${summary}`,
      `[/SIBLING_COMPLETE]`,
    ].join("\n");
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
