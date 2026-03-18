import type { ProviderCapability, ProviderName, SubTask, AgentRole, ModelTier } from "../config/types.ts";
import { eventBus } from "./events.ts";

// Built-in capability definitions (can be overridden by config)
const DEFAULT_CAPABILITIES: ProviderCapability[] = [
  {
    name: "claude",
    models: ["haiku", "sonnet", "opus"],
    strengths: ["architecture", "code-generation", "implementation", "file-editing", "debugging", "review", "testing", "refactoring", "security"],
    weaknesses: [],
    maxContextTokens: 200000,
    supportsStreaming: true,
    supportsToolUse: true,
    costTier: "high",
  },
  {
    name: "codex",
    models: ["codex"],
    strengths: ["code-generation", "refactoring", "implementation", "file-editing"],
    weaknesses: ["architecture", "documentation"],
    maxContextTokens: 192000,
    supportsStreaming: false,
    supportsToolUse: true,
    costTier: "medium",
  },
  {
    name: "gemini",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    strengths: ["large-context", "research", "analysis", "documentation", "review"],
    weaknesses: ["file-editing", "tool-use"],
    maxContextTokens: 1000000,
    supportsStreaming: true,
    supportsToolUse: true,
    costTier: "medium",
  },
  {
    name: "kiro",
    models: ["kiro"],
    strengths: ["spec-driven", "implementation", "testing", "code-generation"],
    weaknesses: ["architecture", "review", "debugging"],
    maxContextTokens: 128000,
    supportsStreaming: false,
    supportsToolUse: false,
    costTier: "low",
  },
];

// Mapping from agent role to required capabilities
const ROLE_REQUIREMENTS: Record<AgentRole, string[]> = {
  architect: ["architecture", "review", "security"],
  coder: ["code-generation", "implementation", "file-editing"],
  reviewer: ["review", "debugging", "security"],
  tester: ["testing", "code-generation"],
  researcher: ["research", "analysis", "large-context"],
  "spec-writer": ["documentation", "analysis"],
  qa: ["testing", "review", "code-generation"],
  design: ["analysis", "documentation", "code-generation"],
};

const COST_MULTIPLIER: Record<string, number> = {
  low: 0.3,
  medium: 0.6,
  high: 1.0,
};

export interface SelectionResult {
  provider: ProviderName;
  model: string;
  score: number;
  reason: string;
}

export class ProviderSelector {
  private capabilities: ProviderCapability[];
  private availableProviders: Set<ProviderName>;
  private rateLimited: Map<ProviderName, number> = new Map(); // provider → reset timestamp

  constructor(
    capabilities?: ProviderCapability[],
    availableProviders?: ProviderName[],
  ) {
    this.capabilities = capabilities ?? DEFAULT_CAPABILITIES;
    this.availableProviders = new Set(availableProviders ?? this.capabilities.map(c => c.name));
  }

  select(
    subtask: SubTask,
    options?: {
      preferCheap?: boolean;
      requireStreaming?: boolean;
      requireToolUse?: boolean;
      excluded?: ProviderName[];
      contextSize?: number;
    },
  ): SelectionResult {
    const excluded = new Set(options?.excluded ?? []);
    const now = Date.now();
    const candidates = this.capabilities.filter(cap => {
      if (!this.availableProviders.has(cap.name)) return false;
      if (excluded.has(cap.name)) return false;
      const rlUntil = this.rateLimited.get(cap.name);
      if (rlUntil && rlUntil > now) return false;
      if (options?.requireStreaming && !cap.supportsStreaming) return false;
      if (options?.requireToolUse && !cap.supportsToolUse) return false;
      if (options?.contextSize && cap.maxContextTokens < options.contextSize) return false;
      return true;
    });

    if (candidates.length === 0) {
      // Fallback: use claude as last resort
      return {
        provider: "claude",
        model: "sonnet",
        score: 0,
        reason: "Fallback — no providers available",
      };
    }

    const providerOrder = [...this.availableProviders];
    const scored = candidates.map(cap => {
      const result = this.scoreProvider(cap, subtask, options);
      // Preference bonus: earlier in preferredProviders list gets up to +5
      const idx = providerOrder.indexOf(cap.name);
      if (idx >= 0) result.score += Math.max(0, 5 - idx);
      return result;
    });
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];

