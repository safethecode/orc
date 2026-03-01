import type { WorkerState } from "../config/types.ts";
import { eventBus } from "./events.ts";

export type StuckReason =
  | "no_activity"
  | "repeated_output"
  | "spinner_loop"
  | "error_loop"
  | "turn_stall"
  | "rate_limited";

export type EscalationLevel = "warn" | "intervene" | "abort" | "human";

export interface StuckEvent {
  workerId: string;
  reason: StuckReason;
  level: EscalationLevel;
  staleDurationMs: number;
  details: string;
  suggestedAction: string;
}

interface OutputFingerprint {
  hash: number;
  timestamp: number;
}

interface RateLimitInfo {
  detectedAt: number;
  retryAfterMs: number | null;
}

export class StuckDetector {
  private warnAfterMs: number;
  private interveneAfterMs: number;
  private abortAfterMs: number;
  private humanAfterMs: number;

  // Per-worker tracking
  private outputHistory: Map<string, OutputFingerprint[]> = new Map();
  private lastTurnSeen: Map<string, { turn: number; seenAt: number }> = new Map();
  private errorCounts: Map<string, Map<string, number>> = new Map();
  private rateLimitState: Map<string, RateLimitInfo> = new Map();
  private stuckSince: Map<string, number> = new Map();

  constructor(opts?: {
    warnAfterMs?: number;
    interveneAfterMs?: number;
    abortAfterMs?: number;
    humanAfterMs?: number;
  }) {
    this.warnAfterMs = opts?.warnAfterMs ?? 60_000;
    this.interveneAfterMs = opts?.interveneAfterMs ?? 180_000;
    this.abortAfterMs = opts?.abortAfterMs ?? 300_000;
    this.humanAfterMs = opts?.humanAfterMs ?? 600_000;
  }

  /**
   * Analyze a worker's current state and captured output.
   * Returns StuckEvent if stuck, null if healthy.
   * Designed to be cheap — called every 30s per worker.
   */
  analyze(worker: WorkerState, capturedOutput: string): StuckEvent | null {
    const workerId = worker.id;
    const now = Date.now();

    // --- Rate limit detection (special handling) ---
    const rateLimitReason = this.detectRateLimit(workerId, capturedOutput);
    if (rateLimitReason) {
      const rlState = this.rateLimitState.get(workerId)!;
      const staleDuration = now - rlState.detectedAt;

      // If we have a retryAfterMs and we're past it, the limit should be cleared
      if (rlState.retryAfterMs !== null && staleDuration >= rlState.retryAfterMs) {
        this.rateLimitState.delete(workerId);
        eventBus.publish({
          type: "stuck:recovered",
          workerId,
          wasStuckMs: staleDuration,
        });
        return null;
      }

      const retryAt = rlState.retryAfterMs !== null
        ? new Date(rlState.detectedAt + rlState.retryAfterMs).toISOString()
        : "unknown";

      eventBus.publish({
        type: "stuck:rate_limited",
        workerId,
        retryAfterMs: rlState.retryAfterMs ?? 0,
        retryAt,
      });

      return {
        workerId,
        reason: "rate_limited",
        level: "warn",
        staleDurationMs: staleDuration,
        details: `Rate limited. Retry at: ${retryAt}`,
        suggestedAction: rlState.retryAfterMs !== null
          ? `Wait until ${retryAt} then auto-resume`
          : "Apply exponential backoff",
      };
    }

    // --- Check for active rate limit state (already detected, waiting) ---
    const existingRl = this.rateLimitState.get(workerId);
    if (existingRl) {
      const elapsed = now - existingRl.detectedAt;
      if (existingRl.retryAfterMs !== null && elapsed >= existingRl.retryAfterMs) {
        // Rate limit expired, worker should resume
        this.rateLimitState.delete(workerId);
        eventBus.publish({
          type: "stuck:recovered",
          workerId,
          wasStuckMs: elapsed,
        });
        return null;
      }
      // Still rate limited — don't detect as stuck via other signals
      return null;
    }

    // --- Detect stuck signals ---
    let stuckReason: StuckReason | null = null;
    let details = "";
    let suggestedAction = "";

    // 1. No activity check
    const lastActivity = new Date(worker.lastActivityAt).getTime();
    const inactivityMs = now - lastActivity;

    if (inactivityMs > this.warnAfterMs) {
      stuckReason = "no_activity";
      details = `No activity for ${Math.round(inactivityMs / 1000)}s`;
      suggestedAction = "Send nudge message to check worker status";
    }

    // 2. Repeated output detection (overrides no_activity if detected)
    if (this.detectRepeatedOutput(workerId, capturedOutput)) {
      stuckReason = "repeated_output";
      details = "Same output fingerprint detected 3+ times consecutively";
      suggestedAction = "Worker may be in an infinite loop, consider restarting";
    }

    // 3. Turn stall detection
    if (this.detectTurnStall(workerId, worker)) {
      stuckReason = "turn_stall";
      const lastSeen = this.lastTurnSeen.get(workerId);
      details = `Turn counter stuck at ${lastSeen?.turn ?? 0} for 2+ check cycles`;
      suggestedAction = "Worker not making progress on turns, may need intervention";
    }

    // 4. Error loop detection
    if (this.detectErrorLoop(workerId, capturedOutput)) {
      stuckReason = "error_loop";
      details = "Same error pattern repeating 3+ times";
      suggestedAction = "Worker stuck in error loop, consider aborting or changing approach";
    }

    // 5. Spinner loop detection (no tool use in recent output for an active worker)
    if (!stuckReason && inactivityMs > this.warnAfterMs) {
      const hasToolUse = /(?:tool_use|Using tool|Tool:|Read|Write|Edit|Bash|Glob|Grep)/i.test(
        capturedOutput.slice(-500),
      );
      if (!hasToolUse && worker.status === "running" && worker.currentTurn > 0) {
        stuckReason = "spinner_loop";
        details = "Worker running but no tool use detected in recent output";
        suggestedAction = "Agent may be stuck thinking, send nudge";
      }
    }

    if (!stuckReason) {
      // Worker is healthy — clear stuck tracking
      if (this.stuckSince.has(workerId)) {
        const wasStuckMs = now - this.stuckSince.get(workerId)!;
        this.stuckSince.delete(workerId);
        eventBus.publish({
          type: "stuck:recovered",
          workerId,
          wasStuckMs,
        });
      }
      return null;
    }

    // Track when worker first became stuck
    if (!this.stuckSince.has(workerId)) {
      this.stuckSince.set(workerId, now);
    }

    const staleDurationMs = now - this.stuckSince.get(workerId)!;
    const level = this.determineLevel(staleDurationMs);

    const event: StuckEvent = {
      workerId,
      reason: stuckReason,
      level,
      staleDurationMs,
      details,
      suggestedAction,
    };

    eventBus.publish({
      type: "stuck:detected",
      workerId,
      reason: stuckReason,
      level,
      staleDurationMs,
    });

    return event;
  }

