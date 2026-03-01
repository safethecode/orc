import { eventBus } from "./events.ts";

export type DLQReason =
  | "max_retries_exceeded"
  | "non_retryable_error"
  | "timeout_exhausted"
  | "cancelled_with_error"
  | "escalation_unresolved"
  | "rate_limit_exhausted"
  | "budget_exceeded";

export interface DeadLetter {
  id: string;
  taskId: string;
  subtaskId: string;
  workerId: string;
  agentName: string;
  provider: string;
  model: string;
  prompt: string;
  error: string;
  reason: DLQReason;
  attempts: number;
  lastAttemptAt: string;
  enqueuedAt: string;
  metadata: {
    tokenUsage: number;
    costUsd: number;
    turnHistory: string[];
    corrections: string[];
    intermediateResults: string[];
  };
  status: "pending" | "retrying" | "resolved" | "discarded";
}

export class DeadLetterQueue {
  private letters: Map<string, DeadLetter> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  enqueue(opts: {
    taskId: string;
    subtaskId: string;
    workerId: string;
    agentName: string;
    provider: string;
    model: string;
    prompt: string;
    error: string;
    reason: DLQReason;
    attempts: number;
    metadata: DeadLetter["metadata"];
  }): DeadLetter {
    const id = `dlq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const letter: DeadLetter = {
      id,
      taskId: opts.taskId,
      subtaskId: opts.subtaskId,
      workerId: opts.workerId,
      agentName: opts.agentName,
      provider: opts.provider,
      model: opts.model,
      prompt: opts.prompt,
      error: opts.error,
      reason: opts.reason,
      attempts: opts.attempts,
      lastAttemptAt: now,
      enqueuedAt: now,
      metadata: opts.metadata,
      status: "pending",
    };

    this.letters.set(id, letter);
    this.evict();

    eventBus.publish({
      type: "dlq:enqueue",
      id,
      taskId: opts.taskId,
      reason: opts.reason,
      error: opts.error,
    });

    return letter;
  }

  list(status?: DeadLetter["status"]): DeadLetter[] {
    const all = [...this.letters.values()];
    if (!status) return all;
    return all.filter((l) => l.status === status);
  }

  get(id: string): DeadLetter | undefined {
    // Exact match first
    const exact = this.letters.get(id);
    if (exact) return exact;

    // Partial ID match
    for (const [key, letter] of this.letters) {
      if (key.startsWith(id)) return letter;
    }
    return undefined;
  }

  markRetrying(id: string): boolean {
    const letter = this.get(id);
    if (!letter || letter.status !== "pending") return false;
    letter.status = "retrying";

    eventBus.publish({
      type: "dlq:retry",
      id: letter.id,
      taskId: letter.taskId,
    });

    return true;
  }

  markResolved(id: string): boolean {
    const letter = this.get(id);
    if (!letter) return false;
    letter.status = "resolved";

    eventBus.publish({
      type: "dlq:resolved",
      id: letter.id,
      taskId: letter.taskId,
    });

    return true;
  }

  discard(id: string): boolean {
    const letter = this.get(id);
    if (!letter) return false;
    letter.status = "discarded";

    eventBus.publish({
      type: "dlq:discarded",
      id: letter.id,
      taskId: letter.taskId,
    });

    return true;
  }

  getRetryPayload(id: string): {
    prompt: string;
    errorContext: string;
    previousAttempts: number;
  } | null {
    const letter = this.get(id);
    if (!letter) return null;

    return {
      prompt: letter.prompt,
      errorContext: this.buildErrorContext(letter),
      previousAttempts: letter.attempts,
    };
  }

  stats(): {
    total: number;
    pending: number;
    retrying: number;
    resolved: number;
    discarded: number;
    totalCostWasted: number;
    topErrors: Array<{ error: string; count: number }>;
  } {
    let pending = 0;
    let retrying = 0;
    let resolved = 0;
    let discarded = 0;
    let totalCostWasted = 0;

    const errorCounts = new Map<string, number>();

    for (const letter of this.letters.values()) {
      switch (letter.status) {
        case "pending": pending++; break;
        case "retrying": retrying++; break;
        case "resolved": resolved++; break;
        case "discarded": discarded++; break;
      }

      totalCostWasted += letter.metadata.costUsd;

      // Group errors by first 100 chars for similarity
      const errorKey = letter.error.slice(0, 100);
      errorCounts.set(errorKey, (errorCounts.get(errorKey) ?? 0) + 1);
    }

    const topErrors = [...errorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([error, count]) => ({ error, count }));

    return {
      total: this.letters.size,
      pending,
      retrying,
      resolved,
      discarded,
      totalCostWasted,
      topErrors,
    };
  }

  private evict(): void {
    if (this.letters.size <= this.maxSize) return;

    // Collect resolved/discarded entries sorted by enqueuedAt (oldest first)
    const evictable: DeadLetter[] = [];
    for (const letter of this.letters.values()) {
      if (letter.status === "resolved" || letter.status === "discarded") {
        evictable.push(letter);
      }
    }

    evictable.sort((a, b) => new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime());

    // Remove oldest resolved/discarded until under maxSize
    let idx = 0;
    while (this.letters.size > this.maxSize && idx < evictable.length) {
      this.letters.delete(evictable[idx].id);
      idx++;
    }
  }

  private buildErrorContext(letter: DeadLetter): string {
    const parts: string[] = [];

    parts.push(`Previous attempt failed with: ${letter.error}`);
    parts.push(`Reason: ${letter.reason}`);
    parts.push(`Attempts: ${letter.attempts}`);

    if (letter.metadata.corrections.length > 0) {
      parts.push(`Corrections sent during previous attempts:`);
      for (const correction of letter.metadata.corrections) {
        parts.push(`  - ${correction}`);
      }
    }

    if (letter.metadata.turnHistory.length > 0) {
      parts.push(`Turn history from previous attempt:`);
      for (const turn of letter.metadata.turnHistory.slice(-5)) {
        parts.push(`  - ${turn}`);
      }
    }

    if (letter.metadata.intermediateResults.length > 0) {
      const lastResult = letter.metadata.intermediateResults[letter.metadata.intermediateResults.length - 1];
      parts.push(`Last intermediate result: ${lastResult.slice(0, 500)}`);
    }

    parts.push(`Avoid repeating the same approach that led to this failure.`);

    return parts.join("\n");
  }

  clear(): void {
    // Remove only resolved and discarded entries
    for (const [id, letter] of this.letters) {
      if (letter.status === "resolved" || letter.status === "discarded") {
        this.letters.delete(id);
      }
    }
  }
}
