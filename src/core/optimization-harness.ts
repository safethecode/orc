// ── Optimization Harness ────────────────────────────────────────────
// Iterative edit→test→measure→feedback loop for optimization tasks.
//
// Flow:
//   1. Agent edits code
//   2. Harness runs test command automatically
//   3. Parse metric from output (e.g., cycle count)
//   4. If improved + correct: checkpoint (git)
//   5. If regressed or broken: rollback to last checkpoint
//   6. Feed structured feedback to agent → next iteration
//
// Supports parallel tournament: N agents explore different strategies,
// best result wins and becomes the starting point for the next round.

import { AgentStreamer, type ToolUseEvent } from "../repl/streamer.ts";
import { buildCommand } from "../agents/provider.ts";
import { buildHarness } from "../agents/harness.ts";
import type { ProviderConfig, AgentProfile, ModelTier } from "../config/types.ts";
import { brainstorm, shouldBrainstorm } from "./brainstorm.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface OptimizationConfig {
  /** Shell command to run tests (e.g., "python tests/submission_tests.py") */
  testCommand: string;
  /** Regex to extract metric from test output. First capture group = number */
  metricPattern: RegExp;
  /** Target metric value (stop when reached) */
  target: number;
  /** Lower is better (default true, e.g., cycle count) */
  lowerIsBetter: boolean;
  /** Max iterations per exploration path */
  maxIterations: number;
  /** Number of parallel exploration paths */
  parallelPaths: number;
  /** Max rounds of tournament selection */
  maxRounds: number;
  /** Working directory for the optimization */
  workdir: string;
  /** File being optimized (for rollback tracking) */
  targetFile: string;
  /** Extra context for the agent's system prompt */
  domainContext?: string;
  /** Model tier for exploration agents */
  explorerModel: ModelTier;
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
  onRoundStart?: (round: number, paths: number) => void;
  onIterationComplete?: (path: number, step: OptimizationStep) => void;
  onTournamentResult?: (round: number, bestMetric: number, bestPath: number) => void;
  onAgentStream?: (path: number, delta: string) => void;
  onAgentTool?: (path: number, tool: ToolUseEvent) => void;
  onTestRun?: (path: number, output: string) => void;
}

// ── Default Config ─────────────────────────────────────────────────

const DEFAULT_CONFIG: Partial<OptimizationConfig> = {
  lowerIsBetter: true,
  maxIterations: 15,
  parallelPaths: 3,
  maxRounds: 5,
  explorerModel: "sonnet",
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

// ── Git Operations ─────────────────────────────────────────────────

async function gitCheckpoint(workdir: string, label: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "stash", "create", label], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
    const sha = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return sha || null;
  } catch {
    return null;
  }
}

async function gitRollbackFile(workdir: string, file: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "checkout", "HEAD", "--", file], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return true;
  } catch {
    return false;
  }
}

async function gitSaveFile(workdir: string, file: string): Promise<string | null> {
  try {
    const fullPath = `${workdir}/${file}`;
    const content = await Bun.file(fullPath).text();
    return content;
  } catch {
    return null;
  }
}

async function gitRestoreFile(workdir: string, file: string, content: string): Promise<boolean> {
  try {
    const fullPath = `${workdir}/${file}`;
    await Bun.write(fullPath, content);
    return true;
  } catch {
    return false;
  }
}

// ── Test Runner ────────────────────────────────────────────────────

async function runTest(command: string, workdir: string, timeoutMs = 120_000): Promise<{ output: string; exitCode: number }> {
  const [cmd, ...args] = command.split(" ");
  const proc = Bun.spawn([cmd, ...args], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);

  const exitCode = await proc.exited;
  return { output: stdout + "\n" + stderr, exitCode };
}

// ── Build Agent Prompt ─────────────────────────────────────────────

function buildIterationPrompt(
  task: string,
  iteration: number,
  maxIterations: number,
  history: OptimizationStep[],
  bestMetric: number,
  target: number,
  lowerIsBetter: boolean,
  lastOutput?: string,
  deliberation?: string,
): string {
  const lines: string[] = [];

  lines.push(`## Optimization Task (iteration ${iteration + 1}/${maxIterations})`);
  lines.push("");
  lines.push(task);
  lines.push("");

  // Metric history
  if (history.length > 0) {
    lines.push("## Performance History");
    const direction = lowerIsBetter ? "lower is better" : "higher is better";
    lines.push(`Target: ${target} (${direction}). Current best: ${bestMetric}`);
    lines.push("");
    for (const step of history.slice(-10)) {
      const marker = step.improved ? "✓" : step.correct ? "○" : "✗";
      const metricStr = step.metric !== null ? String(step.metric) : "N/A";
      lines.push(`  ${marker} iter ${step.iteration}: ${metricStr} cycles — ${step.action}${step.strategy ? ` (${step.strategy})` : ""}`);
    }
    lines.push("");
  }

  // Deliberation strategy
  if (deliberation) {
    lines.push(deliberation);
    lines.push("");
  }

  // Last test output (truncated)
  if (lastOutput) {
    const truncated = lastOutput.length > 2000 ? lastOutput.slice(-2000) : lastOutput;
    lines.push("## Last Test Output");
    lines.push("```");
    lines.push(truncated);
    lines.push("```");
    lines.push("");
  }

  // Instructions
  lines.push("## Instructions");
  lines.push("- Edit the code to improve the metric. Focus on ONE optimization at a time.");
  lines.push("- Do NOT modify files in the tests/ folder.");
  lines.push("- After editing, I will automatically run tests and measure the metric.");
  lines.push("- If your change breaks correctness, it will be reverted automatically.");
  lines.push("- Explain your optimization strategy briefly before implementing it.");

  return lines.join("\n");
}