  /**
   * Determine escalation level based on how long the worker has been stuck.
   */
  private determineLevel(staleDurationMs: number): EscalationLevel {
    if (staleDurationMs >= this.humanAfterMs) return "human";
    if (staleDurationMs >= this.abortAfterMs) return "abort";
    if (staleDurationMs >= this.interveneAfterMs) return "intervene";
    return "warn";
  }

  /**
   * Check for rate limit patterns in output.
   * CLI rate limits look like: "session limit", "rate limit", "try again", "retry after X"
   * Parse the retry-after time if available.
   */
  private detectRateLimit(workerId: string, output: string): StuckReason | null {
    // Skip if already tracked
    if (this.rateLimitState.has(workerId)) return null;

    const recentOutput = output.slice(-1000);
    const rateLimitPatterns = [
      /session\s*limit/i,
      /rate\s*limit/i,
      /too\s*many\s*requests/i,
      /429/,
      /quota\s*exceeded/i,
    ];

    const isRateLimited = rateLimitPatterns.some((p) => p.test(recentOutput));
    if (!isRateLimited) return null;

    // Parse retry-after duration
    let retryAfterMs: number | null = null;

    // "try again in X minutes"
    const minutesMatch = recentOutput.match(/try\s*again\s*in\s*(\d+)\s*minute/i);
    if (minutesMatch) {
      retryAfterMs = parseInt(minutesMatch[1], 10) * 60_000;
    }

    // "try again in X seconds"
    const secondsMatch = recentOutput.match(/try\s*again\s*in\s*(\d+)\s*second/i);
    if (secondsMatch) {
      retryAfterMs = parseInt(secondsMatch[1], 10) * 1_000;
    }

    // "retry_after_ms: 30000" or "retryAfterMs: 30000"
    const msMatch = recentOutput.match(/retry[_\s]*after[_\s]*ms[:\s]+(\d+)/i);
    if (msMatch) {
      retryAfterMs = parseInt(msMatch[1], 10);
    }

    // "retry-after: 30" (seconds, HTTP header style)
    const headerMatch = recentOutput.match(/retry-after:\s*(\d+)/i);
    if (headerMatch && !msMatch) {
      retryAfterMs = parseInt(headerMatch[1], 10) * 1_000;
    }

    this.rateLimitState.set(workerId, {
      detectedAt: Date.now(),
      retryAfterMs,
    });

    return "rate_limited";
  }

