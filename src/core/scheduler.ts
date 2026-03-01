import type { Task } from "../config/types.ts";
import { eventBus } from "./events.ts";

export type TaskPriority = "critical" | "high" | "normal" | "low" | "background";

const PRIORITY_VALUES: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
  background: 4,
};

const PRIORITY_LEVELS: TaskPriority[] = ["critical", "high", "normal", "low", "background"];

interface PriorityQueuedTask {
  task: Task;
  priority: TaskPriority;
  enqueuedAt: number;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
}

interface RunningEntry {
  task: Task;
  priority: TaskPriority;
  startedAt: number;
}

export class PriorityScheduler {
  private maxConcurrent: number;
  private running: Map<string, RunningEntry>;
  private queue: PriorityQueuedTask[];

  constructor(maxConcurrent: number = 3) {
    this.maxConcurrent = maxConcurrent;
    this.running = new Map();
    this.queue = [];
  }

  async acquire(task: Task, priority: TaskPriority = "normal"): Promise<void> {
    if (this.running.size < this.maxConcurrent) {
      this.running.set(task.id, { task, priority, startedAt: Date.now() });
      return;
    }

    // If critical, try preemption before queuing
    if (priority === "critical" && this.tryPreempt(task)) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const entry: PriorityQueuedTask = {
        task,
        priority,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      };
      this.queue.push(entry);
      this.sortQueue();

      const position = this.queue.indexOf(entry) + 1;
      eventBus.publish({
        type: "queue:enqueue",
        taskId: task.id,
        priority,
        position,
      });
    });
  }

  release(taskId: string): void {
    this.running.delete(taskId);
    this.processNext();
  }

  /**
   * Force-execute a task immediately, bypassing the maxConcurrent limit.
   * Use for urgent tasks that cannot wait.
   */
  forceExecute(task: Task): void {
    // If already queued, remove from queue and resolve
    const idx = this.queue.findIndex((q) => q.task.id === task.id);
    if (idx !== -1) {
      const entry = this.queue.splice(idx, 1)[0];
      this.running.set(task.id, {
        task,
        priority: entry.priority,
        startedAt: Date.now(),
      });
      entry.resolve();
    } else {
      // Not in queue — just add to running directly
      this.running.set(task.id, {
        task,
        priority: "critical",
        startedAt: Date.now(),
      });
    }

    eventBus.publish({ type: "queue:force_execute", taskId: task.id });
  }

  /**
   * Change the priority of a queued task.
   * Returns true if the task was found and updated.
   */
  setPriority(taskId: string, newPriority: TaskPriority): boolean {
    const entry = this.queue.find((q) => q.task.id === taskId);
    if (!entry) return false;

    const oldPriority = entry.priority;
    entry.priority = newPriority;
    this.sortQueue();

    eventBus.publish({
      type: "queue:priority_change",
      taskId,
      from: oldPriority,
      to: newPriority,
    });

    return true;
  }

  /**
   * Promote a queued task one priority level up.
   * Returns true if successful.
   */
  promote(taskId: string): boolean {
    const entry = this.queue.find((q) => q.task.id === taskId);
    if (!entry) return false;

    const currentIdx = PRIORITY_LEVELS.indexOf(entry.priority);
    if (currentIdx <= 0) return false; // already at highest

    const oldPriority = entry.priority;
    entry.priority = PRIORITY_LEVELS[currentIdx - 1];
    this.sortQueue();

    eventBus.publish({
      type: "queue:priority_change",
      taskId,
      from: oldPriority,
      to: entry.priority,
    });

    return true;
  }

  /**
   * Demote a queued task one priority level down.
   * Returns true if successful.
   */
  demote(taskId: string): boolean {
    const entry = this.queue.find((q) => q.task.id === taskId);
    if (!entry) return false;

    const currentIdx = PRIORITY_LEVELS.indexOf(entry.priority);
    if (currentIdx >= PRIORITY_LEVELS.length - 1) return false; // already at lowest

    const oldPriority = entry.priority;
    entry.priority = PRIORITY_LEVELS[currentIdx + 1];
    this.sortQueue();

    eventBus.publish({
      type: "queue:priority_change",
      taskId,
      from: oldPriority,
      to: entry.priority,
    });

    return true;
  }

  /**
   * Remove a task from the queue. Returns true if found and removed.
   */
  cancel(taskId: string): boolean {
    const idx = this.queue.findIndex((q) => q.task.id === taskId);
    if (idx === -1) return false;

    const entry = this.queue.splice(idx, 1)[0];
    entry.reject(new Error("Task cancelled"));
    return true;
  }

  /**
   * Snapshot of all queued tasks, ordered by priority then age.
   */
  getQueueSnapshot(): Array<{
    taskId: string;
    priority: TaskPriority;
    waitingMs: number;
    position: number;
  }> {
    const now = Date.now();
    return this.queue.map((entry, idx) => ({
      taskId: entry.task.id,
      priority: entry.priority,
      waitingMs: now - entry.enqueuedAt,
      position: idx + 1,
    }));
  }

  /**
   * Snapshot of all currently running tasks.
   */
  getRunningSnapshot(): Array<{
    taskId: string;
    priority: TaskPriority;
    runningMs: number;
  }> {
    const now = Date.now();
    const result: Array<{ taskId: string; priority: TaskPriority; runningMs: number }> = [];
    for (const [taskId, entry] of this.running) {
      result.push({
        taskId,
        priority: entry.priority,
        runningMs: now - entry.startedAt,
      });
    }
    return result;
  }

  getRunningCount(): number {
    return this.running.size;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getRunningTasks(): string[] {
    return Array.from(this.running.keys());
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

  /**
   * Attempt to preempt the lowest-priority running task to make room
   * for a critical incoming task. Paused task goes back into queue.
   * Returns true if preemption succeeded.
   */
  private tryPreempt(incomingTask: Task): boolean {
    if (this.running.size === 0) return false;

    // Find the lowest-priority (highest numeric value) running task
    let lowestEntry: RunningEntry | null = null;
    let lowestId: string | null = null;
    let lowestValue = -1;

    for (const [id, entry] of this.running) {
      const val = PRIORITY_VALUES[entry.priority];
      if (val > lowestValue) {
        lowestValue = val;
        lowestEntry = entry;
        lowestId = id;
      }
    }

    // Only preempt if the running task has lower priority than critical (0)
    if (!lowestEntry || !lowestId || lowestValue <= PRIORITY_VALUES.critical) {
      return false;
    }

    // Remove from running
    this.running.delete(lowestId);

    // Put preempted task back in queue with its original priority
    // It gets a new promise since the old one was already resolved
    const preemptedTask = lowestEntry.task;
    const preemptedPriority = lowestEntry.priority;

    // Re-enqueue the preempted task (no-op promise — it's already running somewhere)
    this.queue.push({
      task: preemptedTask,
      priority: preemptedPriority,
      enqueuedAt: Date.now(),
      resolve: () => {},
      reject: () => {},
    });
    this.sortQueue();

    // Give the slot to the incoming critical task
    this.running.set(incomingTask.id, {
      task: incomingTask,
      priority: "critical",
      startedAt: Date.now(),
    });

    eventBus.publish({
      type: "queue:preempt",
      preemptedTaskId: lowestId,
      byTaskId: incomingTask.id,
    });

    return true;
  }

  /**
   * Sort queue by priority (lower numeric = higher priority), then by
   * enqueue time (older first) for tiebreaking within the same level.
   */
  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const prioDiff = PRIORITY_VALUES[a.priority] - PRIORITY_VALUES[b.priority];
      if (prioDiff !== 0) return prioDiff;
      return a.enqueuedAt - b.enqueuedAt; // older first
    });
  }

  /**
   * When a slot opens, pick the highest-priority waiting task.
   */
  private processNext(): void {
    if (this.queue.length === 0) return;
    if (this.running.size >= this.maxConcurrent) return;

    // Queue is already sorted — first entry is highest priority
    const next = this.queue.shift()!;
    this.running.set(next.task.id, {
      task: next.task,
      priority: next.priority,
      startedAt: Date.now(),
    });

    const waitedMs = Date.now() - next.enqueuedAt;
    eventBus.publish({
      type: "queue:dequeue",
      taskId: next.task.id,
      waitedMs,
    });

    next.resolve();
  }
}

// Re-export under old name for backward compatibility
export { PriorityScheduler as Scheduler };
