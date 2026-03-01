// ── Benchmark Runner (Vercel AI SDK) ─────────────────────────────────
// Executes benchmark tasks against multiple providers using the Vercel
// AI SDK for direct API access. Supports harness comparison and
// auto-evaluation via a judge model.

import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { BenchmarkTask, BenchmarkRun } from "./types.ts";
import { buildHarness } from "../agents/harness.ts";
import { eventBus } from "../core/events.ts";

export interface RunnerOptions {
  providers: string[];
  harnessComparison: boolean;
  parallel: boolean;
  timeoutMs: number;
  maxCostUsd: number;
  evaluator: "auto" | "manual";
}

interface ProviderModel {
  provider: string;
  model: string;
  sdkModel: string; // model ID for Vercel AI SDK
}

// Provider → SDK model ID mappings
const PROVIDER_DEFAULTS: Record<string, ProviderModel> = {
  claude: { provider: "claude", model: "sonnet", sdkModel: "claude-sonnet-4-5-20250929" },
  codex: { provider: "codex", model: "codex", sdkModel: "gpt-4o" },
  gemini: { provider: "gemini", model: "gemini-2.5-pro", sdkModel: "gemini-2.5-pro-latest" },
};

// Cost per 1M tokens (input/output)
const COST_TABLE: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro-latest": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash-latest": { input: 0.15, output: 0.6 },
};

// Provider factory cache
const anthropic = createAnthropic();
const openai = createOpenAI();
const google = createGoogleGenerativeAI();

