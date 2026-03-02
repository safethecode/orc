// ── Dynamic Harness ──────────────────────────────────────────────────
// Extends the static harness with runtime-gathered codebase context,
// task-specific strategy selection, and failure recovery guidance.
// This is the key differentiator vs. raw Claude Code and oh-my-opencode:
// we inject what the model NEEDS TO KNOW to avoid wasting tokens.

import { existsSync, readFileSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { buildHarness, type HarnessOptions, type HarnessResult } from "./harness.ts";

// Optional AI SDK import for smart classification (graceful degradation)
let generateText: typeof import("ai").generateText | null = null;
let createAnthropic: typeof import("@ai-sdk/anthropic").createAnthropic | null = null;
try {
  const ai = await import("ai");
  const anthropic = await import("@ai-sdk/anthropic");
  generateText = ai.generateText;
  createAnthropic = anthropic.createAnthropic;
} catch {
  // AI SDK not available — keyword fallback will be used
}

// ── Types ────────────────────────────────────────────────────────────

export interface DynamicHarnessOptions extends HarnessOptions {
  projectDir: string;
  prompt: string;
  relevantFiles?: string[];       // pre-identified relevant files
  recentGitLog?: string;          // recent git log output
  gitStatus?: string;             // current git status
  siblingContext?: string;         // context from sibling workers
  turnBudget?: number;            // max turns for this task
  previousFailures?: string[];    // what failed before (for retry context)
}

interface ProjectFingerprint {
  language: string;
  framework: string | null;
  testRunner: string | null;
  packageManager: string;
  strictMode: boolean;
  linting: string | null;
  keyDirs: string[];
  entryPoints: string[];
}

type TaskType = "bug_fix" | "feature" | "refactor" | "test_write" | "review" | "debug" | "generic";

// ── Role → TaskType mapping ──────────────────────────────────────────
// Non-coder roles have a deterministic task type; only coders need classification.
import type { AgentRole } from "../config/types.ts";

const ROLE_TASK_MAP: Partial<Record<AgentRole, TaskType>> = {
  tester: "test_write",
  reviewer: "review",
  architect: "review",
  researcher: "generic",
  "spec-writer": "generic",
  qa: "review",
};

function resolveTaskTypeSync(role: string, prompt: string): TaskType {
  const forced = ROLE_TASK_MAP[role as AgentRole];
  if (forced) return forced;
  return classifyTaskTypeKeyword(prompt);
}

async function resolveTaskTypeAsync(role: string, prompt: string): Promise<TaskType> {
  const forced = ROLE_TASK_MAP[role as AgentRole];
  if (forced) return forced;
  return classifyTaskTypeAI(prompt);
}

// ── Layer 6: Codebase Context ────────────────────────────────────────

function detectProjectFingerprint(projectDir: string): ProjectFingerprint {
  const fp: ProjectFingerprint = {
    language: "unknown",
    framework: null,
    testRunner: null,
    packageManager: "npm",
    strictMode: false,
    linting: null,
    keyDirs: [],
    entryPoints: [],
  };

  // Package manager detection
  if (existsSync(join(projectDir, "bun.lockb")) || existsSync(join(projectDir, "bun.lock"))) {
    fp.packageManager = "bun";
  } else if (existsSync(join(projectDir, "pnpm-lock.yaml"))) {
    fp.packageManager = "pnpm";
  } else if (existsSync(join(projectDir, "yarn.lock"))) {
    fp.packageManager = "yarn";
  }

  // package.json analysis
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Language
      if (allDeps.typescript || existsSync(join(projectDir, "tsconfig.json"))) {
        fp.language = "typescript";
      } else {
        fp.language = "javascript";
      }

      // Framework
      if (allDeps.next) fp.framework = "next.js";
      else if (allDeps.react) fp.framework = "react";
      else if (allDeps.vue) fp.framework = "vue";
      else if (allDeps.svelte) fp.framework = "svelte";
      else if (allDeps.express) fp.framework = "express";
      else if (allDeps.fastify) fp.framework = "fastify";
      else if (allDeps.hono) fp.framework = "hono";

      // Test runner
      if (allDeps.vitest) fp.testRunner = "vitest";
      else if (allDeps.jest) fp.testRunner = "jest";
      else if (allDeps.mocha) fp.testRunner = "mocha";
      else if (allDeps["@playwright/test"]) fp.testRunner = "playwright";
      else if (fp.packageManager === "bun") fp.testRunner = "bun:test";

      // Entry points from scripts
      if (pkg.main) fp.entryPoints.push(pkg.main);
      if (pkg.bin) {
        const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin);
        fp.entryPoints.push(...(bins as string[]));
      }
    } catch { /* malformed package.json */ }
  }

  // Python detection
  if (existsSync(join(projectDir, "pyproject.toml")) || existsSync(join(projectDir, "setup.py"))) {
    fp.language = "python";
    fp.packageManager = existsSync(join(projectDir, "poetry.lock")) ? "poetry" :
      existsSync(join(projectDir, "uv.lock")) ? "uv" : "pip";
    if (existsSync(join(projectDir, "pytest.ini")) || existsSync(join(projectDir, "conftest.py"))) {
      fp.testRunner = "pytest";
    }
  }

  // Rust detection
  if (existsSync(join(projectDir, "Cargo.toml"))) {
    fp.language = "rust";
    fp.packageManager = "cargo";
    fp.testRunner = "cargo test";
  }

  // Go detection
  if (existsSync(join(projectDir, "go.mod"))) {
    fp.language = "go";
    fp.packageManager = "go";
    fp.testRunner = "go test";
  }

  // TypeScript strict mode
  const tsconfigPath = join(projectDir, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      const raw = readFileSync(tsconfigPath, "utf-8")
        .replace(/\/\/.*$/gm, "")           // strip line comments
        .replace(/\/\*[\s\S]*?\*\//g, "");   // strip block comments
      const tsconfig = JSON.parse(raw);
      fp.strictMode = tsconfig.compilerOptions?.strict === true;
    } catch { /* malformed tsconfig */ }
  }

  // Linting
  if (existsSync(join(projectDir, "eslint.config.js")) || existsSync(join(projectDir, ".eslintrc.json")) || existsSync(join(projectDir, ".eslintrc.js"))) {
    fp.linting = "eslint";
  } else if (existsSync(join(projectDir, "biome.json"))) {
    fp.linting = "biome";
  }

  // Key directories (check common patterns)
  const commonDirs = ["src", "lib", "app", "pages", "components", "api", "server", "tests", "test", "__tests__"];
  for (const dir of commonDirs) {
    if (existsSync(join(projectDir, dir))) {
      fp.keyDirs.push(dir);
    }
  }

  return fp;
}

