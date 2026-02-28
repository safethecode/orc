export interface FallbackRule {
  httpStatus: number[];           // e.g. [429, 503, 529]
  action: "switch_model" | "switch_provider" | "wait_retry";
  fallbackModel?: string;
  fallbackProvider?: string;
  waitMs?: number;
  maxAttempts?: number;
}

export interface FallbackChain {
  primary: { provider: string; model: string };
  fallbacks: Array<{ provider: string; model: string; priority: number }>;
}

export class RuntimeFallbackManager {
  private chains: Map<string, FallbackChain> = new Map();
  private rules: FallbackRule[];
  private attempts: Map<string, number> = new Map(); // key -> attempt count

  constructor(rules?: FallbackRule[]) {
    this.rules = rules ?? [
      { httpStatus: [429], action: "wait_retry", waitMs: 2000, maxAttempts: 3 },
      { httpStatus: [503, 529], action: "switch_provider", maxAttempts: 2 },
      { httpStatus: [500], action: "switch_model", maxAttempts: 1 },
    ];
  }

  /** Register a fallback chain for an agent */
  registerChain(agentName: string, chain: FallbackChain): void {
    this.chains.set(agentName, chain);
  }

  /**
   * Determine what to do on error. Returns null if no fallback available.
   * Tracks attempt counts per agent+status to respect maxAttempts.
   */
  handleError(
    agentName: string,
    httpStatus: number,
    currentProvider: string,
    currentModel: string,
  ): { action: string; provider: string; model: string; waitMs?: number } | null {
    const rule = this.rules.find(r => r.httpStatus.includes(httpStatus));
    if (!rule) return null;

    // Track attempts per agent+status
    const attemptKey = `${agentName}:${httpStatus}`;
    const currentAttempts = this.attempts.get(attemptKey) ?? 0;

    if (rule.maxAttempts !== undefined && currentAttempts >= rule.maxAttempts) {
      return null; // Exhausted attempts for this error type
    }

    this.attempts.set(attemptKey, currentAttempts + 1);

    if (rule.action === "wait_retry") {
      return {
        action: "wait_retry",
        provider: currentProvider,
        model: currentModel,
        waitMs: rule.waitMs ?? 2000,
      };
    }

    if (rule.action === "switch_provider") {
      const chain = this.chains.get(agentName);
      if (!chain) {
        // No chain registered — try a wait_retry instead
        return {
          action: "wait_retry",
          provider: currentProvider,
          model: currentModel,
          waitMs: rule.waitMs ?? 3000,
        };
      }

      // Find the next available fallback provider (different from current)
      const sorted = [...chain.fallbacks].sort((a, b) => a.priority - b.priority);
      const next = sorted.find(f => f.provider !== currentProvider);
      if (!next) {
        // All fallbacks are the same provider — use first one anyway
        if (sorted.length > 0) {
          return { action: "switch_provider", provider: sorted[0].provider, model: sorted[0].model };
        }
        return null;
      }

      return {
        action: "switch_provider",
        provider: next.provider,
        model: next.model,
      };
    }

    if (rule.action === "switch_model") {
      const chain = this.chains.get(agentName);
      if (!chain) {
        // No chain — try using rule's explicit fallbackModel
        if (rule.fallbackModel) {
          return {
            action: "switch_model",
            provider: rule.fallbackProvider ?? currentProvider,
            model: rule.fallbackModel,
          };
        }
        return null;
      }

      // Find a fallback with the same provider but different model
      const sorted = [...chain.fallbacks].sort((a, b) => a.priority - b.priority);
      const sameProvider = sorted.find(f => f.provider === currentProvider && f.model !== currentModel);
      if (sameProvider) {
        return { action: "switch_model", provider: sameProvider.provider, model: sameProvider.model };
      }

      // No same-provider alternative — switch to next available fallback entirely
      const next = sorted.find(f => f.provider !== currentProvider || f.model !== currentModel);
      if (next) {
        return { action: "switch_model", provider: next.provider, model: next.model };
      }

      return null;
    }

    return null;
  }

  /** Reset attempt counter for an agent (call on success) */
  resetAttempts(agentName: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.attempts.keys()) {
      if (key.startsWith(`${agentName}:`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.attempts.delete(key);
    }
  }

  /**
   * Parse HTTP status from error message or stderr output.
   * Recognizes patterns: "status 429", "HTTP 503", "Error 529",
   * "overloaded" (-> 529), "rate limit" (-> 429).
   */
  static parseHttpStatus(errorText: string): number | null {
    const lower = errorText.toLowerCase();

    // Direct numeric patterns: "status 429", "HTTP/1.1 503", "Error 529", "code 500"
    const numericMatch = lower.match(/(?:status|http(?:\/\d(?:\.\d)?)?|error|code)\s*[:=]?\s*(\d{3})/);
    if (numericMatch) {
      const code = parseInt(numericMatch[1], 10);
      if (code >= 400 && code < 600) return code;
    }

    // Semantic patterns
    if (/\boverloaded\b/.test(lower)) return 529;
    if (/\brate\s*limit/.test(lower)) return 429;
    if (/\btoo\s*many\s*requests\b/.test(lower)) return 429;
    if (/\bservice\s*unavailable\b/.test(lower)) return 503;
    if (/\binternal\s*server\s*error\b/.test(lower)) return 500;
    if (/\bbad\s*gateway\b/.test(lower)) return 502;
    if (/\bgateway\s*timeout\b/.test(lower)) return 504;

    return null;
  }
}
