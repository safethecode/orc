import type { LogicalConflict, ConflictSeverity } from "../config/types.ts";
import type { Store } from "../db/store.ts";
import { eventBus } from "./events.ts";

interface AgentDiff {
  agentName: string;
  taskId: string;
  files: string[];
  summary: string;
}

const CONFLICT_PATTERNS: Array<{
  patternA: RegExp;
  patternB: RegExp;
  description: string;
  severity: ConflictSeverity;
}> = [
  {
    patternA: /\b(jwt|token|stateless)\b/i,
    patternB: /\b(session|cookie|stateful)\b/i,
    description: "Auth strategy conflict: JWT/stateless vs session/stateful",
    severity: "critical",
  },
  {
    patternA: /\b(sql|relational|postgres|mysql)\b/i,
    patternB: /\b(nosql|mongo|dynamo|document)\b/i,
    description: "Database paradigm conflict: relational vs document store",
    severity: "critical",
  },
  {
    patternA: /\b(rest|restful)\b/i,
    patternB: /\b(graphql|grpc)\b/i,
    description: "API paradigm conflict: REST vs GraphQL/gRPC",
    severity: "warning",
  },
  {
    patternA: /\b(monolith|single.?service)\b/i,
    patternB: /\b(micro.?service|distributed)\b/i,
    description: "Architecture conflict: monolith vs microservices",
    severity: "critical",
  },
  {
    patternA: /\b(snake_case)\b/i,
    patternB: /\b(camelCase)\b/i,
    description: "Naming convention conflict: snake_case vs camelCase",
    severity: "info",
  },
  {
    patternA: /\b(npm|yarn)\b/i,
    patternB: /\b(pnpm|bun)\b/i,
    description: "Package manager conflict",
    severity: "warning",
  },
  {
    patternA: /\b(uuid|guid)\b/i,
    patternB: /\b(auto.?increment|serial|sequence)\b/i,
    description: "ID strategy conflict: UUID vs auto-increment",
    severity: "warning",
  },
  {
    patternA: /\b(ssr|server.?side)\b/i,
    patternB: /\b(spa|client.?side|csr)\b/i,
    description: "Rendering strategy conflict: SSR vs SPA/CSR",
    severity: "warning",
  },
];

const MAX_DIFFS = 100;

export class ConflictWatcher {
  private diffs: Map<string, AgentDiff> = new Map();

  constructor(private store: Store) {}

  recordDiff(diff: AgentDiff): void {
    this.diffs.set(diff.agentName, diff);
    // Evict oldest entries if over limit
    if (this.diffs.size > MAX_DIFFS) {
      const first = this.diffs.keys().next().value;
      if (first) this.diffs.delete(first);
    }
  }

  analyze(): LogicalConflict[] {
    const agents = [...this.diffs.values()];
    const conflicts: LogicalConflict[] = [];

    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];

        // Check file overlap
        const overlapping = a.files.filter((f) => b.files.includes(f));

        // Check semantic conflicts in summaries
        for (const pattern of CONFLICT_PATTERNS) {
          const aMatch = pattern.patternA.test(a.summary) && pattern.patternB.test(b.summary);
          const bMatch = pattern.patternB.test(a.summary) && pattern.patternA.test(b.summary);

          if (aMatch || bMatch) {
            const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            const conflict: LogicalConflict = {
              id,
              agentA: a.agentName,
              agentB: b.agentName,
              description: pattern.description,
              severity: pattern.severity,
              files: overlapping,
              detectedAt: new Date().toISOString(),
              resolved: false,
            };
            conflicts.push(conflict);
            this.store.addConflict(conflict);

            eventBus.publish({
              type: "qa:escalate",
              taskId: a.taskId,
              reason: `Logical conflict: ${pattern.description} between ${a.agentName} and ${b.agentName}`,
            });
          }
        }

        // File overlap with different intent is a warning
        if (overlapping.length > 0) {
          const hasExistingConflict = conflicts.some(
            (c) =>
              (c.agentA === a.agentName && c.agentB === b.agentName) ||
              (c.agentA === b.agentName && c.agentB === a.agentName),
          );

          if (!hasExistingConflict) {
            const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            const conflict: LogicalConflict = {
              id,
              agentA: a.agentName,
              agentB: b.agentName,
              description: `File overlap: ${overlapping.join(", ")}`,
              severity: "warning",
              files: overlapping,
              detectedAt: new Date().toISOString(),
              resolved: false,
            };
            conflicts.push(conflict);
            this.store.addConflict(conflict);
          }
        }
      }
    }

    return conflicts;
  }

  buildConflictPrompt(conflict: LogicalConflict): string {
    return `A logical conflict has been detected between agents:

Agent A: ${conflict.agentA}
Agent B: ${conflict.agentB}

Conflict: ${conflict.description}
Severity: ${conflict.severity}
Affected files: ${conflict.files.join(", ") || "none directly"}

Please analyze both agents' work and determine:
1. Which approach is correct for this project?
2. What changes are needed to resolve the conflict?
3. Should one agent's work be reverted?

Respond with a clear decision and action items.`;
  }

  getUnresolved(): LogicalConflict[] {
    return this.store.getUnresolvedConflicts();
  }

  resolve(conflictId: string): void {
    this.store.resolveConflict(conflictId);
  }

  clearDiffs(): void {
    this.diffs.clear();
  }
}
