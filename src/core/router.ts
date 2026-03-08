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

export interface Classification {
  type: "development" | "conversation";
  agent: string;
  reason: string;
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
  /(디자인|스타일|레이아웃|색상|폰트|컴포넌트|UI|UX|사용성|인터페이스)/,
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
 * Detect whether a prompt is clearly conversational (regex fallback).
 */
function isConversational(prompt: string): boolean {
  if (CHAT_PATTERNS.some((p) => p.test(prompt))) return true;
  if (!isDevelopmentTask(prompt) && prompt.length < 80) return true;
  return false;
}

const CLASSIFY_TIMEOUT_MS = 15_000; // 15s — CLI spawn + haiku API needs headroom

/**
 * Use Sam (haiku) to classify a prompt via LLM with timeout.
 */
export async function classifyWithSam(prompt: string, previousAgent?: string): Promise<Classification> {
  const contextLine = previousAgent && previousAgent !== "Sam"
    ? `\nContext: The previous task was handled by "${previousAgent}". Short follow-ups like "continue", "fix that", "next", "go ahead", "계속", "수정해", "다음" should route to the SAME agent, not Sam.`
    : "";

  const classifyPrompt = [
    `Classify this user prompt. Reply with ONLY a JSON object, nothing else.`,
    `{"type":"development"|"conversation","agent":"Sam"|"coder"|"architect"|"design"|"writer"}`,
    `Rules:`,
    `- "conversation" → ONLY pure greetings, thanks, or questions completely unrelated to any task → agent "Sam"`,
    `- "development" standard → code changes, bugs, tests, refactor, implement, follow-ups to coding work → agent "coder"`,
    `- "development" complex → system architecture, security audit, migration, infrastructure → agent "architect"`,
    `- "development" design → UI/UX design, styling, visual improvements, layout, colors, fonts, components, usability, look and feel, CSS, frontend appearance → agent "design"`,
    `- "development" writing → documentation, README, API docs, changelog, tutorial, copywriting, technical writing, microcopy, error messages, UI text, 문서 작성, 카피, 글쓰기 → agent "writer"`,
    `- IMPORTANT: Short or ambiguous follow-ups that reference previous work (e.g. "fix that", "continue", "next", "keep going", "수정해", "계속", "다음") are development, NOT conversation.`,
    contextLine,
    ``,
    `User prompt: ${prompt}`,
  ].join("\n");

  try {
    const proc = Bun.spawn(
      ["claude", "-p", classifyPrompt, "--model", "haiku", "--output-format", "text"],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );

    // Race: LLM response vs timeout (both stdout AND exited inside the race)
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        try { proc.kill(); } catch {}
        reject(new Error(`classify timeout (${CLASSIFY_TIMEOUT_MS}ms)`));
      }, CLASSIFY_TIMEOUT_MS),
    );

    const output = await Promise.race([
      new Response(proc.stdout).text(),
      timeout,
    ]);

    const jsonMatch = output.match(/\{[^}]+\}/);
    if (!jsonMatch) throw new Error(`no JSON in output: ${output.slice(0, 100)}`);

    const parsed = JSON.parse(jsonMatch[0]);
    const type = parsed.type === "development" ? "development" : "conversation";
    let agent: string;
    if (type === "conversation") {
      agent = "Sam";
    } else {
      const validDevAgents = ["architect", "design", "writer"];
      agent = validDevAgents.includes(parsed.agent) ? parsed.agent : "coder";
    }

    return { type, agent, reason: `Sam: ${type} → ${agent}` };
  } catch (e) {
    const errMsg = (e as Error).message;
    // Fallback: if previous agent was a dev agent, stay with it
    if (previousAgent && previousAgent !== "Sam") {
      return { type: "development", agent: previousAgent, reason: `fallback → previous agent (${errMsg})` };
    }
    if (prompt.length < 80) {
      return { type: "conversation", agent: "Sam", reason: `fallback (${errMsg})` };
    }
    return { type: "development", agent: "coder", reason: `fallback (${errMsg})` };
  }
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
