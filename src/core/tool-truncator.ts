import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TruncationResult {
  text: string;
  truncated: boolean;
  originalLines: number;
  originalBytes: number;
  fullOutputPath?: string;
}

/**
 * Dynamically truncates large tool outputs based on context window usage.
 * When the context window is heavily utilized, limits are reduced aggressively
 * to preserve room for the model's reasoning. Full outputs are saved to disk
 * so the agent can reference them if needed.
 */
export class ToolOutputTruncator {
  private outputDir: string;
  private defaultMaxLines = 2000;
  private defaultMaxBytes = 50 * 1024; // 50KB

  constructor(outputDir?: string) {
    this.outputDir = outputDir ?? join(homedir(), ".orchestrator", "outputs");
    this.ensureOutputDir();
  }

  /**
   * Truncate output based on current context usage.
   * @param output Raw tool output string
   * @param contextUsageRatio 0.0 to 1.0 representing how full the context window is
   */
  truncate(output: string, contextUsageRatio = 0): TruncationResult {
    const originalBytes = Buffer.byteLength(output, "utf-8");
    const lines = output.split("\n");
    const originalLines = lines.length;

    const { maxLines, maxBytes } = this.calculateLimits(contextUsageRatio);

    // Check if truncation is needed
    if (originalLines <= maxLines && originalBytes <= maxBytes) {
      return {
        text: output,
        truncated: false,
        originalLines,
        originalBytes,
      };
    }

    // Save full output to disk before truncating
    const fullOutputPath = this.saveFullOutput(output);

    // Truncate by lines first, then by bytes
    let truncated: string;
    if (originalLines > maxLines) {
      // Keep first portion and last portion for context
      const headLines = Math.floor(maxLines * 0.7);
      const tailLines = maxLines - headLines;
      const head = lines.slice(0, headLines).join("\n");
      const tail = lines.slice(-tailLines).join("\n");
      const omitted = originalLines - headLines - tailLines;
      truncated = `${head}\n\n... [${omitted} lines omitted, full output: ${fullOutputPath}] ...\n\n${tail}`;
    } else {
      truncated = output;
    }

    // Further truncate by bytes if still over limit
    const truncatedBytes = Buffer.byteLength(truncated, "utf-8");
    if (truncatedBytes > maxBytes) {
      // Cut to byte limit, keeping a tail portion
      const headBytes = Math.floor(maxBytes * 0.7);
      const tailBytes = maxBytes - headBytes;

      const encoder = new TextEncoder();
      const encoded = encoder.encode(truncated);
      const headSlice = new TextDecoder().decode(encoded.slice(0, headBytes));
      const tailSlice = new TextDecoder().decode(encoded.slice(-tailBytes));

      truncated = `${headSlice}\n\n... [truncated to ${maxBytes} bytes, full output: ${fullOutputPath}] ...\n\n${tailSlice}`;
    }

    return {
      text: truncated,
      truncated: true,
      originalLines,
      originalBytes,
      fullOutputPath,
    };
  }

  /**
   * Dynamic limit calculation: reduce limits when context is >70% full.
   * At 100% usage the limits shrink to 20% of their defaults.
   */
  private calculateLimits(contextUsageRatio: number): {
    maxLines: number;
    maxBytes: number;
  } {
    const ratio = Math.max(0, Math.min(1, contextUsageRatio));

    if (ratio <= 0.7) {
      return {
        maxLines: this.defaultMaxLines,
        maxBytes: this.defaultMaxBytes,
      };
    }

    // Linear scale-down from 100% at 0.7 to 20% at 1.0
    const scale = 1 - ((ratio - 0.7) / 0.3) * 0.8;

    return {
      maxLines: Math.max(50, Math.floor(this.defaultMaxLines * scale)),
      maxBytes: Math.max(2 * 1024, Math.floor(this.defaultMaxBytes * scale)),
    };
  }

  /**
   * Save the full output to disk using a content-hashed filename.
   * Returns the absolute path to the saved file.
   */
  private saveFullOutput(output: string): string {
    this.ensureOutputDir();

    const hash = Bun.hash(output).toString(36);
    const timestamp = Date.now().toString(36);
    const filename = `${timestamp}-${hash}.txt`;
    const filePath = join(this.outputDir, filename);

    Bun.write(filePath, output);

    return filePath;
  }

  /**
   * Cleanup output files older than 7 days.
   * Returns the number of files removed.
   */
  async cleanup(): Promise<number> {
    if (!existsSync(this.outputDir)) return 0;

    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
    const now = Date.now();
    let removed = 0;

    const entries = readdirSync(this.outputDir);
    for (const entry of entries) {
      const filePath = join(this.outputDir, entry);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          unlinkSync(filePath);
          removed++;
        }
      } catch {
        // File may have been removed concurrently; ignore
      }
    }

    return removed;
  }

  private ensureOutputDir(): void {
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }
}
