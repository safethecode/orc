export interface LoopConfig {
  maxIterations: number;
  completionMarker: string;
  checkInterval: number;
}

export interface LoopIteration {
  index: number;
  startedAt: string;
  completedAt: string;
  output: string;
  completionDetected: boolean;
  todoRemaining: number;
}

export interface LoopResult {
  iterations: LoopIteration[];
  completed: boolean;
  totalIterations: number;
  reason: string;
}

/** Completion-indicating phrases (case insensitive). */
const COMPLETION_PHRASES = [
  "all done",
  "task complete",
  "nothing remaining",
  "all tasks completed",
  "implementation complete",
  "work is done",
  "everything is done",
  "no remaining items",
  "fully complete",
  "all items done",
];

/** Patterns that indicate remaining work. */
const TODO_PATTERNS = [
  /\bTODO\b/g,
  /\bFIXME\b/g,
  /\bHACK\b/g,
  /- \[ \]/g,           // markdown unchecked checkbox
  /\[ \]/g,             // bare unchecked checkbox
  /remaining:\s*(\d+)/gi,
  /(\d+)\s+remaining/gi,
  /left to do/gi,
  /still need/gi,
  /not yet (?:done|implemented|complete)/gi,
];

/**
 * Autonomous completion loop. Keeps calling executeStep until the agent
 * indicates the task is fully done or the iteration limit is reached.
 * Inspired by oh-my-opencode's Ralph Loop pattern.
 */
export class RalphLoop {
  private config: LoopConfig;
  private running = false;
  private cancelled = false;
  private currentIteration = 0;

  constructor(config?: Partial<LoopConfig>) {
    this.config = {
      maxIterations: 10,
      completionMarker: "TASK_COMPLETE",
      checkInterval: 1000,
      ...config,
    };
  }

  /**
   * Run the autonomous loop. Calls `executeStep` each iteration with the
   * iteration index and the previous output (null on the first iteration).
   * Returns when the task is complete, cancelled, or the limit is hit.
   */
  async run(
    task: string,
    executeStep: (
      iteration: number,
      previousOutput: string | null,
    ) => Promise<string>,
  ): Promise<LoopResult> {
    this.running = true;
    this.cancelled = false;
    this.currentIteration = 0;

    const iterations: LoopIteration[] = [];
    let previousOutput: string | null = null;

    try {
      for (let i = 0; i < this.config.maxIterations; i++) {
        if (this.cancelled) {
          return {
            iterations,
            completed: false,
            totalIterations: iterations.length,
            reason: "cancelled",
          };
        }

        this.currentIteration = i;
        const startedAt = new Date().toISOString();

        let output: string;
        try {
          // On subsequent iterations, wrap the previous output in a continuation prompt
          const effectivePrevious =
            i > 0 && previousOutput
              ? this.buildContinuationPrompt(task, i, previousOutput)
              : null;

          output = await executeStep(i, effectivePrevious);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return {
            iterations,
            completed: false,
            totalIterations: iterations.length,
            reason: `error: ${errorMsg}`,
          };
        }

        const completionDetected = this.isComplete(output);
        const todoRemaining = this.extractTodoCount(output);

        const iteration: LoopIteration = {
          index: i,
          startedAt,
          completedAt: new Date().toISOString(),
          output,
          completionDetected,
          todoRemaining,
        };

        iterations.push(iteration);
        previousOutput = output;

        // Check if we're done
        if (completionDetected && todoRemaining === 0) {
          this.running = false;
          return {
            iterations,
            completed: true,
            totalIterations: iterations.length,
            reason: "completed",
          };
        }

        // Even if marker is present, if TODOs remain, keep going
        // But if marker is present with some TODOs, it may still be logically complete
        if (completionDetected && todoRemaining > 0) {
          // Give it one more chance — if it said complete but has TODOs, continue
          // but if this is the last iteration, treat as complete
          if (i === this.config.maxIterations - 1) {
            this.running = false;
            return {
              iterations,
              completed: true,
              totalIterations: iterations.length,
              reason: "completed",
            };
          }
        }

        // Wait before next iteration
        if (i < this.config.maxIterations - 1 && !this.cancelled) {
          await this.sleep(this.config.checkInterval);
        }
      }
    } finally {
      this.running = false;
    }

    return {
      iterations,
      completed: false,
      totalIterations: iterations.length,
      reason: "max_iterations",
    };
  }

  /**
   * Build a continuation prompt that gives the agent context about previous
   * progress and instructions to keep going.
   */
  buildContinuationPrompt(
    task: string,
    iteration: number,
    previousOutput: string,
  ): string {
    // Truncate long previous output but keep enough for context
    const maxPreviousLength = 4000;
    const truncated =
      previousOutput.length > maxPreviousLength
        ? previousOutput.slice(0, maxPreviousLength) +
          "\n\n...[output truncated for brevity]"
        : previousOutput;

    const todoCount = this.extractTodoCount(previousOutput);
    const todoLine =
      todoCount > 0
        ? `\nEstimated remaining items: ${todoCount}`
        : "";

    return [
      `You are continuing work on: ${task}`,
      `This is iteration ${iteration + 1}/${this.config.maxIterations}.`,
      `${todoLine}`,
      "",
      "Previous output summary:",
      truncated,
      "",
      `Continue where you left off. When fully complete, include "${this.config.completionMarker}" in your response.`,
      "If there are remaining items, list them clearly.",
    ].join("\n");
  }

  /** Cancel the running loop. The current iteration will finish. */
  cancel(): void {
    this.cancelled = true;
  }

  /** Get current loop status. */
  getStatus(): {
    running: boolean;
    iteration: number;
    maxIterations: number;
  } {
    return {
      running: this.running,
      iteration: this.currentIteration,
      maxIterations: this.config.maxIterations,
    };
  }

  /** Whether the loop is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  // ── Private Methods ──────────────────────────────────────────────────

  /**
   * Check if the output contains the completion marker or well-known
   * completion phrases.
   */
  private isComplete(output: string): boolean {
    // Check explicit marker
    if (output.includes(this.config.completionMarker)) {
      return true;
    }

    // Check natural language completion phrases (case insensitive)
    const lower = output.toLowerCase();
    for (const phrase of COMPLETION_PHRASES) {
      if (lower.includes(phrase)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract a count of remaining TODO/unchecked items from the output.
   * Returns 0 if no remaining work is detected.
   */
  private extractTodoCount(output: string): number {
    let count = 0;

    for (const pattern of TODO_PATTERNS) {
      // Reset the regex since we use /g flag
      pattern.lastIndex = 0;
      const matches = output.match(pattern);
      if (matches) {
        count += matches.length;
      }
    }

    // Also count unchecked markdown checkboxes specifically
    // (may overlap with general patterns, but we already counted them)
    // Subtract checked checkboxes to avoid double-counting
    const unchecked = (output.match(/- \[ \]/g) || []).length;
    const checked = (output.match(/- \[x\]/gi) || []).length;

    // If we have checkboxes, use the net unchecked count as a better signal
    if (unchecked + checked > 0) {
      // Remove the generic counts from TODO_PATTERNS for checkboxes
      // and use the accurate unchecked count
      return unchecked;
    }

    return count;
  }

  /** Promise-based sleep. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
