export interface DoomLoopConfig {
  enabled: boolean;        // default true
  maxRepetitions: number;  // default 5
  windowSize: number;      // track last N calls, default 15
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
      enabled: true,
      maxRepetitions: 5,
      windowSize: 15,
      action: "warn",
      ...config,
    };
  }

  /**
   * Record a tool call and check for doom loops.
   * Returns whether a loop was triggered, the repetition count, and the tool name.
   */
  record(tool: string, input: string): { triggered: boolean; count: number; tool: string } {
    // If disabled, always return no trigger
    if (!this.config.enabled) {
      return {
        triggered: false,
        count: 0,
        tool,
      };
    }

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

  /** Enable doom loop detection */
  enable(): void {
    this.config.enabled = true;
  }

  /** Disable doom loop detection */
  disable(): void {
    this.config.enabled = false;
  }

  /** Check if doom loop detection is enabled */
  isEnabled(): boolean {
    return this.config.enabled;
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
