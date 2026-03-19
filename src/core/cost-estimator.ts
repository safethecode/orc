import type { CostEstimate, ModelTier, ComplexityResult } from "../config/types.ts";
import type { Store } from "../db/store.ts";
import { assessComplexityHeuristic } from "./complexity.ts";

// Average tokens per task by complexity (from empirical observation)
const AVG_TOKENS: Record<string, number> = {
  simple: 4_000,
  standard: 15_000,
  complex: 50_000,
};

// Cost per 1K tokens (input + output combined average)
const COST_PER_1K: Record<ModelTier, number> = {
  haiku: 0.0005,
  sonnet: 0.006,
  opus: 0.03,
};

// Orchestration overhead multiplier per agent count
const OVERHEAD_MULTIPLIER: Record<number, number> = {
  1: 1.0,
  2: 1.3,   // 30% overhead for coordination
  3: 1.6,   // 60% overhead
  4: 2.0,   // doubles
  5: 2.5,
};

function getOverhead(agentCount: number): number {
  return OVERHEAD_MULTIPLIER[Math.min(agentCount, 5)] ?? 1 + agentCount * 0.4;
}

export class CostEstimator {
  constructor(private store: Store) {}

  estimate(prompt: string, options?: { forceMulti?: boolean; forceSingle?: boolean }): CostEstimate {
    const complexity = assessComplexityHeuristic(prompt);
    const baseTokens = AVG_TOKENS[complexity.level] ?? AVG_TOKENS.standard;

    // Calibrate with historical data
    const calibrated = this.calibrateFromHistory(baseTokens, complexity);

    // Single agent estimate
    const singleModel = this.selectModel(complexity);
    const singleTokens = calibrated;
    const singleCost = (singleTokens / 1000) * COST_PER_1K[singleModel];
    const singleDuration = this.estimateDuration(singleTokens, 1);

    // Multi agent estimate
    const agentCount = this.estimateAgentCount(complexity);
    const multiOverhead = getOverhead(agentCount);
    const multiTokens = Math.round(calibrated * multiOverhead);
    const multiModel = singleModel; // same tier, more agents
    const multiCost = (multiTokens / 1000) * COST_PER_1K[multiModel];
    const multiDuration = this.estimateDuration(calibrated / agentCount, agentCount);

    // Decision logic
    let recommendation: "single" | "multi";
    let reason: string;

    if (options?.forceSingle) {
      recommendation = "single";
      reason = "Forced single-agent mode";
    } else if (options?.forceMulti) {
      recommendation = "multi";
      reason = "Forced multi-agent mode";
    } else if (complexity.level === "simple") {
      recommendation = "single";
      reason = "Simple task — orchestration overhead not justified";
    } else if (agentCount <= 1) {
      recommendation = "single";
      reason = "Task doesn't benefit from parallelization";
    } else if (multiDuration < singleDuration * 0.5 && multiCost < singleCost * 3) {
      recommendation = "multi";
      reason = `${agentCount} agents cut time by ${Math.round((1 - multiDuration / singleDuration) * 100)}% for ${Math.round(multiCost / singleCost * 100 - 100)}% more cost`;
    } else if (complexity.level === "complex" && complexity.integrations.length >= 4) {
      recommendation = "multi";
      reason = `${complexity.integrations.length} integrations require domain expertise separation`;
    } else {
      recommendation = "single";
      reason = `Cost increase (${Math.round(multiCost / singleCost * 100 - 100)}%) outweighs time savings (${Math.round((1 - multiDuration / singleDuration) * 100)}%)`;
    }

    return {
      singleAgent: {
        model: singleModel,
        estimatedTokens: singleTokens,
        estimatedCostUsd: Math.round(singleCost * 10000) / 10000,
        estimatedDurationMs: singleDuration,
      },
      multiAgent: {
        agents: agentCount,
        estimatedTokens: multiTokens,
        estimatedCostUsd: Math.round(multiCost * 10000) / 10000,
        estimatedDurationMs: multiDuration,
        overheadRatio: multiOverhead,
      },
      recommendation,
      reason,
      savingsUsd: Math.round(Math.abs(singleCost - multiCost) * 10000) / 10000,
    };
  }

  formatEstimate(est: CostEstimate): string {
    const s = est.singleAgent;
    const m = est.multiAgent;
    return [
      `Cost Estimate:`,
      `  Single: ${s.model} — ~${s.estimatedTokens.toLocaleString()} tokens, $${s.estimatedCostUsd}, ~${Math.round(s.estimatedDurationMs / 1000)}s`,
      `  Multi:  ${m.agents} agents — ~${m.estimatedTokens.toLocaleString()} tokens, $${m.estimatedCostUsd}, ~${Math.round(m.estimatedDurationMs / 1000)}s (${m.overheadRatio}x overhead)`,
      `  → ${est.recommendation === "single" ? "Single agent recommended" : "Multi-agent recommended"}: ${est.reason}`,
    ].join("\n");
  }

  private selectModel(complexity: ComplexityResult): ModelTier {
    if (complexity.level === "complex") return "sonnet";
    if (complexity.level === "standard") return "sonnet";
    return "sonnet";
  }

  private estimateAgentCount(complexity: ComplexityResult): number {
    if (complexity.level === "simple") return 1;
    if (complexity.level === "standard") return Math.min(2, complexity.integrations.length);
    return Math.min(4, Math.max(2, Math.ceil(complexity.integrations.length / 2)));
  }

  private estimateDuration(tokensPerAgent: number, agentCount: number): number {
    // ~50 tokens/sec average throughput
    const perAgentMs = (tokensPerAgent / 50) * 1000;
    // Parallel agents divide wall time, but coordination adds latency
    const coordinationMs = agentCount > 1 ? 5000 * (agentCount - 1) : 0;
    return Math.round(perAgentMs / Math.max(1, agentCount) + coordinationMs);
  }

  private calibrateFromHistory(baseTokens: number, complexity: ComplexityResult): number {
    // Check recent similar tasks for actual token usage
    const recent = this.store.getRecentPredictions(5);
    if (recent.length === 0) return baseTokens;

    // Simple average of past actual costs for similar complexity
    const relevant = recent.filter((p) => {
      try {
        const risks = JSON.parse(p.risksJson ?? "[]");
        return risks.length >= (complexity.level === "complex" ? 3 : complexity.level === "standard" ? 1 : 0);
      } catch { return false; }
    });

    if (relevant.length === 0) return baseTokens;

    // If we have outcome data, use it; otherwise stick with heuristic
    return baseTokens;
  }
}
