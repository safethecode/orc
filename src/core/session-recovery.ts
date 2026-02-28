export interface RecoveryContext {
  error: Error;
  errorMessage: string;
  agentName: string;
  provider: string;
  model: string;
  turnCount: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type RecoveryAction =
  | { action: "retry"; details: string }
  | { action: "compact_retry"; details: string }
  | { action: "switch_provider"; provider: string; model: string; details: string }
  | { action: "switch_model"; model: string; details: string }
  | { action: "wait_retry"; waitMs: number; details: string }
  | { action: "abort"; details: string };

interface RecoveryStrategy {
  name: string;
  canHandle(ctx: RecoveryContext): boolean;
  recover(ctx: RecoveryContext): RecoveryAction;
}

// --- Strategy implementations ---

class TokenLimitStrategy implements RecoveryStrategy {
  name = "token_limit";

  canHandle(ctx: RecoveryContext): boolean {
    const msg = ctx.errorMessage.toLowerCase();
    return (
      msg.includes("context length exceeded") ||
      msg.includes("token limit") ||
      msg.includes("max_tokens") ||
      /\bcontext.{0,20}(too long|exceed|overflow)\b/.test(msg) ||
      /\btokens?.{0,10}(exceed|limit|maximum)\b/.test(msg)
    );
  }

  recover(ctx: RecoveryContext): RecoveryAction {
    const tokenInfo = ctx.inputTokens
      ? ` (input tokens: ${ctx.inputTokens})`
      : "";
    return {
      action: "compact_retry",
      details: `Context length exceeded for ${ctx.agentName}${tokenInfo} — compacting conversation and retrying`,
    };
  }
}

class RateLimitStrategy implements RecoveryStrategy {
  name = "rate_limit";
  private consecutiveAttempts = 0;

  canHandle(ctx: RecoveryContext): boolean {
    const msg = ctx.errorMessage.toLowerCase();
    return (
      this.extractHttpStatus(msg) === 429 ||
      msg.includes("rate limit") ||
      msg.includes("too many requests") ||
      /\bratelimit\b/.test(msg)
    );
  }

  recover(ctx: RecoveryContext): RecoveryAction {
    const msg = ctx.errorMessage.toLowerCase();

    // Check for retry-after header value in error message
    const retryAfterMatch = msg.match(/retry[\s-]*after[\s:]*(\d+)/);
    let waitMs: number;

    if (retryAfterMatch) {
      const retryAfterSeconds = parseInt(retryAfterMatch[1], 10);
      // retry-after could be in seconds or milliseconds; assume seconds if < 300
      waitMs = retryAfterSeconds < 300
        ? retryAfterSeconds * 1000
        : retryAfterSeconds;
    } else {
      // Exponential backoff: 1s, 2s, 4s, 8s, capped at 30s
      waitMs = Math.min(1000 * Math.pow(2, this.consecutiveAttempts), 30000);
    }

    this.consecutiveAttempts++;

    return {
      action: "wait_retry",
      waitMs,
      details: `Rate limited on ${ctx.provider}/${ctx.model} — waiting ${waitMs}ms before retry (attempt ${this.consecutiveAttempts})`,
    };
  }

  private extractHttpStatus(msg: string): number | null {
    const match = msg.match(/(?:status|http|error|code)\s*[:=]?\s*(\d{3})/);
    if (match) {
      const code = parseInt(match[1], 10);
      if (code >= 400 && code < 600) return code;
    }
    return null;
  }
}

class OverloadStrategy implements RecoveryStrategy {
  name = "overload";

  canHandle(ctx: RecoveryContext): boolean {
    const msg = ctx.errorMessage.toLowerCase();
    const status = this.extractHttpStatus(msg);
    return (
      status === 503 ||
      status === 529 ||
      msg.includes("overloaded") ||
      msg.includes("service unavailable") ||
      /\bserver\s+is\s+(busy|overloaded)\b/.test(msg)
    );
  }

  recover(ctx: RecoveryContext): RecoveryAction {
    return {
      action: "switch_provider",
      provider: this.suggestAlternativeProvider(ctx.provider),
      model: this.suggestAlternativeModel(ctx.provider),
      details: `${ctx.provider} overloaded — switching provider for ${ctx.agentName}`,
    };
  }

  private suggestAlternativeProvider(current: string): string {
    const fallbackOrder = ["claude", "gemini", "codex", "kiro"];
    const next = fallbackOrder.find(p => p !== current);
    return next ?? "claude";
  }

  private suggestAlternativeModel(currentProvider: string): string {
    const defaults: Record<string, string> = {
      claude: "sonnet",
      gemini: "gemini-2.5-pro",
      codex: "codex",
      kiro: "kiro",
    };
    // Pick a provider different from current, return its default model
    for (const [provider, model] of Object.entries(defaults)) {
      if (provider !== currentProvider) return model;
    }
    return "sonnet";
  }
}

class ServerErrorStrategy implements RecoveryStrategy {
  name = "server_error";
  private attempts = 0;

  canHandle(ctx: RecoveryContext): boolean {
    const msg = ctx.errorMessage.toLowerCase();
    const status = this.extractHttpStatus(msg);
    return (
      status === 500 ||
      msg.includes("internal server error") ||
      msg.includes("internal error")
    );
  }

  recover(ctx: RecoveryContext): RecoveryAction {
    this.attempts++;

    if (this.attempts <= 2) {
      return {
        action: "wait_retry",
        waitMs: 2000,
        details: `Server error from ${ctx.provider} — waiting 2s before retry (attempt ${this.attempts}/2)`,
      };
    }

    // After 2 wait_retry attempts, switch model
    const alternativeModel = this.suggestAlternativeModel(ctx.model);
    return {
      action: "switch_model",
      model: alternativeModel,
      details: `Persistent server errors from ${ctx.provider}/${ctx.model} after ${this.attempts} attempts — switching to ${alternativeModel}`,
    };
  }

  private suggestAlternativeModel(current: string): string {
    const models = ["sonnet", "haiku", "opus", "gemini-2.5-pro", "gemini-2.5-flash"];
    const next = models.find(m => m !== current);
    return next ?? "sonnet";
  }

  private extractHttpStatus(msg: string): number | null {
    const match = msg.match(/(?:status|http|error|code)\s*[:=]?\s*(\d{3})/);
    if (match) {
      const code = parseInt(match[1], 10);
      if (code >= 400 && code < 600) return code;
    }
    return null;
  }
}

class TimeoutStrategy implements RecoveryStrategy {
  name = "timeout";
  private attempts = 0;

  canHandle(ctx: RecoveryContext): boolean {
    const msg = ctx.errorMessage.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("etimedout") ||
      msg.includes("econnreset") ||
      msg.includes("timed out") ||
      msg.includes("econnaborted") ||
      /\bconnection\s+(reset|closed|aborted)\b/.test(msg)
    );
  }

  recover(ctx: RecoveryContext): RecoveryAction {
    this.attempts++;

    if (this.attempts <= 1) {
      return {
        action: "retry",
        details: `${ctx.provider}/${ctx.model} timed out for ${ctx.agentName} — retrying (attempt ${this.attempts})`,
      };
    }

    // After first retry, switch provider
    const altProvider = this.suggestAlternativeProvider(ctx.provider);
    const altModel = this.suggestAlternativeModel(altProvider);
    return {
      action: "switch_provider",
      provider: altProvider,
      model: altModel,
      details: `Repeated timeouts from ${ctx.provider} for ${ctx.agentName} — switching to ${altProvider}/${altModel}`,
    };
  }

  private suggestAlternativeProvider(current: string): string {
    const fallbackOrder = ["claude", "gemini", "codex", "kiro"];
    const next = fallbackOrder.find(p => p !== current);
    return next ?? "claude";
  }

  private suggestAlternativeModel(provider: string): string {
    const defaults: Record<string, string> = {
      claude: "sonnet",
      gemini: "gemini-2.5-pro",
      codex: "codex",
      kiro: "kiro",
    };
    return defaults[provider] ?? "sonnet";
  }
}

