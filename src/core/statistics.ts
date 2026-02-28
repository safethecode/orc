// ── Statistics & Cost Tracking ──────────────────────────────────────
// Aggregated per-session and per-project usage statistics.
// Persists to ~/.orchestrator/stats.jsonl in append-only JSONL format.

import { homedir } from "node:os";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

export interface TurnStats {
  timestamp: string;
  sessionId: string;
  agentName: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  toolsUsed: string[];
}

export interface SessionStats {
  sessionId: string;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  toolUsage: Record<string, number>;   // tool name -> count
  modelUsage: Record<string, number>;  // model -> turn count
  startedAt: string;
}

export interface ProjectStats {
  totalSessions: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  costPerDay: Record<string, number>;  // "2025-01-15" -> cost
  topModels: Array<{ model: string; turns: number; cost: number }>;
  topTools: Array<{ tool: string; count: number }>;
}

export class StatisticsTracker {
  private currentSession: TurnStats[] = [];
  private sessionId: string;
  private storePath: string;

  constructor(sessionId?: string, storePath?: string) {
    this.sessionId = sessionId ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.storePath = storePath ?? `${homedir()}/.orchestrator/stats.jsonl`;
  }

  /** Record a turn's statistics (auto-fills timestamp and sessionId, persists to disk) */
  recordTurn(stats: Omit<TurnStats, "timestamp" | "sessionId">): void {
    const turn: TurnStats = {
      ...stats,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    };

    this.currentSession.push(turn);

    // Fire-and-forget persist — don't block the caller
    this.persistTurn(turn).catch(() => {
      // Silently ignore write errors
    });
  }

  /** Get current session stats */
  getSessionStats(): SessionStats {
    const toolUsage: Record<string, number> = {};
    const modelUsage: Record<string, number> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    let totalDurationMs = 0;

    for (const turn of this.currentSession) {
      totalInputTokens += turn.inputTokens;
      totalOutputTokens += turn.outputTokens;
      totalCostUsd += turn.costUsd;
      totalDurationMs += turn.durationMs;

      modelUsage[turn.model] = (modelUsage[turn.model] ?? 0) + 1;

      for (const tool of turn.toolsUsed) {
        toolUsage[tool] = (toolUsage[tool] ?? 0) + 1;
      }
    }

    return {
      sessionId: this.sessionId,
      turnCount: this.currentSession.length,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd: round4(totalCostUsd),
      totalDurationMs,
      toolUsage,
      modelUsage,
      startedAt: this.currentSession[0]?.timestamp ?? new Date().toISOString(),
    };
  }

