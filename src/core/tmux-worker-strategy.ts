import type { SubTask, OrchestratorConfig } from "../config/types.ts";
import type { SessionManager } from "../session/manager.ts";
import type { Store } from "../db/store.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import type { WorkerExecutionStrategy, WorkerHandle, WorkerResult } from "./worker-strategy.ts";
import { buildDynamicHarnessAsync } from "../agents/dynamic-harness.ts";
import { buildCommand } from "../agents/provider.ts";

export class TmuxWorkerStrategy implements WorkerExecutionStrategy {
  constructor(
    private config: OrchestratorConfig,
    private sessionManager: SessionManager,
    private store: Store,
    private registry: AgentRegistry,
    private spawnAgentFn: (name: string) => Promise<{ name: string }>,
    private stopAgentFn: (name: string) => Promise<void>,
  ) {}

  async spawn(subtask: SubTask, maxTurns: number, enrichedPrompt: string): Promise<WorkerHandle> {
    const agentName = `worker-${subtask.id.slice(0, 8)}`;
    const providerConfig = this.config.providers[subtask.provider];
    if (!providerConfig) throw new Error(`Unknown provider: ${subtask.provider}`);

    const harness = await buildDynamicHarnessAsync({
      agentName,
      role: subtask.agentRole,
      provider: subtask.provider,
      parentTaskId: subtask.parentTaskId,
      isWorker: true,
      projectDir: process.cwd(),
      prompt: enrichedPrompt,
      turnBudget: maxTurns,
    });

    const profile = {
      name: agentName,
      provider: subtask.provider,
      model: subtask.model,
      role: subtask.agentRole,
      maxBudgetUsd: this.config.budget.defaultMaxPerTask,
      requires: [] as string[],
      worktree: false,
      systemPrompt: harness.systemPrompt,
      maxTurns,
    };

    this.registry.register(profile);
    const session = await this.spawnAgentFn(agentName);
    await this.sessionManager.sendInput(agentName, enrichedPrompt);

    return { agentName, sessionId: session.name };
  }

  async waitForResult(handle: WorkerHandle, timeoutMs: number): Promise<WorkerResult | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const tasks = this.store.listTasks({ agentName: handle.agentName, status: "completed" });
      if (tasks.length > 0) {
        const t = tasks[0];
        return {
          result: t.result ?? "",
          tokenUsage: t.tokenUsage,
          costUsd: t.costUsd,
          inputTokens: t.tokenUsage,
          outputTokens: 0,
        };
      }
      const failed = this.store.listTasks({ agentName: handle.agentName, status: "failed" });
      if (failed.length > 0) {
        throw new Error(failed[0].result ?? "Task failed");
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return null;
  }

  async stop(handle: WorkerHandle): Promise<void> {
    await this.stopAgentFn(handle.agentName);
  }

  async isAlive(handle: WorkerHandle): Promise<boolean> {
    return this.sessionManager.isAlive(handle.agentName).catch(() => false);
  }

  async captureOutput(handle: WorkerHandle, lines = 200): Promise<string> {
    return this.sessionManager.captureOutput(handle.agentName, lines);
  }

  async sendInput(handle: WorkerHandle, message: string): Promise<void> {
    await this.sessionManager.sendInput(handle.agentName, message);
  }
}