class AuthErrorStrategy implements RecoveryStrategy {
  name = "auth_error";

  canHandle(ctx: RecoveryContext): boolean {
    const msg = ctx.errorMessage.toLowerCase();
    const status = this.extractHttpStatus(msg);
    return (
      status === 401 ||
      status === 403 ||
      msg.includes("unauthorized") ||
      msg.includes("forbidden") ||
      msg.includes("invalid api key") ||
      msg.includes("invalid_api_key") ||
      msg.includes("authentication failed") ||
      msg.includes("permission denied")
    );
  }

  recover(ctx: RecoveryContext): RecoveryAction {
    return {
      action: "abort",
      details: `Authentication/authorization error for ${ctx.provider} — cannot recover. Check API key and permissions for ${ctx.agentName}`,
    };
  }

  private extractHttpStatus(msg: string): number | null {
    const match = msg.match(/(?:status|http|error|code)\s*[:=]?\s*(\d{3})/);
    if (match) {
      const code = parseInt(match[1], 10);
      if (code >= 400 && code < 600) return code;
    }
    return null;
  }
}

class ContentFilterStrategy implements RecoveryStrategy {
  name = "content_filter";

  canHandle(ctx: RecoveryContext): boolean {
    const msg = ctx.errorMessage.toLowerCase();
    return (
      msg.includes("content filter") ||
      msg.includes("content_filter") ||
      msg.includes("safety") ||
      msg.includes("blocked") ||
      msg.includes("content policy") ||
      msg.includes("flagged") ||
      /\bcontent\s+(moderation|violation)\b/.test(msg)
    );
  }

