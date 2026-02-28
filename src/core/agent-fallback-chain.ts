export interface ModelSpec {
  provider: string;
  model: string;
  priority: number;
}

export interface FallbackChainConfig {
  agent: string;
  chain: ModelSpec[];
}

export class AgentFallbackChain {
  private chains: Map<string, ModelSpec[]> = new Map();
  private currentIndex: Map<string, number> = new Map();

  constructor() {}

  register(agent: string, chain: ModelSpec[]): void {
    const sorted = [...chain].sort((a, b) => a.priority - b.priority);
    this.chains.set(agent, sorted);
    this.currentIndex.set(agent, 0);
  }

  current(agent: string): ModelSpec | null {
    const chain = this.chains.get(agent);
    if (!chain || chain.length === 0) return null;

    const idx = this.currentIndex.get(agent) ?? 0;
    if (idx >= chain.length) return null;

    return chain[idx];
  }

  next(agent: string): ModelSpec | null {
    const chain = this.chains.get(agent);
    if (!chain || chain.length === 0) return null;

    const idx = (this.currentIndex.get(agent) ?? 0) + 1;
    if (idx >= chain.length) return null;

    this.currentIndex.set(agent, idx);
    return chain[idx];
  }

  reset(agent: string): void {
    if (this.chains.has(agent)) {
      this.currentIndex.set(agent, 0);
    }
  }

  resetAll(): void {
    for (const agent of this.chains.keys()) {
      this.currentIndex.set(agent, 0);
    }
  }

  hasNext(agent: string): boolean {
    const chain = this.chains.get(agent);
    if (!chain) return false;

    const idx = this.currentIndex.get(agent) ?? 0;
    return idx + 1 < chain.length;
  }

  getChain(agent: string): ModelSpec[] {
    return this.chains.get(agent) ?? [];
  }

  registerDefaults(): void {
    this.register("coder", [
      { provider: "claude", model: "opus", priority: 0 },
      { provider: "claude", model: "sonnet", priority: 1 },
      { provider: "gemini", model: "pro", priority: 2 },
      { provider: "codex", model: "gpt4o", priority: 3 },
    ]);

    this.register("scout", [
      { provider: "claude", model: "haiku", priority: 0 },
      { provider: "gemini", model: "flash", priority: 1 },
      { provider: "codex", model: "gpt4o-mini", priority: 2 },
    ]);

    this.register("planner", [
      { provider: "claude", model: "opus", priority: 0 },
      { provider: "gemini", model: "pro", priority: 1 },
      { provider: "codex", model: "gpt4o", priority: 2 },
    ]);
  }

  formatStatus(agent: string): string {
    const chain = this.chains.get(agent);
    if (!chain || chain.length === 0) {
      return `[${agent}] no fallback chain registered`;
    }

    const idx = this.currentIndex.get(agent) ?? 0;

    const parts = chain.map((spec, i) => {
      const label = `${spec.provider}/${spec.model}`;
      if (i === idx) return `[${label}]`;
      if (i < idx) return `~${label}~`;
      return label;
    });

    const exhausted = idx >= chain.length;
    const suffix = exhausted ? " (exhausted)" : "";

    return `${agent}: ${parts.join(" -> ")}${suffix}`;
  }
}
