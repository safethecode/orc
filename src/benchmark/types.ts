// ── Benchmark Types ─────────────────────────────────────────────────
// Standardized types for running benchmark tasks against multiple
// models/providers and generating comparison reports.

export type BenchmarkCategory = "coding" | "debugging" | "refactoring" | "review" | "architecture" | "testing";

export interface BenchmarkTask {
  id: string;
  name: string;
  category: BenchmarkCategory;
  difficulty: "easy" | "medium" | "hard";
  prompt: string;                    // The task prompt
  expectedOutcomes: string[];        // What success looks like
  evaluationCriteria: {
    correctness: string;             // How to judge correctness
    completeness: string;            // How to judge completeness
    codeQuality: string;             // How to judge quality
  };
  timeoutMs: number;                 // Max time allowed
  maxCostUsd: number;                // Max cost allowed
}

export interface BenchmarkRun {
  taskId: string;
  provider: string;
  model: string;
  harnessEnabled: boolean;           // With or without Orc harness
  startTime: string;
  endTime: string | null;
  durationMs: number | null;
  status: "running" | "completed" | "failed" | "timeout" | "budget_exceeded";
  result: string | null;
  metrics: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    turns: number;
    toolCalls: number;
    filesModified: number;
  };
  evaluation: {
    correctness: number;             // 0-100
    completeness: number;            // 0-100
    codeQuality: number;             // 0-100
    overall: number;                 // weighted average
  } | null;
}

export interface BenchmarkReport {
  id: string;
  createdAt: string;
  tasks: BenchmarkTask[];
  runs: BenchmarkRun[];
  summary: {
    byProvider: Record<string, ProviderSummary>;
    byCategory: Record<string, CategorySummary>;
    rankings: ProviderRanking[];
  };
}

export interface ProviderSummary {
  provider: string;
  totalRuns: number;
  successRate: number;
  avgDurationMs: number;
  avgCostUsd: number;
  avgTokens: number;
  avgScore: number;
  harnessImpact: {                   // Comparison: with harness vs without
    scoreDelta: number;              // +15 means harness adds 15 points
    costDelta: number;               // +0.02 means harness costs $0.02 more
    timeDelta: number;               // -5000 means harness saves 5s
  } | null;
}

export interface CategorySummary {
  category: string;
  bestProvider: string;
  avgScore: number;
  runs: number;
}

export interface ProviderRanking {
  rank: number;
  provider: string;
  model: string;
  harnessed: boolean;
  score: number;
  costEfficiency: number;            // score per dollar
  speedScore: number;                // score per second
}
