export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn?: (error: Error) => boolean;
}

const defaults: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
};

const NON_RETRYABLE = [
  "context_length_exceeded",
  "context window",
  "invalid_api_key",
];

const RETRYABLE = [
  "429",
  "rate limit",
  "500",
  "502",
  "503",
  "504",
  "ECONNRESET",
  "ETIMEDOUT",
  "fetch failed",
];

export function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  if (NON_RETRYABLE.some((p) => msg.includes(p.toLowerCase()))) return false;
  return RETRYABLE.some((p) => msg.includes(p.toLowerCase()));
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const opts = { ...defaults, ...options };

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (attempt === opts.maxAttempts) throw error;

      const shouldRetry = opts.retryOn
        ? opts.retryOn(error)
        : isRetryableError(error);

      if (!shouldRetry) throw error;

      const jitter = 0.9 + Math.random() * 0.2;
      const delay = Math.min(
        opts.baseDelayMs * 2 ** (attempt - 1) * jitter,
        opts.maxDelayMs,
      );

      await Bun.sleep(delay);
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("retryWithBackoff: exhausted attempts");
}
