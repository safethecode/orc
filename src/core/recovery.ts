import type { FailureType, RecoveryAction, RecoveryAttempt, RecoveryDecision } from "../config/types.ts";

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter((t) => t.length > 0));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class RecoveryManager {
  private attempts: Map<string, RecoveryAttempt[]> = new Map();
  private lastKnownGood: Map<string, string> = new Map();

  classifyFailure(error: string, _context: { taskId: string }): FailureType {
    const lower = error.toLowerCase();
    if (/\b(build|compile|syntax|parse)\s*(error|fail)/i.test(lower)) return "broken_build";
    if (/\b(verify|assert|expect|test)\s*(fail|error)/i.test(lower)) return "verification_failed";
    if (/\b(context|token|limit|overflow|exceed)/i.test(lower)) return "context_exhausted";
    if (/\b(timeout|timed?\s*out|deadline)/i.test(lower)) return "timeout";
    return "unknown";
  }

  detectCircularFix(taskId: string, approach: string): boolean {
    const prev = this.attempts.get(taskId);
    if (!prev || prev.length === 0) return false;

    const approachTokens = tokenize(approach);
    for (const attempt of prev) {
      const similarity = jaccardSimilarity(approachTokens, tokenize(attempt.approach));
      if (similarity >= 0.7) return true;
    }
    return false;
  }

  decide(taskId: string, failure: FailureType): RecoveryDecision {
    const attempts = this.attempts.get(taskId) ?? [];
    const attemptCount = attempts.length;

    if (failure === "broken_build") {
      const sha = this.lastKnownGood.get(taskId);
      if (sha) {
        return { action: "rollback", reason: "Build broken, rolling back to last known good", rollbackTarget: sha };
      }
      return { action: "retry", reason: "Build broken, no rollback target available" };
    }

    if (failure === "circular_fix") {
      return { action: "change_approach", reason: "Circular fix detected, need different approach" };
    }

    if (failure === "context_exhausted") {
      return { action: "skip", reason: "Context exhausted, skipping task" };
    }

    if (failure === "verification_failed" && attemptCount < 3) {
      return { action: "retry", reason: `Verification failed, attempt ${attemptCount + 1}/3` };
    }

    if (failure === "timeout") {
      return attemptCount < 2
        ? { action: "retry", reason: "Timeout, retrying" }
        : { action: "escalate", reason: "Repeated timeouts" };
    }

    return { action: "escalate", reason: `Unresolvable failure after ${attemptCount} attempts` };
  }

  recordAttempt(attempt: RecoveryAttempt): void {
    if (!this.attempts.has(attempt.taskId)) {
      this.attempts.set(attempt.taskId, []);
    }
    this.attempts.get(attempt.taskId)!.push(attempt);
  }

  getLastKnownGood(taskId: string): string | null {
    return this.lastKnownGood.get(taskId) ?? null;
  }

  setLastKnownGood(taskId: string, sha: string): void {
    this.lastKnownGood.set(taskId, sha);
  }
}
