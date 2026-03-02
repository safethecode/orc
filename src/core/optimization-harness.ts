// ── Optimization Harness ────────────────────────────────────────────
// Phase-gated optimization with deep study, adaptive models, and
// verified research. Each phase has its own target, model, and strategy.
//
// Phase 0: Deep Study — agent reads ISA/simulator, produces reference
// Phase 1: Foundation — loops + basic VLIW packing (Sonnet)
// Phase 2: Vectorization — SIMD with valu/vload/vstore (Sonnet)
// Phase 3: Advanced — scatter emulation + interleaving (Opus)
// Phase 4: Extreme — software pipelining (Opus)
// Phase 5: Micro — cycle-level bundle auditing + slot filling (Opus)
//
// Quality boosters:
// - Path diversity: each parallel path gets a different "personality"
// - Success/failure pattern tracking: proven techniques & anti-patterns
// - Phase transition injection: winning code from phase N → phase N+1
// - Top-2 tournament seeding: runner-up code seeds 40% of next round's paths
// - Final push: if within 15% of target after all phases, retry with fresh strategy
// - Self-check: agents must verify ISA compliance before submitting code

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
  /** Additional source files to feed the agent for deep understanding */
  contextFiles?: string[];
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
}

// ── Path Diversity ──────────────────────────────────────────────────

