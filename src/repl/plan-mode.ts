import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import type { ModelTier } from "../config/types.ts";

export interface PlanModeConfig {
  model: ModelTier;
  outputDir: string;
  maxTokens?: number;
}

export interface PlanDocument {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  filePath: string;
}

/** Read-only commands that are safe to run in plan mode via bash. */
const SAFE_BASH_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "git",
  "find",
  "tree",
  "which",
  "env",
  "echo",
]);

/** Git sub-commands that are read-only and allowed. */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "tag",
  "remote",
  "rev-parse",
  "describe",
  "shortlog",
  "blame",
  "ls-files",
  "ls-tree",
]);

/** Tools that are always allowed in plan mode. */
const ALWAYS_ALLOWED_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "list",
  "webfetch",
  "skill",
  "task",
]);

/**
 * Plan mode restricts the agent to read-only analysis. It can read files,
 * search code, and write plan documents to the output directory, but cannot
 * modify source files, run destructive commands, or create files elsewhere.
 */
export class PlanMode {
  private active = false;
  private config: PlanModeConfig;
  private currentPlan: PlanDocument | null = null;

  constructor(config?: Partial<PlanModeConfig>) {
    this.config = {
      model: "opus",
      outputDir: ".orchestrator/plans",
      ...config,
    };
  }

  /** Toggle plan mode on/off. Returns the new state. */
  toggle(): boolean {
    this.active = !this.active;
    if (!this.active) {
      this.currentPlan = null;
    }
    return this.active;
  }

  /** Is plan mode currently active? */
  isActive(): boolean {
    return this.active;
  }

  /** Get the system prompt additions for plan mode. */
  getSystemPromptAddition(): string {
    return [
      "You are in PLAN MODE. You can ONLY:",
      "- Read and analyze files",
      "- Search code with grep/glob",
      "- Think and reason about architecture",
      `- Write plan documents to ${this.config.outputDir}/`,
      "",
      "You CANNOT:",
      "- Edit or write source code files",
      "- Run bash commands that modify state",
      "- Create or delete files outside the plans directory",
      "",
      "Your goal is to create a thorough implementation plan before any code changes.",
    ].join("\n");
  }

  /** Get the model tier for plan mode. */
  getModel(): ModelTier {
    return this.config.model;
  }

  /**
   * Check if a tool use is allowed in plan mode.
   * Returns `{ allowed: true }` or `{ allowed: false, reason: "..." }`.
   */
  isToolAllowed(
    tool: string,
    args: Record<string, unknown>,
  ): { allowed: boolean; reason?: string } {
    const normalizedTool = tool.toLowerCase();

    // Always-allowed read-only tools
    if (ALWAYS_ALLOWED_TOOLS.has(normalizedTool)) {
      return { allowed: true };
    }

    // Edit and write: only allowed if the target path is within outputDir
    if (normalizedTool === "edit" || normalizedTool === "write") {
      return this.checkPathAllowed(args);
    }

    // Bash: parse command and allow only read-only commands
    if (normalizedTool === "bash") {
      return this.checkBashAllowed(args);
    }

    return {
      allowed: false,
      reason: `Tool "${tool}" is not allowed in plan mode. Only read, grep, glob, list, webfetch, skill, task, and plan-directory writes are permitted.`,
    };
  }

  /** Save a plan document to disk. */
  async savePlan(
    title: string,
    content: string,
    projectDir: string,
  ): Promise<PlanDocument> {
    const dir = join(projectDir, this.config.outputDir);

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sanitized = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    const fileName = `${sanitized}.md`;
    const filePath = join(dir, fileName);

    const header = [
      `# ${title}`,
      "",
      `> Plan ID: ${id}`,
      `> Created: ${new Date().toISOString()}`,
      "",
      "---",
      "",
    ].join("\n");

    await writeFile(filePath, header + content, "utf-8");

    const plan: PlanDocument = {
      id,
      title,
      content,
      createdAt: new Date().toISOString(),
      filePath,
    };

    this.currentPlan = plan;
    return plan;
  }

  /** List all saved plan documents. */
  async listPlans(projectDir: string): Promise<PlanDocument[]> {
    const dir = join(projectDir, this.config.outputDir);

    if (!existsSync(dir)) {
      return [];
    }

    const entries = await readdir(dir);
    const plans: PlanDocument[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      const filePath = join(dir, entry);
      const plan = await this.loadPlan(filePath);
      if (plan) {
        plans.push(plan);
      }
    }

    // Sort by creation date descending (newest first)
    plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return plans;
  }

