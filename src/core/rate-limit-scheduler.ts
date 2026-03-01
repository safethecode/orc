import { eventBus } from "./events.ts";

export interface RateLimitEntry {
  taskId: string;
  workerId: string;
  detectedAt: number;
  retryAfterMs: number;
  retryAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  onResume: () => void;
}

export interface RateLimitInfo {
  taskId: string;
  workerId: string;
  retryAt: Date;
  remainingMs: number;
  formattedCountdown: string;
}

export class RateLimitScheduler {
  private entries: Map<string, RateLimitEntry> = new Map();

  /**
   * Schedule a task to resume after rate limit expires.
   * Returns the retry timestamp.
   */
  schedule(opts: {
    taskId: string;
    workerId: string;
    retryAfterMs: number;
    onResume: () => void;
  }): Date {
    // Cancel any existing schedule for this task
    this.cancel(opts.taskId);

    const now = Date.now();
    const retryAt = now + opts.retryAfterMs;

    const timer = setTimeout(() => {
      const entry = this.entries.get(opts.taskId);
      if (!entry) return;

      this.entries.delete(opts.taskId);

      const waitedMs = Date.now() - entry.detectedAt;
      eventBus.publish({
        type: "ratelimit:resumed",
        taskId: opts.taskId,
        waitedMs,
      });

      entry.onResume();
    }, opts.retryAfterMs);

    // Ensure timer doesn't prevent process exit
    if (timer && typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    const entry: RateLimitEntry = {
      taskId: opts.taskId,
      workerId: opts.workerId,
      detectedAt: now,
      retryAfterMs: opts.retryAfterMs,
      retryAt,
      timer,
      onResume: opts.onResume,
    };

    this.entries.set(opts.taskId, entry);

    const retryAtDate = new Date(retryAt);
    eventBus.publish({
      type: "ratelimit:scheduled",
      taskId: opts.taskId,
      retryAt: retryAtDate.toISOString(),
      retryAfterMs: opts.retryAfterMs,
    });

    return retryAtDate;
  }

  /**
   * Cancel a scheduled resume.
   */
  cancel(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;

    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }

    this.entries.delete(taskId);

    eventBus.publish({
      type: "ratelimit:cancelled",
      taskId,
    });
  }

  /**
   * Get all currently rate-limited entries.
   */
  getAll(): RateLimitInfo[] {
    const now = Date.now();
    const result: RateLimitInfo[] = [];

    for (const entry of this.entries.values()) {
      const remainingMs = Math.max(0, entry.retryAt - now);
      result.push({
        taskId: entry.taskId,
        workerId: entry.workerId,
        retryAt: new Date(entry.retryAt),
        remainingMs,
        formattedCountdown: this.formatCountdown(remainingMs),
      });
    }

    return result;
  }

  /**
   * Check if a task is currently rate-limited.
   */
  isLimited(taskId: string): boolean {
    const entry = this.entries.get(taskId);
    if (!entry) return false;
    // If the retry time has already passed, it's no longer limited
    return entry.retryAt > Date.now();
  }

  /**
   * Format remaining time as human-readable string.
   *
   * Examples:
   *   0 -> "0s"
   *   5000 -> "5s"
   *   65000 -> "1m 05s"
   *   3600000 -> "1h 00m"
   *   3661000 -> "1h 01m"
   */
  formatCountdown(ms: number): string {
    if (ms <= 0) return "0s";

    const totalSeconds = Math.ceil(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    }

    if (minutes > 0) {
      return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }

    return `${seconds}s`;
  }

  /**
   * Clear all scheduled resumes and clean up timers.
   */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
    }
    this.entries.clear();
  }
}
