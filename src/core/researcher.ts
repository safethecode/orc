// ── Researcher Agent ──────────────────────────────────────────────
// Autonomous research agent that activates when optimization stalls.
//
// Flow:
//   Phase 1: Diagnose — Opus analyzes WHY progress stalled
//   Phase 2: Prior Art — Sonnet searches for how others solved similar problems
//   Phase 3: Research — Sonnet searches for underlying techniques & principles
//   Phase 4: Verify — small experiment to test if an insight actually works
//   Phase 5: Synthesize — Opus distills verified insights into strategy
//
// Only verified insights make it into the final strategy.
// Unverified/failed insights are explicitly marked as risky.

import { AgentStreamer } from "../repl/streamer.ts";
import { buildCommand } from "../agents/provider.ts";
import type { ProviderConfig, AgentProfile } from "../config/types.ts";
import type { OptimizationStep } from "./optimization-harness.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface ResearchResult {
  questions: string[];
  findings: string;
  priorArt: string;
  verifiedInsights: VerifiedInsight[];
  synthesis: string;
  durationMs: number;
}

export interface VerifiedInsight {
  technique: string;
  description: string;
  verified: boolean;
  verificationResult?: string;
  metric?: number;
}

export interface StallContext {
  task: string;
  currentCode: string;
  bestMetric: number;
  target: number;
  history: OptimizationStep[];
  roundNumber: number;
  workdir: string;
  targetFile: string;
  testCommand: string;
  metricPattern: RegExp;
}

interface ResearchCallback {
  (phase: string, detail?: string): void;
}

// ── Plateau Detection ────────────────────────────────────────────

export function detectPlateau(history: OptimizationStep[], windowSize = 10): boolean {
  if (history.length < windowSize) return false;

  const recent = history.slice(-windowSize);
  const improvements = recent.filter(s => s.improved);

  // Plateau = less than 2 improvements in the last N iterations
  return improvements.length < 2;
}

export function detectStuckPattern(history: OptimizationStep[]): string {
  if (history.length < 5) return "insufficient_data";

  const recent = history.slice(-10);
  const broken = recent.filter(s => !s.correct).length;
  const noImprove = recent.filter(s => s.correct && !s.improved).length;

  if (broken > noImprove) return "correctness_barrier";
  if (noImprove >= recent.length - 1) return "optimization_ceiling";

  const metrics = recent
    .filter(s => s.metric !== null)
    .map(s => s.metric as number);
  if (metrics.length >= 3) {
    const range = Math.max(...metrics) - Math.min(...metrics);
    const avg = metrics.reduce((a, b) => a + b, 0) / metrics.length;
    if (range / avg < 0.05) return "metric_plateau";
  }

  return "mixed";
}

// ── Agent Runner ────────────────────────────────────────────────

async function runResearchAgent(
  prompt: string,
  model: string,
  systemPrompt: string,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  maxTurns: number,
  signal?: AbortSignal,
): Promise<string> {
  const streamer = new AgentStreamer();
  const cmd = buildCommand(providerConfig, profile, {
    prompt,
    model,
    systemPrompt,
    maxTurns,
  });
  const result = await streamer.run(cmd, signal);
  return result.text.trim();
}

// ── Test Runner (for verification) ──────────────────────────────