function formatCodebaseContext(fp: ProjectFingerprint, opts: DynamicHarnessOptions): string {
  const lines: string[] = ["## Project Context"];

  // Fingerprint
  lines.push(`Language: ${fp.language}${fp.strictMode ? " (strict)" : ""}`);
  if (fp.framework) lines.push(`Framework: ${fp.framework}`);
  lines.push(`Package manager: ${fp.packageManager}`);
  if (fp.testRunner) lines.push(`Test runner: ${fp.testRunner}`);
  if (fp.linting) lines.push(`Linter: ${fp.linting}`);

  // Test command inference
  if (fp.testRunner) {
    const testCmd = fp.testRunner === "bun:test" ? "bun test" :
      fp.testRunner === "cargo test" ? "cargo test" :
      fp.testRunner === "go test" ? "go test ./..." :
      fp.testRunner === "pytest" ? "pytest" :
      `${fp.packageManager} test`;
    lines.push(`Run tests: \`${testCmd}\``);
  }

  // Key structure
  if (fp.keyDirs.length > 0) {
    lines.push(`Key directories: ${fp.keyDirs.join(", ")}`);
  }
  if (fp.entryPoints.length > 0) {
    lines.push(`Entry points: ${fp.entryPoints.join(", ")}`);
  }

  // Git state
  if (opts.gitStatus) {
    const statusLines = opts.gitStatus.trim().split("\n").slice(0, 8);
    if (statusLines.length > 0 && statusLines[0].trim()) {
      lines.push(`\nGit status: ${statusLines.length} change(s)`);
      for (const sl of statusLines) {
        lines.push(`  ${sl.trim()}`);
      }
    }
  }

  if (opts.recentGitLog) {
    const logLines = opts.recentGitLog.trim().split("\n").slice(0, 5);
    if (logLines.length > 0) {
      lines.push(`\nRecent commits:`);
      for (const ll of logLines) {
        lines.push(`  ${ll.trim()}`);
      }
    }
  }

  // Relevant files
  if (opts.relevantFiles && opts.relevantFiles.length > 0) {
    const relFiles = opts.relevantFiles.map(f => relative(opts.projectDir, f) || f);
    lines.push(`\nRelevant files for this task:`);
    for (const rf of relFiles.slice(0, 15)) {
      lines.push(`  ${rf}`);
    }
  }

  return lines.join("\n");
}

