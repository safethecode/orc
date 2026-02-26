import type { Task } from "../config/types.ts";

interface QueuedTask {
  task: Task;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
}

export class Scheduler {
  private maxConcurrent: number;
  private running: Set<string>;
  private queue: QueuedTask[];

  constructor(maxConcurrent: number = 3) {
    this.maxConcurrent = maxConcurrent;
    this.running = new Set();
    this.queue = [];
  }

  async acquire(task: Task): Promise<void> {
    if (this.running.size < this.maxConcurrent) {
      this.running.add(task.id);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
    });
  }

  release(taskId: string): void {
    this.running.delete(taskId);

    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.running.add(next.task.id);
      next.resolve();
    }
  }

  getRunningCount(): number {
    return this.running.size;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getRunningTasks(): string[] {
    return Array.from(this.running);
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  clear(): void {
    for (const queued of this.queue) {
      queued.reject(new Error("Scheduler cleared"));
    }
    this.queue = [];
    this.running.clear();
  }
}
