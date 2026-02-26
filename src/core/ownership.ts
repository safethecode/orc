import type { OwnershipDeclaration, ConflictCheckResult } from "../config/types.ts";
import { Store } from "../db/store.ts";

export class OwnershipManager {
  constructor(private store: Store) {}

  declare(declaration: OwnershipDeclaration): ConflictCheckResult {
    // Check for conflicts before declaring
    const conflicts = this.checkConflicts(declaration);

    if (!conflicts.allowed) {
      return conflicts;
    }

    // No conflicts — register ownership
    this.store.declareOwnership({
      agentName: declaration.agentName,
      taskId: declaration.taskId,
      owns: declaration.owns,
      reads: declaration.reads,
    });

    return conflicts;
  }

  checkConflicts(declaration: OwnershipDeclaration): ConflictCheckResult {
    const conflicts: ConflictCheckResult["conflicts"] = [];
    const allOwnership = this.store.getAllOwnership();

    for (const requestedPattern of declaration.owns) {
      // Check if any other agent already owns an overlapping pattern
      for (const existing of allOwnership) {
        if (existing.agentName === declaration.agentName) continue;
        if (existing.permission !== "owns") continue;

        if (patternsOverlap(requestedPattern, existing.pattern)) {
          conflicts.push({
            pattern: existing.pattern,
            heldBy: existing.agentName,
            permission: existing.permission,
          });
        }
      }
    }

    return {
      allowed: conflicts.length === 0,
      conflicts,
    };
  }

  release(agentName: string, taskId?: string): void {
    this.store.revokeOwnership(agentName, taskId);
  }

  getAgentTerritory(agentName: string): { owns: string[]; reads: string[] } {
    const ownership = this.store.getOwnership(agentName);
    return {
      owns: ownership.filter(o => o.permission === "owns").map(o => o.pattern),
      reads: ownership.filter(o => o.permission === "reads").map(o => o.pattern),
    };
  }

  formatReport(): string {
    const all = this.store.getAllOwnership();
    if (all.length === 0) return "No ownership declarations.";

    const byAgent = new Map<string, typeof all>();
    for (const entry of all) {
      const list = byAgent.get(entry.agentName) ?? [];
      list.push(entry);
      byAgent.set(entry.agentName, list);
    }

    const lines: string[] = ["File Ownership Report:", "─".repeat(40)];
    for (const [agent, entries] of byAgent) {
      lines.push(`\n  ${agent}:`);
      for (const e of entries) {
        const icon = e.permission === "owns" ? "✎" : "👁";
        lines.push(`    ${icon} ${e.permission}: ${e.pattern}`);
      }
    }

    return lines.join("\n");
  }
}

// Check if two glob patterns could overlap
// Simple heuristic: check if one pattern is a prefix of the other
// or if they share the same directory base
function patternsOverlap(a: string, b: string): boolean {
  // Exact match
  if (a === b) return true;

  // Normalize: remove trailing /**
  const normA = a.replace(/\/\*\*$/, "");
  const normB = b.replace(/\/\*\*$/, "");

  // One contains the other
  if (normA.startsWith(normB) || normB.startsWith(normA)) return true;

  // Both are specific files and match
  if (!a.includes("*") && !b.includes("*") && a === b) return true;

  return false;
}
