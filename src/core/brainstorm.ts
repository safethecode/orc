// ── Parallel Brainstorm ─────────────────────────────────────────────
// Spawns multiple Sonnet agents in parallel to analyze a problem
// from different perspectives. Their insights are synthesized into context
// for the main executing agent.

import { AgentStreamer } from "../repl/streamer.ts";
import { buildCommand } from "../agents/provider.ts";
import type { ProviderConfig, AgentProfile } from "../config/types.ts";

export interface BrainstormPerspective {
  name: string;
  systemPrompt: string;
}

export interface BrainstormResult {
  perspectives: Array<{
    name: string;
    insight: string;
  }>;
  synthesized: string;
  durationMs: number;
}

const PERSPECTIVES: BrainstormPerspective[] = [
  {
    name: "analyzer",
    systemPrompt: `You are a problem analyst. Your job is to break down the given task into its core challenges and constraints. Be specific and concise.

Output format:
- Key challenges (2-3 bullets)
- Constraints and requirements
- What success looks like`,
  },
  {
    name: "strategist",
    systemPrompt: `You are a solution strategist. Your job is to propose 2-3 different approaches to solve the given task, with trade-offs for each. Be concrete and actionable.

Output format:
- Approach 1: [name] — [description] (pros/cons)
- Approach 2: [name] — [description] (pros/cons)
- Recommended approach and why`,
  },
  {
    name: "critic",
    systemPrompt: `You are a critical reviewer. Your job is to identify potential pitfalls, edge cases, and common mistakes for the given task. Think about what could go wrong.

Output format:
- Common mistakes to avoid (2-3 bullets)
- Edge cases to handle
- Key risks and mitigations`,
  },
];

/**
 * Determine if a task warrants parallel brainstorming.
 * Returns true for non-trivial tasks (medium prompt length, not simple commands).
 */
export function shouldBrainstorm(input: string, tier: string): boolean {
  // Simple tier or very short inputs don't need brainstorming
  if (tier === "simple") return false;
  if (input.length < 50) return false;

  // Skip for commands, questions about the system, or casual conversation
  const lower = input.toLowerCase();
  const skipPatterns = [
    /^(what|how|where|when|why|who|can you|do you|is there)/,
    /^(list|show|display|print|explain|describe)/,
    /^(hi|hello|hey|thanks|thank you|ok|okay)/,
  ];
  if (skipPatterns.some(p => p.test(lower))) return false;

  return true;
}

/**
 * Run parallel brainstorm: spawn 3 Sonnet agents simultaneously
 * to analyze the problem from different perspectives.
 */
export async function brainstorm(
  input: string,
  providerConfig: ProviderConfig,
  profile: AgentProfile,
  signal?: AbortSignal,
): Promise<BrainstormResult> {
  const startTime = Date.now();

  const promises = PERSPECTIVES.map(async (perspective) => {
    const streamer = new AgentStreamer();
    const prompt = `Analyze this task:\n\n${input}\n\nKeep your response under 150 words. Be specific to this exact task.`;

    const cmd = buildCommand(providerConfig, profile, {
      prompt,
      model: "sonnet",
      systemPrompt: perspective.systemPrompt,
      maxTurns: 1,
    });

    try {
      const result = await streamer.run(cmd, signal);
      return {
        name: perspective.name,
        insight: result.text.trim() || "(no response)",
      };
    } catch {
      return {
        name: perspective.name,
        insight: "(failed)",
      };
    }
  });

  const results = await Promise.all(promises);
  const durationMs = Date.now() - startTime;

  // Filter out failed perspectives
  const valid = results.filter(r => r.insight !== "(failed)" && r.insight !== "(no response)");

  // Synthesize into a structured context block
  const synthesized = valid.length > 0
    ? `## Brainstorm Insights (${valid.length} perspectives, ${(durationMs / 1000).toFixed(1)}s)\n\n` +
      valid.map(r => `### ${r.name}\n${r.insight}`).join("\n\n")
    : "";

  return { perspectives: results, synthesized, durationMs };
}
