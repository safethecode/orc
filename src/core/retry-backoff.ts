export interface RetryOpts {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryAfterMs?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export type ErrorClass = "retryable" | "non_retryable" | "rate_limit" | "overload";

const RETRYABLE_CODES = ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE"];
const RETRYABLE_MESSAGES = ["socket hang up"];

const RATE_LIMIT_PATTERNS = ["rate limit", "too many requests"];
const OVERLOAD_PATTERNS = ["overloaded"];

// CLI-specific rate limit patterns
const CLI_RATE_LIMIT_PATTERNS = [
  "session limit",
  "concurrent session",
  "max sessions",
  "try again in",
  "please wait",
  "capacity",
  "quota exceeded",
  "billing limit",
];

const NON_RETRYABLE_PATTERNS = ["context length", "content filter", "invalid"];

function getStatusCode(error: Error): number | null {
  const e = error as Error & { status?: number; statusCode?: number; response?: { status?: number } };
  return e.status ?? e.statusCode ?? e.response?.status ?? null;
}

function getErrorCode(error: Error): string | null {
  return (error as Error & { code?: string }).code ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_OPTS: Required<Omit<RetryOpts, "retryAfterMs" | "onRetry">> = {
  maxAttempts: 4,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
};

export class RetryWithBackoff {
  constructor() {}

  async retry<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T> {
    const resolved: Required<Omit<RetryOpts, "retryAfterMs" | "onRetry">> & {
      retryAfterMs: number | undefined;
      onRetry: RetryOpts["onRetry"];
    } = {
      maxAttempts: opts?.maxAttempts ?? DEFAULT_OPTS.maxAttempts,
      initialDelayMs: opts?.initialDelayMs ?? DEFAULT_OPTS.initialDelayMs,
      maxDelayMs: opts?.maxDelayMs ?? DEFAULT_OPTS.maxDelayMs,
      backoffMultiplier: opts?.backoffMultiplier ?? DEFAULT_OPTS.backoffMultiplier,
      retryAfterMs: opts?.retryAfterMs,
      onRetry: opts?.onRetry,
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < resolved.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        const classification = this.classifyError(error);

        if (classification === "non_retryable") {
          throw error;
        }

        if (attempt >= resolved.maxAttempts - 1) {
          throw error;
        }

        let delayMs: number;

        if (classification === "rate_limit") {
          const headerRetry = resolved.retryAfterMs ?? this.parseRetryAfter(error.message);
          delayMs = headerRetry ?? this.calculateDelay(attempt, {
            maxAttempts: resolved.maxAttempts,
            initialDelayMs: resolved.initialDelayMs,
            maxDelayMs: resolved.maxDelayMs,
            backoffMultiplier: resolved.backoffMultiplier,
            retryAfterMs: 0,
            onRetry: () => {},
          });
        } else {
          delayMs = this.calculateDelay(attempt, {
            maxAttempts: resolved.maxAttempts,
            initialDelayMs: resolved.initialDelayMs,
            maxDelayMs: resolved.maxDelayMs,
            backoffMultiplier: resolved.backoffMultiplier,
            retryAfterMs: 0,
            onRetry: () => {},
          });
        }

        resolved.onRetry?.(attempt + 1, error, delayMs);

        await delay(delayMs);
      }
    }

    throw lastError ?? new Error("Retry exhausted with no error captured");
  }

  classifyError(error: Error): ErrorClass {
    const code = getErrorCode(error);
    const status = getStatusCode(error);
    const msg = error.message.toLowerCase();

    // Check retryable network errors by code
    if (code && RETRYABLE_CODES.includes(code)) {
      return "retryable";
    }

    // Check retryable by message
    for (const pattern of RETRYABLE_MESSAGES) {
      if (msg.includes(pattern)) {
        return "retryable";
      }
    }

    // Check rate limit by status
    if (status === 429) {
      return "rate_limit";
    }

    // Check rate limit by message
    for (const pattern of RATE_LIMIT_PATTERNS) {
      if (msg.includes(pattern)) {
        return "rate_limit";
      }
    }

    // Check CLI-specific rate limit patterns
    for (const pattern of CLI_RATE_LIMIT_PATTERNS) {
      if (msg.includes(pattern)) {
        return "rate_limit";
      }
    }

    // Check overload by status
    if (status === 503 || status === 529) {
      return "overload";
    }

    // Check overload by message
    for (const pattern of OVERLOAD_PATTERNS) {
      if (msg.includes(pattern)) {
        return "overload";
      }
    }

    // Check non-retryable by status
    if (status === 400 || status === 401 || status === 403) {
      return "non_retryable";
    }

    // Check non-retryable by message
    for (const pattern of NON_RETRYABLE_PATTERNS) {
      if (msg.includes(pattern)) {
        return "non_retryable";
      }
    }

    // Default: treat unknown errors as retryable to be safe
    return "retryable";
  }

  parseRetryAfter(errorMessage: string): number | null {
    // Match "retry_after_ms: N" (milliseconds)
    const msMatch = errorMessage.match(/retry_after_ms[:\s]+(\d+)/i);
    if (msMatch) {
      return parseInt(msMatch[1], 10);
    }

    // Match "retry-after: N" (seconds, convert to ms)
    const secMatch = errorMessage.match(/retry-after[:\s]+(\d+)/i);
    if (secMatch) {
      return parseInt(secMatch[1], 10) * 1000;
    }

    // "try again in 5 minutes" / "wait 5 minutes" / "retry in 5 min"
    const minMatch = errorMessage.match(/(?:try again|wait|retry)\s+(?:in\s+)?(\d+)\s*min/i);
    if (minMatch) {
      return parseInt(minMatch[1], 10) * 60_000;
    }

    // "try again in 30 seconds" / "wait 30 sec"
    const secMatch2 = errorMessage.match(/(?:try again|wait|retry)\s+(?:in\s+)?(\d+)\s*sec/i);
    if (secMatch2) {
      return parseInt(secMatch2[1], 10) * 1000;
    }

    // "available at HH:MM" / "resets at HH:MM" / "ready at HH:MM"
    const timeMatch = errorMessage.match(/(?:available|resets?|ready)\s+(?:at\s+)?(\d{1,2}):(\d{2})/i);
    if (timeMatch) {
      const target = new Date();
      target.setHours(parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0, 0);
      if (target.getTime() <= Date.now()) {
        target.setDate(target.getDate() + 1);
      }
      return target.getTime() - Date.now();
    }

    return null;
  }

  calculateDelay(attempt: number, opts: Required<RetryOpts>): number {
    const raw = opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt);
    const capped = Math.min(raw, opts.maxDelayMs);
    // Add ±15% jitter to avoid thundering herd
    const jitter = capped * (0.85 + Math.random() * 0.3);
    return Math.round(jitter);
  }
}
