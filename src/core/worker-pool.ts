import type { WorkerState, WorkerStatus, SubTask } from "../config/types.ts";
import { eventBus } from "./events.ts";

export class WorkerPool {
  private workers: Map<string, WorkerState> = new Map();
  private timeoutTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private defaultTimeoutMs: number;
  private maxRetries: number;
  private retryCounts: Map<string, number> = new Map();

  constructor(options?: { timeoutMs?: number; maxRetries?: number }) {
    this.defaultTimeoutMs = options?.timeoutMs ?? 300_000; // 5 minutes
    this.maxRetries = options?.maxRetries ?? 2;
  }

  spawn(subtask: SubTask, agentName: string): WorkerState {
    const worker: WorkerState = {
      id: `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      agentName,
      subtaskId: subtask.id,
      provider: subtask.provider,
      model: subtask.model,
      status: "spawning",
      progress: 0,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      result: null,
      error: null,
      tokenUsage: 0,
      costUsd: 0,
    };

    this.workers.set(worker.id, worker);

    eventBus.publish({
      type: "worker:spawn",
      workerId: worker.id,
      provider: subtask.provider,
      model: subtask.model,
      role: subtask.agentRole,
    });

    // Start timeout timer
    this.startTimeoutTimer(worker.id);

    return worker;
  }

  markRunning(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.status = "running";
    worker.lastActivityAt = new Date().toISOString();
  }

  updateProgress(workerId: string, progress: number): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.progress = Math.min(100, Math.max(0, progress));
    worker.lastActivityAt = new Date().toISOString();

    // Reset timeout on activity
    this.resetTimeoutTimer(workerId);

    eventBus.publish({
      type: "worker:progress",
      workerId,
      progress: worker.progress,
    });
  }

  markCompleted(
    workerId: string,
    result: string,
    usage: { tokenUsage: number; costUsd: number },
  ): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    worker.status = "completed";
    worker.progress = 100;
    worker.result = result;
    worker.tokenUsage = usage.tokenUsage;
    worker.costUsd = usage.costUsd;
    worker.lastActivityAt = new Date().toISOString();

    this.clearTimeoutTimer(workerId);

    const durationMs = new Date(worker.lastActivityAt).getTime() - new Date(worker.startedAt).getTime();

    eventBus.publish({
      type: "worker:complete",
      workerId,
      tokenUsage: usage.tokenUsage,
      costUsd: usage.costUsd,
      durationMs,
    });
  }

  markFailed(workerId: string, error: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    worker.status = "failed";
    worker.error = error;
    worker.lastActivityAt = new Date().toISOString();

    this.clearTimeoutTimer(workerId);

    eventBus.publish({
      type: "worker:fail",
      workerId,
      error,
    });
  }

  canRetry(workerId: string): boolean {
    const count = this.retryCounts.get(workerId) ?? 0;
    return count < this.maxRetries;
  }

  recordRetry(workerId: string): void {
    const count = this.retryCounts.get(workerId) ?? 0;
    this.retryCounts.set(workerId, count + 1);
  }

  get(workerId: string): WorkerState | undefined {
    return this.workers.get(workerId);
  }

  getBySubtask(subtaskId: string): WorkerState | undefined {
    for (const worker of this.workers.values()) {
      if (worker.subtaskId === subtaskId) return worker;
    }
    return undefined;
  }

  getByStatus(...statuses: WorkerStatus[]): WorkerState[] {
    return [...this.workers.values()].filter(w => statuses.includes(w.status));
  }

  getActive(): WorkerState[] {
    return this.getByStatus("spawning", "running");
  }

  getCompleted(): WorkerState[] {
    return this.getByStatus("completed");
  }

  getFailed(): WorkerState[] {
    return this.getByStatus("failed", "timeout");
  }

  getAll(): WorkerState[] {
    return [...this.workers.values()];
  }

  countByStatus(): Record<WorkerStatus, number> {
    const counts: Record<WorkerStatus, number> = {
      spawning: 0, running: 0, completed: 0, failed: 0, timeout: 0,
    };
    for (const w of this.workers.values()) {
      counts[w.status]++;
    }
    return counts;
  }

  getTotalUsage(): { tokens: number; cost: number } {
    let tokens = 0;
    let cost = 0;
    for (const w of this.workers.values()) {
      tokens += w.tokenUsage;
      cost += w.costUsd;
    }
    return { tokens, cost };
  }

  isAllDone(): boolean {
    if (this.workers.size === 0) return false;
    return this.getActive().length === 0;
  }

  clear(): void {
    for (const timer of this.timeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.timeoutTimers.clear();
    this.workers.clear();
    this.retryCounts.clear();
  }

  private startTimeoutTimer(workerId: string): void {
    const timer = setTimeout(() => {
      const worker = this.workers.get(workerId);
      if (worker && (worker.status === "spawning" || worker.status === "running")) {
        worker.status = "timeout";
        worker.error = `Timed out after ${this.defaultTimeoutMs}ms`;
        worker.lastActivityAt = new Date().toISOString();

        eventBus.publish({
          type: "worker:timeout",
          workerId,
          elapsedMs: this.defaultTimeoutMs,
        });
      }
    }, this.defaultTimeoutMs);

    this.timeoutTimers.set(workerId, timer);
  }

  private resetTimeoutTimer(workerId: string): void {
    this.clearTimeoutTimer(workerId);
    this.startTimeoutTimer(workerId);
  }

  private clearTimeoutTimer(workerId: string): void {
    const timer = this.timeoutTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(workerId);
    }
  }
}
