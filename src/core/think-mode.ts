// ── Think Mode ──────────────────────────────────────────────────────
// Auto-detects when user wants deep reasoning and upgrades model tier.
// Scans input for thinking keywords, returns detection result with confidence.

export interface ThinkDetection {
  shouldUpgrade: boolean;
  keyword: string;
  confidence: number; // 0.0 to 1.0
}

export interface ThinkingModelMap {
  [baseModel: string]: string; // e.g., "sonnet" -> "opus"
}

// Keywords that indicate deep thinking is needed (case insensitive)
const THINK_KEYWORDS: Array<{ pattern: RegExp; confidence: number }> = [
  { pattern: /\bultrathink\b/i, confidence: 1.0 },
  { pattern: /\bthink\s+deeply\b/i, confidence: 0.95 },
  { pattern: /\bthink\s+hard\b/i, confidence: 0.95 },
  { pattern: /\breason\s+carefully\b/i, confidence: 0.9 },
  { pattern: /\bthink\s+through\b/i, confidence: 0.85 },
  { pattern: /\bstep\s+by\s+step\b/i, confidence: 0.8 },
  { pattern: /깊이\s*생각/i, confidence: 0.95 },
  { pattern: /신중하게/i, confidence: 0.9 },
];

const DEFAULT_MODEL_MAP: ThinkingModelMap = {
  haiku: "sonnet",
  sonnet: "opus",
  opus: "opus",
};

export class ThinkMode {
  private modelMap: ThinkingModelMap;

  constructor(modelMap?: ThinkingModelMap) {
    this.modelMap = modelMap ?? { ...DEFAULT_MODEL_MAP };
  }

  /**
   * Detect if input requests deep thinking.
   * Returns the highest-confidence match, or a no-upgrade result if none found.
   */
  detect(input: string): ThinkDetection {
    let bestMatch: { keyword: string; confidence: number } | null = null;

    for (const { pattern, confidence } of THINK_KEYWORDS) {
      const match = input.match(pattern);
      if (match) {
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = { keyword: match[0], confidence };
        }
      }
    }

    if (bestMatch) {
      return {
        shouldUpgrade: true,
        keyword: bestMatch.keyword,
        confidence: bestMatch.confidence,
      };
    }

    return {
      shouldUpgrade: false,
      keyword: "",
      confidence: 0,
    };
  }

  /**
   * Get the thinking variant of a model.
   * If the model has a mapped upgrade, returns it. Otherwise returns the model as-is.
   */
  getThinkingModel(currentModel: string): string {
    const lower = currentModel.toLowerCase();

    // Exact match
    if (this.modelMap[lower]) {
      return this.modelMap[lower];
    }

    // Substring match: find if any key is contained in the model string
    for (const [key, value] of Object.entries(this.modelMap)) {
      if (lower.includes(key)) {
        return value;
      }
    }

    // No mapping found — return original
    return currentModel;
  }

  /**
   * Build system prompt addition for thinking mode.
   * Injected when deep reasoning is activated.
   */
  buildPromptAddition(): string {
    return [
      "[Think Mode: ACTIVE]",
      "The user has requested deep reasoning. You should:",
      "- Break the problem into discrete steps before answering",
      "- Consider edge cases and alternative approaches",
      "- Show your reasoning process explicitly",
      "- Verify your conclusions before presenting them",
      "- If unsure, state assumptions clearly",
    ].join("\n");
  }
}