const PATH_PERSONALITIES = [
  "", // path 0: default — follow phase focus directly
  `STYLE: CONSERVATIVE. Make small, safe, incremental changes. Prefer proven patterns from the success history below. Never rewrite more than 20 lines at once. Verify your understanding of each instruction before using it.`,
  `STYLE: AGGRESSIVE. Make bold structural changes. Rewrite entire functions if the architecture is wrong. Prioritize maximum throughput — it's OK to restructure everything as long as correctness holds.`,
  `STYLE: CREATIVE. Combine techniques in unusual ways. What would a hardware engineer do? Think about the physical pipeline — which stages are idle? Can you overlap operations across loop iterations?`,
  `STYLE: SYSTEMATIC. Before coding, compute the EXACT cycle count for each section. Identify the single biggest time sink. Fix ONLY that bottleneck this iteration. Show your cycle math.`,
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

// ── Self-Check Prompt Fragment ──────────────────────────────────────

const SELF_CHECK = `
MANDATORY SELF-CHECK before submitting your code change:
1. Verify every instruction name exists in the ISA reference above
2. Count slots per bundle: alu ≤ 12, valu ≤ 6, load ≤ 2, store ≤ 2, flow ≤ 1
3. No RAW hazards: you cannot READ a value WRITTEN in the same bundle (end-of-cycle writes)
4. Scratch registers must be allocated before use (alloc_scratch)
5. vload/vstore addresses must be contiguous — NOT for scatter/gather
If any check fails, fix it before proceeding.`;

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

function buildPhases(finalTarget: number, initialMetric: number): OptimizationPhase[] {
  const phases: OptimizationPhase[] = [];

  // Phase 1: Foundation — loops + basic VLIW packing
  if (initialMetric > 18000) {
    phases.push({
      name: "foundation",
      targetMetric: 18000,
      model: "sonnet",
      parallelPaths: 3,
      maxRounds: 3,
      maxIterations: 15,
      maxTurns: 8,
      focus: `GOAL: Get below 18,000 cycles.
STRATEGY: Convert the unrolled round×batch loops into actual loops using flow jump/cond_jump instructions, and enable VLIW packing by calling self.build(body, vliw=True).
KEY TECHNIQUES:
- Use cond_jump_rel or cond_jump for loop control instead of unrolling rounds and batch items
- The build() method already has VLIW packing logic — use it by passing vliw=True
- A loop counter in scratch + compare + conditional jump replaces the unrolled Python for-loops
- This alone should give 8-10x speedup from reduced instruction count`,
    });
  }

  // Phase 2: Vectorization — SIMD
  if (finalTarget < 18000) {
    phases.push({
      name: "vectorization",
      targetMetric: Math.max(finalTarget, 4000),
      model: "sonnet",
      parallelPaths: 4,
      maxRounds: 4,
      maxIterations: 20,
      maxTurns: 10,
      focus: `GOAL: Vectorize using SIMD to get below 4,000 cycles.
STRATEGY: Process VLEN=8 batch items simultaneously using vector instructions.
KEY TECHNIQUES:
- vload: load VLEN contiguous elements from memory into scratch (addr is scalar)
- vstore: store VLEN elements from scratch to memory (addr is scalar)
- valu: operate on VLEN elements in parallel. Same ops as alu but on vectors
  e.g., ("^", vdest, va, vb) XORs 8 pairs simultaneously
- vbroadcast: copy a scalar to all VLEN lanes
- vselect: per-lane conditional select (like select but vectorized)
- Allocate vector scratch registers: alloc_scratch(name, VLEN) gives 8 consecutive addresses
- Process the batch in chunks of VLEN instead of one-by-one
- Hash computation can be fully vectorized since each batch item is independent

EXAMPLE PATTERN — vectorized XOR over batch:
  alloc_scratch("vdata", VLEN)    # 8 consecutive addresses
  alloc_scratch("vmask", VLEN)
  body.append(("vload", vdata, batch_base_addr))   # load 8 batch items
  body.append(("vbroadcast", vmask, scalar_key))    # broadcast key to all lanes
  body.append(("^", vdata, vdata, vmask, "valu"))   # XOR all 8 in parallel`,
    });
  }

  // Phase 3: Advanced — scatter emulation + dependency hiding
  if (finalTarget < 4000) {
    phases.push({
      name: "advanced",
      targetMetric: Math.max(finalTarget, 2000),
      model: "opus",
      parallelPaths: 4,
      maxRounds: 5,
      maxIterations: 25,
      maxTurns: 15,
      focus: `GOAL: Get below 2,000 cycles with advanced memory and scheduling optimizations.
STRATEGY: Solve the scatter load bottleneck and hide dependency latencies.
KEY TECHNIQUES:
- Scatter load emulation: vload only works for contiguous addresses, but tree node access is indexed.
  Solution: use multiple scalar "load" or "load_offset" instructions packed in one VLIW bundle.
  With load slot limit of 2, you need ceil(VLEN/2) = 4 cycles to gather 8 values.
  OR: precompute addresses with valu, then use load_offset in a loop.
- Dependency chain hiding: the 6-stage hash has a serial dependency chain.
  Interleave computation for different vector chunks to fill otherwise-idle slots.
  While chunk A waits for hash stage 3, start hash stage 1 for chunk B.
- Pack ALU operations (12 slots!) with loads (2 slots) in the same bundle.
  Address calculations (alu) can share a bundle with data loads.
- SLOT LIMITS: alu:12, valu:6, load:2, store:2, flow:1, debug:64

EXAMPLE PATTERN — scatter gather with scalar loads:
  # Gather 8 tree values using 4 cycles (2 loads per cycle)
  for i in range(0, VLEN, 2):
      body.append(("load_offset", dest[i], base, idx[i]))
      body.append(("load_offset", dest[i+1], base, idx[i+1]))
      # Pack address calc for next pair in same bundle:
      if i+2 < VLEN:
          body.append(("add", idx[i+2], node_base, offset[i+2], "alu"))
          body.append(("add", idx[i+3], node_base, offset[i+3], "alu"))`,
    });
  }

  // Phase 4: Extreme — software pipelining + structural optimization
  if (finalTarget < 2000) {
    phases.push({
      name: "extreme",
      targetMetric: Math.max(finalTarget, 1500),
      model: "opus",
      parallelPaths: 5,
      maxRounds: 8,
      maxIterations: 25,
      maxTurns: 15,
      focus: `GOAL: Get below ${Math.max(finalTarget, 1500)} cycles with software pipelining.
STRATEGY: Software pipelining, full VLIW slot utilization, and micro-architectural tricks.
KEY TECHNIQUES:
- Software pipelining: overlap iterations of the main loop.
  While iteration N does hash computation, iteration N+1 can do memory loads.
  This requires a "prologue" to fill the pipeline and "epilogue" to drain it.
- Modulo scheduling: assign each operation to a specific cycle offset within the loop.
  Ensures every cycle uses the maximum number of slots.
- Minimize flow engine usage: flow has only 1 slot (select, vselect, cond_jump).
  Replace select with bitwise: (cond * a) | ((1-cond) * b) using alu.
  This frees the flow slot for loop control.
- Use add_imm for loop counter increments (single flow slot, no alu needed).
- Consider processing multiple rounds in the inner loop to increase the work per iteration
  and allow more pipelining overlap.
- EVERY idle slot is a wasted cycle. Audit each bundle and fill empty slots.

EXAMPLE PATTERN — software pipelined loop:
  # Prologue: start first iteration's loads
  body.append(("vload", data_A, addr_0))     # iter 0 loads
  body.append(("add", addr_1, addr_0, stride, "alu"))
  # Steady state: overlap load(N+1) with compute(N)
  loop_body = [
      ("vload", data_B, addr_next),           # load for NEXT iteration
      ("^", hash_A, hash_A, data_A, "valu"),  # compute THIS iteration
      ("*", hash_A, hash_A, prime, "valu"),    # more compute THIS
      ("add", addr_next, addr_next, stride, "alu"),  # addr calc for next
  ]
  # Epilogue: finish last iteration's compute (no more loads needed)
${SELF_CHECK}`,
    });
  }

  // Phase 5: Micro — cycle-level bundle auditing + slot filling
  if (finalTarget < 1500) {
    phases.push({
      name: "micro",
      targetMetric: finalTarget,
      model: "opus",
      parallelPaths: 5,
      maxRounds: 10,
      maxIterations: 20,
      maxTurns: 12,
      focus: `GOAL: Get below ${finalTarget} cycles with cycle-level micro-optimization.
THIS IS THE FINAL PHASE. You are close to the target. Every single cycle matters.

APPROACH — audit first, optimize second:
1. Before ANY code change, produce a CYCLE AUDIT of the main loop:
   - List each VLIW bundle (cycle) in the hot loop
   - For each bundle: slot usage — alu: N/12, valu: N/6, load: N/2, store: N/2, flow: N/1
   - Calculate: total_cycles = bundles_per_iteration × loop_iterations
   - Identify the #1 waste: which bundles have the most empty slots?

2. OPTIMIZATION PRIORITIES (highest impact first):
   a. REPLACE FLOW WITH ALU: select/vselect uses the flow engine (only 1 slot!).
      Replace with bitwise: result = (cond & a) | (~cond & b) using alu/valu (12/6 slots).
      This is often worth 10-50 cycles because it unblocks cond_jump packing.
   b. MERGE BUNDLES: if two adjacent bundles have no data dependencies between them
      (no value written in bundle A is read in bundle B), merge them into one bundle.
   c. FILL EMPTY SLOTS: if a bundle uses 1/12 alu, move address calculations from
      neighboring bundles into the empty slots.
   d. HOIST INVARIANTS: move loads/computations that don't change per iteration outside the loop.
      Use the "const" instruction for compile-time constants.
   e. UNROLL 2x: if the loop body has few bundles, unrolling 2x hides the cond_jump overhead
      and creates more opportunities for inter-iteration slot filling.

3. MEASURE: count cycles before and after. Show your math.

SLOT LIMITS: alu:12, valu:6, load:2, store:2, flow:1
CRITICAL BOTTLENECK: flow has 1 slot. select + cond_jump cannot coexist in one bundle.
Every select you eliminate = one more bundle where cond_jump can pack with other work.
${SELF_CHECK}`,
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
      parts.push(`\n### File: ${f}\n\`\`\`python\n${content}\n\`\`\``);
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

  const prompt = `You are about to optimize code for a custom VLIW SIMD architecture. Before writing ANY code, you must deeply understand the machine.

Read ALL the source files below carefully. Then produce a concise ISA REFERENCE CARD that an optimization engineer can use.

## Source Files
${sourceContext}

## Target File (to be optimized)
\`\`\`python
${targetCode}
\`\`\`

## Your Task
Produce a reference card covering:

1. **Machine Architecture**: cores, scratch space, memory model, cycle counting rules
2. **Complete Instruction Set**: EVERY engine and EVERY operation with its syntax and semantics
   - alu ops: list ALL of them with (op, dest, src1, src2) format
   - valu ops: list ALL with vector semantics (VLEN elements)
   - load ops: load, vload, const, load_offset — exact semantics
   - store ops: store, vstore — exact semantics
   - flow ops: select, vselect, cond_jump, jump, add_imm, etc.
3. **Slot Limits**: exact limits per engine per cycle
4. **Critical Semantics**: end-of-cycle writes, hazard rules (WAW, RAW within a bundle)
5. **Available Data Structures**: Tree, Input, memory layout (header format)
6. **Current Bottleneck Analysis**: what the current scalar code does and why it's slow
7. **Key Optimization Opportunities**: specific opportunities based on the ISA

Be precise. Include exact numbers. This reference will be used by agents who haven't read the source.
Under 800 words.`;

  const system = `You are a computer architect analyzing a custom ISA. Read every line of the simulator code. Be thorough and precise — missing a single instruction or getting a semantic wrong will cause optimization failures.`;

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
  isaReference: string,
  config: OptimizationConfig,
  personality?: string,
  prevPhaseCode?: string,
): string {
  const parts: string[] = [];

  parts.push(`You are an expert performance optimization engineer working on a custom VLIW SIMD architecture.

## ISA Reference (study this carefully)
${isaReference}

## Current Phase: ${phase.name}
${phase.focus}`);

  if (personality) {
    parts.push(`\n## Your Optimization Style\n${personality}`);
  }

  if (prevPhaseCode) {
    const truncated = prevPhaseCode.length > 6000 ? prevPhaseCode.slice(0, 6000) + "\n# ... (truncated)" : prevPhaseCode;
    parts.push(`\n## Starting Code (result of previous optimization phase)\nStudy this carefully — it represents proven optimizations. Build on it, don't revert it.\n\`\`\`python\n${truncated}\n\`\`\``);
  }

  parts.push(`
## Rules
1. Make ONE focused optimization per iteration
2. NEVER modify files in tests/ folder
3. Always maintain correctness — wrong results will be reverted
4. Read the ISA reference above BEFORE coding. Understand what instructions exist.
5. Before implementing, briefly state your strategy in one sentence starting with "Strategy:"

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
  lastOutput?: string,
  deliberation?: string,
  successPatterns?: SuccessPattern[],
  failurePatterns?: FailurePattern[],
): string {
  const lines: string[] = [];

  lines.push(`## ${phase.name} — iteration ${iteration + 1}/${phase.maxIterations}`);
  lines.push(`Current: ${bestMetric} cycles → Target: ${phase.targetMetric} cycles`);
  lines.push("");

  if (successPatterns && successPatterns.length > 0) {
    lines.push("## Proven Techniques (these WORKED — build on them, don't undo them)");
    for (const sp of successPatterns.slice(-8)) {
      lines.push(`  ✓ ${sp.technique} (${sp.fromMetric} → ${sp.toMetric} cycles)`);
    }
    lines.push("");
  }

  if (failurePatterns && failurePatterns.length > 0) {
    lines.push("## Anti-Patterns (DO NOT repeat — these already failed)");
    for (const fp of failurePatterns.slice(-6)) {
      lines.push(`  ✗ ${fp.technique} — ${fp.reason}`);
    }
    lines.push("");
  }

  if (history.length > 0) {
    lines.push("## Performance History");
    for (const step of history.slice(-10)) {
      const marker = step.improved ? "IMPROVED" : step.correct ? "no_gain" : "BROKEN";
      lines.push(`  ${marker} iter ${step.iteration}: ${step.metric ?? "N/A"} cycles → ${step.action}`);
    }
    lines.push("");
  }

  if (deliberation) {
    lines.push(deliberation);
    lines.push("");
  }

  if (lastOutput) {
    const truncated = lastOutput.length > 2000 ? lastOutput.slice(-2000) : lastOutput;
    lines.push("## Last Test Output");
    lines.push("```");
    lines.push(truncated);
    lines.push("```");
    lines.push("");
  }

  lines.push("Now implement the next optimization. State your strategy first, then implement it.");
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
  isaReference: string,
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
): Promise<PathResult> {
  const history: OptimizationStep[] = [];
  let bestMetric = initialMetric;
  let bestCode = await saveFile(pathWorkdir, config.targetFile);
  let lastTestOutput: string | undefined;
  const successPatterns: SuccessPattern[] = [...(inheritedSuccess ?? [])];
  const failurePatterns: FailurePattern[] = [...(inheritedFailure ?? [])];

  const pathConfig = { ...config, workdir: pathWorkdir };
  const systemPrompt = buildPhaseSystemPrompt(phase, isaReference, pathConfig, personality, prevPhaseCode);

  for (let iter = 0; iter < phase.maxIterations; iter++) {
    if (signal?.aborted) break;

    const prompt = buildPhaseIterationPrompt(
      phase, iter, history, bestMetric,
      config.lowerIsBetter, lastTestOutput,
      iter === 0 ? deliberation : undefined,
      successPatterns, failurePatterns,
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
      failurePatterns.push({ technique: strategy, reason: `no improvement (${metric} cycles, best is ${bestMetric})` });
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

/** Set up worktrees seeded from multiple starting codes (top-K tournament) */
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
  isaReference: string,
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
): Promise<{ bestMetric: number; bestCode: string | null; successPatterns: SuccessPattern[]; failurePatterns: FailurePattern[] }> {
  let phaseSuccess: SuccessPattern[] = [...(initialSuccess ?? [])];
  let phaseFailure: FailurePattern[] = [...(initialFailure ?? [])];

  // Top-2 codes for tournament seeding (runner-up gets 40% of paths)
  let runnerUpCode: string | null = null;

  // Deliberation for this phase
  let deliberation: string | undefined;
  const delibTask = `${task}\n\nCurrent metric: ${bestMetric} cycles. Phase goal: ${phase.targetMetric} cycles.\n\n${phase.focus}`;
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
        0, phase, config, config.workdir, isaReference,
        providerConfig, profile, bestMetric, deliberation, callbacks, signal,
        "", prevPhaseCode, phaseSuccess, phaseFailure,
      );
      allHistory.push(...result.history);
      phaseSuccess = result.successPatterns;
      phaseFailure = result.failurePatterns;
      if (isImproved(result.bestMetric, bestMetric, config.lowerIsBetter)) {
        bestMetric = result.bestMetric;
        bestCode = result.bestCode;
      }
    } else {
      // Top-2 seeding: first round uses bestCode only, subsequent rounds use winner + runner-up
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
              p, phase, config, wtPath, isaReference,
              providerConfig, profile, bestMetric, deliberation, callbacks, signal,
              PATH_PERSONALITIES[p % PATH_PERSONALITIES.length],
              prevPhaseCode,
              phaseSuccess,
              phaseFailure,
            ),
          ),
        );

        for (const result of pathResults) allHistory.push(...result.history);

        // Merge patterns from all paths (cross-pollination)
        const seenSuccess = new Set(phaseSuccess.map(s => s.technique));
        const seenFailure = new Set(phaseFailure.map(f => f.technique));
        for (const result of pathResults) {
          for (const sp of result.successPatterns) {
            if (!seenSuccess.has(sp.technique)) {
              phaseSuccess.push(sp);
              seenSuccess.add(sp.technique);
            }
          }
          for (const fp of result.failurePatterns) {
            if (!seenFailure.has(fp.technique)) {
              phaseFailure.push(fp);
              seenFailure.add(fp.technique);
            }
          }
        }

        // Top-2 tournament: pick winner AND runner-up
        const sorted = [...pathResults]
          .map((r, i) => ({ ...r, idx: i }))
          .sort((a, b) => config.lowerIsBetter ? a.bestMetric - b.bestMetric : b.bestMetric - a.bestMetric);

        if (sorted.length > 0 && isImproved(sorted[0].bestMetric, bestMetric, config.lowerIsBetter)) {
          bestMetric = sorted[0].bestMetric;
          bestCode = sorted[0].bestCode;
          callbacks.onTournamentResult?.(round, bestMetric, sorted[0].idx);
        }
        // Runner-up for next round's seeding
        if (sorted.length > 1 && sorted[1].bestCode) {
          runnerUpCode = sorted[1].bestCode;
        }
      } finally {
        await teardownWorktrees(gitRoot, worktrees);
      }
    }

    if (bestCode) await restoreFile(config.workdir, config.targetFile, bestCode);

    // Phase target reached?
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

  // 1. Initial metric
  const initialTest = await runTest(fullConfig.testCommand, fullConfig.workdir);
  const initialMetric = parseMetric(initialTest.output, fullConfig.metricPattern);
  if (initialMetric === null) {
    return { bestMetric: Infinity, initialMetric: Infinity, totalIterations: 0, totalRounds: 0, history: [], durationMs: Date.now() - startTime, reason: "error" };
  }

  let bestMetric = initialMetric;
  let bestCode = await saveFile(fullConfig.workdir, fullConfig.targetFile);

  // 2. Deep Study Phase — agent reads all source files, produces ISA reference
  let isaReference = "";
  const contextFiles = fullConfig.contextFiles ?? [];
  if (contextFiles.length > 0) {
    try {
      const studyStart = Date.now();
      isaReference = await deepStudy(
        fullConfig.workdir, fullConfig.targetFile, contextFiles,
        providerConfig, profile, signal,
      );
      callbacks.onStudyComplete?.(Date.now() - studyStart);
    } catch { /* study is non-fatal, proceed without ISA reference */ }
  }

  // 3. Build optimization phases
  const phases = buildPhases(fullConfig.target, initialMetric);

  if (phases.length === 0) {
    return { bestMetric, initialMetric, totalIterations: 0, totalRounds: 0, history: allHistory, durationMs: Date.now() - startTime, reason: "target_reached" };
  }

  // 4. Execute phases sequentially, carrying winning code + patterns forward
  let totalRounds = 0;
  let prevPhaseCode: string | undefined;
  let carrySuccess: SuccessPattern[] = [];
  let carryFailure: FailurePattern[] = [];

  for (const phase of phases) {
    if (signal?.aborted) {
      return { bestMetric, initialMetric, totalIterations: allHistory.length, totalRounds, history: allHistory, durationMs: Date.now() - startTime, reason: "cancelled" };
    }

    callbacks.onPhaseStart?.(phases.indexOf(phase), phase.name, phase.targetMetric);

    const phaseResult = await runPhase(
      phase, task, fullConfig, gitRoot, isaReference,
      providerConfig, profile, bestMetric, bestCode,
      allHistory, callbacks, signal, prevPhaseCode,
    );

    bestMetric = phaseResult.bestMetric;
    bestCode = phaseResult.bestCode;
    totalRounds += phase.maxRounds;
    carrySuccess = phaseResult.successPatterns;
    carryFailure = phaseResult.failurePatterns;
    prevPhaseCode = bestCode ?? undefined;

    // Final target reached?
    if (isTargetReached(bestMetric, fullConfig.target, fullConfig.lowerIsBetter)) {
      if (bestCode) await restoreFile(fullConfig.workdir, fullConfig.targetFile, bestCode);
      return { bestMetric, initialMetric, totalIterations: allHistory.length, totalRounds, history: allHistory, durationMs: Date.now() - startTime, reason: "target_reached" };
    }
  }

  // 5. Final push — if within 15% of target, retry with accumulated knowledge
  const closeEnough = fullConfig.lowerIsBetter
    ? bestMetric <= fullConfig.target * 1.15
    : bestMetric >= fullConfig.target * 0.85;

  if (closeEnough && !signal?.aborted) {
    callbacks.onPhaseStart?.(phases.length, "final_push", fullConfig.target);

    const pushPhase: OptimizationPhase = {
      name: "final_push",
      targetMetric: fullConfig.target,
      model: "opus",
      parallelPaths: 6,
      maxRounds: 6,
      maxIterations: 20,
      maxTurns: 12,
      focus: `GOAL: FINAL PUSH — get from ${bestMetric} to below ${fullConfig.target} cycles.
You are ${((bestMetric / fullConfig.target - 1) * 100).toFixed(0)}% away from the target. This is achievable.

STRATEGY: Cycle-level micro-optimization. Every single cycle counts.
1. AUDIT: List every bundle in the hot loop. Count slots used vs available.
2. BIGGEST WIN FIRST: Find the bundle with the most waste. Fix it.
3. FLOW ELIMINATION: Every select/vselect uses the precious flow slot (only 1!).
   Replace with: result = (cond & a) | (~cond & b) using alu/valu.
4. BUNDLE MERGING: Adjacent bundles with no data dependencies → merge into one.
5. CONSTANT HOISTING: Any value computed the same way every iteration → move outside loop.
6. Remember: the winning code represents PROVEN optimizations. Don't undo them.
${SELF_CHECK}`,
    };

    const pushResult = await runPhase(
      pushPhase, task, fullConfig, gitRoot, isaReference,
      providerConfig, profile, bestMetric, bestCode,
      allHistory, callbacks, signal, prevPhaseCode,
      carrySuccess, carryFailure,
    );

    bestMetric = pushResult.bestMetric;
    bestCode = pushResult.bestCode;
    totalRounds += pushPhase.maxRounds;
  }

  if (bestCode) await restoreFile(fullConfig.workdir, fullConfig.targetFile, bestCode);

  const reason = isTargetReached(bestMetric, fullConfig.target, fullConfig.lowerIsBetter)
    ? "target_reached" : "max_rounds";
  return { bestMetric, initialMetric, totalIterations: allHistory.length, totalRounds, history: allHistory, durationMs: Date.now() - startTime, reason };
}
