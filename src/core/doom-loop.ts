export interface DoomLoopConfig {
  enabled: boolean;        // default true
  maxRepetitions: number;  // identical tool+input threshold, default 5
  windowSize: number;      // track last N calls, default 30
  action: "warn" | "abort"; // default "warn"
  maxFileEdits: number;    // same-file write threshold, default 4
}

export interface ToolCallRecord {
  tool: string;
  input: string;
  timestamp: number;
}

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);

/**
 * Detects when an agent makes repetitive tool calls and intervenes.
 *
 * Two detection modes:
 * 1. Exact match: identical tool+input combo repeated (classic doom loop)
 * 2. File-level: same file edited too many times (circular modifications)
 */
export class DoomLoopDetector {
  private history: ToolCallRecord[] = [];
  private fileEditCounts = new Map<string, number>();
  private config: DoomLoopConfig;

  constructor(config?: Partial<DoomLoopConfig>) {
    this.config = {
      enabled: true,
      maxRepetitions: 5,
      windowSize: 30,
      action: "warn",
      maxFileEdits: 4,
      ...config,
    };
  }

  /**
   * Record a tool call and check for doom loops.
   * Returns whether a loop was triggered, the repetition count, and the tool name.
   */
  record(tool: string, input: string): { triggered: boolean; count: number; tool: string; reason?: string } {
    if (!this.config.enabled) {
      return { triggered: false, count: 0, tool };
    }

    const record: ToolCallRecord = { tool, input, timestamp: Date.now() };
    this.history.push(record);

    // Trim to window size
    if (this.history.length > this.config.windowSize) {
      this.history = this.history.slice(-this.config.windowSize);
    }

    // Check 1: identical tool+input repetition
    const exactCount = this.getRepetitionCount(tool, input);
    if (exactCount >= this.config.maxRepetitions) {
      return { triggered: true, count: exactCount, tool, reason: "identical call repeated" };
    }

    // Check 2: same file edited too many times
    if (WRITE_TOOLS.has(tool.toLowerCase()) && input) {
      const filePath = this.extractFilePath(input);
      if (filePath) {
        const editCount = (this.fileEditCounts.get(filePath) ?? 0) + 1;
        this.fileEditCounts.set(filePath, editCount);
        if (editCount >= this.config.maxFileEdits) {
          return { triggered: true, count: editCount, tool, reason: `file edited ${editCount}x: ${filePath}` };
        }
      }
    }

    return { triggered: false, count: exactCount, tool };
  }

  /** Reset history (e.g. on new message) */
  reset(): void {
    this.history = [];
    this.fileEditCounts.clear();
  }

  /** Enable doom loop detection */
  enable(): void { this.config.enabled = true; }

  /** Disable doom loop detection */
  disable(): void { this.config.enabled = false; }

  /** Check if doom loop detection is enabled */
  isEnabled(): boolean { return this.config.enabled; }

  /** Get file edit count for a specific file */
  getFileEditCount(filePath: string): number {
    return this.fileEditCounts.get(filePath) ?? 0;
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

  /** Extract file path from tool input string (best-effort). */
  private extractFilePath(input: string): string | null {
    // Input is typically the file_path or first arg passed to the tool
    const trimmed = input.trim();
    if (trimmed.startsWith("/") || trimmed.includes(".")) {
      // Take the first path-like segment
      return trimmed.split(/\s/)[0];
    }
    return null;
  }
}
