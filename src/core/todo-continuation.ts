// ── Todo Continuation Enforcer ────────────────────────────────────────
// Auto-injects continuation prompts when an agent goes idle with pending work.

export interface TodoDetection {
  hasTodos: boolean;
  todoCount: number;
  todos: string[]; // extracted todo text items
}

/** Patterns that indicate remaining work. Each has a capture group for the todo text. */
const TODO_REGEXES: RegExp[] = [
  /- \[ \]\s*(.+)/g,           // markdown unchecked checkbox: - [ ] some item
  /\[ \]\s*(.+)/g,             // bare unchecked checkbox: [ ] some item
  /TODO:\s*(.+)/g,             // TODO: description
  /FIXME:\s*(.+)/g,            // FIXME: description
  /remaining:\s*(.+)/gi,       // remaining: something
  /left to do[:\s]*(.+)/gi,    // left to do: something
  /still need[:\s]*(.+)/gi,    // still need to do something
];

/** Completion markers — if present, the task is considered done. */
const COMPLETION_MARKERS = [
  "TASK_COMPLETE",
  "all done",
  "task complete",
  "implementation complete",
  "all tasks completed",
];

export class TodoContinuationEnforcer {
  private maxContinuations: number;
  private continuationCount = 0;

  constructor(maxContinuations?: number) {
    this.maxContinuations = maxContinuations ?? 5;
  }

  /**
   * Analyze output text for unchecked todos and remaining work items.
   * Extracts the actual todo text for each match.
   */
  detect(output: string): TodoDetection {
    const todos: string[] = [];
    const seen = new Set<string>();

    for (const pattern of TODO_REGEXES) {
      // Reset global regex state
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(output)) !== null) {
        const text = match[1]?.trim();
        if (text && !seen.has(text)) {
          seen.add(text);
          todos.push(text);
        }
      }
    }

    return {
      hasTodos: todos.length > 0,
      todoCount: todos.length,
      todos,
    };
  }

  /**
   * Determine whether to auto-continue based on output analysis.
   * Returns true if: todos are detected AND continuationCount < max AND
   * no completion markers are present.
   */
  shouldContinue(output: string): boolean {
    // Check for completion markers first
    if (this.hasCompletionMarker(output)) {
      return false;
    }

    // Check if we've exceeded the continuation limit
    if (this.continuationCount >= this.maxContinuations) {
      return false;
    }

    // Check for remaining todos
    const detection = this.detect(output);
    return detection.hasTodos;
  }

  /**
   * Build a continuation prompt listing remaining todos with
   * instructions to complete them.
   */
  buildContinuationPrompt(detection: TodoDetection): string {
    const lines: string[] = [
      "You have remaining work items that are not yet complete:",
      "",
    ];

    for (let i = 0; i < detection.todos.length; i++) {
      lines.push(`${i + 1}. ${detection.todos[i]}`);
    }

    lines.push(
      "",
      `Total remaining: ${detection.todoCount} item${detection.todoCount === 1 ? "" : "s"}.`,
      "",
      "Please continue working through these items.",
      'When everything is done, say "TASK_COMPLETE".',
    );

    return lines.join("\n");
  }

  /** Record that a continuation was performed. */
  recordContinuation(): void {
    this.continuationCount++;
  }

  /** Reset continuation count (e.g. on a new user message). */
  reset(): void {
    this.continuationCount = 0;
  }

  /** Get current status. */
  getStatus(): { continuations: number; maxContinuations: number } {
    return {
      continuations: this.continuationCount,
      maxContinuations: this.maxContinuations,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────

  /** Check whether output contains any completion marker (case insensitive). */
  private hasCompletionMarker(output: string): boolean {
    const lower = output.toLowerCase();
    for (const marker of COMPLETION_MARKERS) {
      if (lower.includes(marker.toLowerCase())) {
        return true;
      }
    }
    return false;
  }
}
