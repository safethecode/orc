import type { PredictionResult } from "../config/types.ts";
import type { MemoryStore } from "../memory/memory-store.ts";
import type { Store } from "../db/store.ts";

const RISK_PATTERNS: Array<{ pattern: RegExp; risk: string; mitigation: string }> = [
  { pattern: /\b(migration|migrate)\b/i, risk: "Data loss during migration", mitigation: "Create backup before migration, test with staging data" },
  { pattern: /\b(auth|authentication|login)\b/i, risk: "Token expiration edge cases", mitigation: "Test with expired tokens, implement refresh flow" },
  { pattern: /\b(deploy|production|release)\b/i, risk: "Deployment rollback needed", mitigation: "Ensure rollback plan, blue-green deployment" },
  { pattern: /\b(refactor|rewrite)\b/i, risk: "Regression in existing functionality", mitigation: "Run full test suite, add tests before refactoring" },
  { pattern: /\b(concurrent|parallel|async)\b/i, risk: "Race conditions", mitigation: "Use proper locking, test concurrent scenarios" },
  { pattern: /\b(cache|caching)\b/i, risk: "Cache invalidation issues", mitigation: "Define clear invalidation strategy, add TTL" },
  { pattern: /\b(api|endpoint)\b/i, risk: "Breaking API changes", mitigation: "Version the API, maintain backwards compatibility" },
  { pattern: /\b(database|schema|table)\b/i, risk: "Schema migration failures", mitigation: "Test migrations up and down, use transactions" },
  { pattern: /\b(security|permission|access)\b/i, risk: "Authorization bypass", mitigation: "Audit access controls, add integration tests" },
  { pattern: /\b(performance|optimize)\b/i, risk: "Premature optimization", mitigation: "Profile first, benchmark before and after" },
];

export class TaskPredictor {
  constructor(
    private memory: MemoryStore,
    private store: Store,
  ) {}

  async predict(prompt: string): Promise<PredictionResult> {
    const matchedRisks = this.matchPatterns(prompt);
    const checklist = this.buildChecklist(prompt, matchedRisks);

    // Search past similar tasks
    const pastMemories = this.memory.getRelevantMemories(prompt, undefined, 3);
    const pastFailures = pastMemories.filter((m) =>
      m.value.toLowerCase().includes("fail") || m.value.toLowerCase().includes("error"),
    );

    if (pastFailures.length > 0) {
      matchedRisks.push({
        description: "Similar past tasks had failures",
        likelihood: "medium" as const,
        mitigation: `Review past issues: ${pastFailures.map((m) => m.key).join(", ")}`,
      });
    }

    const estimatedDuration =
      matchedRisks.length > 3 ? "long" :
      matchedRisks.length > 1 ? "medium" : "short";

    return {
      risks: matchedRisks,
      checklist,
      estimatedDuration,
      suggestedApproach: matchedRisks.length > 3
        ? "Break into smaller subtasks, tackle high-risk areas first"
        : "Direct implementation with incremental testing",
    };
  }

  private matchPatterns(prompt: string): Array<{ description: string; likelihood: "low" | "medium" | "high"; mitigation: string }> {
    const risks: Array<{ description: string; likelihood: "low" | "medium" | "high"; mitigation: string }> = [];
    for (const { pattern, risk, mitigation } of RISK_PATTERNS) {
      if (pattern.test(prompt)) {
        risks.push({ description: risk, likelihood: "medium", mitigation });
      }
    }
    return risks;
  }

  private buildChecklist(prompt: string, risks: Array<{ description: string; mitigation: string }>): string[] {
    const checklist: string[] = ["Verify requirements are clear before starting"];

    for (const risk of risks) {
      checklist.push(risk.mitigation);
    }

    if (/\b(test|spec)\b/i.test(prompt)) {
      checklist.push("Run existing test suite before changes");
    }
    checklist.push("Review changes before committing");

    return checklist;
  }

  formatForPrompt(prediction: PredictionResult): string {
    const riskLines = prediction.risks.map((r) =>
      `- [${r.likelihood}] ${r.description} → ${r.mitigation}`
    ).join("\n");

    const checklistLines = prediction.checklist.map((c) => `- [ ] ${c}`).join("\n");

    return `Predicted risks:\n${riskLines || "None identified"}\n\nChecklist:\n${checklistLines}`;
  }
}
