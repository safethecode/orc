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

// Patterns that indicate a development/engineering task
const DEV_PATTERNS = [
  /\.(ts|js|py|go|rs|java|cpp|c|rb|php|yml|yaml|json|toml|sh|css|html|jsx|tsx|sql|proto)\b/,
  /\b(function|class|module|import|export|const|let|var|def|fn|struct|impl|interface)\b/i,
  /\b(bug|error|crash|exception|traceback|segfault|stack\s*trace)\b/i,
  /\b(commit|push|pull|merge|branch|deploy|build|compile|install|run)\b/i,
  /\b(file|directory|path|repo|codebase|database|api|endpoint|server|client)\b/i,
  /(코드|파일|함수|클래스|버그|에러|배포|빌드|커밋|푸시|테스트|구현|수정)/,
];

// Patterns that indicate conversational / non-development prompts
const CHAT_PATTERNS = [
  /^(hi|hello|hey|yo|sup|안녕|ㅎㅇ|ㅎㅎ|감사|고마워|thanks|thank you|좋아|ㅇㅇ|ㄴㄴ|ㅋㅋ|ㅎ)\s*[.!?]?$/i,
  /^(what|who|how|why|when|where|뭐|누구|어떻게|왜|언제|어디)\b.{0,60}\??\s*$/i,
  /^.{1,15}$/,  // Very short prompts (1-15 chars) are almost always conversational
];

/**
 * Detect whether a prompt is a development task (vs general conversation).
 * Returns true if the prompt contains development signals.
 */
export function isDevelopmentTask(prompt: string): boolean {
  return DEV_PATTERNS.some((p) => p.test(prompt));
}

/**
 * Detect whether a prompt is clearly conversational.
 */
function isConversational(prompt: string): boolean {
  if (CHAT_PATTERNS.some((p) => p.test(prompt))) return true;
  // If no dev signals and prompt is reasonably short, treat as chat
  if (!isDevelopmentTask(prompt) && prompt.length < 80) return true;
  return false;
}

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
  prompt?: string,
): string {
  if (tier === "complex") return "architect";
  if (tier === "medium") return "coder";
  // simple tier: check if it's conversation or development
  if (prompt && isConversational(prompt)) return "Sam";
  return "coder";
}
