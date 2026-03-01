// ── Benchmark Runner ────────────────────────────────────────────────
// Executes benchmark tasks against multiple providers, with optional
// Orc harness comparison and auto-evaluation via a judge model.

import type { BenchmarkTask, BenchmarkRun } from "./types.ts";
import { buildHarness } from "../agents/harness.ts";
import { eventBus } from "../core/events.ts";

export interface RunnerOptions {
  providers: string[];               // Which providers to test
  harnessComparison: boolean;        // Run with AND without harness
  parallel: boolean;                 // Run providers in parallel
  timeoutMs: number;                 // Global timeout
  maxCostUsd: number;                // Global budget
  evaluator: "auto" | "manual";     // Auto-evaluate or wait for human
}

interface ProviderModel {
  provider: string;
  model: string;
  command: string;
}

// Default provider -> model mappings (mirrors config/default.yml)
const PROVIDER_DEFAULTS: Record<string, ProviderModel> = {
  claude: { provider: "claude", model: "sonnet", command: "claude" },
  codex: { provider: "codex", model: "codex", command: "codex" },
  gemini: { provider: "gemini", model: "gemini-2.5-pro", command: "gemini" },
  kiro: { provider: "kiro", model: "kiro", command: "kiro" },
};

// Cost per 1K tokens (rough estimates for budget tracking)
const COST_PER_1K: Record<string, number> = {
  haiku: 0.0005,
  sonnet: 0.006,
  opus: 0.03,
  codex: 0.005,
  "gemini-2.5-pro": 0.004,
  "gemini-2.5-flash": 0.001,
  kiro: 0.003,
};

export class BenchmarkRunner {
  private runs: BenchmarkRun[] = [];
  private totalCost = 0;

  constructor(private options: RunnerOptions) {}

