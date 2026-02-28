export interface DoomLoopConfig {
  maxRepetitions: number;  // default 3
  windowSize: number;      // track last N calls, default 10
  action: "warn" | "abort"; // default "warn"
}

export interface ToolCallRecord {
  tool: string;
  input: string;
  timestamp: number;
}

/**
 * Detects when an agent makes identical tool calls 3+ times and intervenes.
 * Uses a normalized hash of tool+input for comparison within a sliding window.
 */
export class DoomLoopDetector {
  private history: ToolCallRecord[] = [];
  private config: DoomLoopConfig;

  constructor(config?: Partial<DoomLoopConfig>) {
    this.config = {
      maxRepetitions: 3,
      windowSize: 10,
      action: "warn",
      ...config,
    };
  }

  /**
   * Record a tool call and check for doom loops.
   * Returns whether a loop was triggered, the repetition count, and the tool name.
   */
  record(tool: string, input: string): { triggered: boolean; count: number; tool: string } {
    const record: ToolCallRecord = {
      tool,
      input,
      timestamp: Date.now(),
    };

    this.history.push(record);

    // Trim to window size
    if (this.history.length > this.config.windowSize) {
      this.history = this.history.slice(-this.config.windowSize);
    }

    const count = this.getRepetitionCount(tool, input);
    return {
      triggered: count >= this.config.maxRepetitions,
      count,
      tool,
    };
  }

  /** Reset history (e.g. on new message) */
  reset(): void {
    this.history = [];
  }

  /** Get current repetition count for a tool+input combo within the window */
  getRepetitionCount(tool: string, input: string): number {
    const key = this.normalizeKey(tool, input);
    let count = 0;
    for (const record of this.history) {
      if (this.normalizeKey(record.tool, record.input) === key) {
        count++;
      }
    }
    return count;
  }

  /**
   * Produce a normalized key from tool + input for comparison.
   * Trims whitespace, lowercases, and collapses consecutive whitespace.
   */
  private normalizeKey(tool: string, input: string): string {
    const normalizedTool = tool.trim().toLowerCase();
    const normalizedInput = input.trim().toLowerCase().replace(/\s+/g, " ");
    return `${normalizedTool}::${normalizedInput}`;
  }
}
