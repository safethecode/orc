export interface ModelVariantConfig {
  temperature: number;
  maxTokens: number;
  thinkingBudget?: number;
  reasoningEffort?: "low" | "medium" | "high";
  description: string;
}

const VARIANT_ORDER = ["fast", "default", "high", "max"] as const;
type VariantName = (typeof VARIANT_ORDER)[number];

const DEFAULT_VARIANTS: Record<VariantName, ModelVariantConfig> = {
  fast: { temperature: 0.1, maxTokens: 2048, description: "Quick responses" },
  default: { temperature: 0.7, maxTokens: 8192, description: "Balanced" },
  high: {
    temperature: 0.5,
    maxTokens: 16384,
    thinkingBudget: 10000,
    description: "Detailed reasoning",
  },
  max: {
    temperature: 0.3,
    maxTokens: 32768,
    thinkingBudget: 50000,
    reasoningEffort: "high",
    description: "Maximum quality",
  },
};

const KNOWN_MODELS = ["haiku", "sonnet", "opus"];

export class ModelVariantManager {
  private variants: Map<string, Map<string, ModelVariantConfig>>;
  private currentVariants: Map<string, string>;

  constructor() {
    this.variants = new Map();
    this.currentVariants = new Map();
    this.initDefaults();
  }

  private initDefaults(): void {
    for (const model of KNOWN_MODELS) {
      const modelVariants = new Map<string, ModelVariantConfig>();
      for (const [name, config] of Object.entries(DEFAULT_VARIANTS)) {
        modelVariants.set(name, { ...config });
      }
      this.variants.set(model, modelVariants);
      this.currentVariants.set(model, "default");
    }
  }

  getVariant(model: string, variant?: string): ModelVariantConfig | null {
    const modelVariants = this.variants.get(model);
    if (!modelVariants) return null;

    const name = variant ?? this.currentVariants.get(model) ?? "default";
    return modelVariants.get(name) ?? null;
  }

  cycleVariant(model: string): string {
    const current = this.currentVariants.get(model) ?? "default";
    const idx = VARIANT_ORDER.indexOf(current as VariantName);
    const next = VARIANT_ORDER[(idx + 1) % VARIANT_ORDER.length];
    this.currentVariants.set(model, next);
    return next;
  }

  setVariant(model: string, variant: string): boolean {
    const modelVariants = this.variants.get(model);
    if (!modelVariants || !modelVariants.has(variant)) return false;
    this.currentVariants.set(model, variant);
    return true;
  }

  getCurrentVariant(model: string): string {
    return this.currentVariants.get(model) ?? "default";
  }

  listVariants(
    model: string,
  ): Array<{ name: string; config: ModelVariantConfig; active: boolean }> {
    const modelVariants = this.variants.get(model);
    if (!modelVariants) return [];

    const current = this.currentVariants.get(model) ?? "default";
    const result: Array<{
      name: string;
      config: ModelVariantConfig;
      active: boolean;
    }> = [];

    for (const name of VARIANT_ORDER) {
      const config = modelVariants.get(name);
      if (config) {
        result.push({ name, config, active: name === current });
      }
    }

    // Include any custom variants not in the standard order
    for (const [name, config] of modelVariants) {
      if (!VARIANT_ORDER.includes(name as VariantName)) {
        result.push({ name, config, active: name === current });
      }
    }

    return result;
  }

  registerCustom(
    model: string,
    variants: Record<string, Partial<ModelVariantConfig>>,
  ): void {
    let modelVariants = this.variants.get(model);
    if (!modelVariants) {
      modelVariants = new Map<string, ModelVariantConfig>();
      // Seed with defaults for new models
      for (const [name, config] of Object.entries(DEFAULT_VARIANTS)) {
        modelVariants.set(name, { ...config });
      }
      this.variants.set(model, modelVariants);
      this.currentVariants.set(model, "default");
    }

    for (const [name, partial] of Object.entries(variants)) {
      const existing = modelVariants.get(name);
      if (existing) {
        modelVariants.set(name, { ...existing, ...partial });
      } else {
        // New variant — require at least temperature, maxTokens, description
        modelVariants.set(name, {
          temperature: partial.temperature ?? 0.7,
          maxTokens: partial.maxTokens ?? 8192,
          description: partial.description ?? name,
          ...(partial.thinkingBudget !== undefined && {
            thinkingBudget: partial.thinkingBudget,
          }),
          ...(partial.reasoningEffort !== undefined && {
            reasoningEffort: partial.reasoningEffort,
          }),
        });
      }
    }
  }

  formatStatus(model: string): string {
    const modelVariants = this.variants.get(model);
    if (!modelVariants) return `${model}: (no variants)`;

    const current = this.currentVariants.get(model) ?? "default";
    const parts: string[] = [];

    for (const name of VARIANT_ORDER) {
      if (modelVariants.has(name)) {
        parts.push(name === current ? `[${name}]` : name);
      }
    }

    // Include custom variants
    for (const name of modelVariants.keys()) {
      if (!VARIANT_ORDER.includes(name as VariantName)) {
        parts.push(name === current ? `[${name}]` : name);
      }
    }

    return `${model}: ${parts.join(" ")}`;
  }
}
