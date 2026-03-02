// ── Harness Enforcer ─────────────────────────────────────────────────
// Code-level enforcement of harness rules. Instead of relying on models
// to follow prompt instructions, this module intercepts tool calls and
// validates them against harness constraints. Violations are blocked,
// warned, or trigger corrective prompt injections.

import type { AgentRole } from "../config/types.ts";
import { classifyCommandEnhanced } from "../sandbox/safety.ts";
import { eventBus } from "./events.ts";

// ── Types ────────────────────────────────────────────────────────────

export type EnforcementSeverity = "block" | "warn" | "inject" | "ask";

export interface EnforcementViolation {
  ruleId: string;
  severity: EnforcementSeverity;
  message: string;
  suggestion?: string;
  toolName: string;
  filePath?: string;
}

export interface EnforcementResult {
  allowed: boolean;
  violations: EnforcementViolation[];
  injection?: string; // prompt to inject back to agent
  askRequired?: boolean; // user approval needed before execution
}

export interface ToolCallInput {
  toolName: string;
  input: Record<string, unknown>;
}

/** Internal mutable state tracked across the session. */
interface EnforcerState {
  filesRead: Set<string>;
  filesWritten: Set<string>;
  filesEdited: Set<string>;
  sourceFilesModified: number;
  testRunSinceLastModify: boolean;
  toolCallHashes: Map<string, number>; // hash -> count
  toolCallWindow: Array<{ hash: string; ts: number }>;
  totalToolCalls: number;
  turnNumber: number;
}

// ── Rule Definitions ─────────────────────────────────────────────────

type RuleChecker = (
  tool: ToolCallInput,
  state: EnforcerState,
  role: AgentRole,
) => EnforcementViolation | null;

interface EnforcementRule {
  id: string;
  name: string;
  severity: EnforcementSeverity;
  appliesTo: AgentRole[] | "all";
  check: RuleChecker;
}

// ── Utility ──────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\/+/g, "/").replace(/\/$/, "");
}

function extractFilePath(input: Record<string, unknown>): string | null {
  const candidates = ["file_path", "filePath", "path", "file", "target"];
  for (const key of candidates) {
    const val = input[key];
    if (typeof val === "string" && val.length > 0) return normalizePath(val);
  }
  return null;
}

function extractContent(input: Record<string, unknown>): string | null {
  const candidates = ["content", "new_content", "code", "text", "new_string"];
  for (const key of candidates) {
    const val = input[key];
    if (typeof val === "string") return val;
  }
  return null;
}

function extractCommand(input: Record<string, unknown>): string | null {
  const candidates = ["command", "cmd", "script"];
  for (const key of candidates) {
    const val = input[key];
    if (typeof val === "string") return val;
  }
  return null;
}

function isSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|py|rs|go|java|rb|swift|kt|c|cpp|h|hpp)$/.test(path);
}

function isTestFile(path: string): boolean {
  return /\.(test|spec|_test|_spec)\.(ts|tsx|js|jsx|py|rs|go)$/.test(path) ||
    path.includes("/tests/") ||
    path.includes("/test/") ||
    path.includes("/__tests__/");
}

function isMarkdownFile(path: string): boolean {
  return /\.md$/.test(path);
}

function isWriteTool(name: string): boolean {
  return ["write", "create", "write_file", "create_file"].includes(name);
}

function isEditTool(name: string): boolean {
  return ["edit", "patch", "apply_patch", "str_replace_editor", "multi_edit"].includes(name);
}

function isReadTool(name: string): boolean {
  return ["read", "read_file", "cat", "view"].includes(name);
}

function isBashTool(name: string): boolean {
  return ["bash", "shell", "execute", "run", "terminal"].includes(name);
}

function isTestCommand(cmd: string): boolean {
  const testPatterns = [
    /\bbun\s+test\b/,
    /\bnpm\s+test\b/,
    /\bjest\b/,
    /\bvitest\b/,
    /\bpytest\b/,
    /\bcargo\s+test\b/,
    /\bgo\s+test\b/,
    /\bmake\s+test\b/,
    /\btsc\s+--noEmit\b/,
    /\bbunx\s+tsc\b/,
  ];
  return testPatterns.some((p) => p.test(cmd));
}