  /** Load a plan document from a file path. */
  async loadPlan(filePath: string): Promise<PlanDocument | null> {
    try {
      const raw = await readFile(filePath, "utf-8");

      // Parse the header for metadata
      const titleMatch = raw.match(/^#\s+(.+)$/m);
      const idMatch = raw.match(/>\s*Plan ID:\s*(.+)$/m);
      const createdMatch = raw.match(/>\s*Created:\s*(.+)$/m);

      // Content is everything after the "---" separator
      const separatorIndex = raw.indexOf("---");
      const content =
        separatorIndex !== -1
          ? raw.slice(separatorIndex + 3).trim()
          : raw;

      return {
        id: idMatch?.[1]?.trim() ?? `plan-unknown-${Date.now()}`,
        title: titleMatch?.[1]?.trim() ?? filePath.split("/").pop()?.replace(".md", "") ?? "Untitled",
        content,
        createdAt: createdMatch?.[1]?.trim() ?? new Date().toISOString(),
        filePath,
      };
    } catch {
      return null;
    }
  }

  /** Get the current plan being worked on. */
  getCurrentPlan(): PlanDocument | null {
    return this.currentPlan;
  }

  /** Set the current plan. */
  setCurrentPlan(plan: PlanDocument | null): void {
    this.currentPlan = plan;
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  /**
   * Check if a write/edit target path falls within the plans output directory.
   */
  private checkPathAllowed(
    args: Record<string, unknown>,
  ): { allowed: boolean; reason?: string } {
    const targetPath =
      (args.file_path as string | undefined) ??
      (args.path as string | undefined) ??
      (args.filePath as string | undefined);

    if (!targetPath) {
      return {
        allowed: false,
        reason: "No file path provided. In plan mode, writes are only allowed to the plans directory.",
      };
    }

    const resolved = resolve(targetPath);
    const outputResolved = resolve(this.config.outputDir);

    // Check if the resolved path starts with the output dir (absolute or relative)
    if (
      resolved.startsWith(outputResolved + "/") ||
      resolved === outputResolved
    ) {
      return { allowed: true };
    }

    // Also accept relative paths containing the outputDir prefix
    const rel = relative(".", targetPath);
    if (
      rel.startsWith(this.config.outputDir + "/") ||
      rel === this.config.outputDir
    ) {
      return { allowed: true };
    }

    // Check if the path itself contains the outputDir as a segment
    if (targetPath.includes(this.config.outputDir)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Plan mode only allows writing to ${this.config.outputDir}/. Attempted path: ${targetPath}`,
    };
  }

  /**
   * Parse a bash command string and check if it is read-only safe.
   */
  private checkBashAllowed(
    args: Record<string, unknown>,
  ): { allowed: boolean; reason?: string } {
    const command =
      (args.command as string | undefined) ??
      (args.cmd as string | undefined);

    if (!command) {
      return {
        allowed: false,
        reason: "No command provided for bash tool in plan mode.",
      };
    }

    const trimmed = command.trim();

    // Reject shell operators that chain commands (could bypass safety)
    // Allow pipes (|) since read-only piped to read-only is fine, but check each segment
    const segments = this.splitCommandSegments(trimmed);

    for (const segment of segments) {
      const result = this.isSegmentSafe(segment.trim());
      if (!result.allowed) {
        return result;
      }
    }

    return { allowed: true };
  }

  /**
   * Split a command line by pipes and logical operators into individual segments.
   */
  private splitCommandSegments(command: string): string[] {
    // Split on |, &&, ;, || while handling basic quoting
    const segments: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      const next = command[i + 1];

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        current += ch;
      } else if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        current += ch;
      } else if (!inSingle && !inDouble) {
        if (ch === "|" && next === "|") {
          segments.push(current);
          current = "";
          i++; // skip second |
        } else if (ch === "&" && next === "&") {
          segments.push(current);
          current = "";
          i++; // skip second &
        } else if (ch === ";" || ch === "|") {
          segments.push(current);
          current = "";
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
    }

    if (current.trim()) {
      segments.push(current);
    }

    return segments;
  }

  /**
   * Check if a single command segment is a safe read-only command.
   */
  private isSegmentSafe(
    segment: string,
  ): { allowed: boolean; reason?: string } {
    // Strip leading env var assignments (e.g. FOO=bar cmd)
    let cleaned = segment.replace(/^(\w+=\S+\s+)+/, "").trim();

    // Handle subshells / command substitution — deny them
    if (cleaned.startsWith("(") || cleaned.includes("$(")) {
      return {
        allowed: false,
        reason: `Subshells and command substitution are not allowed in plan mode: "${segment}"`,
      };
    }

    // Extract the base command (first word)
    const parts = cleaned.split(/\s+/);
    const baseCmd = parts[0]?.replace(/^.*\//, ""); // strip path prefix

    if (!baseCmd) {
      return { allowed: true }; // empty segment
    }

    if (!SAFE_BASH_COMMANDS.has(baseCmd)) {
      return {
        allowed: false,
        reason: `Command "${baseCmd}" is not allowed in plan mode. Safe commands: ${[...SAFE_BASH_COMMANDS].join(", ")}`,
      };
    }

    // Special handling for git: only allow read-only subcommands
    if (baseCmd === "git") {
      const subCmd = parts[1];
      if (!subCmd) {
        return { allowed: true }; // bare "git" prints help
      }
      if (!SAFE_GIT_SUBCOMMANDS.has(subCmd)) {
        return {
          allowed: false,
          reason: `Git subcommand "${subCmd}" is not allowed in plan mode. Safe subcommands: ${[...SAFE_GIT_SUBCOMMANDS].join(", ")}`,
        };
      }
    }

    return { allowed: true };
  }
}
