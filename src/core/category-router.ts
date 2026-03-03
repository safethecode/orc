// ── Category-Based Semantic Task Routing ─────────────────────────────
// Route tasks by semantic category instead of explicit model names.
// User-configurable category -> model mapping.

import type { ModelTier } from "../config/types.ts";

export interface CategoryConfig {
  model: string;
  tier: ModelTier;
  temperature?: number;
  description: string;
}

// ── Keyword Sets for Classification ─────────────────────────────────

const PLANNING_KEYWORDS = [
  "architect", "architecture", "plan", "planning", "roadmap",
  "system design", "high-level", "strategy", "rfc", "proposal", "adr",
  "tradeoff", "trade-off", "evaluate approach", "migration plan",
];

const TESTING_KEYWORDS = [
  "test", "spec", "coverage", "unit test", "e2e", "integration test",
  "vitest", "jest", "playwright", "cypress", "fixture", "mock",
  "assertion", "expect", "describe", "it(", "qa", "quality assurance",
];

const VISUAL_KEYWORDS = [
  "ui", "ux", "frontend", "css", "tailwind", "style", "layout",
  "responsive", "component", "page", "design", "figma", "animation",
  "color", "theme", "dark mode", "light mode", "sidebar", "navbar",
  "modal", "dialog", "button", "form", "input", "icon",
  // Korean
  "디자인", "스타일", "레이아웃", "색상", "폰트", "컴포넌트", "반응형",
  "다크모드", "테마", "모달", "버튼", "아이콘", "사용성", "인터페이스",
];

const WRITING_KEYWORDS = [
  "document", "documentation", "readme", "changelog", "write up",
  "blog post", "tutorial", "guide", "explain", "describe", "prose",
  "jsdoc", "api doc", "comment", "annotate",
];

const REVIEW_KEYWORDS = [
  "review", "audit", "analyze", "analysis", "inspect", "check",
  "lint", "code review", "security audit", "performance review",
  "evaluate", "assess", "critique", "feedback",
];

const QUICK_KEYWORDS = [
  "hi", "hello", "hey", "thanks", "thank you", "help", "what is",
  "how are", "good morning", "good evening", "ping", "status",
];

const DEEP_KEYWORDS = [
  "refactor entire", "rebuild", "rewrite", "from scratch", "overhaul",
  "redesign", "migrate", "full stack", "end to end", "complete system",
  "multi-step", "complex", "entire codebase", "all files",
];

// ── Default Categories ──────────────────────────────────────────────

const DEFAULT_CATEGORIES: Record<string, CategoryConfig> = {
  quick: { model: "haiku", tier: "haiku", description: "Single-file trivial fixes" },
  general: { model: "sonnet", tier: "sonnet", description: "General development tasks" },
  deep: { model: "opus", tier: "opus", temperature: 0.3, description: "Deep reasoning and architecture" },
  visual: { model: "sonnet", tier: "sonnet", description: "Frontend, UI/UX, design" },
  writing: { model: "sonnet", tier: "sonnet", temperature: 0.7, description: "Documentation and prose" },
  review: { model: "sonnet", tier: "sonnet", temperature: 0.1, description: "Code review, analysis" },
  planning: { model: "opus", tier: "opus", description: "Architecture and planning" },
  testing: { model: "haiku", tier: "haiku", description: "Test writing and QA" },
};

// ── Role-to-Category Mapping ────────────────────────────────────────

const ROLE_CATEGORY_MAP: Record<string, string> = {
  architect: "planning",
  planner: "planning",
  coder: "general",
  developer: "general",
  reviewer: "review",
  tester: "testing",
  "spec-writer": "writing",
  writer: "writing",
  designer: "visual",
  design: "visual",
  researcher: "deep",
};

export class CategoryRouter {
  private categories: Record<string, CategoryConfig>;

  constructor(overrides?: Record<string, Partial<CategoryConfig>>) {
    // Deep-copy defaults so mutations don't affect the template
    this.categories = {};
    for (const [name, config] of Object.entries(DEFAULT_CATEGORIES)) {
      this.categories[name] = { ...config };
    }

    // Apply user overrides
    if (overrides) {
      for (const [name, partial] of Object.entries(overrides)) {
        const existing = this.categories[name];
        if (existing) {
          this.categories[name] = { ...existing, ...partial };
        } else {
          // New category — require all fields
          if (partial.model && partial.tier && partial.description) {
            this.categories[name] = {
              model: partial.model,
              tier: partial.tier,
              temperature: partial.temperature,
              description: partial.description,
            };
          }
        }
      }
    }
  }

  /**
   * Classify a prompt into a category using keyword heuristics.
   * If an agent role is provided, it biases toward the role's default category.
   */
  classify(prompt: string, agentRole?: string): string {
    const lower = prompt.toLowerCase();

    // Score each category by keyword matches
    const scores: Record<string, number> = {};
    for (const name of Object.keys(this.categories)) {
      scores[name] = 0;
    }

    scores.planning += countMatches(lower, PLANNING_KEYWORDS);
    scores.testing += countMatches(lower, TESTING_KEYWORDS);
    scores.visual += countMatches(lower, VISUAL_KEYWORDS);
    scores.writing += countMatches(lower, WRITING_KEYWORDS);
    scores.review += countMatches(lower, REVIEW_KEYWORDS);
    scores.quick += countMatches(lower, QUICK_KEYWORDS);
    scores.deep += countMatches(lower, DEEP_KEYWORDS);

    // Deep keywords get extra weight since they signal high complexity
    scores.deep = (scores.deep ?? 0) * 2;

    // Quick detection: very short prompts that are greetings
    const wordCount = prompt.trim().split(/\s+/).length;
    if (wordCount <= 5 && scores.quick > 0) {
      scores.quick += 3;
    }

    // Agent role bias: add 1 point to the role's category
    if (agentRole) {
      const roleCategory = this.roleToCategory(agentRole);
      if (scores[roleCategory] !== undefined) {
        scores[roleCategory] += 1;
      }
    }

    // Find highest-scoring category
    let bestCategory = "general";
    let bestScore = 0;

    for (const [name, score] of Object.entries(scores)) {
      if (score > bestScore && this.categories[name]) {
        bestScore = score;
        bestCategory = name;
      }
    }

    // Fallback: if no keywords matched, use "general"
    if (bestScore === 0) {
      bestCategory = "general";
    }

    return bestCategory;
  }

  /**
   * Get config for a named category.
   */
  getCategory(name: string): CategoryConfig | undefined {
    return this.categories[name];
  }

  /**
   * List all categories with their names.
   */
  listCategories(): Array<{ name: string } & CategoryConfig> {
    return Object.entries(this.categories).map(([name, config]) => ({
      name,
      ...config,
    }));
  }

  /**
   * Override or add a category at runtime.
   */
  setCategory(name: string, config: CategoryConfig): void {
    this.categories[name] = config;
  }

  /**
   * Map an agent role string to its default category.
   */
  roleToCategory(role: string): string {
    const lower = role.toLowerCase().trim();
    return ROLE_CATEGORY_MAP[lower] ?? "general";
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Count how many keywords from the list appear in the text.
 * Uses word-boundary-aware matching for single-word keywords and
 * plain substring matching for multi-word phrases.
 */
function countMatches(text: string, keywords: string[]): number {
  let count = 0;
  for (const kw of keywords) {
    if (kw.includes(" ")) {
      // Multi-word phrase: substring match
      if (text.includes(kw)) count++;
    } else {
      // Single word: word-boundary match
      const re = new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i");
      if (re.test(text)) count++;
    }
  }
  return count;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