/** Simple djb2 hash for tool call deduplication */
function hashToolCall(tool: string, input: string): string {
  let hash = 5381;
  const str = `${tool}::${input}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// Placeholder patterns that indicate incomplete code
const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\/\/\s*TODO\b/gi, label: "TODO comment" },
  { pattern: /\/\/\s*FIXME\b/gi, label: "FIXME comment" },
  { pattern: /\/\/\s*HACK\b/gi, label: "HACK comment" },
  { pattern: /\/\/\s*XXX\b/gi, label: "XXX marker" },
  { pattern: /\/\/\s*PLACEHOLDER\b/gi, label: "PLACEHOLDER marker" },
  { pattern: /#\s*TODO\b/gi, label: "TODO comment" },
  { pattern: /#\s*FIXME\b/gi, label: "FIXME comment" },
  { pattern: /\.\.\.\s*\/\/\s*implement/gi, label: "unimplemented placeholder" },
  { pattern: /throw new Error\(['"]not implemented['"]\)/gi, label: "not implemented stub" },
  { pattern: /pass\s*#\s*TODO/gi, label: "Python pass TODO" },
  { pattern: /unimplemented!\(\)/g, label: "Rust unimplemented macro" },
  { pattern: /todo!\(\)/g, label: "Rust todo macro" },
];

// ── Rules ────────────────────────────────────────────────────────────

const RULES: EnforcementRule[] = [
  // Rule 1: Role-based file access control
  {
    id: "role-file-access",
    name: "Role-Based File Access",
    severity: "block",
    appliesTo: ["reviewer", "researcher", "tester", "spec-writer"],
    check(tool, _state, role) {
      const filePath = extractFilePath(tool.input);
      if (!filePath) return null;

      // Reviewers and researchers MUST NOT modify files
      if ((role === "reviewer" || role === "researcher") && (isWriteTool(tool.toolName) || isEditTool(tool.toolName))) {
        return {
          ruleId: "role-file-access",
          severity: "block",
          message: `${role} role is not allowed to modify files. Use read-only operations.`,
          suggestion: "Report findings with file:line references instead of editing.",
          toolName: tool.toolName,
          filePath,
        };
      }

      // Testers can only modify test files
      if (role === "tester" && (isWriteTool(tool.toolName) || isEditTool(tool.toolName))) {
        if (!isTestFile(filePath)) {
          return {
            ruleId: "role-file-access",
            severity: "block",
            message: `Tester role can only modify test files. Attempted to modify: ${filePath}`,
            suggestion: "Only modify files in test directories or with .test/.spec extensions.",
            toolName: tool.toolName,
            filePath,
          };
        }
      }

      // Spec-writers can only modify .md files
      if (role === "spec-writer" && (isWriteTool(tool.toolName) || isEditTool(tool.toolName))) {
        if (!isMarkdownFile(filePath)) {
          return {
            ruleId: "role-file-access",
            severity: "block",
            message: `Spec-writer role can only modify .md files. Attempted to modify: ${filePath}`,
            suggestion: "Write specifications in markdown format only.",
            toolName: tool.toolName,
            filePath,
          };
        }
      }

      return null;
    },
  },

  // Rule 2: Read before write
  {
    id: "read-before-write",
    name: "Read Before Write",
    severity: "block",
    appliesTo: "all",
    check(tool, state) {
      if (!isWriteTool(tool.toolName) && !isEditTool(tool.toolName)) return null;

      const filePath = extractFilePath(tool.input);
      if (!filePath) return null;

      // New file creation is allowed without read
      if (isWriteTool(tool.toolName) && !state.filesRead.has(normalizePath(filePath))) {
        // Check if this could be an existing file being overwritten
        // We can't do fs check here (sync only), so we track writes
        if (state.filesWritten.has(normalizePath(filePath)) || state.filesEdited.has(normalizePath(filePath))) {
          // File was previously modified in this session — must re-read
          return {
            ruleId: "read-before-write",
            severity: "block",
            message: `Cannot overwrite previously modified file without re-reading: ${filePath}`,
            suggestion: "Read the current file contents before writing to ensure no changes are lost.",
            toolName: tool.toolName,
            filePath,
          };
        }
        // First-time write to a new file is OK
        return null;
      }

      // Edit tools always require prior read
      if (isEditTool(tool.toolName) && !state.filesRead.has(normalizePath(filePath))) {
        return {
          ruleId: "read-before-write",
          severity: "block",
          message: `Cannot edit file without reading it first: ${filePath}`,
          suggestion: "Use the read tool to inspect the file contents before making edits.",
          toolName: tool.toolName,
          filePath,
        };
      }

      return null;
    },
  },

  // Rule 3: No placeholder code
  {
    id: "no-placeholder-code",
    name: "No Placeholder Code",
    severity: "inject",
    appliesTo: ["coder", "architect"],
    check(tool) {
      if (!isWriteTool(tool.toolName) && !isEditTool(tool.toolName)) return null;

      const content = extractContent(tool.input);
      if (!content) return null;

      const found: string[] = [];
      for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          found.push(label);
        }
      }

      if (found.length === 0) return null;

      return {
        ruleId: "no-placeholder-code",
        severity: "inject",
        message: `Code contains ${found.length} placeholder(s): ${found.join(", ")}. All code must be fully implemented.`,
        suggestion: "Replace all TODO/FIXME/placeholder comments with actual implementation.",
        toolName: tool.toolName,
      };
    },
  },

  // Rule 4: Doom loop prevention
  {
    id: "doom-loop-block",
    name: "Doom Loop Prevention",
    severity: "block",
    appliesTo: "all",
    check(tool, state) {
      const inputStr = JSON.stringify(tool.input).slice(0, 500);
      const hash = hashToolCall(tool.toolName, inputStr);

      const count = state.toolCallHashes.get(hash) ?? 0;
      if (count >= 8) {
        return {
          ruleId: "doom-loop-block",
          severity: "block",
          message: `Identical tool call detected ${count + 1} times. This appears to be a doom loop.`,
          suggestion: "Try a different approach or tool. If the same operation keeps failing, investigate the root cause.",
          toolName: tool.toolName,
        };
      }

      return null;
    },
  },

  // Rule 5: Test after modify
  {
    id: "test-after-modify",
    name: "Test After Modify",
    severity: "inject",
    appliesTo: ["coder"],
    check(tool, state) {
      // Only trigger on write/edit of source files
      if (!isWriteTool(tool.toolName) && !isEditTool(tool.toolName)) return null;

      const filePath = extractFilePath(tool.input);
      if (!filePath || !isSourceFile(filePath) || isTestFile(filePath)) return null;

      // Check if we've modified 3+ source files without running tests
      if (state.sourceFilesModified >= 3 && !state.testRunSinceLastModify) {
        return {
          ruleId: "test-after-modify",
          severity: "inject",
          message: `${state.sourceFilesModified} source files modified without running tests. Run tests to verify changes.`,
          suggestion: "Run the test suite before continuing to modify more files.",
          toolName: tool.toolName,
          filePath,
        };
      }

      return null;
    },
  },

  // Rule 6: Command safety
  {
    id: "command-safety",
    name: "Command Safety",
    severity: "block",
    appliesTo: "all",
    check(tool, state) {
      if (!isBashTool(tool.toolName)) return null;

      const command = extractCommand(tool.input);
      if (!command) return null;

      // Skip if user already approved this command
      if ((state as any).__approvedCommands?.has(command.trim())) return null;

      const level = classifyCommandEnhanced(command);

      if (level === "forbidden") {
        return {
          ruleId: "command-safety",
          severity: "ask",
          message: `Dangerous command detected: ${command.slice(0, 100)}`,
          suggestion: "This command requires user approval before execution.",
          toolName: tool.toolName,
        };
      }

      return null;
    },
  },

  // Rule 7: Prefer edit over write for existing files
  {
    id: "prefer-edit-over-write",
    name: "Prefer Edit Over Write",
    severity: "warn",
    appliesTo: ["coder"],
    check(tool, state) {
      if (!isWriteTool(tool.toolName)) return null;

      const filePath = extractFilePath(tool.input);
      if (!filePath) return null;

      const normalized = normalizePath(filePath);

      // If we've read this file, it exists — prefer edit over full rewrite
      if (state.filesRead.has(normalized)) {
        const content = extractContent(tool.input);
        if (content) {
          const lineCount = content.split("\n").length;
          // Only warn for large overwrites (small files may legitimately need full rewrite)
          if (lineCount > 50) {
            return {
              ruleId: "prefer-edit-over-write",
              severity: "warn",
              message: `Full rewrite of existing file (${lineCount} lines): ${filePath}. Prefer targeted edits.`,
              suggestion: "Use the edit tool for surgical changes instead of overwriting the entire file.",
              toolName: tool.toolName,
              filePath,
            };
          }
        }
      }

      return null;
    },
  },

  // Rule 8: Scope creep guard
  {
    id: "scope-creep-guard",
    name: "Scope Creep Guard",
    severity: "warn",
    appliesTo: ["coder"],
    check(tool, state) {
      if (!isWriteTool(tool.toolName) && !isEditTool(tool.toolName)) return null;

      const filePath = extractFilePath(tool.input);
      if (!filePath) return null;

      const totalModified = state.filesWritten.size + state.filesEdited.size;

      if (totalModified > 8) {
        return {
          ruleId: "scope-creep-guard",
          severity: "warn",
          message: `${totalModified} files modified in this session. Ensure changes are focused on the current task.`,
          suggestion: "Review whether all file modifications are necessary for the current task.",
          toolName: tool.toolName,
          filePath,
        };
      }

      return null;
    },
  },

  // Rule 9: No self-modify
  {
    id: "no-self-modify",
    name: "No Self-Modification",
    severity: "block",
    appliesTo: "all",
    check(tool) {
      if (!isWriteTool(tool.toolName) && !isEditTool(tool.toolName)) return null;

      const filePath = extractFilePath(tool.input);
      if (!filePath) return null;

      const protectedPaths = [
        ".orchestrator/config",
        ".claude/config",
        ".claude/settings",
        ".env",
        ".env.local",
        "credentials",
        "secrets",
      ];

      for (const protected_ of protectedPaths) {
        if (filePath.includes(protected_)) {
          return {
            ruleId: "no-self-modify",
            severity: "block",
            message: `Modification of protected path blocked: ${filePath}`,
            suggestion: "Configuration and credential files cannot be modified by agents.",
            toolName: tool.toolName,
            filePath,
          };
        }
      }

      return null;
    },
  },
];

// ── Main Enforcer Class ──────────────────────────────────────────────

export class HarnessEnforcer {
  private state: EnforcerState;
  private role: AgentRole;
  private activeRules: EnforcementRule[];
  private violations: EnforcementViolation[] = [];
  private enabled = true;
  private approvedCommands: Set<string> = new Set();

  constructor(role: AgentRole) {
    this.role = role;
    this.state = {
      filesRead: new Set(),
      filesWritten: new Set(),
      filesEdited: new Set(),
      sourceFilesModified: 0,
      testRunSinceLastModify: false,
      toolCallHashes: new Map(),
      toolCallWindow: [],
      totalToolCalls: 0,
      turnNumber: 0,
    };
    // Expose approved commands to rules via state
    (this.state as any).__approvedCommands = this.approvedCommands;

    // Filter rules to those applicable to this role
    this.activeRules = RULES.filter(
      (r) => r.appliesTo === "all" || r.appliesTo.includes(role),
    );
  }

  /**
   * Pre-execution check: validate a tool call against all active rules.
   * Returns whether the call is allowed and any violations found.
   */
  check(toolName: string, input: Record<string, unknown>): EnforcementResult {
    if (!this.enabled) {
      return { allowed: true, violations: [] };
    }

    const tool: ToolCallInput = { toolName: toolName.toLowerCase(), input };
    const violations: EnforcementViolation[] = [];
    const injections: string[] = [];
    let blocked = false;
    let askRequired = false;

    for (const rule of this.activeRules) {
      const violation = rule.check(tool, this.state, this.role);
      if (!violation) continue;

      violations.push(violation);
      this.violations.push(violation);

      if (violation.severity === "block") {
        blocked = true;
      }

      if (violation.severity === "ask") {
        askRequired = true;
      }

      if (violation.severity === "inject" && violation.suggestion) {
        injections.push(
          `[ENFORCER:${violation.ruleId}] ${violation.message} ${violation.suggestion}`,
        );
      }

      // Emit event
      eventBus.publish({
        type: "enforcer:violation" as any,
        ruleId: violation.ruleId,
        severity: violation.severity,
        message: violation.message,
        toolName,
      } as any);
    }

    return {
      allowed: !blocked && !askRequired,
      violations,
      injection: injections.length > 0 ? injections.join("\n") : undefined,
      askRequired,
    };
  }

  /**
   * Post-execution recording: update enforcer state after a tool call executes.
   * Call this after every successful tool execution.
   */
  record(toolName: string, input: Record<string, unknown>): void {
    const name = toolName.toLowerCase();
    const filePath = extractFilePath(input);

    this.state.totalToolCalls++;

    // Track reads
    if (isReadTool(name) && filePath) {
      this.state.filesRead.add(normalizePath(filePath));
    }

    // Track writes
    if (isWriteTool(name) && filePath) {
      const normalized = normalizePath(filePath);
      this.state.filesWritten.add(normalized);
      if (isSourceFile(filePath) && !isTestFile(filePath)) {
        this.state.sourceFilesModified++;
        this.state.testRunSinceLastModify = false;
      }
    }

    // Track edits
    if (isEditTool(name) && filePath) {
      const normalized = normalizePath(filePath);
      this.state.filesEdited.add(normalized);
      if (isSourceFile(filePath) && !isTestFile(filePath)) {
        this.state.sourceFilesModified++;
        this.state.testRunSinceLastModify = false;
      }
    }

    // Track test runs
    if (isBashTool(name)) {
      const command = extractCommand(input);
      if (command && isTestCommand(command)) {
        this.state.testRunSinceLastModify = true;
        this.state.sourceFilesModified = 0;
      }
    }

    // Track tool call hashes for doom loop detection
    const inputStr = JSON.stringify(input).slice(0, 500);
    const hash = hashToolCall(name, inputStr);
    const count = this.state.toolCallHashes.get(hash) ?? 0;
    this.state.toolCallHashes.set(hash, count + 1);

    // Maintain sliding window (last 20 calls)
    this.state.toolCallWindow.push({ hash, ts: Date.now() });
    if (this.state.toolCallWindow.length > 20) {
      const removed = this.state.toolCallWindow.shift()!;
      // Decrement hash count for evicted entries
      const oldCount = this.state.toolCallHashes.get(removed.hash) ?? 1;
      if (oldCount <= 1) {
        this.state.toolCallHashes.delete(removed.hash);
      } else {
        this.state.toolCallHashes.set(removed.hash, oldCount - 1);
      }
    }
  }

  /**
   * Post-output check: validate agent text output for quality issues.
   * Call this after receiving complete text from the agent.
   */
  checkOutput(text: string): EnforcementResult {
    if (!this.enabled) {
      return { allowed: true, violations: [] };
    }

    const violations: EnforcementViolation[] = [];
    const injections: string[] = [];

    // Check for lazy output patterns
    const lazyPatterns: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /I['']ll implement this later/gi, label: "deferred implementation" },
      { pattern: /left as an exercise/gi, label: "exercise cop-out" },
      { pattern: /\.\.\.\s*\(rest of/gi, label: "truncated code" },
      { pattern: /\/\/ \.{3}\s*more/gi, label: "elided code" },
      { pattern: /similar to above/gi, label: "copy reference" },
      { pattern: /etc\.\s*$/gim, label: "trailing etc." },
      { pattern: /and so on\.?\s*$/gim, label: "trailing 'and so on'" },
    ];

    for (const { pattern, label } of lazyPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        const violation: EnforcementViolation = {
          ruleId: "output-quality",
          severity: "inject",
          message: `Output contains incomplete pattern: "${label}". All code must be fully written out.`,
          suggestion: "Write the complete implementation. Do not abbreviate, truncate, or defer code.",
          toolName: "text_output",
        };
        violations.push(violation);
        this.violations.push(violation);
        injections.push(
          `[ENFORCER:output-quality] ${violation.message} ${violation.suggestion}`,
        );
      }
    }

    return {
      allowed: true, // output checks never block
      violations,
      injection: injections.length > 0 ? injections.join("\n") : undefined,
    };
  }

  /** Advance turn counter. Call at each new agent turn. */
  nextTurn(): void {
    this.state.turnNumber++;
  }

  /** Approve a previously blocked command (user granted permission). */
  approve(command: string): void {
    this.approvedCommands.add(command.trim());
  }

  /** Mark a file as read externally (e.g., from initial context). */
  markRead(filePath: string): void {
    this.state.filesRead.add(normalizePath(filePath));
  }

  /** Enable or disable enforcement (e.g., for benchmark runs). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Get whether enforcement is enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Get all recorded violations in this session. */
  getViolations(): EnforcementViolation[] {
    return [...this.violations];
  }

  /** Get violation counts by rule. */
  getViolationStats(): Record<string, { count: number; severity: EnforcementSeverity }> {
    const stats: Record<string, { count: number; severity: EnforcementSeverity }> = {};
    for (const v of this.violations) {
      if (!stats[v.ruleId]) {
        stats[v.ruleId] = { count: 0, severity: v.severity };
      }
      stats[v.ruleId].count++;
    }
    return stats;
  }

  /** Get current state snapshot for debugging. */
  getState(): {
    filesRead: number;
    filesWritten: number;
    filesEdited: number;
    sourceFilesModified: number;
    testRunSinceLastModify: boolean;
    totalToolCalls: number;
    turnNumber: number;
    activeRules: string[];
    violationCount: number;
  } {
    return {
      filesRead: this.state.filesRead.size,
      filesWritten: this.state.filesWritten.size,
      filesEdited: this.state.filesEdited.size,
      sourceFilesModified: this.state.sourceFilesModified,
      testRunSinceLastModify: this.state.testRunSinceLastModify,
      totalToolCalls: this.state.totalToolCalls,
      turnNumber: this.state.turnNumber,
      activeRules: this.activeRules.map((r) => r.id),
      violationCount: this.violations.length,
    };
  }

  /** Reset all state (new session). */
  reset(): void {
    this.state.filesRead.clear();
    this.state.filesWritten.clear();
    this.state.filesEdited.clear();
    this.state.sourceFilesModified = 0;
    this.state.testRunSinceLastModify = false;
    this.state.toolCallHashes.clear();
    this.state.toolCallWindow = [];
    this.state.totalToolCalls = 0;
    this.state.turnNumber = 0;
    this.violations = [];
  }

  /** Format a violation report for display. */
  formatReport(): string {
    if (this.violations.length === 0) return "No violations recorded.";

    const stats = this.getViolationStats();
    const lines: string[] = [
      `Enforcement Report (${this.violations.length} violations)`,
      "─".repeat(50),
    ];

    const sorted = Object.entries(stats).sort((a, b) => b[1].count - a[1].count);
    for (const [ruleId, { count, severity }] of sorted) {
      const icon = severity === "block" ? "X" : severity === "warn" ? "!" : "~";
      lines.push(`  [${icon}] ${ruleId}: ${count}x (${severity})`);
    }

    const blocked = this.violations.filter((v) => v.severity === "block").length;
    const warned = this.violations.filter((v) => v.severity === "warn").length;
    const injected = this.violations.filter((v) => v.severity === "inject").length;

    lines.push("─".repeat(50));
    lines.push(`  Blocked: ${blocked}  Warned: ${warned}  Injected: ${injected}`);

    return lines.join("\n");
  }
}

/** Create a pre-configured enforcer for the given role. */
export function createEnforcer(role: AgentRole): HarnessEnforcer {
  return new HarnessEnforcer(role);
}
