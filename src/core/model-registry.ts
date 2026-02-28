// ── Model Registry ──────────────────────────────────────────────────
// External model metadata with pricing, capabilities, and limits.
// Inspired by models.dev — auto-refreshable with hardcoded defaults.

export interface ModelInfo {
  id: string;                    // e.g. "anthropic/claude-sonnet-4-5"
  name: string;
  provider: string;
  family: string;
  capabilities: {
    toolUse: boolean;
    reasoning: boolean;
    vision: boolean;
    streaming: boolean;
  };
  cost: {
    inputPerMillion: number;     // USD per 1M input tokens
    outputPerMillion: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
  };
  limits: {
    contextWindow: number;
    maxOutput: number;
  };
  status: "active" | "beta" | "deprecated";
}

export class ModelRegistry {
  private models: Map<string, ModelInfo> = new Map();
  private lastRefresh: number = 0;
  private refreshIntervalMs: number;

  constructor(refreshIntervalMs?: number) {
    this.refreshIntervalMs = refreshIntervalMs ?? 3_600_000; // 1 hour
    this.loadDefaults();
  }

  /**
   * Load hardcoded defaults for common models with accurate 2025 pricing.
   */
  private loadDefaults(): void {
    const defaults: ModelInfo[] = [
      // ── Anthropic ──────────────────────────────────────────
      {
        id: "anthropic/claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        provider: "anthropic",
        family: "claude",
        capabilities: { toolUse: true, reasoning: false, vision: true, streaming: true },
        cost: {
          inputPerMillion: 0.80,
          outputPerMillion: 4.00,
          cacheReadPerMillion: 0.08,
          cacheWritePerMillion: 1.00,
        },
        limits: { contextWindow: 200_000, maxOutput: 8_192 },
        status: "active",
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        family: "claude",
        capabilities: { toolUse: true, reasoning: true, vision: true, streaming: true },
        cost: {
          inputPerMillion: 3.00,
          outputPerMillion: 15.00,
          cacheReadPerMillion: 0.30,
          cacheWritePerMillion: 3.75,
        },
        limits: { contextWindow: 200_000, maxOutput: 16_384 },
        status: "active",
      },
      {
        id: "anthropic/claude-opus-4-6",
        name: "Claude Opus 4.6",
        provider: "anthropic",
        family: "claude",
        capabilities: { toolUse: true, reasoning: true, vision: true, streaming: true },
        cost: {
          inputPerMillion: 15.00,
          outputPerMillion: 75.00,
          cacheReadPerMillion: 1.50,
          cacheWritePerMillion: 18.75,
        },
        limits: { contextWindow: 200_000, maxOutput: 32_000 },
        status: "active",
      },

      // ── OpenAI ─────────────────────────────────────────────
      {
        id: "openai/gpt-4o",
        name: "GPT-4o",
        provider: "openai",
        family: "gpt",
        capabilities: { toolUse: true, reasoning: false, vision: true, streaming: true },
        cost: {
          inputPerMillion: 2.50,
          outputPerMillion: 10.00,
          cacheReadPerMillion: 1.25,
        },
        limits: { contextWindow: 128_000, maxOutput: 16_384 },
        status: "active",
      },
      {
        id: "openai/gpt-4o-mini",
        name: "GPT-4o Mini",
        provider: "openai",
        family: "gpt",
        capabilities: { toolUse: true, reasoning: false, vision: true, streaming: true },
        cost: {
          inputPerMillion: 0.15,
          outputPerMillion: 0.60,
          cacheReadPerMillion: 0.075,
        },
        limits: { contextWindow: 128_000, maxOutput: 16_384 },
        status: "active",
      },

      // ── Google ─────────────────────────────────────────────
      {
        id: "google/gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        provider: "google",
        family: "gemini",
        capabilities: { toolUse: true, reasoning: true, vision: true, streaming: true },
        cost: {
          inputPerMillion: 1.25,
          outputPerMillion: 10.00,
        },
        limits: { contextWindow: 1_048_576, maxOutput: 65_536 },
        status: "active",
      },
      {
        id: "google/gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        provider: "google",
        family: "gemini",
        capabilities: { toolUse: true, reasoning: true, vision: true, streaming: true },
        cost: {
          inputPerMillion: 0.15,
          outputPerMillion: 0.60,
        },
        limits: { contextWindow: 1_048_576, maxOutput: 65_536 },
        status: "active",
      },
    ];

    for (const model of defaults) {
      this.models.set(model.id, model);
    }

    this.lastRefresh = Date.now();
  }

