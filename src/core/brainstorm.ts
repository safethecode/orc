// ── Deliberation Protocol ───────────────────────────────────────────
// Multi-round debate to produce the best strategy for a given task.
//
// Round 1: Sonnet ×3 parallel analysis (analyzer, strategist, critic)
// Round 2: Opus review — scrutinizes the analyses, finds gaps, ranks ideas
// Round 3: Sonnet rebuttal — defends/revises based on Opus feedback, final plan
//
// The synthesized output is injected into the executing agent's system prompt.

import { AgentStreamer } from "../repl/streamer.ts";
import { buildCommand } from "../agents/provider.ts";
import type { ProviderConfig, AgentProfile } from "../config/types.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface DeliberationResult {
  round1: Array<{ name: string; insight: string }>;
  round2: string; // Opus review
  round3: string; // Sonnet rebuttal + final strategy
  synthesized: string;
  durationMs: number;
}

interface RoundCallback {
  (round: number, label: string): void;
}

// ── Perspectives (Round 1) ─────────────────────────────────────────

const PERSPECTIVES = [
  {
    name: "analyzer",
    systemPrompt: `You are a senior problem analyst. Break down the task into its core challenges, constraints, and success criteria. Be precise and technical.

Format:
- Core challenges (2-3 key technical challenges)
- Hard constraints (what MUST be true)
- Success criteria (measurable outcomes)`,
  },
  {
    name: "strategist",
    systemPrompt: `You are a senior solution architect. Propose 2-3 concrete approaches with clear trade-offs. Focus on implementation feasibility.

Format:
- Approach 1: [name] — how it works, pros, cons
- Approach 2: [name] — how it works, pros, cons
- Recommended approach with justification`,
  },
  {
    name: "critic",
    systemPrompt: `You are a senior technical reviewer. Identify failure modes, edge cases, and common mistakes. Think adversarially — what will go wrong?

Format:
- Likely failure modes (2-3 specific scenarios)
- Edge cases that break naive solutions
- Non-obvious risks and their mitigations`,
  },
];

// ── Trigger Logic ──────────────────────────────────────────────────

export function shouldBrainstorm(input: string, tier: string): boolean {
  if (tier === "simple") return false;
  if (input.length < 50) return false;

  const lower = input.toLowerCase();
  const skipPatterns = [
    /^(what|how|where|when|why|who|can you|do you|is there)/,
    /^(list|show|display|print|explain|describe)/,
    /^(hi|hello|hey|thanks|thank you|ok|okay)/,
  ];
  if (skipPatterns.some(p => p.test(lower))) return false;

  return true;
}

// ── Helper: run a single agent ─────────────────────────────────────

async function runAgent(
  prompt: string,
  model: string,
  systemPrompt: string,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<string> {
  const streamer = new AgentStreamer();
  const cmd = buildCommand(providerConfig, profile, {
    prompt,
    model,
    systemPrompt,
    maxTurns: 1,
  });
  const result = await streamer.run(cmd, signal);
  return result.text.trim();
}

// ── Main Deliberation ──────────────────────────────────────────────

export async function brainstorm(
  input: string,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
  onRound?: RoundCallback,
): Promise<DeliberationResult> {
  const startTime = Date.now();

  // ── Round 1: Sonnet ×3 parallel analysis ──────────────────────
  onRound?.(1, "sonnet ×3 analyzing");

  const round1Promises = PERSPECTIVES.map(async (p) => {
    const prompt = `Analyze this task:\n\n${input}\n\nBe specific and technical. Under 200 words.`;
    try {
      const insight = await runAgent(prompt, "sonnet", p.systemPrompt, providerConfig, profile, signal);
      return { name: p.name, insight: insight || "(no response)" };
    } catch {
      return { name: p.name, insight: "(failed)" };
    }
  });

  const round1 = await Promise.all(round1Promises);
  const validR1 = round1.filter(r => r.insight !== "(failed)" && r.insight !== "(no response)");

  if (validR1.length === 0) {
    return { round1, round2: "", round3: "", synthesized: "", durationMs: Date.now() - startTime };
  }

  // ── Round 2: Opus review ──────────────────────────────────────
  onRound?.(2, "opus reviewing");

  const analysisBlock = validR1.map(r => `### ${r.name}\n${r.insight}`).join("\n\n");

  const opusPrompt = `A team of analysts produced the following analyses for a task. Review them critically.

## Original Task
${input}

## Team Analyses
${analysisBlock}

## Your Review
Evaluate each analysis:
1. What did they get right?
2. What did they miss or get wrong?
3. Which approach is most promising and why?
4. What critical gaps remain?

Be direct and specific. Under 300 words.`;

  const opusSystem = `You are a principal engineer conducting a technical review. You have deep expertise and zero tolerance for hand-waving. Point out specific flaws, missing considerations, and rank the proposed approaches by feasibility. If an analysis is weak, say so directly.`;

  let round2 = "";
  try {
    round2 = await runAgent(opusPrompt, "opus", opusSystem, providerConfig, profile, signal);
  } catch {
    round2 = "(opus review failed)";
  }

  // ── Round 3: Sonnet rebuttal + final strategy ─────────────────
  onRound?.(3, "sonnet synthesizing strategy");

  const rebuttalPrompt = `You proposed analyses for a task. A senior reviewer critiqued them. Now produce the final strategy.

## Original Task
${input}

## Your Team's Analyses
${analysisBlock}

## Senior Review (Opus)
${round2}

## Your Response
1. Address each critique — accept valid points, rebut incorrect ones with evidence
2. Incorporate the feedback into an improved strategy
3. Produce a FINAL EXECUTION PLAN: concrete steps, in order, with specific technical details

This plan will be given directly to an executing agent. Make it actionable. Under 400 words.`;

  const rebuttalSystem = `You are a lead engineer synthesizing feedback into an execution plan. Accept valid criticism, push back on wrong critiques with reasoning, and produce a clear, step-by-step plan. No fluff — every sentence should be actionable.`;

  let round3 = "";
  try {
    round3 = await runAgent(rebuttalPrompt, "sonnet", rebuttalSystem, providerConfig, profile, signal);
  } catch {
    round3 = "(synthesis failed)";
  }

  const durationMs = Date.now() - startTime;

  // ── Synthesize final output ───────────────────────────────────
  const parts: string[] = [];
  parts.push(`## Deliberation Strategy (3 rounds, ${(durationMs / 1000).toFixed(1)}s)`);
  parts.push("");

  if (round3 && round3 !== "(synthesis failed)") {
    parts.push("### Final Execution Plan");
    parts.push(round3);
  }

  if (round2 && round2 !== "(opus review failed)") {
    parts.push("");
    parts.push("### Key Review Points (Opus)");
    parts.push(round2);
  }

  const synthesized = parts.join("\n");

  return { round1, round2, round3, synthesized, durationMs };
}