  /** Get project-wide stats (across all sessions), optionally filtered by recent N days */
  async getProjectStats(days?: number): Promise<ProjectStats> {
    const allTurns = await this.loadAll();

    // Merge in-memory turns that may not be on disk yet
    const onDiskIds = new Set(allTurns.map((t) => `${t.sessionId}:${t.timestamp}`));
    for (const turn of this.currentSession) {
      const key = `${turn.sessionId}:${turn.timestamp}`;
      if (!onDiskIds.has(key)) {
        allTurns.push(turn);
      }
    }

    // Filter by date range
    let filtered = allTurns;
    if (days !== undefined && days > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffIso = cutoff.toISOString();
      filtered = allTurns.filter((t) => t.timestamp >= cutoffIso);
    }

    // Aggregate
    const sessions = new Set<string>();
    const costPerDay: Record<string, number> = {};
    const modelAgg: Record<string, { turns: number; cost: number }> = {};
    const toolAgg: Record<string, number> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    for (const turn of filtered) {
      sessions.add(turn.sessionId);
      totalInputTokens += turn.inputTokens;
      totalOutputTokens += turn.outputTokens;
      totalCostUsd += turn.costUsd;

      // Cost per day
      const day = turn.timestamp.slice(0, 10); // "YYYY-MM-DD"
      costPerDay[day] = (costPerDay[day] ?? 0) + turn.costUsd;

      // Model aggregation
      if (!modelAgg[turn.model]) {
        modelAgg[turn.model] = { turns: 0, cost: 0 };
      }
      modelAgg[turn.model].turns++;
      modelAgg[turn.model].cost += turn.costUsd;

      // Tool aggregation
      for (const tool of turn.toolsUsed) {
        toolAgg[tool] = (toolAgg[tool] ?? 0) + 1;
      }
    }

    // Round cost-per-day values
    for (const day of Object.keys(costPerDay)) {
      costPerDay[day] = round4(costPerDay[day]);
    }

    // Sort models by turn count descending
    const topModels = Object.entries(modelAgg)
      .map(([model, data]) => ({ model, turns: data.turns, cost: round4(data.cost) }))
      .sort((a, b) => b.turns - a.turns);

    // Sort tools by count descending
    const topTools = Object.entries(toolAgg)
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalSessions: sessions.size,
      totalTurns: filtered.length,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd: round4(totalCostUsd),
      costPerDay,
      topModels,
      topTools,
    };
  }

  /** Get top N models by usage from current session */
  getTopModels(n = 5): Array<{ model: string; turns: number; cost: number }> {
    const agg: Record<string, { turns: number; cost: number }> = {};

    for (const turn of this.currentSession) {
      if (!agg[turn.model]) {
        agg[turn.model] = { turns: 0, cost: 0 };
      }
      agg[turn.model].turns++;
      agg[turn.model].cost += turn.costUsd;
    }

    return Object.entries(agg)
      .map(([model, data]) => ({ model, turns: data.turns, cost: round4(data.cost) }))
      .sort((a, b) => b.turns - a.turns)
      .slice(0, n);
  }

  /** Get top N tools by usage from current session */
  getTopTools(n = 5): Array<{ tool: string; count: number }> {
    const agg: Record<string, number> = {};

    for (const turn of this.currentSession) {
      for (const tool of turn.toolsUsed) {
        agg[tool] = (agg[tool] ?? 0) + 1;
      }
    }

    return Object.entries(agg)
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
  }

  /** Format current session stats as a compact one-line summary */
  formatSessionStats(): string {
    const stats = this.getSessionStats();
    const tokens = formatTokenCount(stats.totalInputTokens + stats.totalOutputTokens);
    const duration = formatDuration(stats.totalDurationMs);
    return `Session: ${stats.turnCount} turns | $${stats.totalCostUsd.toFixed(2)} | ${tokens} tokens | ${duration}`;
  }

  /** Format project-wide stats as a multi-line report */
  formatProjectStats(stats: ProjectStats): string {
    const lines: string[] = [];

    lines.push(`Project Stats: ${stats.totalSessions} sessions, ${stats.totalTurns} turns`);
    lines.push(`  Total cost: $${stats.totalCostUsd.toFixed(2)}`);
    lines.push(`  Tokens: ${formatTokenCount(stats.totalInputTokens)} in / ${formatTokenCount(stats.totalOutputTokens)} out`);

    // Cost per day (last 7 days, bar chart)
    const days = Object.entries(stats.costPerDay).sort((a, b) => a[0].localeCompare(b[0]));
    if (days.length > 0) {
      lines.push("");
      lines.push("  Daily cost:");
      const maxCost = Math.max(...days.map(([, c]) => c));
      const barWidth = 20;
      for (const [day, cost] of days.slice(-14)) {
        const barLen = maxCost > 0 ? Math.round((cost / maxCost) * barWidth) : 0;
        const bar = "\u2588".repeat(barLen) + "\u2591".repeat(barWidth - barLen);
        lines.push(`    ${day}  ${bar}  $${cost.toFixed(2)}`);
      }
    }

    // Top models
    if (stats.topModels.length > 0) {
      lines.push("");
      lines.push("  Top models:");
      for (const m of stats.topModels.slice(0, 5)) {
        lines.push(`    ${m.model}: ${m.turns} turns, $${m.cost.toFixed(2)}`);
      }
    }

    // Top tools
    if (stats.topTools.length > 0) {
      lines.push("");
      lines.push("  Top tools:");
      for (const t of stats.topTools.slice(0, 5)) {
        lines.push(`    ${t.tool}: ${t.count} uses`);
      }
    }

    return lines.join("\n");
  }

  /** Start a new session (resets in-memory turns) */
  newSession(sessionId?: string): void {
    this.currentSession = [];
    this.sessionId = sessionId ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Persist a single turn to disk (append to JSONL) */
  private async persistTurn(turn: TurnStats): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });

    const line = JSON.stringify(turn) + "\n";
    const file = Bun.file(this.storePath);

    if (await file.exists()) {
      // Append by reading existing content and rewriting
      const existing = await file.text();
      await Bun.write(this.storePath, existing + line);
    } else {
      await Bun.write(this.storePath, line);
    }
  }

  /** Load all turns from disk (JSONL format) */
  private async loadAll(): Promise<TurnStats[]> {
    const file = Bun.file(this.storePath);
    if (!(await file.exists())) return [];

    try {
      const text = await file.text();
      const turns: TurnStats[] = [];

      for (const raw of text.trim().split("\n")) {
        if (!raw.trim()) continue;
        try {
          turns.push(JSON.parse(raw) as TurnStats);
        } catch {
          // Skip corrupted lines
        }
      }

      return turns;
    } catch {
      return [];
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Round to 4 decimal places (sub-cent precision for cost tracking) */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Format token count with K/M suffix */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

/** Format duration in ms to human-readable string */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m${remainingSeconds}s`;
}
