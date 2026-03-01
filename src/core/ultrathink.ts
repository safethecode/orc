// ── Ultrathink Mode ─────────────────────────────────────────────────
// Deep reasoning agent mode for maximum analytical depth.
// Detects ultrathink keywords at the start of input, strips them,
// and returns configuration overrides that push reasoning to its deepest.
// Combines deep analysis with maximum performance — the single mode
// for pushing agent reasoning and execution to their limits.

export interface UltrathinkOverrides {
  model: string;
  maxTurns: number;
  forceMultiAgent: boolean;
  forcePlanning: boolean;
  forceQA: boolean;
  forceIdeation: boolean;
  temperature: number;
}

const DEFAULT_OVERRIDES: UltrathinkOverrides = {
  model: "opus",
  maxTurns: 100,
  forceMultiAgent: false,
  forcePlanning: true,
  forceQA: true,
  forceIdeation: true,
  temperature: 0.1,
};

const ULTRATHINK_KEYWORDS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^ultrathink\b/i, label: "ultrathink" },
  { pattern: /^uth\b/i, label: "uth" },
  { pattern: /^deep\s+think\b/i, label: "deep think" },
  { pattern: /^깊이생각\b/i, label: "깊이생각" },
  { pattern: /^심사숙고\b/i, label: "심사숙고" },
];

export class UltrathinkMode {
  private active = false;
  private keywords: Array<{ pattern: RegExp; label: string }>;

  constructor() {
    this.keywords = [...ULTRATHINK_KEYWORDS];
  }

  /**
   * Detect ultrathink keywords at the start of input.
   * If found, strips the keyword and returns the clean prompt.
   * Also activates ultrathink mode as a side effect.
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
   * Get configuration overrides when ultrathink is active.
   * Returns deep-reasoning settings: opus model, high turns, low temperature.
   */
  getOverrides(): UltrathinkOverrides {
    return { ...DEFAULT_OVERRIDES };
  }

  /**
   * Build system prompt addition for ultrathink mode.
   * Injected when ultrathink is activated to push agent into deep reasoning.
   */
  buildSystemPromptAddition(): string {
    return [
      "ULTRATHINK MODE: ACTIVE",
      "",
      "You are in deep reasoning mode. Follow this 4-phase protocol:",
      "",
      "## Phase 1: Deep Analysis",
      "- Read ALL relevant files before making any changes",
      "- Understand the full architecture and dependencies",
      "- Map out every code path affected by the change",
      "- Identify edge cases and potential regressions",
      "",
      "## Phase 2: Multi-Perspective Planning",
      "- Consider at least 3 different approaches",
      "- Evaluate trade-offs: simplicity vs flexibility, performance vs readability",
      "- Choose the approach that minimizes blast radius",
      "- Document your reasoning for the chosen approach",
      "",
      "## Phase 3: Verified Implementation",
      "- Implement changes incrementally, verifying each step",
      "- After each file modification, check for type errors",
      "- Run relevant tests after each significant change",
      "- Never leave incomplete implementations",
      "",
      "## Phase 4: Self-Review",
      "- Review your own changes as a senior engineer would",
      "- Check for security implications (OWASP top 10)",
      "- Verify error handling for all failure modes",
      "- Ensure backward compatibility",
      "- Run the full test suite before declaring completion",
      "",
      "RULES:",
      "- Think through every edge case BEFORE writing code",
      "- If uncertain about any aspect, investigate further rather than guessing",
      "- Prefer minimal, surgical changes over broad rewrites",
      "- Zero tolerance for TODO comments or placeholder code",
      "- TASK_COMPLETE only after all 4 phases are verified",
    ].join("\n");
  }

  /** Activate ultrathink mode. */
  activate(): void {
    this.active = true;
  }

  /** Deactivate ultrathink mode. */
  deactivate(): void {
    this.active = false;
  }

  /** Check if ultrathink mode is currently active. */
  isActive(): boolean {
    return this.active;
  }

  /** Get full status including current overrides. */
  getStatus(): { active: boolean; overrides: UltrathinkOverrides } {
    return {
      active: this.active,
      overrides: this.getOverrides(),
    };
  }
}