async function runTest(
  command: string,
  workdir: string,
  timeoutMs = 120_000,
): Promise<{ output: string; exitCode: number }> {
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

function parseMetric(output: string, pattern: RegExp): number | null {
  const match = output.match(pattern);
  if (match && match[1]) {
    const val = parseFloat(match[1]);
    return isNaN(val) ? null : val;
  }
  return null;
}

// ── Phase 1: Diagnose ───────────────────────────────────────────

async function diagnose(
  context: StallContext,
  stuckPattern: string,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<{ diagnosis: string; questions: string[] }> {
  const historyBlock = context.history.slice(-15).map(s => {
    const marker = s.improved ? "IMPROVED" : s.correct ? "no_gain" : "BROKEN";
    return `  iter ${s.iteration}: ${s.metric ?? "N/A"} — ${marker} (${s.action})`;
  }).join("\n");

  const prompt = `You are analyzing why an optimization effort has stalled.

## Task
${context.task}

## Current Best: ${context.bestMetric} (target: ${context.target})
## Stall Pattern: ${stuckPattern}
## Round: ${context.roundNumber}

## Recent History
${historyBlock}

## Current Code (last 200 lines)
\`\`\`python
${context.currentCode.split("\n").slice(-200).join("\n")}
\`\`\`

Analyze:
1. What specific optimization has the agent been attempting?
2. Why is it failing or not improving?
3. What fundamental concept or technique is the agent missing?
4. What would a human expert search for to break through this barrier?

Generate exactly 3 focused research questions that would help understand the UNDERLYING PRINCIPLES needed. Not "how to optimize X" but "why does X work, what patterns exist."

Also generate 2 prior art questions — how did people historically solve THIS KIND of problem? What tools, compilers, or frameworks dealt with similar constraints?

Format:
DIAGNOSIS: <1-2 sentences>
MISSING_CONCEPT: <what the agent doesn't understand>
QUESTION_1: <research question>
QUESTION_2: <research question>
QUESTION_3: <research question>
PRIOR_ART_1: <how did historical systems solve this?>
PRIOR_ART_2: <what existing tools/compilers handle this?>`;

  const system = `You are a senior performance engineer and technical educator. Your job is to identify what CONCEPTUAL UNDERSTANDING is missing when someone is stuck on an optimization problem. Think about it like teaching — what does the student need to learn, not what answer to give them. Also think historically — what compilers, DSPs, GPUs, or other systems solved similar problems?`;

  let diagnosis = "";
  let questions: string[] = [];
  try {
    diagnosis = await runResearchAgent(prompt, "opus", system, providerConfig, profile, 1, signal);
    for (const m of diagnosis.matchAll(/QUESTION_\d:\s*(.+)/g)) {
      questions.push(m[1].trim());
    }
    for (const m of diagnosis.matchAll(/PRIOR_ART_\d:\s*(.+)/g)) {
      questions.push(m[1].trim());
    }
  } catch {
    diagnosis = "(diagnosis failed)";
  }

  if (questions.length === 0) {
    questions = [
      `optimization techniques for ${context.task.slice(0, 100)}`,
      `common performance bottlenecks in instruction-level parallelism`,
      `how to break through optimization plateaus in compiled code`,
      `historical approaches to VLIW scheduling in DSP compilers`,
      `how TI C6000 or Itanium compilers solve software pipelining`,
    ];
  }

  return { diagnosis, questions };
}

// ── Phase 2: Prior Art Search ───────────────────────────────────

async function searchPriorArt(
  diagnosis: string,
  questions: string[],
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<string> {
  // Extract the prior art questions (last 2) or use all if less
  const priorArtQs = questions.filter(q =>
    q.toLowerCase().includes("histor") ||
    q.toLowerCase().includes("compiler") ||
    q.toLowerCase().includes("prior") ||
    q.toLowerCase().includes("existing") ||
    q.toLowerCase().includes("how did") ||
    q.toLowerCase().includes("dsp") ||
    q.toLowerCase().includes("itanium")
  );

  const qs = priorArtQs.length > 0 ? priorArtQs : questions.slice(-2);

  const prompt = `You are researching how similar optimization problems have been solved historically.

## Context
${diagnosis}

## Questions About Prior Art
${qs.map((q, i) => `${i + 1}. ${q}`).join("\n")}

## Instructions
Search for HISTORICAL SOLUTIONS to problems like this. Look for:

1. **Compiler backends** that targeted VLIW architectures (TI C6000, Itanium/IA-64, Qualcomm Hexagon, SHARC DSPs)
   - How did their schedulers handle dependency chains?
   - What software pipelining algorithms did they use?
   - How did they handle gather/scatter without hardware support?

2. **Academic work** on VLIW code generation
   - Modulo scheduling, swing modulo scheduling
   - Trace scheduling (Fisher's original work)
   - Software pipelining theory

3. **Real-world solutions** from DSP/embedded engineers
   - Blog posts, forum discussions, application notes
   - TI's optimization guides for C66x
   - Intel's Itanium optimization manuals

4. **Similar open-source projects**
   - LLVM's VLIW backends
   - GCC's modulo scheduling pass

For each source found, extract:
- The SPECIFIC TECHNIQUE they used
- WHY it works (the underlying principle)
- WHEN it applies (constraints and assumptions)
- A concrete example if available

Under 600 words. Prioritize depth over breadth.`;

  const system = `You are a computer architecture historian and compiler engineer. Search the web thoroughly for how real systems solved VLIW scheduling, software pipelining, and instruction-level parallelism problems. Focus on practical solutions from actual compilers and DSP toolchains, not just theory. Look for TI, Intel, Qualcomm, and LLVM documentation.`;

  try {
    return await runResearchAgent(prompt, "sonnet", system, providerConfig, profile, 15, signal);
  } catch {
    return "(prior art search failed)";
  }
}

// ── Phase 3: Technique Research ─────────────────────────────────

async function searchTechniques(
  diagnosis: string,
  questions: string[],
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<string> {
  const techQs = questions.filter(q =>
    !q.toLowerCase().includes("histor") &&
    !q.toLowerCase().includes("prior") &&
    !q.toLowerCase().includes("how did")
  );
  const qs = techQs.length > 0 ? techQs : questions.slice(0, 3);

  const prompt = `You are a technical researcher. Search the web for techniques that would help solve this optimization problem.

## Context
${diagnosis}

## Research Questions
${qs.map((q, i) => `${i + 1}. ${q}`).join("\n")}

## Instructions
For each question:
1. Search the web for relevant technical content (papers, blog posts, compiler documentation, optimization guides)
2. Read the most promising results
3. Extract KEY INSIGHTS — the deep "why" and "how", not surface summaries

Focus on:
- Underlying principles (WHY does this technique work?)
- Trade-offs (WHEN does it help vs hurt?)
- Implementation patterns (HOW is it typically done?)
- Common pitfalls (WHAT goes wrong?)

Under 600 words. Be specific and technical.

Format:
## Finding 1: [topic]
**Why it matters**: ...
**Key insight**: ...
**Implementation pattern**: ...

## Finding 2: [topic]
...`;

  const system = `You are an expert technical researcher. Use web search to find authoritative sources on performance optimization, compiler techniques, VLIW architectures, SIMD programming, and instruction scheduling. Prioritize academic papers, compiler documentation, and expert blog posts over generic tutorials. Extract deep insights, not surface-level advice.`;

  try {
    return await runResearchAgent(prompt, "sonnet", system, providerConfig, profile, 15, signal);
  } catch {
    return "(technique research failed)";
  }
}

// ── Phase 4: Verification ───────────────────────────────────────

async function verifyInsights(
  context: StallContext,
  findings: string,
  priorArt: string,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<VerifiedInsight[]> {
  // Step 1: Extract testable techniques from findings
  const extractPrompt = `Given these research findings, extract 2-3 CONCRETE techniques that can be tested with a small code change.

## Research Findings
${findings}

## Prior Art
${priorArt}

## Current Code
\`\`\`python
${context.currentCode.split("\n").slice(-150).join("\n")}
\`\`\`

For each technique, describe:
1. A MINIMAL code change that would test if this technique works (just enough to measure impact)
2. What improvement you expect and why

Format (exactly 2-3 entries):
TECHNIQUE_1_NAME: <name>
TECHNIQUE_1_DESC: <what to change and why, in 1-2 sentences>
TECHNIQUE_2_NAME: <name>
TECHNIQUE_2_DESC: <what to change and why>
TECHNIQUE_3_NAME: <name>
TECHNIQUE_3_DESC: <what to change and why>`;

  const extractSystem = `You are a pragmatic engineer who validates ideas before committing to them. Extract the most promising techniques and describe the SMALLEST possible experiment to test each one.`;

  let techniques: Array<{ name: string; desc: string }> = [];
  try {
    const extractResult = await runResearchAgent(
      extractPrompt, "sonnet", extractSystem,
      providerConfig, profile, 1, signal,
    );
    for (const m of extractResult.matchAll(/TECHNIQUE_(\d+)_NAME:\s*(.+)/g)) {
      const idx = parseInt(m[1]);
      const name = m[2].trim();
      const descMatch = extractResult.match(new RegExp(`TECHNIQUE_${idx}_DESC:\\s*(.+)`));
      const desc = descMatch ? descMatch[1].trim() : "";
      techniques.push({ name, desc });
    }
  } catch { /* extraction failed */ }

  if (techniques.length === 0) {
    return [{
      technique: "research_findings",
      description: "Could not extract testable techniques — using raw findings",
      verified: false,
    }];
  }

  // Step 2: For each technique, run a small experiment
  const verified: VerifiedInsight[] = [];

  for (const tech of techniques.slice(0, 3)) {
    if (signal?.aborted) break;

    // Save current code
    const originalCode = context.currentCode;

    // Ask an agent to apply JUST this one technique
    const applyPrompt = `Apply this ONE specific optimization technique to the code. Make the MINIMAL change needed to test if it helps.

## Technique: ${tech.name}
${tech.desc}

## Current Code
The file is at ${context.workdir}/${context.targetFile}

## Rules
- Make the SMALLEST change that tests this technique
- Maintain correctness
- Do NOT apply any other optimizations
- After editing, explain what you changed in one sentence`;

    const applySystem = `You are testing a single optimization hypothesis. Apply the described technique with minimal changes. Do NOT add unrelated optimizations.`;

    try {
      await runResearchAgent(
        applyPrompt, "sonnet", applySystem,
        providerConfig, profile, 3, signal,
      );

      // Run test to see if it helped
      const testResult = await runTest(context.testCommand, context.workdir);
      const metric = parseMetric(testResult.output, context.metricPattern);
      const correct = testResult.exitCode === 0 || (metric !== null && testResult.output.includes("ok"));

      if (metric !== null && correct) {
        const improved = metric < context.bestMetric;
        verified.push({
          technique: tech.name,
          description: tech.desc,
          verified: true,
          verificationResult: improved
            ? `improved: ${metric} (from ${context.bestMetric})`
            : `correct but no improvement: ${metric}`,
          metric,
        });
      } else {
        verified.push({
          technique: tech.name,
          description: tech.desc,
          verified: true,
          verificationResult: `broke correctness or no metric`,
        });
      }
    } catch {
      verified.push({
        technique: tech.name,
        description: tech.desc,
        verified: false,
        verificationResult: "experiment failed to run",
      });
    }

    // Always restore original code after each experiment
    try {
      await Bun.write(`${context.workdir}/${context.targetFile}`, originalCode);
    } catch { /* best effort restore */ }
  }

  return verified;
}

// ── Phase 5: Synthesize ─────────────────────────────────────────

async function synthesize(
  context: StallContext,
  stuckPattern: string,
  diagnosis: string,
  findings: string,
  priorArt: string,
  verified: VerifiedInsight[],
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<string> {
  const verifiedBlock = verified.map(v => {
    const status = v.verified
      ? (v.metric && v.metric < context.bestMetric ? "VERIFIED_IMPROVED" : "VERIFIED_NO_GAIN")
      : "UNVERIFIED";
    return `- [${status}] ${v.technique}: ${v.description}${v.verificationResult ? ` → ${v.verificationResult}` : ""}`;
  }).join("\n");

  const prompt = `You are translating research findings into a concrete optimization strategy. CRITICALLY: some insights have been TESTED. Prioritize verified insights.

## Original Task
${context.task}

## Current State
Best metric: ${context.bestMetric}, Target: ${context.target}
Stuck pattern: ${stuckPattern}

## Diagnosis
${diagnosis}

## Prior Art (how others solved similar problems)
${priorArt}

## Research Findings
${findings}

## Verification Results
${verifiedBlock}

## Current Code Structure
\`\`\`python
${context.currentCode.split("\n").slice(0, 30).join("\n")}
...
${context.currentCode.split("\n").slice(-80).join("\n")}
\`\`\`

Synthesize into an ACTIONABLE STRATEGY:

Rules:
1. VERIFIED_IMPROVED techniques go FIRST — they are proven to work
2. VERIFIED_NO_GAIN techniques: explain why they didn't help yet, suggest how to combine them
3. UNVERIFIED techniques: include but mark as "theoretical, needs careful implementation"
4. Connect prior art solutions to the current problem — "TI C6000 solves this by X, we can adapt by Y"
5. The executing agent needs to UNDERSTAND the principles, not just follow steps

Format:
## Key Insight
<The fundamental concept, informed by prior art and verification>

## Proven Techniques (verified to improve or maintain correctness)
1. **[technique]**: What, why, how — with verification evidence
...

## Promising Techniques (verified correct but needs combination)
1. **[technique]**: What, why, how to combine with proven techniques
...

## Theoretical Techniques (unverified, use with caution)
1. **[technique]**: What, why, risk assessment
...

## Prior Art Patterns
- How [system X] solved this: ...
- Applicable lesson: ...

## Pitfalls to Avoid
- ...

Under 600 words.`;

  const system = `You are a principal engineer who bridges theory and practice. You have verification data — use it. Proven techniques get priority. Theoretical ones get caveats. Prior art provides the "why" that helps the agent adapt when things don't go as planned.`;

  try {
    return await runResearchAgent(prompt, "opus", system, providerConfig, profile, 1, signal);
  } catch {
    return "(synthesis failed)";
  }
}

// ── Main Research Flow ──────────────────────────────────────────

export async function research(
  context: StallContext,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
  onProgress?: ResearchCallback,
): Promise<ResearchResult> {
  const startTime = Date.now();
  const stuckPattern = detectStuckPattern(context.history);

  // ── Phase 1: Diagnose ─────────────────────────────────────────
  onProgress?.("diagnosing", "analyzing bottleneck");
  const { diagnosis, questions } = await diagnose(
    context, stuckPattern, providerConfig, profile, signal,
  );

  // ── Phase 2 & 3: Prior Art + Technique Research (parallel) ────
  onProgress?.("researching", `prior art + ${questions.length} queries`);

  const [priorArt, findings] = await Promise.all([
    searchPriorArt(diagnosis, questions, providerConfig, profile, signal),
    searchTechniques(diagnosis, questions, providerConfig, profile, signal),
  ]);

  // ── Phase 4: Verify ───────────────────────────────────────────
  onProgress?.("verifying", "testing insights with small experiments");
  const verifiedInsights = await verifyInsights(
    context, findings, priorArt, providerConfig, profile, signal,
  );

  const verifiedCount = verifiedInsights.filter(v => v.verified).length;
  const improvedCount = verifiedInsights.filter(v => v.metric && v.metric < context.bestMetric).length;
  onProgress?.("verified", `${improvedCount} improved, ${verifiedCount} tested`);

  // ── Phase 5: Synthesize ───────────────────────────────────────
  onProgress?.("synthesizing", "opus distilling verified insights");
  const synthResult = await synthesize(
    context, stuckPattern, diagnosis, findings, priorArt,
    verifiedInsights, providerConfig, profile, signal,
  );

  return {
    questions,
    findings,
    priorArt,
    verifiedInsights,
    synthesis: synthResult,
    durationMs: Date.now() - startTime,
  };
}
