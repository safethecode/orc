import { eventBus } from "./events.ts";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTask {
  id: string;
  prompt: string;
  provider: string;
  model: string;
  status: TaskStatus;
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
  pid?: number;
}

export interface BackgroundSpawnOpts {
  prompt: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  maxTurns?: number;
  cwd?: string;
}

/**
 * Spawns and manages multiple agents running in parallel background processes.
 * Each agent runs as a subprocess via Bun.spawn, with stdout piped for output capture.
 * Concurrency is tracked per provider to avoid overwhelming any single API.
 */
export class BackgroundAgentManager {
  private tasks: Map<string, BackgroundTask> = new Map();
  private processes: Map<string, import("bun").Subprocess> = new Map();
  private concurrencyLimits: Map<string, number> = new Map();
  private defaultConcurrency = 3;

  constructor() {}

  /** Spawn a background agent task. Returns the generated taskId. */
  async spawn(opts: BackgroundSpawnOpts): Promise<string> {
    if (!this.canSpawn(opts.provider)) {
      throw new Error(
        `Concurrency limit reached for provider "${opts.provider}" ` +
        `(${this.getRunningCount(opts.provider)}/${this.concurrencyLimits.get(opts.provider) ?? this.defaultConcurrency})`,
      );
    }

    const taskId = this.generateId();

    const task: BackgroundTask = {
      id: taskId,
      prompt: opts.prompt,
      provider: opts.provider,
      model: opts.model,
      status: "pending",
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, task);

    // Build CLI command based on provider
    const cmd = this.buildCommand(opts);

    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    task.status = "running";
    task.pid = proc.pid;
    this.processes.set(taskId, proc);

    eventBus.publish({
      type: "worker:spawn",
      workerId: taskId,
      provider: opts.provider,
      model: opts.model,
      role: "background",
    });

    // Read stdout in the background, resolve when process exits
    this.drainProcess(taskId, proc);

    return taskId;
  }

  /** Poll task status without blocking. */
  poll(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Wait for a task to complete and return its output. Throws on failure/timeout. */
  async getResult(taskId: string, timeoutMs = 300_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);

      if (task.status === "completed") return task.output ?? "";
      if (task.status === "failed") throw new Error(task.error ?? "Task failed");
      if (task.status === "cancelled") throw new Error("Task was cancelled");

      await Bun.sleep(500);
    }

    throw new Error(`Task ${taskId} timed out after ${timeoutMs}ms`);
  }

  /** Cancel a running task by killing its subprocess. */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status !== "running" && task.status !== "pending") return false;

    const proc = this.processes.get(taskId);
    if (proc) {
      proc.kill();
      this.processes.delete(taskId);
    }

    task.status = "cancelled";
    task.completedAt = new Date().toISOString();
    return true;
  }

  /** List all tasks, optionally filtered by status. */
  list(status?: TaskStatus): BackgroundTask[] {
    const all = [...this.tasks.values()];
    if (!status) return all;
    return all.filter((t) => t.status === status);
  }

  /** List only running tasks. */
  listActive(): BackgroundTask[] {
    return this.list("running");
  }

  /** Count running tasks, optionally for a specific provider. */
  getRunningCount(provider?: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      if (provider && task.provider !== provider) continue;
      count++;
    }
    return count;
  }

  /** Set the maximum number of concurrent tasks for a provider. */
  setConcurrencyLimit(provider: string, limit: number): void {
    this.concurrencyLimits.set(provider, limit);
  }

  /** Check whether a new task can be spawned for the given provider. */
  canSpawn(provider: string): boolean {
    const limit = this.concurrencyLimits.get(provider) ?? this.defaultConcurrency;
    return this.getRunningCount(provider) < limit;
  }

  /** Remove completed/failed/cancelled tasks older than maxAgeMs. Returns count cleaned. */
  cleanup(maxAgeMs = 600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let cleaned = 0;

    for (const [id, task] of this.tasks) {
      if (task.status === "running" || task.status === "pending") continue;
      if (!task.completedAt) continue;

      const completedTime = new Date(task.completedAt).getTime();
      if (completedTime < cutoff) {
        this.tasks.delete(id);
        this.processes.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /** Kill all running processes and clear all state. */
  async shutdownAll(): Promise<void> {
    const killPromises: Promise<number>[] = [];

    for (const [id, proc] of this.processes) {
      const task = this.tasks.get(id);
      if (task && (task.status === "running" || task.status === "pending")) {
        proc.kill();
        task.status = "cancelled";
        task.completedAt = new Date().toISOString();
        killPromises.push(proc.exited);
      }
    }

    // Wait for all processes to actually exit
    await Promise.allSettled(killPromises);

    this.processes.clear();
    this.tasks.clear();
  }

  /** Handle process completion: read stdout, update task state, publish events. */
  private handleComplete(taskId: string, stdout: string, exitCode: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    // Task may have been cancelled while draining
    if (task.status === "cancelled") return;

    task.completedAt = new Date().toISOString();
    const durationMs = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();

    if (exitCode === 0) {
      task.status = "completed";
      task.output = stdout;

      eventBus.publish({
        type: "worker:complete",
        workerId: taskId,
        tokenUsage: 0,
        costUsd: 0,
        durationMs,
      });
    } else {
      task.status = "failed";
      task.error = stdout || `Process exited with code ${exitCode}`;

      eventBus.publish({
        type: "worker:fail",
        workerId: taskId,
        error: task.error,
      });
    }

    this.processes.delete(taskId);
  }

  /** Generate a short, unique task ID. */
  private generateId(): string {
    return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Build CLI command array for the given provider. */
  private buildCommand(opts: BackgroundSpawnOpts): string[] {
    const { prompt, provider, model, systemPrompt, maxTurns } = opts;

    if (provider === "claude") {
      const cmd = [
        "claude",
        "-p", prompt,
        "--model", model,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (maxTurns != null) cmd.push("--max-turns", String(maxTurns));
      if (systemPrompt) cmd.push("--system-prompt", systemPrompt);
      return cmd;
    }

    if (provider === "codex") {
      const codexPrompt = systemPrompt
        ? `${systemPrompt}\n\n---\n\n${prompt}`
        : prompt;
      return ["codex", "exec", codexPrompt, "--full-auto"];
    }

    if (provider === "gemini") {
      const cmd = ["gemini", "-p", prompt];
      if (model) cmd.push("--model", model);
      if (systemPrompt) cmd.push("--system-prompt", systemPrompt);
      return cmd;
    }

    // Generic fallback: providerBinary -p prompt
    return [provider, "-p", prompt];
  }

  /** Drain stdout from a subprocess and handle completion. Runs in background. */
  private async drainProcess(taskId: string, proc: import("bun").Subprocess): Promise<void> {
    try {
      const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
      const exitCode = await proc.exited;
      this.handleComplete(taskId, stdout, exitCode);
    } catch (err) {
      const task = this.tasks.get(taskId);
      if (task && task.status === "running") {
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = new Date().toISOString();

        eventBus.publish({
          type: "worker:fail",
          workerId: taskId,
          error: task.error,
        });
      }
      this.processes.delete(taskId);
    }
  }
}
