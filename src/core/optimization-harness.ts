// ── Optimization Harness ────────────────────────────────────────────
// Phase-gated optimization with deep study, adaptive models, and
// verified research. Each phase has its own target, model, and strategy.
//
// Phase 0: Deep Study — agent reads source files, produces domain reference
// Phase 1: Foundation — basic structural optimizations (Sonnet)
// Phase 2: Intermediate — domain-specific optimizations from study (Sonnet)
// Phase 3: Advanced — deep optimizations with full domain knowledge (Opus)
// Phase 4: Extreme — micro-level optimizations (Opus)
//
// Quality boosters:
// - Golden solution injection: reference code from past runs
// - Domain verifier: Haiku pre-flight check catches violations before testing
// - Path diversity: each parallel path gets a different "personality"
// - Success/failure pattern tracking: proven techniques & anti-patterns
// - Phase transition injection: winning code from phase N → phase N+1
// - Top-2 tournament seeding: runner-up code seeds 40% of next round's paths
// - Final push: if within 15% of target after all phases, retry
// - Self-check: agents verify domain compliance before submitting code

import { AgentStreamer, type ToolUseEvent } from "../repl/streamer.ts";
import { buildCommand } from "../agents/provider.ts";
import { buildHarness } from "../agents/harness.ts";
import type { ProviderConfig, AgentProfile, ModelTier } from "../config/types.ts";
import { brainstorm, shouldBrainstorm } from "./brainstorm.ts";
import { research, detectPlateau, type StallContext } from "./researcher.ts";
import { randomUUID } from "crypto";

// ── Types ──────────────────────────────────────────────────────────

export interface OptimizationConfig {
  testCommand: string;
  metricPattern: RegExp;
  target: number;
  lowerIsBetter: boolean;
  maxIterations: number;
  parallelPaths: number;
  maxRounds: number;
  workdir: string;
  targetFile: string;
  explorerModel: ModelTier;
  /** Label for the metric being optimized (e.g. "cycles", "ms", "bytes") */
  metricUnit?: string;
  /** Additional source files to feed the agent for deep understanding */
  contextFiles?: string[];
  /** Directory for golden solution persistence (default: ${workdir}/.orc-golden) */
  goldenDir?: string;
}

export interface OptimizationStep {
  iteration: number;
  metric: number | null;
  correct: boolean;
  improved: boolean;
  action: "checkpoint" | "rollback" | "initial";
  strategy?: string;
}

export interface OptimizationResult {
  bestMetric: number;
  initialMetric: number;
  totalIterations: number;
  totalRounds: number;
  history: OptimizationStep[];
  durationMs: number;
  reason: "target_reached" | "max_rounds" | "cancelled" | "error";
}

export interface OptimizationCallbacks {
  onPhaseStart?: (phase: number, name: string, target: number) => void;
  onRoundStart?: (round: number, paths: number) => void;
  onIterationComplete?: (path: number, step: OptimizationStep) => void;
  onTournamentResult?: (round: number, bestMetric: number, bestPath: number) => void;
  onAgentStream?: (path: number, delta: string) => void;
  onAgentTool?: (path: number, tool: ToolUseEvent) => void;
  onTestRun?: (path: number, output: string) => void;
  onResearchStart?: (round: number) => void;
  onResearchProgress?: (phase: string, detail?: string) => void;
  onResearchComplete?: (round: number, durationMs: number) => void;
  onStudyComplete?: (durationMs: number) => void;
  onVerification?: (path: number, valid: boolean, issue?: string) => void;
  onGoldenLoaded?: (count: number) => void;
  onGoldenSaved?: (metric: number) => void;
}

// ── Path Diversity ──────────────────────────────────────────────────

const PATH_PERSONALITIES = [
  "", // path 0: default — follow phase focus directly
  `STYLE: CONSERVATIVE. Make small, safe, incremental changes. Prefer proven patterns from the success history below. Never rewrite more than 20 lines at once. Verify your understanding before using any instruction.`,
  `STYLE: AGGRESSIVE. Make bold structural changes. Rewrite entire functions if the architecture is wrong. Prioritize maximum throughput — it's OK to restructure everything as long as correctness holds.`,
  `STYLE: CREATIVE. Combine techniques in unusual ways. Think about the underlying hardware/runtime — which resources are idle? Can you overlap operations or restructure data flow?`,
  `STYLE: SYSTEMATIC. Before coding, compute the EXACT cost for each section. Identify the single biggest bottleneck. Fix ONLY that bottleneck this iteration. Show your math.`,
];

// ── Success/Failure Patterns ────────────────────────────────────────

interface SuccessPattern {
  fromMetric: number;
  toMetric: number;
  technique: string;
}

interface FailurePattern {
  technique: string;
  reason: string;
}

function extractStrategy(agentText: string): string {
  const patterns = [
    /(?:strategy|approach|plan|optimization)[:\s]*(.+?)(?:\n|$)/i,
    /(?:I'll|Let me|I will|My approach is to|Going to)\s+(.+?)(?:\n|$)/i,
    /##\s*(?:Strategy|Approach|Plan)\s*\n+(.+?)(?:\n|$)/i,
  ];
  for (const p of patterns) {
    const m = agentText.match(p);
    if (m?.[1] && m[1].length > 10) return m[1].trim().slice(0, 200);
  }
  const firstLine = agentText.split("\n").find(l => l.trim().length > 10);
  return firstLine?.trim().slice(0, 200) ?? "unknown approach";
}

// ── Self-Check (Dynamic) ──────────────────────────────────────────

function buildSelfCheck(domainRef: string): string {
  if (!domainRef) return "";
  return `
MANDATORY SELF-CHECK before submitting your code change:
1. Re-read the domain reference above
2. Verify every operation/instruction you use actually exists in the reference
3. Verify you are not violating any constraints or limits described in the reference
4. Check for data dependency violations (writing and reading the same value in the same step)
5. Verify all resource allocations are done before use
If any check fails, fix it before proceeding.`;
}

// ── Golden Solution Persistence ─────────────────────────────────────

async function loadGoldenSolutions(goldenDir: string): Promise<Map<number, string>> {
  const solutions = new Map<number, string>();
  try {
    const proc = Bun.spawn(["ls", goldenDir], { stdout: "pipe", stderr: "pipe" });
    const output = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0 || !output) return solutions;
    for (const filename of output.split("\n")) {
      const match = filename.match(/^golden_(\d+)\.\w+$/);
      if (match) {
        try {
          const content = await Bun.file(`${goldenDir}/${filename}`).text();
          solutions.set(parseInt(match[1]), content);
        } catch { /* skip unreadable */ }
      }
    }
  } catch { /* no golden dir */ }
  return solutions;
}

