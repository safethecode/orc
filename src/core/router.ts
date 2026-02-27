import type { RoutingConfig, ModelTier, CostEstimate } from "../config/types.ts";

export interface RouteResult {
  tier: "simple" | "medium" | "complex";
  model: ModelTier;
  multiAgent: boolean;
  reason: string;
}

export interface RouteOptions {
  costEstimate?: CostEstimate;
}

const MULTI_AGENT_KEYWORDS = [
  "and then",
  "after that",
  "review after",
  "followed by",
  "once done",
  "then have",
];

export function routeTask(
  prompt: string,
  config: RoutingConfig,
  options?: RouteOptions,
): RouteResult {
  const lower = prompt.toLowerCase();

  const tierNames = ["simple", "medium", "complex"] as const;
  const scores: Record<string, number> = { simple: 0, medium: 0, complex: 0 };
  const matchedDomains = new Set<string>();

  for (const tierName of tierNames) {
    const tier = config.tiers[tierName];
    for (const keyword of tier.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        scores[tierName]++;
        matchedDomains.add(keyword.toLowerCase());
      }
    }
  }

  let bestTier: "simple" | "medium" | "complex" = "simple";
  let bestScore = 0;

  for (const tierName of tierNames) {
    if (scores[tierName] > bestScore) {
      bestScore = scores[tierName];
      bestTier = tierName;
    }
  }

  const multiAgentByKeyword = MULTI_AGENT_KEYWORDS.some((kw) =>
    lower.includes(kw),
  );

  const domainCount = new Set(
    tierNames.flatMap((t) =>
      config.tiers[t].keywords
        .filter((kw) => lower.includes(kw.toLowerCase()))
        .map((kw) => kw.toLowerCase()),
    ),
  ).size;

  const multiAgentByDomains = domainCount >= 3;
  const heuristicMulti = multiAgentByKeyword || multiAgentByDomains;

  // Cost-aware override: CostEstimator recommendation takes precedence over heuristic
  let multiAgent: boolean;
  let reason: string;

  if (options?.costEstimate) {
    const est = options.costEstimate;
    if (est.recommendation === "single" && heuristicMulti) {
      multiAgent = false;
      reason = `Cost override: ${est.reason}`;
    } else if (est.recommendation === "multi" && !heuristicMulti) {
      multiAgent = true;
      reason = `Cost recommends multi-agent: ${est.reason}`;
    } else {
      multiAgent = heuristicMulti;
      reason = heuristicMulti
        ? `Heuristic + cost aligned: multi-agent`
        : bestScore > 0 ? `Matched ${bestScore} keyword(s) for tier "${bestTier}"` : "";
    }
  } else {
    multiAgent = heuristicMulti;
    reason = bestScore > 0
      ? `Matched ${bestScore} keyword(s) for tier "${bestTier}"`
      : "";
  }

  const model = config.tiers[bestTier].model;
  return { tier: bestTier, model, multiAgent, reason };
}

export function suggestAgent(
  tier: "simple" | "medium" | "complex",
): string {
  return tier === "complex" ? "architect" : "coder";
}
