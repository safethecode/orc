// ── IntentGate Protocol ──────────────────────────────────────────────
// Step 0 intent classification before routing.
// Maps surface request to true intent, complexity, and agent suggestions.

export interface IntentClassification {
  surfaceRequest: string;        // What the user literally said
  trueIntent: string;            // What they actually want
  category: string;              // maps to CategoryRouter category
  complexity: "trivial" | "simple" | "moderate" | "complex";
  requiresMultiAgent: boolean;
  suggestedAgentRoles: string[];
  confidence: number;            // 0-1
}

// ── Pattern Definitions ─────────────────────────────────────────────

const GREETING_PATTERNS = [
  /^\s*(hi|hello|hey|yo|sup|howdy|greetings|good\s+(morning|afternoon|evening|day))\s*[!?.]*\s*$/i,
  /^\s*(thanks?(\s+you)?|ty|cheers|thx)\s*[!?.]*\s*$/i,
  /^\s*(ping|test|status)\s*[!?.]*\s*$/i,
  /^\s*how\s+are\s+you\s*[?!.]*\s*$/i,
  /^\s*what('s|\s+is)\s+up\s*[?!.]*\s*$/i,
];

const CHITCHAT_PATTERNS = [
  ...GREETING_PATTERNS,
  /^\s*(ok|okay|sure|got\s+it|understood|cool|nice|great|awesome)\s*[!?.]*\s*$/i,
  /^\s*(yes|no|yep|nope|yeah|nah)\s*[!?.]*\s*$/i,
];

const COMMAND_PATTERN = /^\s*\//;

const CODE_QUESTION_PATTERNS = [
  /\b(what|how|why|where|when|explain|describe|show)\b.*\b(code|function|file|class|module|variable|type|interface|import|export|error|bug|issue)\b/i,
  /\b(code|function|file|class|module|variable|type|interface)\b.*\b(what|how|why|where|does|is|mean|work)\b/i,
  /\bwhat\s+(does|is)\b/i,
  /\bhow\s+(does|do|to|can)\b/i,
  /\bwhy\s+(does|is|do)\b/i,
  /\bexplain\b/i,
];

const ADD_FEATURE_PATTERNS = [
  /\b(add|implement|create|build|make|write|introduce)\b.*\b(feature|function|endpoint|component|page|route|handler|middleware|hook|util)\b/i,
  /\b(add|implement|create|build|make|write)\s+(?:a\s+)?(?:new\s+)?\w+/i,
];

const REFACTOR_PATTERNS = [
  /\b(refactor|rewrite|restructure|reorganize|overhaul|redesign)\s+(entire|whole|all|the\s+entire|the\s+whole)\b/i,
  /\b(refactor|rewrite|restructure|reorganize)\b.*\b(system|module|codebase|architecture|layer)\b/i,
  /\bmigrate\s+(from|to|the)\b/i,
  /\b(complete|full)\s+(rewrite|overhaul|refactor|restructure)\b/i,
];

const BUILD_FROM_SCRATCH_PATTERNS = [
  /\b(build|create|implement|develop|make)\b.*\b(from\s+scratch|from\s+the\s+ground\s+up)\b/i,
  /\b(build|create|implement|develop)\b.*\bwith\b.*\band\b/i,
  /\b(full[- ]stack|end[- ]to[- ]end|complete\s+application)\b/i,
];

const REVIEW_PATTERNS = [
  /\b(review|audit|analyze|inspect|check|evaluate|assess)\b.*\b(code|pr|pull\s+request|commit|change|implementation|security|performance)\b/i,
  /\b(code\s+review|security\s+audit|performance\s+analysis)\b/i,
];

const PLANNING_PATTERNS = [
  /\b(plan|design|architect|propose|draft|outline)\b.*\b(system|architecture|approach|solution|strategy|implementation)\b/i,
  /\b(rfc|adr|technical\s+design|system\s+design)\b/i,
];

const TESTING_PATTERNS = [
  /\b(write|add|create|implement)\b.*\b(test|spec|coverage)\b/i,
  /\b(unit\s+test|e2e|integration\s+test|test\s+suite)\b/i,
];

const DOC_PATTERNS = [
  /\b(write|update|create|add)\b.*\b(doc|documentation|readme|guide|tutorial|changelog)\b/i,
  /\b(document|jsdoc|api\s+doc)\b/i,
];

const VISUAL_PATTERNS = [
  /\b(style|css|tailwind|ui|ux|design|layout|responsive|animation|theme)\b/i,
  /\b(dark\s+mode|light\s+mode|color\s+scheme)\b/i,
];

// ── Multi-agent Signals ─────────────────────────────────────────────

const MULTI_AGENT_SIGNALS = [
  /\b(and\s+then|after\s+that|followed\s+by|once\s+done)\b/i,
  /\b(review\s+after|test\s+after|then\s+review|then\s+test)\b/i,
  /\bwith\b.*\band\b.*\band\b/i,               // "with X and Y and Z"
  /\b(multiple|several)\s+(steps|phases|stages)\b/i,
  /\b(front\s*end|backend|database|auth|api)\b.*\b(front\s*end|backend|database|auth|api)\b/i, // 2+ domains
];

// ── IntentGate Class ────────────────────────────────────────────────

export class IntentGate {
  /**
   * Classify user intent from their input.
   */
  classify(input: string): IntentClassification {
    const trimmed = input.trim();

    // Command check
    if (this.isCommand(trimmed)) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "Execute CLI command",
        category: "quick",
        complexity: "trivial",
        requiresMultiAgent: false,
        suggestedAgentRoles: [],
        confidence: 1.0,
      };
    }

    // Chitchat / greeting
    if (this.isChitchat(trimmed)) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "Casual conversation or acknowledgment",
        category: "quick",
        complexity: "trivial",
        requiresMultiAgent: false,
        suggestedAgentRoles: [],
        confidence: 0.95,
      };
    }

    // Build from scratch (check before add-feature since it's more specific)
    if (BUILD_FROM_SCRATCH_PATTERNS.some((p) => p.test(trimmed))) {
      const roles = inferBuildRoles(trimmed);
      return {
        surfaceRequest: trimmed,
        trueIntent: "Build a new system or application with multiple components",
        category: "deep",
        complexity: "complex",
        requiresMultiAgent: true,
        suggestedAgentRoles: roles,
        confidence: 0.80,
      };
    }

    // Refactor entire system
    if (REFACTOR_PATTERNS.some((p) => p.test(trimmed))) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "Large-scale refactoring or rewrite of existing system",
        category: "deep",
        complexity: "complex",
        requiresMultiAgent: true,
        suggestedAgentRoles: ["architect", "coder", "reviewer"],
        confidence: 0.80,
      };
    }

    // Planning / architecture
    if (PLANNING_PATTERNS.some((p) => p.test(trimmed))) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "Create technical plan or architectural design",
        category: "planning",
        complexity: "moderate",
        requiresMultiAgent: false,
        suggestedAgentRoles: ["architect"],
        confidence: 0.80,
      };
    }

    // Code review / audit
    if (REVIEW_PATTERNS.some((p) => p.test(trimmed))) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "Analyze or review existing code for quality, security, or correctness",
        category: "review",
        complexity: "simple",
        requiresMultiAgent: false,
        suggestedAgentRoles: ["reviewer"],
        confidence: 0.85,
      };
    }

    // Test writing
    if (TESTING_PATTERNS.some((p) => p.test(trimmed))) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "Write or improve tests",
        category: "testing",
        complexity: "simple",
        requiresMultiAgent: false,
        suggestedAgentRoles: ["tester"],
        confidence: 0.85,
      };
    }

    // Documentation
    if (DOC_PATTERNS.some((p) => p.test(trimmed))) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "Write or update documentation",
        category: "writing",
        complexity: "simple",
        requiresMultiAgent: false,
        suggestedAgentRoles: ["spec-writer"],
        confidence: 0.85,
      };
    }

    // Visual / UI work
    if (VISUAL_PATTERNS.some((p) => p.test(trimmed))) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "Implement visual or UI changes",
        category: "visual",
        complexity: "moderate",
        requiresMultiAgent: false,
        suggestedAgentRoles: ["coder"],
        confidence: 0.75,
      };
    }

    // Add feature (moderate)
    if (ADD_FEATURE_PATTERNS.some((p) => p.test(trimmed))) {
      const multiAgent = hasMultiAgentSignals(trimmed);
      const roles = multiAgent ? ["coder", "tester"] : ["coder"];
      return {
        surfaceRequest: trimmed,
        trueIntent: "Implement a new feature or functionality",
        category: "general",
        complexity: "moderate",
        requiresMultiAgent: multiAgent,
        suggestedAgentRoles: roles,
        confidence: 0.75,
      };
    }

    // Question about code
    if (CODE_QUESTION_PATTERNS.some((p) => p.test(trimmed))) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "Understand or get information about existing code",
        category: "review",
        complexity: "simple",
        requiresMultiAgent: false,
        suggestedAgentRoles: ["reviewer"],
        confidence: 0.70,
      };
    }

    // Fallback: assess by length and multi-agent signals
    const wordCount = trimmed.split(/\s+/).length;
    const multiAgent = hasMultiAgentSignals(trimmed);

    if (wordCount <= 8 && !multiAgent) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "General development request",
        category: "general",
        complexity: "simple",
        requiresMultiAgent: false,
        suggestedAgentRoles: ["coder"],
        confidence: 0.50,
      };
    }

    if (multiAgent || wordCount > 80) {
      return {
        surfaceRequest: trimmed,
        trueIntent: "Multi-step development task requiring coordination",
        category: "deep",
        complexity: "complex",
        requiresMultiAgent: true,
        suggestedAgentRoles: ["architect", "coder", "reviewer"],
        confidence: 0.55,
      };
    }

    return {
      surfaceRequest: trimmed,
      trueIntent: "General development request",
      category: "general",
      complexity: "moderate",
      requiresMultiAgent: false,
      suggestedAgentRoles: ["coder"],
      confidence: 0.50,
    };
  }

  /**
   * Build an intent summary for injection into agent system prompt.
   */
  formatForPrompt(intent: IntentClassification): string {
    const multiAgentStr = intent.requiresMultiAgent ? "yes" : "no";
    const rolesStr = intent.suggestedAgentRoles.length > 0
      ? intent.suggestedAgentRoles.join(", ")
      : "none";

    return [
      "[Intent Analysis]",
      `Surface: ${intent.surfaceRequest}`,
      `True Intent: ${intent.trueIntent}`,
      `Category: ${intent.category} | Complexity: ${intent.complexity}`,
      `Multi-agent: ${multiAgentStr} | Roles: ${rolesStr}`,
    ].join("\n");
  }

  /**
   * Quick check: is this a simple greeting/chitchat?
   */
  isChitchat(input: string): boolean {
    const trimmed = input.trim();
    return CHITCHAT_PATTERNS.some((p) => p.test(trimmed));
  }

  /**
   * Quick check: is this a command (starts with /)
   */
  isCommand(input: string): boolean {
    return COMMAND_PATTERN.test(input);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function hasMultiAgentSignals(text: string): boolean {
  return MULTI_AGENT_SIGNALS.some((p) => p.test(text));
}

/**
 * Infer which roles are needed for a "build from scratch" request
 * by looking at domain keywords in the prompt.
 */
function inferBuildRoles(text: string): string[] {
  const roles = new Set<string>(["planner", "coder"]);

  if (/\b(test|spec|coverage|qa)\b/i.test(text)) {
    roles.add("tester");
  }
  if (/\b(review|audit|quality)\b/i.test(text)) {
    roles.add("reviewer");
  }
  if (/\b(doc|readme|guide)\b/i.test(text)) {
    roles.add("spec-writer");
  }

  // Default: always include tester for from-scratch builds
  roles.add("tester");

  return [...roles];
}
