// ── Fastwork Mode ───────────────────────────────────────────────────
// One-keyword activation for maximum agent performance.
// Detects fastwork keywords at the start of input, strips them,
// and returns configuration overrides that push every dial to max.

export interface FastworkOverrides {
  model: string;
  maxTurns: number;
  forceMultiAgent: boolean;
  forcePlanning: boolean;
  temperature: number;
}

const DEFAULT_OVERRIDES: FastworkOverrides = {
  model: "opus",
  maxTurns: 50,
  forceMultiAgent: true,
  forcePlanning: true,
  temperature: 0.3,
};

const FASTWORK_KEYWORDS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^fastwork\b/i, label: "fastwork" },
  { pattern: /^fw\b/i, label: "fw" },
  { pattern: /^fast\s+run\b/i, label: "fast run" },
  { pattern: /^ulw-loop\b/i, label: "ulw-loop" },
  { pattern: /^ulw\b/i, label: "ulw" },
  { pattern: /^최대성능\b/i, label: "최대성능" },
  { pattern: /^full\s+power\b/i, label: "full power" },
  { pattern: /^풀파워\b/i, label: "풀파워" },
  { pattern: /^빠른실행\b/i, label: "빠른실행" },
];

export class FastworkMode {
  private active = false;
  private keywords: Array<{ pattern: RegExp; label: string }>;

  constructor() {
    this.keywords = [...FASTWORK_KEYWORDS];
  }

  /**
   * Detect fastwork keywords at the start of input.
   * If found, strips the keyword and returns the clean prompt.
   * Also activates fastwork mode as a side effect.
   */
  detect(input: string): {
    detected: boolean;
    keyword: string;
    cleanInput: string;
  } {
    const trimmed = input.trim();

    for (const { pattern, label } of this.keywords) {
      const match = trimmed.match(pattern);
      if (match) {
        const cleanInput = trimmed.slice(match[0].length).trim();
        this.activate();
        return { detected: true, keyword: label, cleanInput };
      }
    }

    return { detected: false, keyword: "", cleanInput: input };
  }

  /**
   * Get configuration overrides when fastwork is active.
   * Returns max-performance settings for model, turns, and behavior.
   */
  getOverrides(): FastworkOverrides {
    return { ...DEFAULT_OVERRIDES };
  }

  /**
   * Build system prompt addition for fastwork mode.
   * Injected when fastwork is activated to push agent to max performance.
   */
  buildSystemPromptAddition(): string {
    return [
      "[FASTWORK MODE: ACTIVE]",
      "You are in FASTWORK mode. Maximum performance required.",
      "Use every tool available. Read before writing. Verify after changes.",
      "Do NOT leave any task incomplete. Zero tolerance for partial work.",
      "If you encounter an obstacle, find an alternative approach immediately.",
      "Use parallel exploration when possible.",
      "Say TASK_COMPLETE only when everything is fully verified.",
    ].join("\n");
  }

  /** Activate fastwork mode. */
  activate(): void {
    this.active = true;
  }

  /** Deactivate fastwork mode. */
  deactivate(): void {
    this.active = false;
  }

  /** Check if fastwork mode is currently active. */
  isActive(): boolean {
    return this.active;
  }

  /** Get full status including current overrides. */
  getStatus(): { active: boolean; overrides: FastworkOverrides } {
    return {
      active: this.active,
      overrides: this.getOverrides(),
    };
  }
}
