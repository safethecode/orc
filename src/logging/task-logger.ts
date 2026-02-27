import type { ToolLogEntry, LogPhase } from "../config/types.ts";

export class TaskLogger {
  private entries: Map<string, ToolLogEntry[]> = new Map();

  toolStart(taskId: string, tool: string, detail?: string, phase: LogPhase = "general"): void {
    if (!this.entries.has(taskId)) {
      this.entries.set(taskId, []);
    }
    this.entries.get(taskId)!.push({
      tool,
      detail,
      phase,
      startedAt: new Date().toISOString(),
    });
  }

  toolEnd(taskId: string, tool: string, success: boolean, detail?: string): void {
    const entries = this.entries.get(taskId);
    if (!entries) return;

    // Find last matching entry without endedAt
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].tool === tool && !entries[i].endedAt) {
        const endedAt = new Date().toISOString();
        entries[i].endedAt = endedAt;
        entries[i].success = success;
        entries[i].durationMs = new Date(endedAt).getTime() - new Date(entries[i].startedAt).getTime();
        if (detail) entries[i].detail = detail;
        break;
      }
    }
  }

  getLog(taskId: string): ToolLogEntry[] {
    return this.entries.get(taskId) ?? [];
  }

  getSummary(taskId: string): {
    totalTools: number;
    successRate: number;
    byPhase: Record<LogPhase, number>;
    totalDurationMs: number;
  } {
    const entries = this.entries.get(taskId) ?? [];
    const completed = entries.filter((e) => e.success != null);
    const successful = completed.filter((e) => e.success);

    const byPhase: Record<LogPhase, number> = {
      spec: 0, planning: 0, coding: 0, review: 0, qa: 0, fix: 0, general: 0,
    };
    for (const e of entries) {
      byPhase[e.phase]++;
    }

    const totalDurationMs = entries.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);

    return {
      totalTools: entries.length,
      successRate: completed.length > 0 ? successful.length / completed.length : 0,
      byPhase,
      totalDurationMs,
    };
  }

  formatTimeline(taskId: string): string {
    const entries = this.entries.get(taskId) ?? [];
    if (entries.length === 0) return "No tool usage recorded.";

    return entries.map((e) => {
      const status = e.success == null ? "..." : e.success ? "OK" : "FAIL";
      const duration = e.durationMs ? ` (${e.durationMs}ms)` : "";
      return `[${e.phase}] ${e.tool} → ${status}${duration}`;
    }).join("\n");
  }
}