async function saveGoldenSolution(goldenDir: string, metric: number, code: string): Promise<void> {
  try {
    const mkdirProc = Bun.spawn(["mkdir", "-p", goldenDir], { stdout: "pipe", stderr: "pipe" });
    await mkdirProc.exited;
    await Bun.write(`${goldenDir}/golden_${Math.round(metric)}.py`, code);
  } catch { /* non-fatal */ }
}

function findBestGolden(
  goldenSolutions: Map<number, string>,
  phaseTarget: number,
  currentMetric: number,
  lowerIsBetter: boolean,
): { metric: number; code: string } | undefined {
  let best: { metric: number; code: string } | undefined;
  for (const [metric, code] of goldenSolutions) {
    if (lowerIsBetter) {
      if (metric <= phaseTarget) {
        if (!best || metric > best.metric) best = { metric, code };
      }
    } else {
      if (metric >= phaseTarget) {
        if (!best || metric < best.metric) best = { metric, code };
      }
    }
  }
  return best;
}

// ── Domain Verifier (Haiku Pre-Flight Check) ─────────────────────────
// Fast Haiku agent checks code for domain rule violations before testing.
// Only runs in opus phases where each wasted iteration is costly.

async function verifyDomainCompliance(
  workdir: string,
  targetFile: string,
  domainReference: string,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<{ valid: boolean; issue?: string }> {
  if (!domainReference) return { valid: true };

  let code: string;
  try {
    code = await Bun.file(`${workdir}/${targetFile}`).text();
  } catch {
    return { valid: true };
  }

  const shortRef = domainReference.length > 2000 ? domainReference.slice(0, 2000) : domainReference;
  const shortCode = code.length > 6000 ? code.slice(0, 6000) : code;

  const prompt = `Check this code for domain rule violations based on the reference below. Output ONLY one of:
- "VALID" if no issues found
- "INVALID: <one-line description of the most critical issue>"

## Domain Reference
${shortRef}

## Code to Check
\`\`\`
${shortCode}
\`\`\`

Rules to check:
1. Every operation/instruction used must exist in the domain reference
2. All resource limits and constraints must be respected
3. No data dependency violations (read-after-write in same step, etc.)
4. All required setup/allocation must happen before use
5. Any domain-specific addressing or access patterns must be correct

Only flag CLEAR violations, not style issues.`;

  const streamer = new AgentStreamer();
  const cmd = buildCommand(providerConfig, profile, {
    prompt,
    model: "haiku",
    systemPrompt: "You are a domain compliance checker. Be precise. Only flag CLEAR violations based on the reference, not style issues.",
    maxTurns: 1,
  });

  try {
    const result = await streamer.run(cmd, signal);
    const text = result.text.trim();
    if (text.toUpperCase().startsWith("VALID")) return { valid: true };
    const issueMatch = text.match(/INVALID:\s*(.+)/i);
    return { valid: false, issue: issueMatch?.[1]?.slice(0, 200) ?? text.slice(0, 200) };
  } catch {
    return { valid: true };
  }
}

// ── Phase Definition ──────────────────────────────────────────────

interface OptimizationPhase {
  name: string;
  targetMetric: number;
  model: ModelTier;
  parallelPaths: number;
  maxRounds: number;
  maxIterations: number;
  maxTurns: number;
  focus: string;
}

function buildPhases(finalTarget: number, initialMetric: number, lowerIsBetter: boolean, unit: string): OptimizationPhase[] {
  const phases: OptimizationPhase[] = [];

  // Compute intermediate targets as fractions of the gap
  const gap = Math.abs(initialMetric - finalTarget);
  if (gap === 0) return phases;

  // lerp: fraction of gap from initial toward target
  const lerp = (frac: number) =>
    lowerIsBetter
      ? initialMetric - gap * frac
      : initialMetric + gap * frac;

  // Phase 1: Foundation — get 30% of the way (Sonnet, conservative)
  const t1 = lerp(0.3);
  if (lowerIsBetter ? initialMetric > t1 : initialMetric < t1) {
    phases.push({
      name: "foundation",
      targetMetric: Math.round(t1),
      model: "sonnet",
      parallelPaths: 3,
      maxRounds: 3,
      maxIterations: 15,
      maxTurns: 5,
      focus: `GOAL: Reach ${Math.round(t1)} ${unit} (30% improvement from ${initialMetric}).
STRATEGY: Basic structural optimizations — fix obvious inefficiencies first.
KEY TECHNIQUES:
- Replace unrolled/repeated code with proper loops
- Enable any built-in parallelism or optimization flags
- Fix algorithmic complexity issues (O(n²) → O(n), etc.)
- Use appropriate data structures for the access pattern
Focus on the BIGGEST wins with the LEAST risk. Do not attempt advanced techniques yet.`,
    });
  }

  // Phase 2: Intermediate — get to 60% (Sonnet, moderate)
  const t2 = lerp(0.6);
  if (lowerIsBetter ? finalTarget < t1 : finalTarget > t1) {
    phases.push({
      name: "intermediate",
      targetMetric: Math.round(Math.max(lowerIsBetter ? finalTarget : 0, lowerIsBetter ? t2 : t2)),
      model: "sonnet",
      parallelPaths: 4,
      maxRounds: 4,
      maxIterations: 20,
      maxTurns: 6,
      focus: `GOAL: Reach ${Math.round(t2)} ${unit} (60% improvement).
STRATEGY: Apply domain-specific optimizations revealed by the study phase.
KEY TECHNIQUES:
- Use parallel/vector/SIMD operations if the domain supports them
- Batch processing: process multiple items at once instead of one-by-one
- Memory layout optimization: arrange data for sequential access
- Reduce instruction count by using specialized operations from the domain reference
Consult the domain reference above for available operations and their semantics.`,
    });
  }

  // Phase 3: Advanced — get to 85% (Opus, aggressive)
  const t3 = lerp(0.85);
  if (lowerIsBetter ? finalTarget < t2 : finalTarget > t2) {
    phases.push({
      name: "advanced",
      targetMetric: Math.round(lowerIsBetter ? Math.max(finalTarget, t3) : Math.min(finalTarget, t3)),
      model: "opus",
      parallelPaths: 4,
      maxRounds: 5,
      maxIterations: 25,
      maxTurns: 8,
      focus: `GOAL: Reach ${Math.round(t3)} ${unit} (85% improvement).
STRATEGY: Deep optimizations using full domain knowledge.
KEY TECHNIQUES:
- Hide latency: overlap independent operations (pipelining, interleaving)
- Resolve bottlenecks: identify which resources are saturated and restructure to balance load
- Dependency chain breaking: restructure computation to expose more parallelism
- Memory access pattern optimization: prefetch, coalesce, or reorganize for locality
- Exploit all available execution resources — audit utilization and fill idle capacity
Every optimization must be validated against the domain reference.`,
    });
  }

  // Phase 4: Extreme — get to 95%+ (Opus, micro-level)
  if (lowerIsBetter ? finalTarget < t3 : finalTarget > t3) {
    phases.push({
      name: "extreme",
      targetMetric: finalTarget,
      model: "opus",
      parallelPaths: 5,
      maxRounds: 8,
      maxIterations: 25,
      maxTurns: 8,
      focus: `GOAL: Reach the final target of ${finalTarget} ${unit}.
STRATEGY: Micro-level optimization — every unit of the metric counts.
KEY TECHNIQUES:
- AUDIT FIRST: before any change, produce a detailed breakdown of where cost accumulates
- Resource utilization: for every execution step, check how many available slots/units are used vs wasted
- Replace expensive operations with cheaper equivalents (consult the domain reference)
- Merge adjacent steps that have no data dependencies between them
- Hoist invariant computations out of loops
- Consider unrolling to amortize loop overhead and enable cross-iteration optimization
- MEASURE: quantify the expected improvement before implementing

3. VERIFY: check your changes against ALL domain rules before submitting.`,
    });
  }

  return phases;
}

// ── Default Config ─────────────────────────────────────────────────

const DEFAULT_CONFIG: Partial<OptimizationConfig> = {
  lowerIsBetter: true,
  maxIterations: 25,
  parallelPaths: 3,
  maxRounds: 8,
  explorerModel: "sonnet",
  metricUnit: "units",
};

// ── Metric Parser ──────────────────────────────────────────────────

function parseMetric(output: string, pattern: RegExp): number | null {
  const match = output.match(pattern);
  if (match && match[1]) {
    const val = parseFloat(match[1]);
    return isNaN(val) ? null : val;
  }
  return null;
}

function isImproved(current: number, best: number, lowerIsBetter: boolean): boolean {
  return lowerIsBetter ? current < best : current > best;
}

function isTargetReached(current: number, target: number, lowerIsBetter: boolean): boolean {
  return lowerIsBetter ? current <= target : current >= target;
}

// ── File Operations ───────────────────────────────────────────────

async function saveFile(workdir: string, file: string): Promise<string | null> {
  try {
    return await Bun.file(`${workdir}/${file}`).text();
  } catch {
    return null;
  }
}

async function restoreFile(workdir: string, file: string, content: string): Promise<boolean> {
  try {
    await Bun.write(`${workdir}/${file}`, content);
    return true;
  } catch {
    return false;
  }
}

async function readContextFiles(workdir: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const f of files) {
    try {
      const content = await Bun.file(`${workdir}/${f}`).text();
      parts.push(`\n### File: ${f}\n\`\`\`\n${content}\n\`\`\``);
    } catch { /* skip unreadable files */ }
  }
  return parts.join("\n");
}