    eventBus.publish({
      type: "provider:selected",
      subtaskId: subtask.id,
      provider: best.provider,
      model: best.model,
      reason: best.reason,
    });

    return best;
  }

  selectWithFallback(
    subtask: SubTask,
    options?: Parameters<ProviderSelector["select"]>[1],
  ): SelectionResult {
    const primary = this.select(subtask, options);
    if (primary.score > 0) return primary;

    // Fallback chain: claude → codex → gemini → kiro
    const fallbackOrder: ProviderName[] = ["claude", "codex", "gemini", "kiro"];
    for (const provider of fallbackOrder) {
      const cap = this.capabilities.find(c => c.name === provider);
      if (!cap) continue;

      eventBus.publish({
        type: "provider:fallback",
        subtaskId: subtask.id,
        from: primary.provider,
        to: provider,
        reason: `Primary provider ${primary.provider} scored 0, falling back`,
      });

      return {
        provider,
        model: cap.models[0],
        score: 1,
        reason: `Fallback to ${provider}`,
      };
    }

    return primary;
  }

  markRateLimited(provider: ProviderName, resetAt: number): void {
    this.rateLimited.set(provider, resetAt);
  }

  clearRateLimit(provider: ProviderName): void {
    this.rateLimited.delete(provider);
  }

  getCapabilities(): ProviderCapability[] {
    return [...this.capabilities];
  }

  private scoreProvider(
    cap: ProviderCapability,
    subtask: SubTask,
    options?: { preferCheap?: boolean },
  ): SelectionResult {
    let score = 0;
    const reasons: string[] = [];

    // 1. Strength match (0-50 points)
    const required = ROLE_REQUIREMENTS[subtask.agentRole] ?? [];
    const strengthMatches = required.filter(r => cap.strengths.includes(r));
    const strengthScore = required.length > 0
      ? (strengthMatches.length / required.length) * 50
      : 25;
    score += strengthScore;
    if (strengthMatches.length > 0) {
      reasons.push(`strengths: ${strengthMatches.join(", ")}`);
    }

    // 2. Weakness penalty (-20 per weakness match)
    const weaknessMatches = required.filter(r => cap.weaknesses.includes(r));
    score -= weaknessMatches.length * 20;
    if (weaknessMatches.length > 0) {
      reasons.push(`weak at: ${weaknessMatches.join(", ")}`);
    }

    // 3. Cost preference (0-20 points)
    const costScore = options?.preferCheap
      ? (1 - COST_MULTIPLIER[cap.costTier]) * 20
      : COST_MULTIPLIER[cap.costTier] * 10; // slightly prefer higher quality by default
    score += costScore;

    // 4. Token capacity bonus (0-10 points)
    if (subtask.estimatedTokens > 0 && cap.maxContextTokens >= subtask.estimatedTokens * 2) {
      score += 10;
    }

    // 5. Tool use bonus for coding tasks
    if (cap.supportsToolUse && ["coder", "tester"].includes(subtask.agentRole)) {
      score += 10;
    }

    // Select best model for the task within this provider
    const model = this.selectModel(cap, subtask);

    return {
      provider: cap.name,
      model,
      score: Math.max(0, Math.round(score)),
      reason: reasons.join("; ") || `Default selection for ${cap.name}`,
    };
  }

  private selectModel(cap: ProviderCapability, subtask: SubTask): string {
    if (cap.models.length === 1) return cap.models[0];

    // For claude: map by role and estimated complexity
    if (cap.name === "claude") {
      if (subtask.agentRole === "architect" || subtask.estimatedTokens > 30000) return "opus";
      if (subtask.agentRole === "tester" || subtask.estimatedTokens < 5000) return "haiku";
      return "sonnet";
    }

    // For gemini: use pro for complex, flash for simple
    if (cap.name === "gemini") {
      return subtask.estimatedTokens > 20000 ? "gemini-2.5-pro" : "gemini-2.5-flash";
    }

    return cap.models[0];
  }
}