// ── Layer 7: Task Strategy ───────────────────────────────────────────

// Cache for AI classifications to avoid duplicate calls
const classificationCache = new Map<string, TaskType>();

/**
 * AI-powered task classification using Haiku (~$0.001 per call).
 * Falls back to keyword matching if AI SDK is unavailable or call fails.
 */
async function classifyTaskTypeAI(prompt: string): Promise<TaskType> {
  // Check cache first (use first 200 chars as key)
  const cacheKey = prompt.slice(0, 200);
  if (classificationCache.has(cacheKey)) return classificationCache.get(cacheKey)!;

  // If AI SDK not available, fall back to keywords
  if (!generateText || !createAnthropic) {
    return classifyTaskTypeKeyword(prompt);
  }

  try {
    const anthropic = createAnthropic();
    const result = await Promise.race([
      generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        prompt: `Classify this coding task into exactly one category. Reply with ONLY the category name, nothing else.

Categories:
- bug_fix (fixing errors, crashes, incorrect behavior)
- feature (adding new functionality)
- refactor (restructuring code without changing behavior)
- test_write (writing or improving tests)
- review (code review, audit, inspection)
- debug (investigating root cause of issues)
- generic (anything else)

Task: ${prompt.slice(0, 500)}

Category:`,
        maxOutputTokens: 20,
        temperature: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("CLASSIFY_TIMEOUT")), 3000),
      ),
    ]);

    const raw = result.text.trim().toLowerCase().replace(/[^a-z_]/g, "");
    const valid: TaskType[] = ["bug_fix", "feature", "refactor", "test_write", "review", "debug", "generic"];
    const classified = valid.includes(raw as TaskType) ? (raw as TaskType) : classifyTaskTypeKeyword(prompt);

    classificationCache.set(cacheKey, classified);
    return classified;
  } catch {
    // AI classification failed — fall back to keywords
    return classifyTaskTypeKeyword(prompt);
  }
}