// ── Git Worktree Operations ──────────────────────────────────────

async function createWorktree(repoDir: string, worktreePath: string): Promise<boolean> {
  try {
    const headProc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    const headSha = (await new Response(headProc.stdout).text()).trim();
    await headProc.exited;
    const proc = Bun.spawn(
      ["git", "worktree", "add", "--detach", worktreePath, headSha],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
  try {
    const proc = Bun.spawn(["git", "worktree", "remove", "--force", worktreePath], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  } catch { /* best effort */ }
}

async function pruneWorktrees(repoDir: string): Promise<void> {
  try {
    const proc = Bun.spawn(["git", "worktree", "prune"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  } catch { /* best effort */ }
}

async function findGitRoot(dir: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const root = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return root || dir;
}

// ── Test Runner ────────────────────────────────────────────────────

async function runTest(command: string, workdir: string, timeoutMs = 120_000): Promise<{ output: string; exitCode: number }> {
  const [cmd, ...args] = command.split(" ");
  const proc = Bun.spawn([cmd, ...args], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  const exitCode = await proc.exited;
  return { output: stdout + "\n" + stderr, exitCode };
}

// ── Deep Study Phase ──────────────────────────────────────────────

async function deepStudy(
  workdir: string,
  targetFile: string,
  contextFiles: string[],
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<string> {
  const sourceContext = await readContextFiles(workdir, contextFiles);
  const targetCode = await saveFile(workdir, targetFile) ?? "";

  const prompt = `You are about to optimize code for a specialized domain. Before writing ANY code, you must deeply understand the system.

Read ALL the source files below carefully. Then produce a concise DOMAIN REFERENCE CARD that an optimization engineer can use.

## Source Files
${sourceContext}

## Target File (to be optimized)
\`\`\`
${targetCode}
\`\`\`

## Your Task
Produce a reference card covering:

1. **System Architecture**: execution model, resource types, memory model, cost model (what is being optimized — cycles, latency, size, etc.)
2. **Complete Operation Set**: EVERY available operation/instruction with syntax and semantics
   - Group by category (compute, memory, control flow, specialized, etc.)
   - Include exact parameter formats
3. **Resource Limits**: exact limits per execution unit per step/cycle/iteration
4. **Critical Semantics**: timing model, dependency rules, hazard rules (read-after-write, etc.)
5. **Available Data Structures**: what data types, memory regions, addressing modes exist
6. **Current Bottleneck Analysis**: what the current code does and why it's slow
7. **Key Optimization Opportunities**: specific opportunities based on the domain

Be precise. Include exact numbers. This reference will be used by agents who haven't read the source.
Under 800 words.`;

  const system = `You are a domain expert analyzing a specialized system. Read every line of the source code. Be thorough and precise — missing a single operation or getting a semantic wrong will cause optimization failures.`;

  const streamer = new AgentStreamer();
  const cmd = buildCommand(providerConfig, profile, {
    prompt,
    model: "opus",
    systemPrompt: system,
    maxTurns: 1,
  });
  const result = await streamer.run(cmd, signal);
  return result.text.trim();
}

// ── Build Phase-Aware Prompts ─────────────────────────────────────

function buildPhaseSystemPrompt(
  phase: OptimizationPhase,
  domainReference: string,
  config: OptimizationConfig,
  personality?: string,
  prevPhaseCode?: string,
  goldenCode?: { metric: number; code: string },
): string {
  const unit = config.metricUnit ?? "units";
  const parts: string[] = [];

  parts.push(`You are an expert performance optimization engineer.`);

  if (domainReference) {
    parts.push(`\n## Domain Reference (study this carefully)\n${domainReference}`);
  }

  parts.push(`\n## Current Phase: ${phase.name}\n${phase.focus}`);

  if (personality) {
    parts.push(`\n## Your Optimization Style\n${personality}`);
  }

  if (goldenCode) {
    const truncGolden = goldenCode.code.length > 4000 ? goldenCode.code.slice(0, 4000) + "\n# ... (truncated)" : goldenCode.code;
    parts.push(`\n## Reference Solution (achieved ${goldenCode.metric} ${unit} in a previous run)
Study this code's STRUCTURE carefully. It shows optimization patterns that work at this performance level.
Do NOT copy it verbatim — understand WHY it achieves this performance, then apply those principles to your approach.
\`\`\`
${truncGolden}
\`\`\``);
  }

  if (prevPhaseCode) {
    const truncated = prevPhaseCode.length > 6000 ? prevPhaseCode.slice(0, 6000) + "\n# ... (truncated)" : prevPhaseCode;
    parts.push(`\n## Starting Code (result of previous optimization phase)\nStudy this carefully — it represents proven optimizations. Build on it, don't revert it.\n\`\`\`\n${truncated}\n\`\`\``);
  }

  const selfCheck = buildSelfCheck(domainReference);

  parts.push(`
## Iteration Protocol (follow EXACTLY every iteration)

Step 1 — ANALYZE: Read the current code. Identify the single biggest bottleneck.
  Write exactly: "BOTTLENECK: [specific location and why it costs performance]"

Step 2 — PLAN: Propose ONE focused change with expected impact.
  Write exactly: "PLAN: [what change] → expect [N] ${unit} improvement"

Step 3 — IMPLEMENT: Make the change. One optimization only — never combine multiple.

Step 4 — VERIFY: Run the test command. Check correctness and metric.
${selfCheck}

## Rules
- ONE optimization per iteration — combining changes makes failures undiagnosable
- NEVER modify test files
- Correctness is mandatory — broken results will be reverted
- Consult the domain reference before using any operation
- If a technique appears in Anti-Patterns below, DO NOT attempt it again

Working in: ${config.workdir}
Target file: ${config.targetFile}
Test command: ${config.testCommand}`);

  return parts.join("\n");
}

function buildPhaseIterationPrompt(
  phase: OptimizationPhase,
  iteration: number,
  history: OptimizationStep[],
  bestMetric: number,
  lowerIsBetter: boolean,
  unit: string,
  lastOutput?: string,
  deliberation?: string,
  successPatterns?: SuccessPattern[],
  failurePatterns?: FailurePattern[],
  reflection?: string,
): string {
  const lines: string[] = [];

  // ── Status (always shown) ──
  lines.push(`## [Status] ${phase.name} — iteration ${iteration + 1}/${phase.maxIterations}`);
  lines.push(`Current: ${bestMetric} ${unit} → Target: ${phase.targetMetric} ${unit}`);
  lines.push("");

  // ── Deliberation (round-start strategy, iteration 0 only) ──
  if (deliberation) {
    lines.push("## [Plan] Strategy from deliberation");
    lines.push(deliberation);
    lines.push("");
  }

  // ── Reflection from last iteration ──
  if (reflection) {
    lines.push("## [Reflection] What happened last iteration");
    lines.push(reflection);
    lines.push("");
  }

  // ── Knowledge: failures — always shown (critical to avoid wasting iterations) ──
  if (failurePatterns && failurePatterns.length > 0) {
    lines.push("## [Knowledge] Anti-Patterns — DO NOT repeat these");
    for (const fp of failurePatterns.slice(-8)) {
      lines.push(`  ✗ ${fp.technique} — ${fp.reason}`);
    }
    lines.push("");
  }

  // ── Knowledge: successes — shown after iteration 2 (let agent explore freely first) ──
  if (iteration >= 2 && successPatterns && successPatterns.length > 0) {
    lines.push("## [Knowledge] Proven Techniques — build on these, don't undo them");
    for (const sp of successPatterns.slice(-6)) {
      lines.push(`  ✓ ${sp.technique} (${sp.fromMetric} → ${sp.toMetric} ${unit})`);
    }
    lines.push("");
  }

  // ── History — condensed, shown after iteration 3 ──
  if (iteration >= 3 && history.length > 0) {
    lines.push("## [History] Recent attempts");
    for (const step of history.slice(-5)) {
      const marker = step.improved ? "✓" : step.correct ? "○" : "✗";
      lines.push(`  ${marker} iter ${step.iteration}: ${step.metric ?? "N/A"} ${unit} → ${step.action}`);
    }
    lines.push("");
  }

  // ── Observation (last test output) ──
  if (lastOutput) {
    const truncated = lastOutput.length > 2000 ? lastOutput.slice(-2000) : lastOutput;
    lines.push("## [Observation] Last test output");
    lines.push("```");
    lines.push(truncated);
    lines.push("```");
    lines.push("");
  }

  // ── Action instruction ──
  lines.push("Follow the Iteration Protocol: ANALYZE → PLAN → IMPLEMENT → VERIFY.");
  lines.push("Start your response with BOTTLENECK: and PLAN: before writing any code.");
  return lines.join("\n");
}

// ── Single Exploration Path ────────────────────────────────────────

interface PathResult {
  history: OptimizationStep[];
  bestMetric: number;
  bestCode: string | null;
  successPatterns: SuccessPattern[];
  failurePatterns: FailurePattern[];
}

async function runExplorationPath(
  pathIndex: number,
  phase: OptimizationPhase,
  config: OptimizationConfig,
  pathWorkdir: string,
  domainReference: string,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  initialMetric: number,
  deliberation: string | undefined,
  callbacks: OptimizationCallbacks,
  signal?: AbortSignal,
  personality?: string,
  prevPhaseCode?: string,
  inheritedSuccess?: SuccessPattern[],
  inheritedFailure?: FailurePattern[],
  goldenCode?: { metric: number; code: string },
): Promise<PathResult> {
  const history: OptimizationStep[] = [];
  let bestMetric = initialMetric;
  let bestCode = await saveFile(pathWorkdir, config.targetFile);
  let lastTestOutput: string | undefined;
  const successPatterns: SuccessPattern[] = [...(inheritedSuccess ?? [])];
  const failurePatterns: FailurePattern[] = [...(inheritedFailure ?? [])];
  const useVerifier = phase.model === "opus" && domainReference.length > 0;
  const unit = config.metricUnit ?? "units";

  const pathConfig = { ...config, workdir: pathWorkdir };
  const systemPrompt = buildPhaseSystemPrompt(phase, domainReference, pathConfig, personality, prevPhaseCode, goldenCode);
  let lastReflection: string | undefined;

  for (let iter = 0; iter < phase.maxIterations; iter++) {
    if (signal?.aborted) break;

    const prompt = buildPhaseIterationPrompt(
      phase, iter, history, bestMetric,
      config.lowerIsBetter, unit, lastTestOutput,
      iter === 0 ? deliberation : undefined,
      successPatterns, failurePatterns,
      lastReflection,
    );

    const streamer = new AgentStreamer();
    const cmd = buildCommand(providerConfig, profile, {
      prompt,
      model: phase.model,
      systemPrompt,
      maxTurns: phase.maxTurns,
    });

    streamer.on("text_delta", (delta: string) => callbacks.onAgentStream?.(pathIndex, delta));
    streamer.on("tool_use", (tool: ToolUseEvent) => callbacks.onAgentTool?.(pathIndex, tool));

    let agentText = "";
    try {
      const result = await streamer.run(cmd, signal);
      agentText = result.text;
    } catch {
      history.push({ iteration: iter, metric: null, correct: false, improved: false, action: "rollback", strategy: "crashed" });
      if (bestCode) await restoreFile(pathWorkdir, config.targetFile, bestCode);
      continue;
    }

    const strategy = extractStrategy(agentText);

    // Domain verifier pre-flight check (opus phases only)
    if (useVerifier) {
      const verification = await verifyDomainCompliance(
        pathWorkdir, config.targetFile, domainReference,
        providerConfig, profile, signal,
      );
      callbacks.onVerification?.(pathIndex, verification.valid, verification.issue);
      if (!verification.valid) {
        const issue = verification.issue ?? "domain violation";
        failurePatterns.push({ technique: strategy, reason: `violation: ${issue}` });
        const step: OptimizationStep = {
          iteration: iter, metric: null, correct: false, improved: false,
          action: "rollback", strategy: `${strategy} [${issue}]`,
        };
        history.push(step);
        callbacks.onIterationComplete?.(pathIndex, step);
        if (bestCode) await restoreFile(pathWorkdir, config.targetFile, bestCode);
        continue;
      }
    }

    const testResult = await runTest(config.testCommand, pathWorkdir);
    callbacks.onTestRun?.(pathIndex, testResult.output);
    lastTestOutput = testResult.output;

    const metric = parseMetric(testResult.output, config.metricPattern);
    const correct = testResult.exitCode === 0 || (metric !== null && testResult.output.includes("ok"));

    if (metric !== null && correct && isImproved(metric, bestMetric, config.lowerIsBetter)) {
      successPatterns.push({ fromMetric: bestMetric, toMetric: metric, technique: strategy });
      bestMetric = metric;
      bestCode = await saveFile(pathWorkdir, config.targetFile);
      const step: OptimizationStep = { iteration: iter, metric, correct: true, improved: true, action: "checkpoint", strategy };
      history.push(step);
      callbacks.onIterationComplete?.(pathIndex, step);

      if (isTargetReached(metric, phase.targetMetric, config.lowerIsBetter)) {
        break;
      }
    } else if (metric !== null && correct) {
      failurePatterns.push({ technique: strategy, reason: `no improvement (${metric} ${unit}, best is ${bestMetric})` });
      const step: OptimizationStep = { iteration: iter, metric, correct: true, improved: false, action: "rollback", strategy };
      history.push(step);
      callbacks.onIterationComplete?.(pathIndex, step);
      if (bestCode) await restoreFile(pathWorkdir, config.targetFile, bestCode);
    } else {
      failurePatterns.push({ technique: strategy, reason: "broke correctness" });
      const step: OptimizationStep = { iteration: iter, metric, correct: false, improved: false, action: "rollback", strategy };
      history.push(step);
      callbacks.onIterationComplete?.(pathIndex, step);
      if (bestCode) await restoreFile(pathWorkdir, config.targetFile, bestCode);
    }

    // Build structured reflection for next iteration (Manus-inspired)
    const bottleneckMatch = agentText.match(/BOTTLENECK:\s*(.+?)(?:\n|$)/i);
    const planMatch = agentText.match(/PLAN:\s*(.+?)(?:\n|$)/i);
    const reflParts: string[] = [];
    if (bottleneckMatch) reflParts.push(`Identified bottleneck: ${bottleneckMatch[1].trim().slice(0, 150)}`);
    if (planMatch) reflParts.push(`Planned: ${planMatch[1].trim().slice(0, 150)}`);
    const lastStep = history[history.length - 1];
    if (lastStep) {
      reflParts.push(`Result: ${lastStep.metric ?? "N/A"} ${unit} — ${lastStep.improved ? "IMPROVED" : lastStep.correct ? "no gain, rolled back" : "BROKEN, rolled back"}`);
    }
    lastReflection = reflParts.length > 0 ? reflParts.join("\n") : undefined;
  }

  return { history, bestMetric, bestCode, successPatterns, failurePatterns };
}

// ── Worktree Setup/Teardown ──────────────────────────────────────

async function setupWorktrees(
  repoDir: string, count: number, bestCode: string | null, targetFile: string,
): Promise<string[]> {
  const runId = randomUUID().slice(0, 8);
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const wtPath = `/tmp/orc-optimize-${runId}-path${i}`;
    const ok = await createWorktree(repoDir, wtPath);
    if (!ok) {
      const proc = Bun.spawn(["cp", "-r", repoDir, wtPath], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    }
    if (bestCode) await restoreFile(wtPath, targetFile, bestCode);
    paths.push(wtPath);
  }
  return paths;
}

async function setupWorktreesMultiSeed(
  repoDir: string,
  seeds: Array<{ code: string | null; count: number }>,
  targetFile: string,
): Promise<string[]> {
  const runId = randomUUID().slice(0, 8);
  const paths: string[] = [];
  let pathIdx = 0;
  for (const seed of seeds) {
    for (let i = 0; i < seed.count; i++) {
      const wtPath = `/tmp/orc-optimize-${runId}-path${pathIdx}`;
      const ok = await createWorktree(repoDir, wtPath);
      if (!ok) {
        const proc = Bun.spawn(["cp", "-r", repoDir, wtPath], { stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      }
      if (seed.code) await restoreFile(wtPath, targetFile, seed.code);
      paths.push(wtPath);
      pathIdx++;
    }
  }
  return paths;
}

async function teardownWorktrees(repoDir: string, worktrees: string[]): Promise<void> {
  for (const wt of worktrees) {
    await removeWorktree(repoDir, wt);
    try {
      const proc = Bun.spawn(["rm", "-rf", wt], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    } catch { /* best effort */ }
  }
  await pruneWorktrees(repoDir);
}

// ── Run a Single Phase ──────────────────────────────────────────

async function runPhase(
  phase: OptimizationPhase,
  task: string,
  config: OptimizationConfig,
  gitRoot: string,
  domainReference: string,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  bestMetric: number,
  bestCode: string | null,
  allHistory: OptimizationStep[],
  callbacks: OptimizationCallbacks,
  signal?: AbortSignal,
  prevPhaseCode?: string,
  initialSuccess?: SuccessPattern[],
  initialFailure?: FailurePattern[],
  goldenCode?: { metric: number; code: string },
): Promise<{ bestMetric: number; bestCode: string | null; successPatterns: SuccessPattern[]; failurePatterns: FailurePattern[] }> {
  let phaseSuccess: SuccessPattern[] = [...(initialSuccess ?? [])];
  let phaseFailure: FailurePattern[] = [...(initialFailure ?? [])];
  let runnerUpCode: string | null = null;
  const unit = config.metricUnit ?? "units";

  let deliberation: string | undefined;
  const delibTask = `${task}\n\nCurrent metric: ${bestMetric} ${unit}. Phase goal: ${phase.targetMetric} ${unit}.\n\n${phase.focus}`;
  if (shouldBrainstorm(delibTask, "complex")) {
    try {
      const bsResult = await brainstorm(delibTask, providerConfig, profile, signal);
      deliberation = bsResult.synthesized || undefined;
    } catch { /* non-fatal */ }
  }

  for (let round = 0; round < phase.maxRounds; round++) {
    if (signal?.aborted) break;

    callbacks.onRoundStart?.(round, phase.parallelPaths);

    if (bestCode) await restoreFile(config.workdir, config.targetFile, bestCode);

    if (phase.parallelPaths <= 1) {
      const result = await runExplorationPath(
        0, phase, config, config.workdir, domainReference,
        providerConfig, profile, bestMetric, deliberation, callbacks, signal,
        "", prevPhaseCode, phaseSuccess, phaseFailure, goldenCode,
      );
      allHistory.push(...result.history);
      phaseSuccess = result.successPatterns;
      phaseFailure = result.failurePatterns;
      if (isImproved(result.bestMetric, bestMetric, config.lowerIsBetter)) {
        bestMetric = result.bestMetric;
        bestCode = result.bestCode;
      }
    } else {
      let worktrees: string[];
      if (round > 0 && runnerUpCode && runnerUpCode !== bestCode) {
        const primaryCount = Math.ceil(phase.parallelPaths * 0.6);
        const secondaryCount = phase.parallelPaths - primaryCount;
        worktrees = await setupWorktreesMultiSeed(gitRoot, [
          { code: bestCode, count: primaryCount },
          { code: runnerUpCode, count: secondaryCount },
        ], config.targetFile);
      } else {
        worktrees = await setupWorktrees(gitRoot, phase.parallelPaths, bestCode, config.targetFile);
      }

      try {
        const pathResults = await Promise.all(
          worktrees.map((wtPath, p) =>
            runExplorationPath(
              p, phase, config, wtPath, domainReference,
              providerConfig, profile, bestMetric, deliberation, callbacks, signal,
              PATH_PERSONALITIES[p % PATH_PERSONALITIES.length],
              prevPhaseCode, phaseSuccess, phaseFailure, goldenCode,
            ),
          ),
        );

        for (const result of pathResults) allHistory.push(...result.history);

        const seenSuccess = new Set(phaseSuccess.map(s => s.technique));
        const seenFailure = new Set(phaseFailure.map(f => f.technique));
        for (const result of pathResults) {
          for (const sp of result.successPatterns) {
            if (!seenSuccess.has(sp.technique)) { phaseSuccess.push(sp); seenSuccess.add(sp.technique); }
          }
          for (const fp of result.failurePatterns) {
            if (!seenFailure.has(fp.technique)) { phaseFailure.push(fp); seenFailure.add(fp.technique); }
          }
        }

        const sorted = [...pathResults]
          .map((r, i) => ({ ...r, idx: i }))
          .sort((a, b) => config.lowerIsBetter ? a.bestMetric - b.bestMetric : b.bestMetric - a.bestMetric);

        if (sorted.length > 0 && isImproved(sorted[0].bestMetric, bestMetric, config.lowerIsBetter)) {
          bestMetric = sorted[0].bestMetric;
          bestCode = sorted[0].bestCode;
          callbacks.onTournamentResult?.(round, bestMetric, sorted[0].idx);
        }
        if (sorted.length > 1 && sorted[1].bestCode) {
          runnerUpCode = sorted[1].bestCode;
        }
      } finally {
        await teardownWorktrees(gitRoot, worktrees);
      }
    }

    if (bestCode) await restoreFile(config.workdir, config.targetFile, bestCode);

    if (isTargetReached(bestMetric, phase.targetMetric, config.lowerIsBetter)) {
      return { bestMetric, bestCode, successPatterns: phaseSuccess, failurePatterns: phaseFailure };
    }

    // Research + re-deliberation on plateau
    if (round < phase.maxRounds - 1 && allHistory.length > 0) {
      let researchInsights = "";
      if (detectPlateau(allHistory)) {
        callbacks.onResearchStart?.(round);
        try {
          const stallCtx: StallContext = {
            task, currentCode: bestCode ?? "", bestMetric,
            target: phase.targetMetric, history: allHistory,
            roundNumber: round, workdir: config.workdir,
            targetFile: config.targetFile, testCommand: config.testCommand,
            metricPattern: config.metricPattern,
          };
          const researchResult = await research(
            stallCtx, providerConfig, profile, signal,
            (ph, detail) => callbacks.onResearchProgress?.(ph, detail),
          );
          researchInsights = researchResult.synthesis;
          callbacks.onResearchComplete?.(round, researchResult.durationMs);
        } catch { /* non-fatal */ }
      }

      const successBlock = phaseSuccess.length > 0
        ? `\n## What Worked\n${phaseSuccess.slice(-5).map(s => `- ${s.technique} (${s.fromMetric}→${s.toMetric})`).join("\n")}`
        : "";
      const failureBlock = phaseFailure.length > 0
        ? `\n## What Failed (don't repeat)\n${phaseFailure.slice(-5).map(f => `- ${f.technique}: ${f.reason}`).join("\n")}`
        : "";
      const historyContext = allHistory.slice(-15).map(s =>
        `iter ${s.iteration}: ${s.metric ?? "N/A"}, ${s.action}${s.improved ? " (improved)" : ""}`
      ).join("\n");
      const researchBlock = researchInsights ? `\n\n## Research Insights\n${researchInsights}` : "";
      const reDelibTask = `${task}\n\nPhase: ${phase.name}, target: ${phase.targetMetric}\nBest: ${bestMetric}\n${historyContext}${successBlock}${failureBlock}${researchBlock}\n\n${phase.focus}\n\nPropose the NEXT strategy. Do NOT repeat failed approaches.`;
      try {
        const bsResult = await brainstorm(reDelibTask, providerConfig, profile, signal);
        deliberation = bsResult.synthesized || deliberation;
      } catch { /* keep old */ }
    }
  }

  return { bestMetric, bestCode, successPatterns: phaseSuccess, failurePatterns: phaseFailure };
}

// ── Main Optimization Harness ──────────────────────────────────────

export async function runOptimization(
  task: string,
  config: OptimizationConfig,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  callbacks: OptimizationCallbacks = {},
  signal?: AbortSignal,
): Promise<OptimizationResult> {
  const startTime = Date.now();
  const fullConfig = { ...DEFAULT_CONFIG, ...config } as OptimizationConfig;
  const allHistory: OptimizationStep[] = [];
  const gitRoot = await findGitRoot(fullConfig.workdir);
  const goldenDir = fullConfig.goldenDir ?? `${fullConfig.workdir}/.orc-golden`;
  const unit = fullConfig.metricUnit ?? "units";

  // 1. Load golden solutions from past runs
  const goldenSolutions = await loadGoldenSolutions(goldenDir);
  if (goldenSolutions.size > 0) {
    callbacks.onGoldenLoaded?.(goldenSolutions.size);
  }

  // 2. Initial metric
  const initialTest = await runTest(fullConfig.testCommand, fullConfig.workdir);
  const initialMetric = parseMetric(initialTest.output, fullConfig.metricPattern);
  if (initialMetric === null) {
    return { bestMetric: Infinity, initialMetric: Infinity, totalIterations: 0, totalRounds: 0, history: [], durationMs: Date.now() - startTime, reason: "error" };
  }

  let bestMetric = initialMetric;
  let bestCode = await saveFile(fullConfig.workdir, fullConfig.targetFile);

  // 3. Deep Study Phase
  let domainReference = "";
  const contextFiles = fullConfig.contextFiles ?? [];
  if (contextFiles.length > 0) {
    try {
      const studyStart = Date.now();
      domainReference = await deepStudy(
        fullConfig.workdir, fullConfig.targetFile, contextFiles,
        providerConfig, profile, signal,
      );
      callbacks.onStudyComplete?.(Date.now() - studyStart);
    } catch { /* non-fatal */ }
  }

  // 4. Build optimization phases
  const phases = buildPhases(fullConfig.target, initialMetric, fullConfig.lowerIsBetter, unit);
  if (phases.length === 0) {
    return { bestMetric, initialMetric, totalIterations: 0, totalRounds: 0, history: allHistory, durationMs: Date.now() - startTime, reason: "target_reached" };
  }

  // 5. Execute phases sequentially
  let totalRounds = 0;
  let prevPhaseCode: string | undefined;
  let carrySuccess: SuccessPattern[] = [];
  let carryFailure: FailurePattern[] = [];

  for (const phase of phases) {
    if (signal?.aborted) {
      return { bestMetric, initialMetric, totalIterations: allHistory.length, totalRounds, history: allHistory, durationMs: Date.now() - startTime, reason: "cancelled" };
    }

    callbacks.onPhaseStart?.(phases.indexOf(phase), phase.name, phase.targetMetric);

    const golden = findBestGolden(goldenSolutions, phase.targetMetric, bestMetric, fullConfig.lowerIsBetter);

    const phaseResult = await runPhase(
      phase, task, fullConfig, gitRoot, domainReference,
      providerConfig, profile, bestMetric, bestCode,
      allHistory, callbacks, signal, prevPhaseCode,
      undefined, undefined, golden,
    );

    bestMetric = phaseResult.bestMetric;
    bestCode = phaseResult.bestCode;
    totalRounds += phase.maxRounds;
    carrySuccess = phaseResult.successPatterns;
    carryFailure = phaseResult.failurePatterns;
    prevPhaseCode = bestCode ?? undefined;

    if (bestCode && isImproved(bestMetric, initialMetric, fullConfig.lowerIsBetter)) {
      await saveGoldenSolution(goldenDir, bestMetric, bestCode);
      callbacks.onGoldenSaved?.(bestMetric);
    }

    if (isTargetReached(bestMetric, fullConfig.target, fullConfig.lowerIsBetter)) {
      if (bestCode) await restoreFile(fullConfig.workdir, fullConfig.targetFile, bestCode);
      return { bestMetric, initialMetric, totalIterations: allHistory.length, totalRounds, history: allHistory, durationMs: Date.now() - startTime, reason: "target_reached" };
    }
  }

  // 6. Final push — if within 15% of target, retry with accumulated knowledge
  const closeEnough = fullConfig.lowerIsBetter
    ? bestMetric <= fullConfig.target * 1.15
    : bestMetric >= fullConfig.target * 0.85;

  if (closeEnough && !signal?.aborted) {
    callbacks.onPhaseStart?.(phases.length, "final_push", fullConfig.target);

    const golden = findBestGolden(goldenSolutions, fullConfig.target, bestMetric, fullConfig.lowerIsBetter);
    const selfCheck = buildSelfCheck(domainReference);
    const gapPct = fullConfig.lowerIsBetter
      ? ((bestMetric / fullConfig.target - 1) * 100).toFixed(0)
      : ((1 - bestMetric / fullConfig.target) * 100).toFixed(0);

    const pushPhase: OptimizationPhase = {
      name: "final_push",
      targetMetric: fullConfig.target,
      model: "opus",
      parallelPaths: 6,
      maxRounds: 6,
      maxIterations: 20,
      maxTurns: 8,
      focus: `GOAL: FINAL PUSH — get from ${bestMetric} to ${fullConfig.lowerIsBetter ? "below" : "above"} ${fullConfig.target} ${unit}.
You are ${gapPct}% away from the target. This is achievable.

STRATEGY: Micro-level optimization — every single ${unit.replace(/s$/, "")} counts.
1. AUDIT: produce a detailed breakdown of where cost accumulates in the hot path
2. BIGGEST WIN FIRST: identify the step/section with the most waste and fix it
3. REPLACE EXPENSIVE WITH CHEAP: consult the domain reference for cheaper equivalent operations
4. MERGE STEPS: adjacent steps with no data dependencies can often be combined
5. HOIST INVARIANTS: any value computed identically every iteration belongs outside the loop
6. Remember: the winning code represents PROVEN optimizations. Don't undo them.
${selfCheck}`,
    };

    const pushResult = await runPhase(
      pushPhase, task, fullConfig, gitRoot, domainReference,
      providerConfig, profile, bestMetric, bestCode,
      allHistory, callbacks, signal, prevPhaseCode,
      carrySuccess, carryFailure, golden,
    );

    bestMetric = pushResult.bestMetric;
    bestCode = pushResult.bestCode;
    totalRounds += pushPhase.maxRounds;

    if (bestCode && isImproved(bestMetric, initialMetric, fullConfig.lowerIsBetter)) {
      await saveGoldenSolution(goldenDir, bestMetric, bestCode);
      callbacks.onGoldenSaved?.(bestMetric);
    }
  }

  if (bestCode) await restoreFile(fullConfig.workdir, fullConfig.targetFile, bestCode);

  const reason = isTargetReached(bestMetric, fullConfig.target, fullConfig.lowerIsBetter)
    ? "target_reached" : "max_rounds";
  return { bestMetric, initialMetric, totalIterations: allHistory.length, totalRounds, history: allHistory, durationMs: Date.now() - startTime, reason };
}
