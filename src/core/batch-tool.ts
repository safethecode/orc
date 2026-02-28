export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface BatchResult {
  id: string;
  name: string;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface BatchOptions {
  maxConcurrent?: number; // default 25
  timeoutMs?: number; // per-call timeout, default 30000
}

/**
 * Batch Tool — executes multiple tool calls in parallel with concurrency
 * control and per-call timeouts. The executor callback is provided by the
 * caller (the REPL); the batch tool itself only orchestrates execution.
 */
export class BatchToolExecutor {
  private maxConcurrent = 25;
  private defaultTimeoutMs = 30_000;
  private disallowedInBatch = new Set(["batch"]);

  constructor() {}

  /** Execute multiple tool calls in parallel */
  async executeBatch(
    calls: ToolCall[],
    executor: (name: string, input: Record<string, unknown>) => Promise<string>,
    opts?: BatchOptions,
  ): Promise<BatchResult[]> {
    const validation = this.validate(calls);
    if (!validation.valid) {
      return calls.map((call) => ({
        id: call.id,
        name: call.name,
        success: false,
        error: validation.errors.join("; "),
        durationMs: 0,
      }));
    }

    const concurrency = opts?.maxConcurrent ?? this.maxConcurrent;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;

    // Process in chunks of `concurrency` to respect the limit
    const results: BatchResult[] = [];

    for (let i = 0; i < calls.length; i += concurrency) {
      const chunk = calls.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        chunk.map((call) => this.executeOne(call, executor, timeoutMs)),
      );

      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j];
        if (outcome.status === "fulfilled") {
          results.push(outcome.value);
        } else {
          results.push({
            id: chunk[j].id,
            name: chunk[j].name,
            success: false,
            error: outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
            durationMs: 0,
          });
        }
      }
    }

    return results;
  }

  /** Validate calls before execution */
  validate(calls: ToolCall[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (calls.length === 0) {
      errors.push("No tool calls provided");
    }

    if (calls.length > this.maxConcurrent) {
      errors.push(
        `Too many calls: ${calls.length} exceeds maximum of ${this.maxConcurrent}`,
      );
    }

    const seenIds = new Set<string>();
    for (const call of calls) {
      if (this.disallowedInBatch.has(call.name)) {
        errors.push(`Tool "${call.name}" cannot be used inside a batch`);
      }
      if (!call.id) {
        errors.push("Each tool call must have an id");
      } else if (seenIds.has(call.id)) {
        errors.push(`Duplicate call id: "${call.id}"`);
      } else {
        seenIds.add(call.id);
      }
      if (!call.name) {
        errors.push("Each tool call must have a name");
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /** Format results for display */
  formatResults(results: BatchResult[]): string {
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;
    const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
    const wallMs = Math.max(...results.map((r) => r.durationMs), 0);
    const wallSec = (wallMs / 1000).toFixed(1);

    const parts = [
      `Batch: ${succeeded}/${results.length} succeeded | ${failed} failed | ${wallSec}s total`,
    ];

    for (const r of results) {
      if (r.success) {
        const preview = r.output
          ? r.output.length > 80
            ? r.output.slice(0, 80) + "..."
            : r.output
          : "(no output)";
        parts.push(`  [OK] ${r.id} (${r.name}) ${r.durationMs}ms — ${preview}`);
      } else {
        parts.push(`  [FAIL] ${r.id} (${r.name}) ${r.durationMs}ms — ${r.error}`);
      }
    }

    return parts.join("\n");
  }

  /** Execute a single tool call with timeout */
  private async executeOne(
    call: ToolCall,
    executor: (name: string, input: Record<string, unknown>) => Promise<string>,
    timeoutMs: number,
  ): Promise<BatchResult> {
    const start = performance.now();

    try {
      const output = await Promise.race([
        executor(call.name, call.input),
        this.timeout(timeoutMs, call.id),
      ]);

      return {
        id: call.id,
        name: call.name,
        success: true,
        output,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err: unknown) {
      return {
        id: call.id,
        name: call.name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Math.round(performance.now() - start),
      };
    }
  }

  /** Create a promise that rejects after the given timeout */
  private timeout(ms: number, callId: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`Timeout after ${ms}ms for call "${callId}"`)),
        ms,
      );
    });
  }
}
