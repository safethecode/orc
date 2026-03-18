import type { SubTask, OrchestratorConfig } from "../config/types.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import type { Store } from "../db/store.ts";
import type { WorkerExecutionStrategy, WorkerHandle, WorkerResult } from "./worker-strategy.ts";
import { AgentStreamer, type ToolUseEvent } from "../repl/streamer.ts";
import { buildCommand } from "../agents/provider.ts";
import { buildHarness } from "../agents/harness.ts";
import { eventBus } from "./events.ts";

interface ActiveWorker {
  streamer: AgentStreamer;
  abort: AbortController;
  textBuffer: string;
  promise: Promise<WorkerResult | null>;
  lastError: string | null;
}

export class StreamerWorkerStrategy implements WorkerExecutionStrategy {
  private workers = new Map<string, ActiveWorker>();

  constructor(
    private config: OrchestratorConfig,
    private registry: AgentRegistry,
    private store: Store,
  ) {}

  async spawn(subtask: SubTask, maxTurns: number, enrichedPrompt: string): Promise<WorkerHandle> {
    const agentName = `worker-${subtask.id.slice(0, 8)}`;
    const providerConfig = this.config.providers[subtask.provider];
    if (!providerConfig) throw new Error(`Unknown provider: ${subtask.provider}`);

    const harness = buildHarness({
      agentName,
      role: subtask.agentRole as any,
      provider: subtask.provider as any,
      parentTaskId: subtask.parentTaskId,
      isWorker: true,
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
    this.store.registerAgent(agentName, subtask.provider, subtask.model);

    const cmd = buildCommand(providerConfig, profile, {
      prompt: enrichedPrompt,
      model: subtask.model,
      systemPrompt: harness.systemPrompt,
      maxTurns,
    });

    const streamer = new AgentStreamer();
    const abort = new AbortController();
    const worker: ActiveWorker = {
      streamer,
      abort,
      textBuffer: "",
      promise: null as any,
      lastError: null,
    };

    // Track tool use events for feedback
    let turnCount = 0;
    streamer.on("tool_use", (tool: ToolUseEvent) => {
      turnCount++;
      eventBus.publish({
        type: "worker:turn",
        workerId: agentName,
        turn: turnCount,
        maxTurns,
        toolUsed: tool.name,
      });
    });

    streamer.on("text_complete", (text: string) => {
      worker.textBuffer += text;
    });

    streamer.on("error", (errText: string) => {
      worker.lastError = errText;
    });

    // Start execution and store the promise
    worker.promise = streamer.run(cmd, abort.signal).then(
      (result) => {
        // Process exited but produced no output — treat as failure
        if (!result.text && !result.inputTokens) {
          worker.lastError = worker.lastError ?? "Worker produced no output";
          return null;
        }
        return {
          result: result.text,
          tokenUsage: result.inputTokens + result.outputTokens,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        };
      },
      (err) => {
        worker.lastError = err instanceof Error ? err.message : String(err);
        return null;
      },
    );

    this.workers.set(agentName, worker);

    return { agentName, sessionId: `streamer-${agentName}` };
  }

  async waitForResult(handle: WorkerHandle, timeoutMs: number): Promise<WorkerResult | null> {
    const worker = this.workers.get(handle.agentName);
    if (!worker) return null;

    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs),
    );

    return Promise.race([worker.promise, timeout]);
  }

  async stop(handle: WorkerHandle): Promise<void> {
    const worker = this.workers.get(handle.agentName);
    if (worker) {
      worker.abort.abort();
      this.workers.delete(handle.agentName);
    }
  }

  async isAlive(handle: WorkerHandle): Promise<boolean> {
    return this.workers.has(handle.agentName);
  }

  async captureOutput(handle: WorkerHandle): Promise<string> {
    const worker = this.workers.get(handle.agentName);
    return worker?.textBuffer ?? "";
  }

  getLastError(handle: WorkerHandle): string | null {
    return this.workers.get(handle.agentName)?.lastError ?? null;
  }

  async sendInput(_handle: WorkerHandle, _message: string): Promise<void> {
    // AgentStreamer uses stdin: "ignore" — mid-run corrections are not supported.
    // Corrections are handled post-completion via quality gate and retry.
  }
}