  recover(ctx: RecoveryContext): RecoveryAction {
    return {
      action: "abort",
      details: `Content was blocked by ${ctx.provider} safety/content filter for ${ctx.agentName} — cannot recover automatically`,
    };
  }
}

// --- Manager ---

export class SessionRecoveryManager {
  private strategies: RecoveryStrategy[];
  private attemptCounts: Map<string, number> = new Map();
  private maxAttemptsPerStrategy = 3;
  private totalRecoveries = 0;
  private strategiesUsed: Record<string, number> = {};

  constructor() {
    // Order matters: first match wins. Auth and content filter are checked
    // before retryable errors to avoid wasting attempts on unrecoverable cases.
    this.strategies = [
      new AuthErrorStrategy(),
      new ContentFilterStrategy(),
      new TokenLimitStrategy(),
      new RateLimitStrategy(),
      new OverloadStrategy(),
      new ServerErrorStrategy(),
      new TimeoutStrategy(),
    ];
  }

  recover(ctx: RecoveryContext): RecoveryAction {
    for (const strategy of this.strategies) {
      if (!strategy.canHandle(ctx)) continue;

      const count = this.attemptCounts.get(strategy.name) ?? 0;
      if (count >= this.maxAttemptsPerStrategy) {
        return {
          action: "abort",
          details: `Exhausted ${this.maxAttemptsPerStrategy} recovery attempts for ${strategy.name} strategy on ${ctx.agentName} — aborting`,
        };
      }

      this.attemptCounts.set(strategy.name, count + 1);
      this.totalRecoveries++;
      this.strategiesUsed[strategy.name] = (this.strategiesUsed[strategy.name] ?? 0) + 1;

      return strategy.recover(ctx);
    }

    // No strategy matched
    return {
      action: "abort",
      details: `No recovery strategy matched for error on ${ctx.agentName}: ${ctx.errorMessage.slice(0, 200)}`,
    };
  }

  resetAttempts(): void {
    this.attemptCounts.clear();
  }

  getStats(): { totalRecoveries: number; strategiesUsed: Record<string, number> } {
    return {
      totalRecoveries: this.totalRecoveries,
      strategiesUsed: { ...this.strategiesUsed },
    };
  }
}