/** Keyword-based classification (fast fallback, no API call). */
function classifyTaskTypeKeyword(prompt: string): TaskType {
  const lower = prompt.toLowerCase();

  // Use word-boundary regex to avoid substring false positives (e.g., "debug" matching "bug")
  const bugKeywords = [/\bfix\b/, /\bbug\b/, /\berror\b/, /\bcrash/, /\bbroken\b/, /doesn't work/, /\bfails?\b/, /\bissue\b/, /\bwrong\b/, /\bincorrect\b/, /수정/, /버그/, /에러/, /오류/];
  const featureKeywords = [/\badd\b/, /\bcreate\b/, /\bimplement/, /\bbuild\b/, /\bnew\b/, /\bfeature\b/, /추가/, /구현/, /만들/];
  const refactorKeywords = [/\brefactor/, /\brename\b/, /\bmove\b/, /\bextract\b/, /clean ?up/, /\bsimplify\b/, /리팩토링/, /리팩터/];
  const testKeywords = [/\btest/, /\bspec\b/, /\bcoverage\b/, /\bassertion\b/, /테스트/];
  const reviewKeywords = [/\breview\b/, /\baudit\b/, /\binspect\b/, /리뷰/, /검토/];
  const debugKeywords = [/\bdebug\b/, /\btrace\b/, /\binvestigat/, /\bwhy\b/, /root cause/, /디버그/, /원인/];

  const score = (patterns: RegExp[]): number =>
    patterns.filter(p => p.test(lower)).length;

  const scores: [TaskType, number][] = [
    ["bug_fix", score(bugKeywords)],
    ["feature", score(featureKeywords)],
    ["refactor", score(refactorKeywords)],
    ["test_write", score(testKeywords)],
    ["review", score(reviewKeywords)],
    ["debug", score(debugKeywords)],
  ];

  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : "generic";
}

const TASK_STRATEGIES: Record<TaskType, string> = {
  bug_fix: `## Strategy: Bug Fix
1. REPRODUCE: Read the relevant code and understand the expected vs actual behavior.
2. ISOLATE: Identify the root cause — do not guess. Read error messages, stack traces, and related code.
3. FIX: Make the minimal change that addresses the root cause, not symptoms.
4. VERIFY: Run tests to confirm the fix. Add a regression test if none exists.
5. CHECK: Ensure the fix doesn't break other functionality.`,

  feature: `## Strategy: Feature Implementation
1. UNDERSTAND: Read existing code in the target area. Identify patterns and conventions.
2. PLAN: Decide where the new code should go. Prefer extending existing structures over creating new files.
3. IMPLEMENT: Write clean code that follows the project's existing patterns. No TODOs or placeholders.
4. TEST: Run existing tests. Write new tests for the feature.
5. INTEGRATE: Verify the feature works with the rest of the codebase.`,

  refactor: `## Strategy: Refactoring
1. ANALYZE: Read all files that will be affected. Understand the current structure.
2. PLAN: Describe the target state. Ensure it's strictly better, not just different.
3. TRANSFORM: Make changes incrementally. Run tests after each step.
4. VERIFY: All existing tests must pass. Behavior must be identical (unless intentionally changed).
5. CLEANUP: Remove dead code. Update imports. Run the linter.`,

  test_write: `## Strategy: Test Writing
1. READ: Understand the code being tested — its inputs, outputs, edge cases, and error paths.
2. IDENTIFY: List the scenarios that need testing (happy path, edge cases, error cases).
3. WRITE: Write focused, independent tests. Each test should test one thing.
4. RUN: Execute the tests and verify they pass.
5. COVERAGE: Check that critical paths are covered. Don't test trivial getters/setters.`,

  review: `## Strategy: Code Review
1. READ: Read all changed files thoroughly. Understand the intent of each change.
2. CHECK: Look for correctness issues, edge cases, error handling, and security problems.
3. VERIFY: Check that the code follows project conventions.
4. REPORT: Categorize findings as blocking (must fix), warning (should fix), or suggestion (nice to have).
5. FORMAT: Report each issue with file:line references.`,

  debug: `## Strategy: Debugging
1. OBSERVE: Read the error output, logs, and relevant code carefully.
2. HYPOTHESIZE: List 2-3 possible causes. Start with the most likely.
3. TEST: Add targeted logging or read related code to confirm/reject each hypothesis.
4. IDENTIFY: Narrow down to the exact root cause before making any changes.
5. FIX: Apply the minimal fix and verify it resolves the issue.`,

  generic: `## Strategy
1. READ: Understand the relevant code before making changes.
2. PLAN: Think about your approach before acting.
3. EXECUTE: Make changes incrementally. Verify each step.
4. TEST: Run the test suite after changes.
5. REPORT: Summarize what you changed and why.`,
};

// ── Layer 8: Failure Recovery ────────────────────────────────────────

function buildFailureRecoveryBlock(previousFailures?: string[]): string {
  const lines: string[] = ["## Recovery Protocol"];

  lines.push(
    "If your edit fails: re-read the file (it may have changed) and retry with updated content.",
    "If a test fails: read the FULL error output before changing code. Fix the root cause, not the symptom.",
    "If the same approach fails 3 times: stop, analyze what's wrong, and try a completely different strategy.",
    "If you're unsure about a change: read more context (related files, tests, docs) before acting.",
    "If you encounter a type error: check the actual type definitions, don't guess signatures.",
  );

  // Inject previous failure context for retries
  if (previousFailures && previousFailures.length > 0) {
    lines.push("");
    lines.push("PREVIOUS ATTEMPTS THAT FAILED (do NOT repeat these):");
    for (const f of previousFailures.slice(-3)) {
      lines.push(`  - ${f}`);
    }
    lines.push("You MUST try a different approach.");
  }

  return lines.join("\n");
}

// ── Worker Coordination Block ────────────────────────────────────────

function buildWorkerCoordinationBlock(opts: DynamicHarnessOptions): string {
  if (!opts.isWorker) return "";

  const lines: string[] = ["## Worker Coordination"];

  if (opts.siblingContext) {
    lines.push(`Other workers in this task:\n${opts.siblingContext}`);
    lines.push("Do NOT modify files assigned to other workers.");
  }

  if (opts.turnBudget) {
    lines.push(`Turn budget: ${opts.turnBudget}. Pace yourself accordingly.`);
    if (opts.turnBudget <= 5) {
      lines.push("LOW BUDGET: Be extremely focused. Skip exploration, go straight to the fix.");
    } else if (opts.turnBudget >= 30) {
      lines.push("HIGH BUDGET: Take time to read thoroughly and verify carefully.");
    }
  }

  return lines.join("\n");
}

// ── Quality Gate Block ───────────────────────────────────────────────

function buildQualityGateBlock(fp: ProjectFingerprint): string {
  const lines: string[] = [
    "## Quality Requirements",
    "ZERO TOLERANCE for placeholder code: no TODO, FIXME, HACK, or unimplemented stubs.",
    "All code must be complete and functional.",
  ];

  if (fp.strictMode) {
    lines.push("TypeScript strict mode is ON: handle all nullable types, use explicit types for function parameters.");
  }

  if (fp.testRunner) {
    lines.push(`Tests must pass. Run \`${fp.testRunner === "bun:test" ? "bun test" : fp.testRunner}\` before reporting done.`);
  }

  if (fp.linting) {
    lines.push(`Linting is configured (${fp.linting}). Ensure no lint errors.`);
  }

  lines.push("Do NOT add comments to unchanged code. Do NOT refactor unrelated code.");

  return lines.join("\n");
}

// ── Main: Build Dynamic Harness ──────────────────────────────────────

/**
 * Build dynamic harness (sync version — uses keyword classification).
 * Prefer buildDynamicHarnessAsync() for better classification accuracy.
 */
export function buildDynamicHarness(options: DynamicHarnessOptions): HarnessResult {
  const taskType = resolveTaskTypeSync(options.role, options.prompt);
  return assembleDynamicHarness(options, taskType);
}

/**
 * Build dynamic harness (async version — uses Haiku AI for task classification).
 * Falls back to keyword classification if AI SDK is unavailable.
 * Cost: ~$0.001 per call via Haiku.
 */
export async function buildDynamicHarnessAsync(options: DynamicHarnessOptions): Promise<HarnessResult> {
  const taskType = await resolveTaskTypeAsync(options.role, options.prompt);
  return assembleDynamicHarness(options, taskType);
}

/** Internal: assemble harness from classified task type. */
function assembleDynamicHarness(options: DynamicHarnessOptions, taskType: TaskType): HarnessResult {
  // Start with static harness (layers 1-5)
  const base = buildHarness(options);

  // Layer 6: Codebase context
  const fp = detectProjectFingerprint(options.projectDir);
  const codebaseBlock = formatCodebaseContext(fp, options);

  // Layer 7: Task strategy
  const strategyBlock = TASK_STRATEGIES[taskType];

  // Layer 8: Failure recovery
  const recoveryBlock = buildFailureRecoveryBlock(options.previousFailures);

  // Worker coordination (conditional)
  const coordinationBlock = buildWorkerCoordinationBlock(options);

  // Quality gate
  const qualityBlock = buildQualityGateBlock(fp);

  // Assemble the full dynamic harness
  const dynamicSections = [
    base.systemPrompt,
    `\n\n${codebaseBlock}`,
    `\n\n${strategyBlock}`,
    `\n\n${qualityBlock}`,
    `\n\n${recoveryBlock}`,
    coordinationBlock ? `\n\n${coordinationBlock}` : "",
  ].join("");

  const tokenEstimate = Math.ceil(dynamicSections.length / 4);

  return {
    systemPrompt: dynamicSections,
    tokenEstimate,
  };
}

/**
 * Detect project fingerprint for external use (e.g., by commands).
 */
export function getProjectFingerprint(projectDir: string): ProjectFingerprint {
  return detectProjectFingerprint(projectDir);
}

/**
 * Classify a prompt into a task type for external use.
 * Sync version (keyword-based).
 */
export function getTaskType(prompt: string): TaskType {
  return classifyTaskTypeKeyword(prompt);
}

/**
 * Classify a prompt into a task type using AI (Haiku).
 * Async version with fallback to keywords.
 */
export async function getTaskTypeAI(prompt: string): Promise<TaskType> {
  return classifyTaskTypeAI(prompt);
}
