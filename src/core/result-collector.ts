import type {
  CollectedResult,
  AggregatedResult,
  WorkerState,
  ProviderName,
} from "../config/types.ts";
import { eventBus } from "./events.ts";

export class ResultCollector {
  private results: Map<string, CollectedResult> = new Map(); // subtaskId -> result
  private taskId: string;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  collect(worker: WorkerState): CollectedResult | null {
    if (worker.status !== "completed" || !worker.result) return null;

    const durationMs = worker.lastActivityAt
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