  /**
   * Get model info by ID. Supports fuzzy matching — a bare substring
   * like "sonnet" will match "anthropic/claude-sonnet-4-5".
   */
  get(id: string): ModelInfo | undefined {
    // Exact match first
    const exact = this.models.get(id);
    if (exact) return exact;

    // Fuzzy: case-insensitive substring match
    const lower = id.toLowerCase();
    for (const [key, model] of this.models) {
      if (
        key.toLowerCase().includes(lower) ||
        model.name.toLowerCase().includes(lower)
      ) {
        return model;
      }
    }

    return undefined;
  }

  /**
   * List all models, optionally filtered by provider.
   */
  list(provider?: string): ModelInfo[] {
    const all = [...this.models.values()];
    if (!provider) return all;
    const lower = provider.toLowerCase();
    return all.filter((m) => m.provider.toLowerCase() === lower);
  }

  /**
   * Calculate cost for a given token usage.
   * Uses Decimal-safe math: multiply before divide to avoid precision loss.
   */
  calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens?: number,
  ): number {
    const model = this.get(modelId);
    if (!model) return 0;

    const { cost } = model;

    // Multiply token count by per-million rate, then divide by 1_000_000.
    // This keeps intermediate values as large integers for better precision.
    let totalCents = 0;

    // input cost: (inputTokens * inputPerMillion * 100) / 1_000_000  → cents
    // We work in micro-dollars (*1e6) then divide once at the end.
    const inputMicro = inputTokens * Math.round(cost.inputPerMillion * 1_000_000) ; // token * micro-$/M
    const outputMicro = outputTokens * Math.round(cost.outputPerMillion * 1_000_000);

    let cacheMicro = 0;
    if (cacheReadTokens && cost.cacheReadPerMillion !== undefined) {
      cacheMicro = cacheReadTokens * Math.round(cost.cacheReadPerMillion * 1_000_000);
    }

    // Each micro value is tokens * (rate * 1e6). Divide by 1e6 (per million tokens)
    // and again by 1e6 (undo the micro scaling) → divide by 1e12 total.
    const totalUsd = (inputMicro + outputMicro + cacheMicro) / 1_000_000_000_000;

    // Round to 8 decimal places to avoid floating-point dust
    return Math.round(totalUsd * 100_000_000) / 100_000_000;
  }

  /**
   * Register a custom model (e.g. from user config or a remote registry).
   */
  register(model: ModelInfo): void {
    this.models.set(model.id, model);
  }

  /**
   * Check if a refresh from an external registry is needed based on elapsed time.
   */
  needsRefresh(): boolean {
    return Date.now() - this.lastRefresh >= this.refreshIntervalMs;
  }

  /**
   * Mark registry as freshly refreshed (call after fetching remote data).
   */
  markRefreshed(): void {
    this.lastRefresh = Date.now();
  }

  /**
   * Format a single model info line for CLI display.
   * Example: "anthropic/claude-sonnet-4-5  $3.00/$15.00  200K ctx  [tool,reason,vision,stream]"
   */
  formatModelLine(model: ModelInfo): string {
    const caps: string[] = [];
    if (model.capabilities.toolUse) caps.push("tool");
    if (model.capabilities.reasoning) caps.push("reason");
    if (model.capabilities.vision) caps.push("vision");
    if (model.capabilities.streaming) caps.push("stream");

    const ctxK = model.limits.contextWindow >= 1_000_000
      ? `${(model.limits.contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(model.limits.contextWindow / 1_000)}K`;

    const inPrice = formatPrice(model.cost.inputPerMillion);
    const outPrice = formatPrice(model.cost.outputPerMillion);
    const status = model.status !== "active" ? ` (${model.status})` : "";

    return `${model.id.padEnd(32)}  $${inPrice}/$${outPrice}  ${ctxK.padStart(5)} ctx  [${caps.join(",")}]${status}`;
  }
}

function formatPrice(usd: number): string {
  if (usd >= 1) return usd.toFixed(2);
  if (usd >= 0.1) return usd.toFixed(2);
  return usd.toFixed(3);
}