// ── System Prompt ──────────────────────────────────────────────────

function buildOptimizationSystemPrompt(config: OptimizationConfig): string {
  const parts: string[] = [];

  parts.push("You are an expert performance optimization engineer. Your task is to iteratively optimize code to minimize a measured metric.");
  parts.push("");
  parts.push("## Rules");
  parts.push("1. Make ONE focused optimization per iteration");
  parts.push("2. NEVER modify test files");
  parts.push("3. Always maintain correctness — wrong results will be reverted");
  parts.push("4. Explain your strategy briefly, then implement it");
  parts.push("5. Use vector/SIMD operations when possible for parallelism");
  parts.push("6. Use loops instead of unrolling when instruction count matters");
  parts.push("7. Pack independent operations into the same VLIW bundle");
  parts.push("");

  if (config.domainContext) {
    parts.push(config.domainContext);
  }

  parts.push("");
  parts.push(`Working in: ${config.workdir}`);
  parts.push(`Target file: ${config.targetFile}`);
  parts.push(`Test command: ${config.testCommand}`);

  return parts.join("\n");
}

// ── Single Exploration Path ────────────────────────────────────────

async function runExplorationPath(
  pathIndex: number,
  task: string,
  config: OptimizationConfig,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  initialMetric: number,
  deliberation: string | undefined,
  callbacks: OptimizationCallbacks,
  signal?: AbortSignal,
): Promise<{ history: OptimizationStep[]; bestMetric: number; bestCode: string | null }> {
  const history: OptimizationStep[] = [];
  let bestMetric = initialMetric;
  let bestCode = await gitSaveFile(config.workdir, config.targetFile);
  let lastTestOutput: string | undefined;

  const systemPrompt = buildOptimizationSystemPrompt(config);

  for (let iter = 0; iter < config.maxIterations; iter++) {
    if (signal?.aborted) break;

    // Build prompt for this iteration
    const prompt = buildIterationPrompt(
      task,
      iter,
      config.maxIterations,
      history,
      bestMetric,
      config.target,
      config.lowerIsBetter,
      lastTestOutput,
      iter === 0 ? deliberation : undefined,
    );

    // Run agent
    const streamer = new AgentStreamer();
    const cmd = buildCommand(providerConfig, profile, {
      prompt,
      model: config.explorerModel,
      systemPrompt,
      maxTurns: 5,
    });

    // Wire up streaming callbacks
    streamer.on("text_delta", (delta: string) => callbacks.onAgentStream?.(pathIndex, delta));
    streamer.on("tool_use", (tool: ToolUseEvent) => callbacks.onAgentTool?.(pathIndex, tool));

    try {
      await streamer.run(cmd, signal);
    } catch {
      // Agent crashed — skip this iteration
      history.push({ iteration: iter, metric: null, correct: false, improved: false, action: "rollback" });
      if (bestCode) await gitRestoreFile(config.workdir, config.targetFile, bestCode);
      continue;
    }

    // Auto-run tests
    const testResult = await runTest(config.testCommand, config.workdir);
    callbacks.onTestRun?.(pathIndex, testResult.output);
    lastTestOutput = testResult.output;

    // Parse metric
    const metric = parseMetric(testResult.output, config.metricPattern);
    const correct = testResult.exitCode === 0 || (metric !== null && testResult.output.includes("ok"));

    if (metric !== null && correct && isImproved(metric, bestMetric, config.lowerIsBetter)) {
      // Improvement! Checkpoint.
      bestMetric = metric;
      bestCode = await gitSaveFile(config.workdir, config.targetFile);
      const step: OptimizationStep = { iteration: iter, metric, correct: true, improved: true, action: "checkpoint" };
      history.push(step);
      callbacks.onIterationComplete?.(pathIndex, step);

      // Check if target reached
      if (isTargetReached(metric, config.target, config.lowerIsBetter)) {
        break;
      }
    } else if (metric !== null && correct) {
      // Correct but not improved — keep going but rollback
      const step: OptimizationStep = { iteration: iter, metric, correct: true, improved: false, action: "rollback" };
      history.push(step);
      callbacks.onIterationComplete?.(pathIndex, step);
      if (bestCode) await gitRestoreFile(config.workdir, config.targetFile, bestCode);
    } else {
      // Broken — rollback
      const step: OptimizationStep = { iteration: iter, metric, correct: false, improved: false, action: "rollback" };
      history.push(step);
      callbacks.onIterationComplete?.(pathIndex, step);
      if (bestCode) await gitRestoreFile(config.workdir, config.targetFile, bestCode);
    }
  }

  return { history, bestMetric, bestCode };
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

  // 1. Get initial metric
  const initialTest = await runTest(fullConfig.testCommand, fullConfig.workdir);
  const initialMetric = parseMetric(initialTest.output, fullConfig.metricPattern);
  if (initialMetric === null) {
    return {
      bestMetric: Infinity,
      initialMetric: Infinity,
      totalIterations: 0,
      totalRounds: 0,
      history: [],
      durationMs: Date.now() - startTime,
      reason: "error",
    };
  }

  let bestMetric = initialMetric;
  let bestCode = await gitSaveFile(fullConfig.workdir, fullConfig.targetFile);

  // 2. Deliberation (strategy planning)
  let deliberation: string | undefined;
  if (shouldBrainstorm(task, "complex")) {
    try {
      const bsResult = await brainstorm(task, providerConfig, profile, signal);
      deliberation = bsResult.synthesized || undefined;
    } catch { /* non-fatal */ }
  }

  // 3. Tournament rounds
  for (let round = 0; round < fullConfig.maxRounds; round++) {
    if (signal?.aborted) {
      return { bestMetric, initialMetric, totalIterations: allHistory.length, totalRounds: round, history: allHistory, durationMs: Date.now() - startTime, reason: "cancelled" };
    }

    callbacks.onRoundStart?.(round, fullConfig.parallelPaths);

    // Ensure all paths start from the same best code
    if (bestCode) {
      await gitRestoreFile(fullConfig.workdir, fullConfig.targetFile, bestCode);
    }

    // Run parallel exploration paths
    if (fullConfig.parallelPaths <= 1) {
      // Single path — no parallelism overhead
      const result = await runExplorationPath(
        0, task, fullConfig, providerConfig, profile,
        bestMetric, deliberation, callbacks, signal,
      );
      allHistory.push(...result.history);
      if (isImproved(result.bestMetric, bestMetric, fullConfig.lowerIsBetter)) {
        bestMetric = result.bestMetric;
        bestCode = result.bestCode;
      }
    } else {
      // Parallel paths: each gets a copy of the best code
      // Since they modify the same file, we serialize but vary the strategy
      // TODO: true parallelism with git worktrees
      const pathResults = [];
      for (let p = 0; p < fullConfig.parallelPaths; p++) {
        if (signal?.aborted) break;
        // Restore best code before each path
        if (bestCode) await gitRestoreFile(fullConfig.workdir, fullConfig.targetFile, bestCode);
        const result = await runExplorationPath(
          p, task, fullConfig, providerConfig, profile,
          bestMetric, deliberation, callbacks, signal,
        );
        pathResults.push(result);
        allHistory.push(...result.history);
      }

      // Tournament: find best path
      let tournamentBest = bestMetric;
      let tournamentCode = bestCode;
      let tournamentPath = -1;
      for (let p = 0; p < pathResults.length; p++) {
        const r = pathResults[p];
        if (isImproved(r.bestMetric, tournamentBest, fullConfig.lowerIsBetter)) {
          tournamentBest = r.bestMetric;
          tournamentCode = r.bestCode;
          tournamentPath = p;
        }
      }
      if (tournamentPath >= 0) {
        bestMetric = tournamentBest;
        bestCode = tournamentCode;
        callbacks.onTournamentResult?.(round, bestMetric, tournamentPath);
      }
    }

    // Restore best code for next round
    if (bestCode) await gitRestoreFile(fullConfig.workdir, fullConfig.targetFile, bestCode);

    // Check if target reached
    if (isTargetReached(bestMetric, fullConfig.target, fullConfig.lowerIsBetter)) {
      return {
        bestMetric,
        initialMetric,
        totalIterations: allHistory.length,
        totalRounds: round + 1,
        history: allHistory,
        durationMs: Date.now() - startTime,
        reason: "target_reached",
      };
    }

    // Update deliberation with new performance history for next round
    // (Re-deliberate with knowledge of what worked)
    if (round < fullConfig.maxRounds - 1 && allHistory.length > 0) {
      const historyContext = allHistory.slice(-10).map(s =>
        `iter ${s.iteration}: ${s.metric ?? "N/A"} cycles, ${s.action}${s.improved ? " (improved!)" : ""}`
      ).join("\n");
      const reDelibTask = `${task}\n\n## Previous Optimization Attempts\nBest so far: ${bestMetric} cycles (target: ${fullConfig.target})\n${historyContext}\n\nPropose the NEXT optimization strategy based on what worked and what didn't.`;
      try {
        const bsResult = await brainstorm(reDelibTask, providerConfig, profile, signal);
        deliberation = bsResult.synthesized || deliberation;
      } catch { /* keep old deliberation */ }
    }
  }

  return {
    bestMetric,
    initialMetric,
    totalIterations: allHistory.length,
    totalRounds: fullConfig.maxRounds,
    history: allHistory,
    durationMs: Date.now() - startTime,
    reason: "max_rounds",
  };
}
