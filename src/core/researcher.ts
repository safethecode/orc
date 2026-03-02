// ── Researcher Agent ──────────────────────────────────────────────
// Autonomous research agent that activates when optimization stalls.
//
// Instead of hardcoding domain knowledge, the researcher:
//   1. Analyzes WHY progress stalled (from code + metrics + history)
//   2. Formulates research questions (what concepts would help?)
//   3. Searches the web for relevant techniques, papers, patterns
//   4. Synthesizes findings into actionable optimization insights
//
// Think Redux analogy: don't tell the agent "use Redux" —
// help it understand why state management is hard, what patterns
// exist, and let it choose the right approach.

import { AgentStreamer } from "../repl/streamer.ts";
import { buildCommand } from "../agents/provider.ts";
import type { ProviderConfig, AgentProfile } from "../config/types.ts";
import type { OptimizationStep } from "./optimization-harness.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface ResearchResult {
  questions: string[];
  findings: string;
  synthesis: string;
  durationMs: number;
}

export interface StallContext {
  task: string;
  currentCode: string;
  bestMetric: number;
  target: number;
  history: OptimizationStep[];
  roundNumber: number;
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

// ── Research Agent ───────────────────────────────────────────────

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

  // ── Phase 1: Diagnose the bottleneck ──────────────────────────
  onProgress?.("diagnosing", "analyzing bottleneck");

  const historyBlock = context.history.slice(-15).map(s => {
    const marker = s.improved ? "IMPROVED" : s.correct ? "no_gain" : "BROKEN";
    return `  iter ${s.iteration}: ${s.metric ?? "N/A"} — ${marker} (${s.action})`;
  }).join("\n");

  const diagnosisPrompt = `You are analyzing why an optimization effort has stalled.

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

Generate exactly 3 focused research questions that would help understand the UNDERLYING PRINCIPLES needed to make progress. Not "how to optimize X" but "why does X work, what are the trade-offs, what patterns exist for problems like this."

Format:
DIAGNOSIS: <1-2 sentences>
MISSING_CONCEPT: <what the agent doesn't understand>
QUESTION_1: <research question>
QUESTION_2: <research question>
QUESTION_3: <research question>`;

  const diagnosisSystem = `You are a senior performance engineer and technical educator. Your job is to identify what CONCEPTUAL UNDERSTANDING is missing when someone is stuck on an optimization problem. Think about it like teaching — what does the student need to learn, not what answer to give them.`;

  let diagnosis = "";
  let questions: string[] = [];
  try {
    diagnosis = await runResearchAgent(
      diagnosisPrompt, "opus", diagnosisSystem,
      providerConfig, profile, 1, signal,
    );

    // Parse questions from diagnosis
    const qMatches = diagnosis.matchAll(/QUESTION_\d:\s*(.+)/g);
    for (const m of qMatches) {
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
    ];
  }

  // ── Phase 2: Web research ──────────────────────────────────────
  onProgress?.("researching", `${questions.length} queries`);

  // Use a Sonnet agent with WebSearch capability and enough turns
  // to search, read pages, and compile findings
  const researchPrompt = `You are a technical researcher. Search the web for information that would help solve this optimization problem.

## Context
${diagnosis}

## Research Questions
${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}

## Instructions
For each question:
1. Search the web for relevant technical content (papers, blog posts, compiler documentation, optimization guides)
2. Read the most promising results
3. Extract the KEY INSIGHTS — not surface-level summaries but the deep "why" and "how"

Focus on:
- Underlying principles (WHY does this technique work?)
- Trade-offs (WHEN does it help vs hurt?)
- Implementation patterns (HOW is it typically done?)
- Common pitfalls (WHAT goes wrong?)

Compile your findings into a structured report. Under 800 words.

Format:
## Finding 1: [topic]
**Why it matters**: ...
**Key insight**: ...
**Implementation pattern**: ...

## Finding 2: [topic]
...

## Finding 3: [topic]
...`;

  const researchSystem = `You are an expert technical researcher. Use web search to find authoritative sources on performance optimization, compiler techniques, VLIW architectures, SIMD programming, and instruction scheduling. Prioritize academic papers, compiler documentation, and expert blog posts over generic tutorials. Extract deep insights, not surface-level advice.`;

  let findings = "";
  try {
    findings = await runResearchAgent(
      researchPrompt, "sonnet", researchSystem,
      providerConfig, profile, 15, signal, // 15 turns for search+read+compile
    );
  } catch {
    findings = "(research failed)";
  }

  // ── Phase 3: Synthesize into actionable strategy ──────────────
  onProgress?.("synthesizing", "opus distilling insights");

  const synthesisPrompt = `You are translating research findings into a concrete optimization strategy.

## Original Task
${context.task}

## Current State
Best metric: ${context.bestMetric}, Target: ${context.target}
Stuck pattern: ${stuckPattern}

## Diagnosis
${diagnosis}

## Research Findings
${findings}

## Current Code Structure (key sections)
\`\`\`python
${context.currentCode.split("\n").slice(0, 50).join("\n")}
...
${context.currentCode.split("\n").slice(-100).join("\n")}
\`\`\`

Synthesize the research into an ACTIONABLE STRATEGY for the next optimization round.

Rules:
1. Connect each recommendation to a specific research finding — explain WHY it would help
2. Order recommendations by expected impact (highest first)
3. Be specific about HOW to implement each optimization, referencing the actual code structure
4. Include the conceptual insight that makes each optimization work — the executing agent needs to UNDERSTAND, not just follow instructions

Format:
## Key Insight
<The fundamental concept the agent was missing>

## Strategy (ordered by impact)
1. **[technique]**: What to do, why it works (based on finding X), and how it applies to this code
2. **[technique]**: ...
3. **[technique]**: ...

## Pitfalls to Avoid
- ...

Under 500 words. Every sentence must be actionable or explanatory.`;

  const synthesisSystem = `You are a principal engineer who bridges theory and practice. Your job is to take research findings and translate them into a step-by-step strategy that gives the executing agent not just WHAT to do, but WHY it works. The agent needs to understand the underlying principles so it can adapt when things don't go exactly as planned.`;

  let synthesis = "";
  try {
    synthesis = await runResearchAgent(
      synthesisPrompt, "opus", synthesisSystem,
      providerConfig, profile, 1, signal,
    );
  } catch {
    synthesis = "(synthesis failed)";
  }

  return {
    questions,
    findings,
    synthesis,
    durationMs: Date.now() - startTime,
  };
}