/** Resolve SDK model instance from provider + model ID string. */
function resolveModel(provider: string, sdkModel: string) {
  switch (provider) {
    case "claude":
      return anthropic(sdkModel);
    case "codex":
      return openai(sdkModel);
    case "gemini":
      return google(sdkModel);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/** Calculate cost in USD from token counts and model pricing. */
function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = COST_TABLE[model];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export class BenchmarkRunner {
  private runs: BenchmarkRun[] = [];
  private totalCost = 0;

  constructor(private options: RunnerOptions) {}

  /**
   * Run a single task against a single provider via Vercel AI SDK.
   */
  async runTask(
    task: BenchmarkTask,
    provider: string,
    model: string,
    harnessEnabled: boolean,
  ): Promise<BenchmarkRun> {
    const pm = PROVIDER_DEFAULTS[provider];
    const sdkModel = pm?.sdkModel ?? model;

    const startTime = new Date().toISOString();
    const run: BenchmarkRun = {
      taskId: task.id,
      provider,
      model,
      harnessEnabled,
      startTime,
      endTime: null,
      durationMs: null,
      status: "running",
      result: null,
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        turns: 0,
        toolCalls: 0,
        filesModified: 0,
      },
      evaluation: null,
    };

    // Budget check
    if (this.totalCost >= this.options.maxCostUsd) {
      run.status = "budget_exceeded";
      run.endTime = new Date().toISOString();
      run.durationMs = 0;
      this.runs.push(run);
      return run;
    }

    const taskTimeout = Math.min(task.timeoutMs, this.options.timeoutMs);

    try {
      // Build system prompt — with or without harness
      let systemPrompt: string | undefined;
      if (harnessEnabled) {
        const harness = buildHarness({
          agentName: "benchmark-runner",
          role: "coder",
          provider: provider as any,
          parentTaskId: `bench-${task.id}`,
          isWorker: false,
        });
        systemPrompt = harness.systemPrompt;
      }

      // Execute via Vercel AI SDK with timeout
      const modelInstance = resolveModel(provider, sdkModel);

      const result = await Promise.race([
        generateText({
          model: modelInstance,
          system: systemPrompt,
          prompt: task.prompt,
          maxOutputTokens: 4096,
          temperature: 0.2,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), taskTimeout),
        ),
      ]);

      // Extract metrics from SDK response
      const usage = result.usage;
      const inTok = usage.inputTokens ?? 0;
      const outTok = usage.outputTokens ?? 0;
      run.result = result.text;
      run.metrics.inputTokens = inTok;
      run.metrics.outputTokens = outTok;
      run.metrics.totalTokens = inTok + outTok;
      run.metrics.costUsd = calculateCost(sdkModel, inTok, outTok);
      run.metrics.turns = 1;
      run.status = "completed";

      // Track cost
      this.totalCost += run.metrics.costUsd;

      // Per-task budget check
      if (run.metrics.costUsd > task.maxCostUsd) {
        run.status = "budget_exceeded";
      }

      // Auto-evaluate
      if (this.options.evaluator === "auto" && run.result) {
        try {
          run.evaluation = await this.autoEvaluate(task, run.result);
        } catch {
          run.evaluation = null;
        }
      }
    } catch (error) {
      const err = error as Error;
      if (err.message === "TIMEOUT") {
        run.status = "timeout";
      } else {
        run.status = "failed";
        run.result = err.message;
      }
    }

    run.endTime = new Date().toISOString();
    run.durationMs = new Date(run.endTime).getTime() - new Date(run.startTime).getTime();

    this.runs.push(run);

    eventBus.emit("orc", {
      type: "stats:record",
      tokens: run.metrics.totalTokens,
      cost: run.metrics.costUsd,
      model,
    });

    return run;
  }

  /**
   * Run all tasks against all configured providers.
   */
  async runAll(tasks: BenchmarkTask[]): Promise<BenchmarkRun[]> {
    const providerModels = this.options.providers
      .map((p) => PROVIDER_DEFAULTS[p])
      .filter(Boolean);

    const plan: Array<{
      task: BenchmarkTask;
      provider: string;
      model: string;
      harnessEnabled: boolean;
    }> = [];

    for (const task of tasks) {
      for (const pm of providerModels) {
        plan.push({ task, provider: pm.provider, model: pm.model, harnessEnabled: true });
        if (this.options.harnessComparison) {
          plan.push({ task, provider: pm.provider, model: pm.model, harnessEnabled: false });
        }
      }
    }

    if (this.options.parallel) {
      const grouped = new Map<string, typeof plan>();
      for (const item of plan) {
        const key = `${item.provider}-${item.harnessEnabled}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(item);
      }

      const groupPromises = Array.from(grouped.values()).map(async (items) => {
        for (const item of items) {
          if (this.totalCost >= this.options.maxCostUsd) break;
          await this.runTask(item.task, item.provider, item.model, item.harnessEnabled);
        }
      });

      await Promise.all(groupPromises);
    } else {
      for (const item of plan) {
        if (this.totalCost >= this.options.maxCostUsd) {
          const remaining: BenchmarkRun = {
            taskId: item.task.id,
            provider: item.provider,
            model: item.model,
            harnessEnabled: item.harnessEnabled,
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 0,
            status: "budget_exceeded",
            result: null,
            metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, turns: 0, toolCalls: 0, filesModified: 0 },
            evaluation: null,
          };
          this.runs.push(remaining);
          continue;
        }
        await this.runTask(item.task, item.provider, item.model, item.harnessEnabled);
      }
    }

    return this.runs;
  }

  /**
   * Auto-evaluate using Haiku as judge via AI SDK.
   */
  async autoEvaluate(
    task: BenchmarkTask,
    result: string,
  ): Promise<{ correctness: number; completeness: number; codeQuality: number; overall: number }> {
    const judgePrompt = this.buildJudgePrompt(task, result);

    const judgeResult = await Promise.race([
      generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        prompt: judgePrompt,
        maxOutputTokens: 512,
        temperature: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("JUDGE_TIMEOUT")), 60_000),
      ),
    ]);

    const scores = this.parseJudgeScores(judgeResult.text);

    // Track judge cost
    const judgeCost = calculateCost(
      "claude-haiku-4-5-20251001",
      judgeResult.usage.inputTokens ?? 0,
      judgeResult.usage.outputTokens ?? 0,
    );
    this.totalCost += judgeCost;

    return scores;
  }

  private buildJudgePrompt(task: BenchmarkTask, result: string): string {
    return `You are a code evaluation judge. Score the following response to a coding task.

## Task
**Name**: ${task.name}
**Category**: ${task.category}
**Difficulty**: ${task.difficulty}

**Prompt given to the model**:
${task.prompt}

**Expected outcomes**:
${task.expectedOutcomes.map((o) => `- ${o}`).join("\n")}

## Evaluation Criteria
- **Correctness** (0-100): ${task.evaluationCriteria.correctness}
- **Completeness** (0-100): ${task.evaluationCriteria.completeness}
- **Code Quality** (0-100): ${task.evaluationCriteria.codeQuality}

## Response to Evaluate
${result}

## Your Scoring
Rate each dimension from 0 to 100. Provide your scores in EXACTLY this format (one per line, no extra text):

CORRECTNESS: <number>
COMPLETENESS: <number>
CODE_QUALITY: <number>
OVERALL: <number>

The OVERALL score should be a weighted average: 40% correctness, 35% completeness, 25% code quality.
Round all scores to integers.`;
  }

  private parseJudgeScores(response: string): {
    correctness: number;
    completeness: number;
    codeQuality: number;
    overall: number;
  } {
    const extract = (label: string): number => {
      const match = response.match(new RegExp(`${label}:\\s*(\\d+)`, "i"));
      const value = match ? parseInt(match[1], 10) : 50;
      return Math.max(0, Math.min(100, value));
    };

    const correctness = extract("CORRECTNESS");
    const completeness = extract("COMPLETENESS");
    const codeQuality = extract("CODE_QUALITY");

    const parsedOverall = extract("OVERALL");
    const calculatedOverall = Math.round(correctness * 0.4 + completeness * 0.35 + codeQuality * 0.25);

    const overall = Math.abs(parsedOverall - calculatedOverall) > 15
      ? calculatedOverall
      : parsedOverall;

    return { correctness, completeness, codeQuality, overall };
  }

  getResults(): BenchmarkRun[] {
    return [...this.runs];
  }

  getTotalCost(): number {
    return this.totalCost;
  }
}

/**
 * Estimate the total cost for a full benchmark run without executing.
 */
export function estimateBenchmarkCost(
  taskCount: number,
  providers: string[],
  harnessComparison: boolean,
): { totalEstimate: number; perProvider: Record<string, number>; runCount: number } {
  const multiplier = harnessComparison ? 2 : 1;
  const runCount = taskCount * providers.length * multiplier;

  // Avg tokens per task (input ~2000, output ~2000)
  const avgInputTokens = 2_000;
  const avgOutputTokens = 2_000;
  const judgeCostPerTask = 0.001;

  const perProvider: Record<string, number> = {};
  let totalEstimate = 0;

  for (const provider of providers) {
    const pm = PROVIDER_DEFAULTS[provider];
    if (!pm) continue;

    const pricing = COST_TABLE[pm.sdkModel];
    if (!pricing) continue;

    const inputCost = (avgInputTokens / 1_000_000) * pricing.input * taskCount * multiplier;
    const outputCost = (avgOutputTokens / 1_000_000) * pricing.output * taskCount * multiplier;
    const judgeCost = taskCount * multiplier * judgeCostPerTask;

    perProvider[provider] = Math.round((inputCost + outputCost + judgeCost) * 1000) / 1000;
    totalEstimate += perProvider[provider];
  }

  return {
    totalEstimate: Math.round(totalEstimate * 1000) / 1000,
    perProvider,
    runCount,
  };
}
