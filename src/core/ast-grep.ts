export interface AstGrepMatch {
  file: string;
  line: number;
  column: number;
  matchedText: string;
  surroundingLines: string;
}

export interface AstGrepReplaceResult {
  file: string;
  replacements: number;
  success: boolean;
  error?: string;
}

// Supported languages and their file extensions
const LANGUAGE_MAP: Record<string, string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cpp", ".hpp", ".cc", ".cxx"],
  ruby: [".rb"],
  swift: [".swift"],
  kotlin: [".kt", ".kts"],
  css: [".css", ".scss", ".less"],
  html: [".html", ".htm"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
};

export class AstGrep {
  private sgPath: string | null = null;

  constructor() {}

  /**
   * Check if ast-grep (sg) is installed and find its path.
   * Caches the result after first successful check.
   */
  async isAvailable(): Promise<boolean> {
    if (this.sgPath !== null) return true;

    try {
      const proc = Bun.spawn(["which", "sg"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode === 0 && output.trim().length > 0) {
        this.sgPath = output.trim();

        // Verify it actually works
        const verifyProc = Bun.spawn([this.sgPath, "--version"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        await new Response(verifyProc.stdout).text();
        const verifyExit = await verifyProc.exited;

        if (verifyExit === 0) return true;
      }
    } catch {
      // sg not found
    }

    this.sgPath = null;
    return false;
  }

  /**
   * Get the sg binary path, defaulting to "sg" if not yet resolved.
   */
  private getSgBin(): string {
    return this.sgPath ?? "sg";
  }

  /**
   * Search for a pattern in files.
   * Runs: sg run --pattern "PATTERN" --lang LANG PATH --json
   * Parses JSON output into AstGrepMatch[].
   */
  async search(
    pattern: string,
    options?: {
      language?: string;
      path?: string;
      maxResults?: number;
    },
  ): Promise<AstGrepMatch[]> {
    const available = await this.isAvailable();
    if (!available) return [];

    const args: string[] = [
      this.getSgBin(),
      "run",
      "--pattern",
      pattern,
      "--json",
    ];

    if (options?.language) {
      args.push("--lang", options.language);
    }

    // Path must come last
    args.push(options?.path ?? ".");

    try {
      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      // sg returns exit code 1 when no matches found, which is not an error
      if (exitCode !== 0 && exitCode !== 1) {
        return [];
      }

      if (!stdout.trim()) return [];

      const rawResults = JSON.parse(stdout);
      const matches: AstGrepMatch[] = [];

      if (!Array.isArray(rawResults)) return [];

      for (const entry of rawResults) {
        // ast-grep JSON output has various formats; handle common structures
        const file = entry.file ?? entry.path ?? "";
        const line = entry.range?.start?.line ?? entry.line ?? 0;
        const column = entry.range?.start?.column ?? entry.column ?? 0;
        const matchedText = entry.text ?? entry.matchedText ?? entry.match ?? "";
        const surroundingLines = entry.lines ?? entry.surroundingLines ?? matchedText;

        matches.push({
          file,
          line: typeof line === "number" ? line + 1 : line, // sg uses 0-based lines
          column: typeof column === "number" ? column + 1 : column,
          matchedText,
          surroundingLines,
        });

        if (options?.maxResults && matches.length >= options.maxResults) {
          break;
        }
      }

      return matches;
    } catch {
      return [];
    }
  }

  /**
   * Replace a pattern in files.
   * Runs: sg run --pattern "PATTERN" --rewrite "REPLACEMENT" --lang LANG PATH
   */
  async replace(
    pattern: string,
    replacement: string,
    options?: {
      language?: string;
      path?: string;
      dryRun?: boolean;
    },
  ): Promise<AstGrepReplaceResult[]> {
    const available = await this.isAvailable();
    if (!available) {
      return [{
        file: options?.path ?? ".",
        replacements: 0,
        success: false,
        error: "ast-grep (sg) is not installed",
      }];
    }

    // First, search to find matches and their files
    const matches = await this.search(pattern, {
      language: options?.language,
      path: options?.path,
    });

    if (matches.length === 0) {
      return [{
        file: options?.path ?? ".",
        replacements: 0,
        success: true,
      }];
    }

    if (options?.dryRun) {
      // Group matches by file for dry-run reporting
      const byFile = new Map<string, number>();
      for (const m of matches) {
        byFile.set(m.file, (byFile.get(m.file) ?? 0) + 1);
      }

      return Array.from(byFile.entries()).map(([file, count]) => ({
        file,
        replacements: count,
        success: true,
      }));
    }

    // Actually apply the replacement
    const args: string[] = [
      this.getSgBin(),
      "run",
      "--pattern",
      pattern,
      "--rewrite",
      replacement,
      "--update-all",
    ];

    if (options?.language) {
      args.push("--lang", options.language);
    }

    args.push(options?.path ?? ".");

    try {
      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0 && exitCode !== 1) {
        return [{
          file: options?.path ?? ".",
          replacements: 0,
          success: false,
          error: stderr.trim() || `sg exited with code ${exitCode}`,
        }];
      }

      // Group original matches by file for result reporting
      const byFile = new Map<string, number>();
      for (const m of matches) {
        byFile.set(m.file, (byFile.get(m.file) ?? 0) + 1);
      }

      return Array.from(byFile.entries()).map(([file, count]) => ({
        file,
        replacements: count,
        success: true,
      }));
    } catch (err) {
      return [{
        file: options?.path ?? ".",
        replacements: 0,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }];
    }
  }

  /**
   * Detect language from file extension.
   * Returns the language name or null if unrecognized.
   */
  detectLanguage(filePath: string): string | null {
    // Extract the extension including the dot
    const dotIndex = filePath.lastIndexOf(".");
    if (dotIndex === -1) return null;

    const ext = filePath.slice(dotIndex).toLowerCase();

    for (const [language, extensions] of Object.entries(LANGUAGE_MAP)) {
      if (extensions.includes(ext)) return language;
    }

    return null;
  }

  /**
   * Format search results for display.
   * Produces a human-readable summary of matches.
   */
  formatResults(matches: AstGrepMatch[]): string {
    if (matches.length === 0) {
      return "No matches found.";
    }

    const lines: string[] = [];
    lines.push(`Found ${matches.length} match${matches.length === 1 ? "" : "es"}:\n`);

    // Group matches by file
    const byFile = new Map<string, AstGrepMatch[]>();
    for (const match of matches) {
      const existing = byFile.get(match.file) ?? [];
      existing.push(match);
      byFile.set(match.file, existing);
    }

    for (const [file, fileMatches] of byFile) {
      lines.push(`  ${file} (${fileMatches.length} match${fileMatches.length === 1 ? "" : "es"}):`);

      for (const match of fileMatches) {
        const locationTag = `L${match.line}:${match.column}`;
        // Truncate matched text if too long for display
        const displayText = match.matchedText.length > 80
          ? match.matchedText.slice(0, 77) + "..."
          : match.matchedText;
        // Replace newlines in display text for single-line output
        const singleLine = displayText.replace(/\n/g, "\\n");
        lines.push(`    ${locationTag}  ${singleLine}`);
      }

      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }
}
