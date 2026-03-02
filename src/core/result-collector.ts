import type {
  CollectedResult,
  AggregatedResult,
  WorkerState,
  ProviderName,
  AgentRole,
  SiblingResult,
} from "../config/types.ts";
import { eventBus } from "./events.ts";

export class ResultCollector {
  private results: Map<string, CollectedResult> = new Map(); // subtaskId -> result
  private taskId: string;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  collect(worker: WorkerState, role?: AgentRole, domain?: string): CollectedResult | null {
    if (worker.status !== "completed" || !worker.result) return null;

    const durationMs = worker.lastActivityAt && worker.startedAt
      ? new Date(worker.lastActivityAt).getTime() - new Date(worker.startedAt).getTime()
      : 0;

    const result: CollectedResult = {
      subtaskId: worker.subtaskId,
      agentName: worker.agentName,
      provider: worker.provider,
      result: worker.result,
      files: this.extractFiles(worker.result),
      tokenUsage: worker.tokenUsage,
      costUsd: worker.costUsd,
      durationMs,
      role: role ?? "coder",
      domain: domain ?? "general",
    };

    this.results.set(worker.subtaskId, result);

    eventBus.publish({
      type: "result:collected",
      taskId: this.taskId,
      subtaskId: worker.subtaskId,
      success: true,
    });

    return result;
  }

  aggregate(): AggregatedResult {
    const subtaskResults = [...this.results.values()];
    const conflicts = this.detectConflicts(subtaskResults);

    const totalTokens = subtaskResults.reduce((sum, r) => sum + r.tokenUsage, 0);
    const totalCost = subtaskResults.reduce((sum, r) => sum + r.costUsd, 0);
    const totalDurationMs = subtaskResults.reduce((max, r) => Math.max(max, r.durationMs), 0);

    const mergedOutput = this.mergeResults(subtaskResults);

    const aggregated: AggregatedResult = {
      taskId: this.taskId,
      subtaskResults,
      mergedOutput,
      totalTokens,
      totalCost,
      totalDurationMs,
      conflicts,
      success: subtaskResults.length > 0 && conflicts.length === 0,
    };

    eventBus.publish({
      type: "result:merged",
      taskId: this.taskId,
      totalSubtasks: subtaskResults.length,
      conflicts: conflicts.length,
    });

    return aggregated;
  }

  getResult(subtaskId: string): CollectedResult | undefined {
    return this.results.get(subtaskId);
  }

  getAllResults(): CollectedResult[] {
    return [...this.results.values()];
  }

  getCollectedCount(): number {
    return this.results.size;
  }

  getByProvider(provider: ProviderName): CollectedResult[] {
    return [...this.results.values()].filter(r => r.provider === provider);
  }

  getCostByProvider(): Map<ProviderName, { tokens: number; cost: number }> {
    const map = new Map<ProviderName, { tokens: number; cost: number }>();
    for (const r of this.results.values()) {
      const existing = map.get(r.provider) ?? { tokens: 0, cost: 0 };
      existing.tokens += r.tokenUsage;
      existing.cost += r.costUsd;
      map.set(r.provider, existing);
    }
    return map;
  }

  collectIntermediate(workerId: string, subtaskId: string, output: string): void {
    const existing = this.results.get(subtaskId);
    if (existing) {
      existing.result += "\n---\n" + output;
    }
  }

  getSummaryForPropagation(): SiblingResult[] {
    return [...this.results.values()].map(r => ({
      agentName: r.agentName,
      subtaskId: r.subtaskId,
      role: r.role ?? "coder" as AgentRole,
      domain: r.domain ?? "general",
      summary: r.result,
      filesChanged: r.files,
      apisCreated: this.extractApis(r.result),
      schemasCreated: this.extractSchemas(r.result),
    }));
  }

  extractApis(result: string): string[] {
    const apis: string[] = [];
    const patterns = [
      /(?:GET|POST|PUT|DELETE|PATCH)\s+\/[a-zA-Z0-9_/:.{}-]+/gi,
      /(?:app|router)\.\s*(?:get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(result)) !== null) {
        const api = match[1] ?? match[0].trim();
        if (!apis.includes(api)) apis.push(api);
      }
    }
    return apis;
  }

  extractSchemas(result: string): string[] {
    const schemas: string[] = [];
    const patterns = [
      /(?:interface|type|class|enum)\s+([A-Z][a-zA-Z0-9_]*)/g,
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(result)) !== null) {
        if (match[1] && !schemas.includes(match[1])) schemas.push(match[1]);
      }
    }
    return schemas;
  }

  clear(): void {
    this.results.clear();
  }

  private extractFiles(result: string): string[] {
    const files: string[] = [];
    // Match common file path patterns in output
    const patterns = [
      /(?:created?|modified?|updated?|wrote|edited)\s+[`"]?([a-zA-Z0-9_/.\\-]+\.[a-zA-Z]{1,10})[`"]?/gi,
      /^[+-]{3}\s+[ab]\/(.+)$/gm,  // git diff paths
      /File:\s*(.+\.[a-zA-Z]{1,10})/gm,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(result)) !== null) {
        const file = match[1].trim();
        if (file && !files.includes(file)) {
          files.push(file);
        }
      }
    }

    return files;
  }

  private detectConflicts(results: CollectedResult[]): string[] {
    const conflicts: string[] = [];
    const fileOwners = new Map<string, string[]>(); // file -> subtaskIds

    for (const result of results) {
      for (const file of result.files) {
        const owners = fileOwners.get(file) ?? [];
        owners.push(result.subtaskId);
        fileOwners.set(file, owners);
      }
    }

    for (const [file, owners] of fileOwners) {
      if (owners.length > 1) {
        conflicts.push(`File conflict: "${file}" modified by subtasks ${owners.join(", ")}`);
      }
    }

    return conflicts;
  }

  private mergeResults(results: CollectedResult[]): string {
    if (results.length === 0) return "";
    if (results.length === 1) return results[0].result;

    const sections = results.map((r, i) => {
      const header = `## Subtask ${i + 1}: ${r.subtaskId} (${r.provider}/${r.agentName})`;
      return `${header}\n\n${r.result}`;
    });

    return sections.join("\n\n---\n\n");
  }
}