  /**
   * Check for repeated identical output (fingerprinting).
   * Hash last 500 chars of captured output; if same hash seen 3+ times
   * consecutively, the worker is stuck.
   */
  private detectRepeatedOutput(workerId: string, output: string): boolean {
    if (output.length < 10) return false;

    const tail = output.slice(-500);
    const hash = this.hashString(tail);
    const now = Date.now();

    const history = this.outputHistory.get(workerId) ?? [];
    history.push({ hash, timestamp: now });

    // Keep only last 10 fingerprints
    if (history.length > 10) {
      history.splice(0, history.length - 10);
    }
    this.outputHistory.set(workerId, history);

    // Check if last 3 fingerprints are identical
    if (history.length < 3) return false;
    const last3 = history.slice(-3);
    return last3[0].hash === last3[1].hash && last3[1].hash === last3[2].hash;
  }

  /**
   * Check for turn stall (turn counter not advancing).
   * If the same turn number is seen 2+ consecutive check cycles, it's stalled.
   */
  private detectTurnStall(workerId: string, worker: WorkerState): boolean {
    const now = Date.now();
    const prev = this.lastTurnSeen.get(workerId);

    if (!prev) {
      this.lastTurnSeen.set(workerId, { turn: worker.currentTurn, seenAt: now });
      return false;
    }

    if (worker.currentTurn !== prev.turn) {
      // Turn advanced — reset
      this.lastTurnSeen.set(workerId, { turn: worker.currentTurn, seenAt: now });
      return false;
    }

    // Same turn — check if enough time has passed (2+ check cycles = ~60s by default)
    const elapsed = now - prev.seenAt;
    return elapsed >= 60_000 && worker.currentTurn > 0;
  }

  /**
   * Check for error loops (same error message repeating).
   * Extract error-like patterns from recent output, count occurrences.
   */
  private detectErrorLoop(workerId: string, output: string): boolean {
    const recentOutput = output.slice(-1500);

    const errorPatterns = [
      /Error:\s*(.{10,80})/gi,
      /ENOENT[:\s]+(.{10,60})/gi,
      /EACCES[:\s]+(.{10,60})/gi,
      /failed[:\s]+(.{10,60})/gi,
      /panic[:\s]+(.{10,60})/gi,
    ];

    const errorSignatures: string[] = [];
    for (const pattern of errorPatterns) {
      let match;
      while ((match = pattern.exec(recentOutput)) !== null) {
        // Normalize the error signature (lowercase, trim, collapse whitespace)
        const sig = match[1].toLowerCase().trim().replace(/\s+/g, " ");
        errorSignatures.push(sig);
      }
    }

    if (errorSignatures.length === 0) return false;

    // Track error counts per worker
    let workerErrors = this.errorCounts.get(workerId);
    if (!workerErrors) {
      workerErrors = new Map();
      this.errorCounts.set(workerId, workerErrors);
    }

    // Count each signature
    for (const sig of errorSignatures) {
      const count = (workerErrors.get(sig) ?? 0) + 1;
      workerErrors.set(sig, count);
      if (count >= 3) return true;
    }

    return false;
  }

  /**
   * Simple string hash for fingerprinting (djb2 algorithm).
   * Fast, deterministic, good distribution for short strings.
   */
  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }

  /**
   * Clean up tracking data for a worker.
   */
  cleanup(workerId: string): void {
    this.outputHistory.delete(workerId);
    this.lastTurnSeen.delete(workerId);
    this.errorCounts.delete(workerId);
    this.rateLimitState.delete(workerId);
    this.stuckSince.delete(workerId);
  }

  /**
   * Get current rate limit state for a worker.
   */
  getRateLimitState(workerId: string): {
    isLimited: boolean;
    retryAfterMs?: number;
    retryAt?: Date;
  } {
    const state = this.rateLimitState.get(workerId);
    if (!state) return { isLimited: false };

    const retryAfterMs = state.retryAfterMs ?? undefined;
    const retryAt = state.retryAfterMs !== null
      ? new Date(state.detectedAt + state.retryAfterMs)
      : undefined;

    return { isLimited: true, retryAfterMs, retryAt };
  }
}