  /**
   * Run a single task against a single provider.
   * Uses Bun.spawn to execute the CLI command.
   * With harness: uses Orc's buildHarness() for enriched system prompt
   * Without harness: sends raw prompt directly to the CLI
   */
  async runTask(
    task: BenchmarkTask,
    provider: string,
    model: string,
    harnessEnabled: boolean,
  ): Promise<BenchmarkRun> {
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

    // Budget check before running
    if (this.totalCost >= this.options.maxCostUsd) {
      run.status = "budget_exceeded";
      run.endTime = new Date().toISOString();
      run.durationMs = 0;
      this.runs.push(run);
      return run;
    }

    const taskTimeout = Math.min(task.timeoutMs, this.options.timeoutMs);

    try {
      // Build the prompt — with or without harness
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

      // Build CLI command based on provider
      const cmd = this.buildProviderCommand(provider, model, task.prompt, systemPrompt);

      // Execute with timeout
      const result = await this.executeWithTimeout(cmd, taskTimeout, provider);

      // Parse result and extract metrics
      const parsed = this.parseResult(result, provider);
      run.result = parsed.text;
      run.metrics = parsed.metrics;
      run.status = "completed";

      // Track cost
      this.totalCost += run.metrics.costUsd;

      // Per-task budget check
      if (run.metrics.costUsd > task.maxCostUsd) {
        run.status = "budget_exceeded";
      }

      // Auto-evaluate if configured
      if (this.options.evaluator === "auto" && run.result) {
        try {
          run.evaluation = await this.autoEvaluate(task, run.result);
        } catch {
          // Evaluation failure doesn't fail the run
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

    // Build run plan: each task x each provider x harness variants
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
      // Run providers in parallel (tasks sequentially within each provider)
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
      // Run sequentially
      for (const item of plan) {
        if (this.totalCost >= this.options.maxCostUsd) {
          // Mark remaining as budget_exceeded
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
   * Auto-evaluate a result using a judge model (claude haiku for cost efficiency).
   * Sends the task + result to a judge with scoring criteria.
   */
  async autoEvaluate(
    task: BenchmarkTask,
    result: string,
  ): Promise<{ correctness: number; completeness: number; codeQuality: number; overall: number }> {
    const judgePrompt = this.buildJudgePrompt(task, result);

    // Use haiku as judge — cheapest model for evaluation
    const cmd = [
      "claude",
      "-p", judgePrompt,
      "--model", "haiku",
      "--output-format", "text",
      "--max-turns", "1",
    ];

    const judgeResult = await this.executeWithTimeout(cmd, 60_000, "claude");
    const scores = this.parseJudgeScores(judgeResult);

    // Track judge cost (small, but still counts)
    const judgeCost = (judgeResult.length / 4 / 1000) * COST_PER_1K.haiku * 2; // rough estimate
    this.totalCost += judgeCost;

    return scores;
  }

  /**
   * Build the judge prompt for auto-evaluation.
   */
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

  /**
   * Parse judge response into scores.
   */
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

    // Parse or calculate overall
    const parsedOverall = extract("OVERALL");
    const calculatedOverall = Math.round(correctness * 0.4 + completeness * 0.35 + codeQuality * 0.25);

    // Use calculated if parsed seems off (judge might not follow instructions perfectly)
    const overall = Math.abs(parsedOverall - calculatedOverall) > 15
      ? calculatedOverall
      : parsedOverall;

    return { correctness, completeness, codeQuality, overall };
  }

  /**
   * Build the CLI command array for a given provider.
   */
  private buildProviderCommand(
    provider: string,
    model: string,
    prompt: string,
    systemPrompt?: string,
  ): string[] {
    switch (provider) {
      case "claude": {
        const cmd = [
          "claude",
          "-p", prompt,
          "--model", model,
          "--output-format", "stream-json",
          "--verbose",
          "--max-turns", "10",
        ];
        if (systemPrompt) {
          cmd.push("--system-prompt", systemPrompt);
        }
        return cmd;
      }

      case "codex": {
        const codexPrompt = systemPrompt
          ? `${systemPrompt}\n\n---\n\n${prompt}`
          : prompt;
        return ["codex", "exec", codexPrompt, "--full-auto"];
      }

      case "gemini": {
        const cmd = ["gemini", "-p", prompt];
        if (model) cmd.push("--model", model);
        if (systemPrompt) cmd.push("--system-prompt", systemPrompt);
        return cmd;
      }

      case "kiro": {
        const cmd = ["kiro", "cli", prompt];
        if (systemPrompt) cmd.push("--system-prompt", systemPrompt);
        return cmd;
      }

      default:
        return [provider, prompt];
    }
  }

  /**
   * Execute a CLI command with timeout, capturing stdout.
   */
  private async executeWithTimeout(
    cmd: string[],
    timeoutMs: number,
    provider: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const proc = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.cwd(),
      });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("TIMEOUT"));
      }, timeoutMs);

      const chunks: Uint8Array[] = [];

      (async () => {
        try {
          const reader = proc.stdout.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }

          clearTimeout(timer);

          const exitCode = await proc.exited;
          const output = Buffer.concat(chunks).toString("utf-8");

          if (exitCode !== 0 && output.trim().length === 0) {
            // Read stderr for error info
            const stderrText = await new Response(proc.stderr).text();
            reject(new Error(`Process exited with code ${exitCode}: ${stderrText.slice(0, 500)}`));
          } else {
            resolve(output);
          }
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      })();
    });
  }

  /**
   * Parse raw CLI output into text + metrics.
   * Handles different output formats per provider.
   */
  private parseResult(
    raw: string,
    provider: string,
  ): { text: string; metrics: BenchmarkRun["metrics"] } {
    const metrics: BenchmarkRun["metrics"] = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      turns: 0,
      toolCalls: 0,
      filesModified: 0,
    };

    let text = "";

    if (provider === "claude") {
      // Claude stream-json format: one JSON object per line
      const lines = raw.split("\n").filter((l) => l.trim());
      const textParts: string[] = [];

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          if (event.type === "content_block_delta" && event.delta?.text) {
            textParts.push(event.delta.text);
          }

          if (event.type === "message_delta" && event.usage) {
            metrics.outputTokens += event.usage.output_tokens ?? 0;
          }

          if (event.type === "message_start" && event.message?.usage) {
            metrics.inputTokens = event.message.usage.input_tokens ?? 0;
          }

          if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
            metrics.toolCalls++;
          }

          // Result message with final usage
          if (event.type === "result") {
            if (event.result) textParts.push(event.result);
            if (event.input_tokens) metrics.inputTokens = event.input_tokens;
            if (event.output_tokens) metrics.outputTokens = event.output_tokens;
            if (event.num_turns) metrics.turns = event.num_turns;
          }

          // Track file modifications via tool use
          if (event.type === "tool_use" || event.type === "content_block_stop") {
            if (event.name === "write" || event.name === "edit") {
              metrics.filesModified++;
            }
          }
        } catch {
          // Non-JSON line — might be raw text output
          if (line.trim()) textParts.push(line);
        }
      }

      text = textParts.join("");
    } else {
      // For other providers, treat output as plain text
      text = raw;

      // Estimate tokens from text length (rough: 1 token ~ 4 chars)
      const estimatedTokens = Math.ceil(raw.length / 4);
      metrics.outputTokens = estimatedTokens;
      metrics.inputTokens = Math.ceil(estimatedTokens * 0.3); // rough input estimate
    }

    metrics.totalTokens = metrics.inputTokens + metrics.outputTokens;
    metrics.costUsd = (metrics.totalTokens / 1000) * (COST_PER_1K[provider] ?? COST_PER_1K.sonnet);

    return { text, metrics };
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

  // Avg tokens per task (rough estimate based on task complexity)
  const avgTokensPerTask = 8_000;
  const judgeCostPerTask = 0.001; // haiku judge cost

  const perProvider: Record<string, number> = {};
  let totalEstimate = 0;

  for (const provider of providers) {
    const model = PROVIDER_DEFAULTS[provider]?.model ?? provider;
    const costPer1k = COST_PER_1K[model] ?? 0.005;
    const providerCost = taskCount * multiplier * (avgTokensPerTask / 1000) * costPer1k;
    const judgeCost = taskCount * multiplier * judgeCostPerTask;
    perProvider[provider] = Math.round((providerCost + judgeCost) * 1000) / 1000;
    totalEstimate += perProvider[provider];
  }

  return {
    totalEstimate: Math.round(totalEstimate * 1000) / 1000,
    perProvider,
    runCount,
  };
}
