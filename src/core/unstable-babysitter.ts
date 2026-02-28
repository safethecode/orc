// ── Unstable Agent Babysitter ─────────────────────────────────────────
// Monitors background tasks and nudges stuck agents back into action.

export interface HealthCheck {
  taskId: string;
  idleMs: number;
  status: "healthy" | "idle" | "stuck";
}

export class UnstableBabysitter {
  private idleThresholdMs: number;
  private cooldowns: Map<string, number> = new Map(); // taskId -> last nudge timestamp
  private cooldownMs = 300_000; // 5 minutes between nudges

  constructor(idleThresholdMs?: number) {
    this.idleThresholdMs = idleThresholdMs ?? 120_000; // 2 minutes
  }

  /**
   * Check health of background tasks based on their last activity timestamps.
   * Returns a HealthCheck for each task with idle duration and status.
   */
  checkHealth(
    tasks: Array<{ id: string; status: string; lastActivityAt: number }>,
  ): HealthCheck[] {
    const now = Date.now();

    return tasks.map((task) => {
      const idleMs = now - task.lastActivityAt;

      // Completed or failed tasks are not monitored
      if (task.status === "completed" || task.status === "failed") {
        return { taskId: task.id, idleMs: 0, status: "healthy" as const };
      }

      if (idleMs > this.idleThresholdMs * 2) {
        return { taskId: task.id, idleMs, status: "stuck" as const };
      }

      if (idleMs > this.idleThresholdMs) {
        return { taskId: task.id, idleMs, status: "idle" as const };
      }

      return { taskId: task.id, idleMs, status: "healthy" as const };
    });
  }

  /**
   * Determine whether a task should be nudged.
   * True if idle exceeds the threshold AND the task is not on cooldown.
   */
  shouldNudge(taskId: string, idleMs: number): boolean {
    if (idleMs <= this.idleThresholdMs) {
      return false;
    }

    const lastNudge = this.cooldowns.get(taskId);
    if (lastNudge !== undefined) {
      const elapsed = Date.now() - lastNudge;
      if (elapsed < this.cooldownMs) {
        return false;
      }
    }

    return true;
  }

  /**
   * Build a nudge/reminder prompt for a stuck task.
   * Includes the original task prompt so the agent has context.
   */
  buildNudge(taskId: string, originalPrompt: string): string {
    return [
      `You appear to be idle on task ${taskId}.`,
      "",
      `Your task: ${originalPrompt}`,
      "",
      'Please continue working on the task, or say "TASK_COMPLETE" if you are finished.',
    ].join("\n");
  }

  /** Record that a nudge was sent for a task. */
  recordNudge(taskId: string): void {
    this.cooldowns.set(taskId, Date.now());
  }

  /** Reset the cooldown for a specific task. */
  resetCooldown(taskId: string): void {
    this.cooldowns.delete(taskId);
  }

  /** Clear all cooldowns. */
  reset(): void {
    this.cooldowns.clear();
  }
}
