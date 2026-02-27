import type { Database } from "bun:sqlite";
import type { ArchitecturalDecision, DecisionStatus } from "../config/types.ts";
import { Store } from "../db/store.ts";

export class DecisionRegistry {
  constructor(private store: Store) {}

  record(params: {
    title: string;
    decision: string;
    context: string;
    decidedBy: string;
    tags?: string[];
  }): ArchitecturalDecision {
    const id = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const entry: ArchitecturalDecision = {
      id,
      title: params.title,
      decision: params.decision,
      context: params.context,
      decidedBy: params.decidedBy,
      status: "active",
      tags: params.tags ?? [],
      createdAt: new Date().toISOString(),
    };
    this.store.addDecision(entry);
    return entry;
  }

  supersede(oldId: string, params: {
    title: string;
    decision: string;
    context: string;
    decidedBy: string;
    tags?: string[];
  }): ArchitecturalDecision {
    const newDecision = this.record(params);
    this.store.supersedeDecision(oldId, newDecision.id);
    return newDecision;
  }

  revoke(id: string): void {
    const decision = this.store.getDecision(id);
    if (decision) {
      this.store.addDecision({ ...decision, status: "revoked" });
    }
  }

  get(id: string): ArchitecturalDecision | null {
    return this.store.getDecision(id);
  }

  listActive(): ArchitecturalDecision[] {
    return this.store.listDecisions("active");
  }

  search(query: string): ArchitecturalDecision[] {
    return this.store.searchDecisions(query);
  }

  findByTag(tag: string): ArchitecturalDecision[] {
    return this.listActive().filter((d) => d.tags.includes(tag));
  }

  getRelevantDecisions(prompt: string): ArchitecturalDecision[] {
    const keywords = prompt
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 10);

    if (keywords.length === 0) return [];

    const all = this.listActive();
    const scored = all.map((d) => {
      const text = `${d.title} ${d.decision} ${d.tags.join(" ")}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) score++;
      }
      return { decision: d, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((s) => s.decision);
  }

  formatForPrompt(decisions: ArchitecturalDecision[]): string {
    if (decisions.length === 0) return "";
    const lines = decisions.map((d) =>
      `- [${d.id}] ${d.title}: ${d.decision} (by ${d.decidedBy}, tags: ${d.tags.join(", ") || "none"})`,
    );
    return `\nArchitectural decisions in effect:\n${lines.join("\n")}\n`;
  }
}
