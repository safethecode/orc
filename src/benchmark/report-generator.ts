// ── Benchmark Report Generator ──────────────────────────────────────
// Generates rich markdown comparison reports from benchmark run data.
// Designed for readability in both terminal and GitHub markdown.

import type {
  BenchmarkTask,
  BenchmarkRun,
  BenchmarkReport,
  ProviderSummary,
  CategorySummary,
  ProviderRanking,
} from "./types.ts";

export class ReportGenerator {
  /**
   * Generate a full markdown benchmark report.
   */
  generate(tasks: BenchmarkTask[], runs: BenchmarkRun[]): string {
    const sections: string[] = [];

    sections.push(this.generateHeader(tasks, runs));
    sections.push(this.generateSummary(runs));
    sections.push(this.generateProviderComparison(runs));
    sections.push(this.generateHarnessImpact(runs));
    sections.push(this.generateCategoryBreakdown(tasks, runs));
    sections.push(this.generateDetailedResults(tasks, runs));
    sections.push(this.generateCostAnalysis(runs));

    return sections.join("\n\n---\n\n");
  }

  /**
   * Build the full report data structure.
   */
  buildReport(tasks: BenchmarkTask[], runs: BenchmarkRun[]): BenchmarkReport {
    const summaries = this.calculateSummaries(runs);
    const rankings = this.calculateRankings(runs);
    const byCategory = this.calculateCategorySummaries(tasks, runs);

    return {
      id: `bench-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      tasks,
      runs,
      summary: {
        byProvider: summaries,
        byCategory,
        rankings,
      },
    };
  }

  // ── Header ──────────────────────────────────────────────────────────

  private generateHeader(tasks: BenchmarkTask[], runs: BenchmarkRun[]): string {
    const providers = new Set(runs.map((r) => r.provider));
    const totalCost = runs.reduce((sum, r) => sum + r.metrics.costUsd, 0);
    const totalDuration = runs.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);

    return `# Orc Benchmark Report

**Date**: ${new Date().toISOString().split("T")[0]}
**Tasks**: ${tasks.length} | **Providers**: ${providers.size} | **Total Runs**: ${runs.length}
**Total Cost**: ${this.formatCost(totalCost)} | **Total Time**: ${this.formatDuration(totalDuration)}`;
  }

  // ── Rankings ────────────────────────────────────────────────────────

  private generateSummary(runs: BenchmarkRun[]): string {
    const rankings = this.calculateRankings(runs);

    if (rankings.length === 0) {
      return "## Rankings\n\nNo completed runs with evaluations.";
    }

    const header = "| Rank | Provider | Model | Harness | Score | Cost | Speed | Efficiency |";
    const divider = "|------|----------|-------|---------|-------|------|-------|------------|";

    const rows = rankings.map((r) => {
      const harness = r.harnessed ? "\u2713 Orc" : "\u2717 Raw";
      return `| ${r.rank} | ${r.provider} | ${r.model} | ${harness} | ${r.score.toFixed(1)} | ${this.formatCost(1 / r.costEfficiency * r.score)} | ${r.speedScore.toFixed(2)}/s | ${Math.round(r.costEfficiency)}/$ |`;
    });

    return `## Rankings

${header}
${divider}
${rows.join("\n")}`;
  }

  // ── Provider Comparison ─────────────────────────────────────────────

  private generateProviderComparison(runs: BenchmarkRun[]): string {
    const summaries = this.calculateSummaries(runs);
    const providers = Object.values(summaries);

    if (providers.length === 0) {
      return "## Provider Comparison\n\nNo data available.";
    }

    const header = "| Provider | Runs | Success | Avg Score | Avg Cost | Avg Time | Avg Tokens |";
    const divider = "|----------|------|---------|-----------|----------|----------|------------|";

    const rows = providers
      .sort((a, b) => b.avgScore - a.avgScore)
      .map((p) => {
        const successPct = `${(p.successRate * 100).toFixed(0)}%`;
        return `| ${p.provider} | ${p.totalRuns} | ${successPct} | ${this.scoreBar(p.avgScore)} | ${this.formatCost(p.avgCostUsd)} | ${this.formatDuration(p.avgDurationMs)} | ${p.avgTokens.toLocaleString()} |`;
      });

    return `## Provider Comparison

${header}
${divider}
${rows.join("\n")}`;
  }

  // ── Harness Impact ──────────────────────────────────────────────────

  private generateHarnessImpact(runs: BenchmarkRun[]): string {
    const providers = [...new Set(runs.map((r) => r.provider))];

    // Need both harnessed and raw runs for comparison
    const hasComparison = providers.some((p) => {
      const harnessed = runs.filter((r) => r.provider === p && r.harnessEnabled);
      const raw = runs.filter((r) => r.provider === p && !r.harnessEnabled);
      return harnessed.length > 0 && raw.length > 0;
    });

    if (!hasComparison) {
      return "## Harness Impact\n\nNo harness comparison data (run with `harnessComparison: true`).";
    }

    const header = "| Provider | Raw Score | Orc Score | Delta | Cost Impact | Time Impact |";
    const divider = "|----------|-----------|-----------|-------|-------------|-------------|";

    const rows: string[] = [];

    for (const provider of providers) {
      const harnessed = runs.filter(
        (r) => r.provider === provider && r.harnessEnabled && r.evaluation,
      );
      const raw = runs.filter(
        (r) => r.provider === provider && !r.harnessEnabled && r.evaluation,
      );

      if (harnessed.length === 0 || raw.length === 0) continue;

      const harnessedAvg = this.avgScore(harnessed);
      const rawAvg = this.avgScore(raw);
      const delta = harnessedAvg - rawAvg;

      const harnessedCost = this.avg(harnessed.map((r) => r.metrics.costUsd));
      const rawCost = this.avg(raw.map((r) => r.metrics.costUsd));
      const costDelta = harnessedCost - rawCost;

      const harnessedTime = this.avg(harnessed.map((r) => r.durationMs ?? 0));
      const rawTime = this.avg(raw.map((r) => r.durationMs ?? 0));
      const timeDelta = harnessedTime - rawTime;

      const deltaStr = delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
      const costStr = costDelta >= 0
        ? `+${this.formatCost(costDelta)}`
        : `-${this.formatCost(Math.abs(costDelta))}`;
      const timeStr = timeDelta >= 0
        ? `+${this.formatDuration(timeDelta)}`
        : `-${this.formatDuration(Math.abs(timeDelta))}`;

      rows.push(
        `| ${provider} | ${rawAvg.toFixed(1)} | ${harnessedAvg.toFixed(1)} | ${deltaStr} | ${costStr} | ${timeStr} |`,
      );
    }

    return `## Harness Impact

${header}
${divider}
${rows.join("\n")}`;
  }

  // ── Category Breakdown ──────────────────────────────────────────────

  private generateCategoryBreakdown(
    tasks: BenchmarkTask[],
    runs: BenchmarkRun[],
  ): string {
    const categories = [...new Set(tasks.map((t) => t.category))];
    const sections: string[] = ["## By Category"];

    for (const category of categories) {
      const categoryTasks = tasks.filter((t) => t.category === category);
      const taskIds = new Set(categoryTasks.map((t) => t.id));

      // Get unique provider+harness combos
      const combos = new Map<string, BenchmarkRun[]>();
      for (const run of runs) {
        if (!taskIds.has(run.taskId)) continue;
        const key = run.harnessEnabled ? `${run.provider}+Orc` : run.provider;
        if (!combos.has(key)) combos.set(key, []);
        combos.get(key)!.push(run);
      }

      if (combos.size === 0) continue;

      // Build difficulty columns based on what tasks exist in this category
      const difficulties = [...new Set(categoryTasks.map((t) => t.difficulty))].sort(
        (a, b) => ["easy", "medium", "hard"].indexOf(a) - ["easy", "medium", "hard"].indexOf(b),
      );

      const diffHeaders = difficulties.map((d) => d.charAt(0).toUpperCase() + d.slice(1));
      const header = `| Provider | ${diffHeaders.join(" | ")} | Avg |`;
      const divider = `|----------|${difficulties.map(() => "------").join("|")}|-----|`;

      const rows: string[] = [];

      for (const [comboName, comboRuns] of combos) {
        const scores: string[] = [];
        let totalScore = 0;
        let scoreCount = 0;

        for (const diff of difficulties) {
          const diffTasks = categoryTasks.filter((t) => t.difficulty === diff);
          const diffTaskIds = new Set(diffTasks.map((t) => t.id));
          const diffRuns = comboRuns.filter((r) => diffTaskIds.has(r.taskId) && r.evaluation);

          if (diffRuns.length > 0) {
            const avg = this.avgScore(diffRuns);
            scores.push(avg.toFixed(0));
            totalScore += avg;
            scoreCount++;
          } else {
            scores.push("-");
          }
        }

        const avg = scoreCount > 0 ? (totalScore / scoreCount).toFixed(0) : "-";
        rows.push(`| ${comboName} | ${scores.join(" | ")} | ${avg} |`);
      }

      sections.push(`### ${category.charAt(0).toUpperCase() + category.slice(1)}

${header}
${divider}
${rows.join("\n")}`);
    }

    return sections.join("\n\n");
  }

  // ── Detailed Results ────────────────────────────────────────────────

  private generateDetailedResults(
    tasks: BenchmarkTask[],
    runs: BenchmarkRun[],
  ): string {
    const sections: string[] = ["## Detailed Results"];

    for (const task of tasks) {
      const taskRuns = runs.filter((r) => r.taskId === task.id);
      if (taskRuns.length === 0) continue;

      const header = "| Provider | Score | Tokens | Cost | Time | Status |";
      const divider = "|----------|-------|--------|------|------|--------|";

      const rows = taskRuns
        .sort((a, b) => (b.evaluation?.overall ?? 0) - (a.evaluation?.overall ?? 0))
        .map((r) => {
          const name = r.harnessEnabled ? `${r.provider}+Orc` : r.provider;
          const score = r.evaluation ? r.evaluation.overall.toFixed(0) : "-";
          const tokens = r.metrics.totalTokens.toLocaleString();
          const cost = this.formatCost(r.metrics.costUsd);
          const time = r.durationMs ? this.formatDuration(r.durationMs) : "-";
          const status = this.statusIcon(r.status);
          return `| ${name} | ${score} | ${tokens} | ${cost} | ${time} | ${status} |`;
        });

      sections.push(`### Task: ${task.name} (${task.difficulty}/${task.category})

${header}
${divider}
${rows.join("\n")}`);
    }

    return sections.join("\n\n");
  }

  // ── Cost Analysis ───────────────────────────────────────────────────

  private generateCostAnalysis(runs: BenchmarkRun[]): string {
    const providers = [...new Set(runs.map((r) => r.provider))];

    const header = "| Provider | Avg Cost/Task | Total | Most Expensive Task | Cheapest Task |";
    const divider = "|----------|---------------|-------|---------------------|---------------|";

    const rows: string[] = [];

    for (const provider of providers) {
      const providerRuns = runs.filter(
        (r) => r.provider === provider && r.status === "completed",
      );
      if (providerRuns.length === 0) continue;

      const totalCost = providerRuns.reduce((s, r) => s + r.metrics.costUsd, 0);
      const avgCost = totalCost / providerRuns.length;

      const sorted = [...providerRuns].sort(
        (a, b) => b.metrics.costUsd - a.metrics.costUsd,
      );
      const mostExpensive = sorted[0]
        ? `${sorted[0].taskId.split("-").slice(-1)[0]} (${this.formatCost(sorted[0].metrics.costUsd)})`
        : "-";
      const cheapest = sorted[sorted.length - 1]
        ? `${sorted[sorted.length - 1].taskId.split("-").slice(-1)[0]} (${this.formatCost(sorted[sorted.length - 1].metrics.costUsd)})`
        : "-";

      rows.push(
        `| ${provider} | ${this.formatCost(avgCost)} | ${this.formatCost(totalCost)} | ${mostExpensive} | ${cheapest} |`,
      );
    }

    return `## Cost Analysis

${header}
${divider}
${rows.join("\n")}`;
  }

  // ── Calculations ────────────────────────────────────────────────────

  /**
   * Calculate provider summaries from runs.
   */
  private calculateSummaries(runs: BenchmarkRun[]): Record<string, ProviderSummary> {
    const summaries: Record<string, ProviderSummary> = {};
    const providers = [...new Set(runs.map((r) => r.provider))];

    for (const provider of providers) {
      const providerRuns = runs.filter((r) => r.provider === provider);
      const completedRuns = providerRuns.filter((r) => r.status === "completed");
      const evaluatedRuns = completedRuns.filter((r) => r.evaluation);

      // Calculate harness impact if both variants exist
      const harnessedRuns = providerRuns.filter((r) => r.harnessEnabled && r.evaluation);
      const rawRuns = providerRuns.filter((r) => !r.harnessEnabled && r.evaluation);

      let harnessImpact: ProviderSummary["harnessImpact"] = null;
      if (harnessedRuns.length > 0 && rawRuns.length > 0) {
        harnessImpact = {
          scoreDelta: this.avgScore(harnessedRuns) - this.avgScore(rawRuns),
          costDelta:
            this.avg(harnessedRuns.map((r) => r.metrics.costUsd)) -
            this.avg(rawRuns.map((r) => r.metrics.costUsd)),
          timeDelta:
            this.avg(harnessedRuns.map((r) => r.durationMs ?? 0)) -
            this.avg(rawRuns.map((r) => r.durationMs ?? 0)),
        };
      }

      summaries[provider] = {
        provider,
        totalRuns: providerRuns.length,
        successRate: providerRuns.length > 0 ? completedRuns.length / providerRuns.length : 0,
        avgDurationMs: this.avg(completedRuns.map((r) => r.durationMs ?? 0)),
        avgCostUsd: this.avg(completedRuns.map((r) => r.metrics.costUsd)),
        avgTokens: this.avg(completedRuns.map((r) => r.metrics.totalTokens)),
        avgScore: evaluatedRuns.length > 0 ? this.avgScore(evaluatedRuns) : 0,
        harnessImpact,
      };
    }

    return summaries;
  }

  /**
   * Calculate category summaries.
   */
  private calculateCategorySummaries(
    tasks: BenchmarkTask[],
    runs: BenchmarkRun[],
  ): Record<string, CategorySummary> {
    const summaries: Record<string, CategorySummary> = {};
    const categories = [...new Set(tasks.map((t) => t.category))];

    for (const category of categories) {
      const taskIds = new Set(
        tasks.filter((t) => t.category === category).map((t) => t.id),
      );
      const categoryRuns = runs.filter(
        (r) => taskIds.has(r.taskId) && r.evaluation,
      );

      if (categoryRuns.length === 0) {
        summaries[category] = { category, bestProvider: "-", avgScore: 0, runs: 0 };
        continue;
      }

      // Find best provider for this category
      const providerScores = new Map<string, number[]>();
      for (const run of categoryRuns) {
        const key = run.harnessEnabled ? `${run.provider}+Orc` : run.provider;
        if (!providerScores.has(key)) providerScores.set(key, []);
        providerScores.get(key)!.push(run.evaluation!.overall);
      }

      let bestProvider = "-";
      let bestAvg = 0;
      for (const [name, scores] of providerScores) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        if (avg > bestAvg) {
          bestAvg = avg;
          bestProvider = name;
        }
      }

      summaries[category] = {
        category,
        bestProvider,
        avgScore: this.avgScore(categoryRuns),
        runs: categoryRuns.length,
      };
    }

    return summaries;
  }

  /**
   * Calculate rankings across all providers and harness configurations.
   */
  private calculateRankings(runs: BenchmarkRun[]): ProviderRanking[] {
    // Group by provider+model+harness
    const groups = new Map<string, BenchmarkRun[]>();
    for (const run of runs) {
      if (!run.evaluation || run.status !== "completed") continue;
      const key = `${run.provider}|${run.model}|${run.harnessEnabled}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(run);
    }

    const rankings: ProviderRanking[] = [];

    for (const [key, groupRuns] of groups) {
      const [provider, model, harnessed] = key.split("|");

      const avgScoreVal = this.avgScore(groupRuns);
      const avgCost = this.avg(groupRuns.map((r) => r.metrics.costUsd));
      const avgDuration = this.avg(groupRuns.map((r) => r.durationMs ?? 0));

      const costEfficiency = avgCost > 0 ? avgScoreVal / avgCost : 0;
      const speedScore = avgDuration > 0 ? avgScoreVal / (avgDuration / 1000) : 0;

      rankings.push({
        rank: 0, // Set after sorting
        provider,
        model,
        harnessed: harnessed === "true",
        score: avgScoreVal,
        costEfficiency,
        speedScore,
      });
    }

    // Sort by score descending, then by cost efficiency
    rankings.sort((a, b) => {
      if (Math.abs(a.score - b.score) > 1) return b.score - a.score;
      return b.costEfficiency - a.costEfficiency;
    });

    // Assign ranks
    for (let i = 0; i < rankings.length; i++) {
      rankings[i].rank = i + 1;
    }

    return rankings;
  }

  // ── Formatting Helpers ──────────────────────────────────────────────

  /**
   * Format number as score bar: ████████░░ 80%
   */
  private scoreBar(score: number, width = 10): string {
    const filled = Math.round((score / 100) * width);
    const empty = width - filled;
    return "\u2588".repeat(filled) + "\u2591".repeat(empty) + ` ${score.toFixed(0)}`;
  }

  /**
   * Format cost as dollar string.
   */
  private formatCost(usd: number): string {
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    if (usd < 1) return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(2)}`;
  }

  /**
   * Format duration.
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m`;
  }

  /**
   * Status icon for run status.
   */
  private statusIcon(status: BenchmarkRun["status"]): string {
    switch (status) {
      case "completed": return "\u2713";
      case "failed": return "\u2717";
      case "timeout": return "\u23f0";
      case "budget_exceeded": return "\ud83d\udcb0";
      case "running": return "\u25cb";
      default: return "?";
    }
  }

  // ── Math Helpers ────────────────────────────────────────────────────

  private avg(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private avgScore(runs: BenchmarkRun[]): number {
    const evaluated = runs.filter((r) => r.evaluation);
    if (evaluated.length === 0) return 0;
    return this.avg(evaluated.map((r) => r.evaluation!.overall));
  }
}
