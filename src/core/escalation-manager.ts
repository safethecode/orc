import type { StuckEvent, EscalationLevel } from "./stuck-detector.ts";
import { eventBus } from "./events.ts";

export type EscalationAction =
  | { type: "log"; message: string }
  | { type: "nudge"; workerId: string; message: string }
  | { type: "restart"; workerId: string }
  | { type: "reassign"; workerId: string; newProvider?: string }
  | { type: "abort"; workerId: string; reason: string }
  | { type: "human"; workerId: string; summary: string; suggestedActions: string[] };

export interface EscalationPolicy {
  level: EscalationLevel;
  actions: EscalationAction[];
}

export class EscalationManager {
  private history: Map<string, StuckEvent[]> = new Map();
  private humanCallbacks: Array<(event: StuckEvent, actions: string[]) => void> = [];

  constructor() {}

  /**
   * Process a stuck event and determine actions.
   * Returns the policy with concrete actions to execute.
   */
  escalate(event: StuckEvent): EscalationPolicy {
    // Record in history
    const workerHistory = this.history.get(event.workerId) ?? [];
    workerHistory.push(event);
    this.history.set(event.workerId, workerHistory);

    const actions: EscalationAction[] = [];

    switch (event.level) {
      case "warn":
        actions.push({
          type: "log",
          message: `Worker ${event.workerId} may be stuck: ${event.details}`,
        });
        break;

      case "intervene":
        actions.push({
          type: "log",
          message: `Worker ${event.workerId} stuck for ${Math.round(event.staleDurationMs / 1000)}s: ${event.details}`,
        });
        actions.push({
          type: "nudge",
          workerId: event.workerId,
          message: this.buildNudgeMessage(event),
        });
        break;

      case "abort":
        actions.push({
          type: "log",
          message: `Aborting worker ${event.workerId} after ${Math.round(event.staleDurationMs / 1000)}s stuck: ${event.details}`,
        });

        // If it's an error loop or repeated output, try reassigning first
        if (event.reason === "error_loop" || event.reason === "repeated_output") {
          actions.push({
            type: "reassign",
            workerId: event.workerId,
          });
        } else {
          actions.push({
            type: "abort",
            workerId: event.workerId,
            reason: event.details,
          });
        }
        break;

      case "human": {
        const summary = this.buildHumanSummary(event, workerHistory);
        const suggestedActions = [
          "Manually inspect worker output",
          "Restart the worker with a modified prompt",
          "Abort the task and try a different approach",
          "Check for external issues (rate limits, network, etc.)",
        ];

        actions.push({
          type: "log",
          message: `HUMAN ESCALATION: Worker ${event.workerId} stuck for ${Math.round(event.staleDurationMs / 1000)}s`,
        });
        actions.push({
          type: "human",
          workerId: event.workerId,
          summary,
          suggestedActions,
        });

        // Invoke human escalation callbacks
        for (const cb of this.humanCallbacks) {
          try {
            cb(event, suggestedActions);
          } catch {
            // Don't let callback errors break escalation
          }
        }
        break;
      }
    }

    eventBus.publish({
      type: "stuck:escalated",
      workerId: event.workerId,
      level: event.level,
      action: actions.map((a) => a.type).join(","),
    });

    return { level: event.level, actions };
  }

  /**
   * Register callback for human escalation.
   * When level reaches "human", these callbacks are invoked.
   */
  onHumanEscalation(callback: (event: StuckEvent, actions: string[]) => void): void {
    this.humanCallbacks.push(callback);
  }

  /**
   * Get escalation history for a worker.
   */
  getHistory(workerId: string): StuckEvent[] {
    return this.history.get(workerId) ?? [];
  }

  /**
   * Build a nudge message appropriate for the stuck reason.
   */
  private buildNudgeMessage(event: StuckEvent): string {
    switch (event.reason) {
      case "no_activity":
        return `[Supervisor]: No activity detected for ${Math.round(event.staleDurationMs / 1000)}s. Are you stuck? Please continue with the task or report your status.`;
      case "repeated_output":
        return `[Supervisor]: I'm detecting repeated output, which suggests you may be in a loop. Please try a different approach or report what's blocking you.`;
      case "spinner_loop":
        return `[Supervisor]: You appear to be stuck thinking without taking action. Please use a tool or describe what's blocking you.`;
      case "error_loop":
        return `[Supervisor]: The same error is repeating. Please try a different approach instead of retrying the same fix.`;
      case "turn_stall":
        return `[Supervisor]: Your turn counter hasn't advanced. Please continue working or report if you're blocked.`;
      case "rate_limited":
        return `[Supervisor]: Rate limit detected. Pausing until limit expires.`;
    }
  }

  /**
   * Build human-readable summary for escalation notification.
   */
  private buildHumanSummary(event: StuckEvent, history: StuckEvent[]): string {
    const lines: string[] = [];

    lines.push(`Worker ${event.workerId} has been stuck for ${Math.round(event.staleDurationMs / 1000)} seconds.`);
    lines.push(`Current reason: ${event.reason} - ${event.details}`);
    lines.push(`Suggested action: ${event.suggestedAction}`);

    if (history.length > 1) {
      lines.push("");
      lines.push(`Escalation history (${history.length} events):`);

      // Show last 5 events
      const recentHistory = history.slice(-5);
      for (const h of recentHistory) {
        const timeAgo = Math.round((Date.now() - (Date.now() - h.staleDurationMs)) / 1000);
        lines.push(`  - [${h.level}] ${h.reason}: ${h.details} (${timeAgo}s ago)`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Clean up tracking data for a worker.
   */
  cleanup(workerId: string): void {
    this.history.delete(workerId);
  }
}
