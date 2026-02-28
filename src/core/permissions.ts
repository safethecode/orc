export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string;       // e.g. "bash", "edit", "read", "*"
  pattern: string;    // glob pattern e.g. "git *", "rm *", "*.env"
  action: PermissionAction;
}

export interface PermissionConfig {
  defaults: Record<string, PermissionAction>;  // tool -> default action
  rules: PermissionRule[];
  agentOverrides: Record<string, PermissionRule[]>; // agentName -> rules
}

export class PermissionManager {
  private config: PermissionConfig;
  private sessionOverrides: PermissionRule[] = [];

  constructor(config?: Partial<PermissionConfig>) {
    this.config = {
      defaults: {
        read: "allow", edit: "allow", bash: "ask", glob: "allow",
        grep: "allow", task: "ask", skill: "allow", webfetch: "ask",
        "*": "allow",
      },
      rules: [
        { tool: "read", pattern: "*.env", action: "deny" },
        { tool: "read", pattern: "*.env.*", action: "deny" },
        { tool: "read", pattern: "*.env.example", action: "allow" },
        { tool: "bash", pattern: "git *", action: "allow" },
        { tool: "bash", pattern: "rm *", action: "deny" },
        { tool: "bash", pattern: "rm -rf *", action: "deny" },
        { tool: "edit", pattern: "*.lock", action: "ask" },
      ],
      agentOverrides: {},
      ...config,
    };
  }

  /**
   * Check if action is allowed. Returns the action (allow/ask/deny).
   * Priority: agent overrides > session overrides > config rules > defaults.
   * Among rules at the same level, the most specific pattern wins (longest pattern).
   */
  check(tool: string, input: string, agentName?: string): PermissionAction {
    // 1. Agent overrides (highest priority)
    if (agentName) {
      const agentRules = this.config.agentOverrides[agentName];
      if (agentRules) {
        const match = this.findBestMatch(agentRules, tool, input);
        if (match) return match.action;
      }
    }

    // 2. Session overrides
    if (this.sessionOverrides.length > 0) {
      const match = this.findBestMatch(this.sessionOverrides, tool, input);
      if (match) return match.action;
    }

    // 3. Config rules
    if (this.config.rules.length > 0) {
      const match = this.findBestMatch(this.config.rules, tool, input);
      if (match) return match.action;
    }

    // 4. Defaults
    if (tool in this.config.defaults) {
      return this.config.defaults[tool];
    }
    if ("*" in this.config.defaults) {
      return this.config.defaults["*"];
    }

    return "ask";
  }

  /**
   * Find the best (most specific) matching rule from a list.
   * Specificity is determined by:
   *   - Exact tool match beats wildcard tool
   *   - Longer pattern beats shorter pattern
   */
  private findBestMatch(rules: PermissionRule[], tool: string, input: string): PermissionRule | null {
    let bestRule: PermissionRule | null = null;
    let bestSpecificity = -1;

    for (const rule of rules) {
      // Tool must match: exact match or wildcard
      const toolMatch = rule.tool === tool || rule.tool === "*";
      if (!toolMatch) continue;

      // Pattern must match
      if (!this.matchPattern(rule.pattern, input)) continue;

      // Calculate specificity score
      let specificity = 0;

      // Exact tool match is more specific than wildcard
      if (rule.tool === tool) specificity += 1000;

      // Longer pattern = more specific
      specificity += rule.pattern.length;

      // Patterns without wildcards are more specific
      if (!rule.pattern.includes("*") && !rule.pattern.includes("?")) {
        specificity += 500;
      }

      if (specificity > bestSpecificity) {
        bestSpecificity = specificity;
        bestRule = rule;
      }
    }

    return bestRule;
  }

  /**
   * Simple glob matching: * = any sequence of chars, ? = single char.
   * Supports patterns like "git *", "*.env", "rm -rf *", "*.env.example".
   */
  private matchPattern(pattern: string, input: string): boolean {
    // Convert glob to regex
    let regexStr = "^";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "*") {
        regexStr += ".*";
      } else if (ch === "?") {
        regexStr += ".";
      } else if (".+^${}()|[]\\".includes(ch)) {
        regexStr += "\\" + ch;
      } else {
        regexStr += ch;
      }
    }
    regexStr += "$";

    try {
      return new RegExp(regexStr).test(input);
    } catch {
      return false;
    }
  }

  /** Add session-level override (e.g. user approved "always" for a pattern) */
  addSessionOverride(rule: PermissionRule): void {
    this.sessionOverrides.push(rule);
  }

  /** Get all rules for a tool (from all sources: config + session + agent) */
  getRulesForTool(tool: string): PermissionRule[] {
    const results: PermissionRule[] = [];

    for (const rule of this.config.rules) {
      if (rule.tool === tool || rule.tool === "*") results.push(rule);
    }
    for (const rule of this.sessionOverrides) {
      if (rule.tool === tool || rule.tool === "*") results.push(rule);
    }
    for (const agentRules of Object.values(this.config.agentOverrides)) {
      for (const rule of agentRules) {
        if (rule.tool === tool || rule.tool === "*") results.push(rule);
      }
    }

    return results;
  }

  /** Get the effective config (read-only snapshot) */
  getConfig(): PermissionConfig {
    return {
      defaults: { ...this.config.defaults },
      rules: [...this.config.rules],
      agentOverrides: { ...this.config.agentOverrides },
    };
  }

  /** Get merged rules for a specific agent: agent overrides + config rules */
  getAgentRules(agentName: string): PermissionRule[] {
    const agentSpecific = this.config.agentOverrides[agentName] ?? [];
    return [...agentSpecific, ...this.config.rules];
  }
}
