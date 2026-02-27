import type {
  FeedbackLoopConfig,
  FeedbackCheckpoint,
  FeedbackAction,
  SupervisorAssessment,
  WorkerTurnProgress,
  SubTask,
  CritiqueResult,
  QAResult,
  RecoveryDecision,
  WorkerState,
  WorkerMessageType,
  ProviderConfig,
} from "../config/types.ts";
import type { SessionManager } from "../session/manager.ts";
import type { WorkerPool } from "./worker-pool.ts";
import type { WorkerBus } from "./worker-bus.ts";
import type { CheckpointManager } from "./checkpoint.ts";
import type { RecoveryManager } from "./recovery.ts";
import type { Store } from "../db/store.ts";
import { buildCritiquePrompt, parseCritiqueResponse } from "./critique.ts";
import { eventBus } from "./events.ts";

const DEFAULT_CONFIG: Required<FeedbackLoopConfig> = {
  enabled: true,
  checkIntervalMs: 30_000,
  maxCorrections: 3,
  qualityGateOnComplete: true,
  qaLoopOnFail: true,
};

export class FeedbackLoop {
  private config: Required<FeedbackLoopConfig>;
  private checkpoints: Map<string, FeedbackCheckpoint[]> = new Map();
  private correctionCounts: Map<string, number> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private processedMarkers: Map<string, Set<string>> = new Map();

  constructor(
    config: Partial<FeedbackLoopConfig> | undefined,
    private sessionManager: SessionManager,
    private pool: WorkerPool,
    private checkpointMgr: CheckpointManager,
    private recovery: RecoveryManager,
    private store: Store,
    private workerBus?: WorkerBus,
    private providerConfig?: ProviderConfig,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  startMonitoring(workerId: string, subtask: SubTask): void {
    if (!this.config.enabled) return;

    const timer = setInterval(
      () => this.inspect(workerId, subtask).catch(() => {}),
      this.config.checkIntervalMs,
    );
    this.timers.set(workerId, timer);
  }

  stopMonitoring(workerId: string): void {
    const timer = this.timers.get(workerId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(workerId);
    }
    this.processedMarkers.delete(workerId);
  }

  private async inspect(workerId: string, subtask: SubTask): Promise<void> {
    const worker = this.pool.get(workerId);
    if (!worker || worker.status === "completed" || worker.status === "failed") {
      this.stopMonitoring(workerId);
      return;
    }

    // Check if session is still alive — detect completion via session death
    const sessionAlive = await this.sessionManager.isAlive(worker.agentName).catch(() => false);
    if (!sessionAlive) {
      await this.detectWorkerCompletion(workerId, worker, subtask);
      return;
    }

    // Capture tmux output
    let capturedOutput: string;
    try {
      capturedOutput = await this.sessionManager.captureOutput(worker.agentName, 200);
    } catch {
      return; // Session may be gone
    }

    eventBus.publish({
      type: "feedback:check",
      workerId,
      subtaskId: subtask.id,
      turn: worker.currentTurn,
    });

    // Detect bus markers in tmux output
    this.detectBusMessages(workerId, capturedOutput, worker, subtask);

    // Detect ORC result markers (DONE/RESULT/PROGRESS)
    this.detectResultMarkers(workerId, capturedOutput, worker);

    // Parse turn progress
    const progress = this.parseTurnProgress(capturedOutput, worker);
    if (progress.currentTurn !== undefined) {
      this.pool.updateTurnProgress(workerId, {
        workerId,
        currentTurn: progress.currentTurn ?? worker.currentTurn,
        maxTurns: worker.maxTurns,
        lastToolUse: progress.lastToolUse ?? null,
        lastOutput: progress.lastOutput ?? null,
        filesModified: progress.filesModified ?? [],
        testsRun: progress.testsRun ?? false,
        testsPassed: progress.testsPassed ?? null,
        timestamp: new Date().toISOString(),
      });
    }

    // Assess worker state
    const assessment = this.assess(worker, capturedOutput, subtask);

    eventBus.publish({
      type: "feedback:assessment",
      workerId,
      action: assessment.action,
      reason: assessment.reason,
    });

    // Act on assessment
    switch (assessment.action) {
      case "continue":
        break;

      case "correct":
        if (assessment.correction) {
          await this.sendCorrection(workerId, assessment.correction);
        }
        break;

      case "checkpoint": {
        const cp: FeedbackCheckpoint = {
          workerId,
          subtaskId: subtask.id,
          turn: worker.currentTurn,
          capturedOutput: capturedOutput.slice(0, 2000),
          filesModified: progress.filesModified ?? [],
          assessment: assessment.action,
          correctionSent: null,
          timestamp: new Date().toISOString(),
        };
        const existing = this.checkpoints.get(workerId) ?? [];
        existing.push(cp);
        this.checkpoints.set(workerId, existing);
        this.store.saveFeedbackCheckpoint({
          id: `fcp-${Date.now().toString(36)}`,
          workerId: cp.workerId,
          subtaskId: cp.subtaskId,
          turn: cp.turn,
          capturedOutput: cp.capturedOutput,
          filesModified: cp.filesModified,
          assessment: cp.assessment,
          correction: cp.correctionSent,
        });
        break;
      }

      case "abort":
        eventBus.publish({
          type: "feedback:abort",
          workerId,
          reason: assessment.reason,
        });
        this.stopMonitoring(workerId);
        break;

      case "recovery": {
        const decision = this.handleFailure(workerId, subtask, new Error(assessment.reason));
        eventBus.publish({
          type: "feedback:recovery",
          workerId,
          action: decision.action,
          reason: decision.reason,
        });
        break;
      }
    }
  }

  assess(worker: WorkerState, capturedOutput: string, subtask: SubTask): SupervisorAssessment {
    // Check for failure patterns
    const failurePattern = this.detectFailurePattern(capturedOutput);
    if (failurePattern) {
      const corrections = this.correctionCounts.get(worker.id) ?? 0;
      if (corrections >= this.config.maxCorrections) {
        return { action: "abort", reason: `Max corrections reached (${corrections}). Last failure: ${failurePattern}`, confidence: 0.9 };
      }
      return {
        action: "correct",
        reason: `Detected failure: ${failurePattern}`,
        correction: `[Supervisor Correction]: I detected an issue: ${failurePattern}. Please address this and continue with the original task.`,
        confidence: 0.8,
      };
    }

    // Check for scope drift
    const offTrack = this.detectOffTrack(capturedOutput, subtask);
    if (offTrack.offTrack) {
      return {
        action: "correct",
        reason: offTrack.reason,
        correction: `[Supervisor Correction]: You appear to be drifting from the task. ${offTrack.reason}. Please refocus on: ${subtask.prompt.slice(0, 200)}`,
        confidence: 0.7,
      };
    }

    // Checkpoint interval check
    const checkpoints = this.checkpoints.get(worker.id) ?? [];
    const lastCheckpointTurn = checkpoints.length > 0
      ? checkpoints[checkpoints.length - 1].turn
      : 0;
    if (worker.currentTurn - lastCheckpointTurn >= 5) {
      return { action: "checkpoint", reason: "Periodic checkpoint", confidence: 1.0 };
    }

    return { action: "continue", reason: "Worker progressing normally", confidence: 0.9 };
  }

  async sendCorrection(workerId: string, message: string): Promise<boolean> {
    const worker = this.pool.get(workerId);
    if (!worker) return false;

    const count = (this.correctionCounts.get(workerId) ?? 0) + 1;
    this.correctionCounts.set(workerId, count);

    if (count > this.config.maxCorrections) {
      return false;
    }

    try {
      await this.sessionManager.sendInput(worker.agentName, message);
      this.pool.addCorrection(workerId, message);

      eventBus.publish({
        type: "feedback:correction",
        workerId,
        message,
      });

      return true;
    } catch {
      return false;
    }
  }

  async runQualityGate(subtask: SubTask, result: string): Promise<CritiqueResult> {
    // Try LLM-based critique first
    if (this.providerConfig) {
      try {
        const llmResult = await this.runLLMQualityGate(subtask, result);
        eventBus.publish({
          type: "feedback:quality_gate",
          subtaskId: subtask.id,
          passed: llmResult.passes,
          issues: llmResult.issues,
        });
        return llmResult;
      } catch {
        // Fall through to heuristic
      }
    }

    // Heuristic fallback
    return this.runHeuristicQualityGate(subtask, result);
  }

  private async runLLMQualityGate(subtask: SubTask, result: string): Promise<CritiqueResult> {
    const prompt = buildCritiquePrompt({ prompt: subtask.prompt, result });
    const model = this.providerConfig?.defaultModel ?? "haiku";
    const proc = Bun.spawn(
      ["claude", "-p", prompt, "--model", model, "--output-format", "text", "--max-turns", "1"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return parseCritiqueResponse(stdout);
  }

  private runHeuristicQualityGate(subtask: SubTask, result: string): CritiqueResult {
    const issues: string[] = [];
    const improvements: string[] = [];

    if (/error|exception|failed/i.test(result) && !/fixed|resolved|handled/i.test(result)) {
      issues.push("Result contains unresolved error patterns");
    }

    if (result.length < 50) {
      issues.push("Result is suspiciously short");
    }

    if (/TODO|FIXME|HACK|XXX/i.test(result)) {
      issues.push("Result contains TODO/FIXME markers");
    }

    const passed = issues.length === 0;

    eventBus.publish({
      type: "feedback:quality_gate",
      subtaskId: subtask.id,
      passed,
      issues,
    });

    return {
      passes: passed,
      issues,
      improvements,
      confidence: passed ? "high" : "medium",
    };
  }

  async runQALoop(
    subtask: SubTask,
    critiqueResult: CritiqueResult,
    maxIterations = 2,
  ): Promise<QAResult> {
    const allIssues = [...critiqueResult.issues].map(desc => ({
      description: desc,
      severity: "major" as const,
    }));

    for (let i = 0; i < maxIterations; i++) {
      eventBus.publish({
        type: "feedback:qa_loop",
        subtaskId: subtask.id,
        iteration: i + 1,
      });

      // If no remaining issues, pass
      if (allIssues.length === 0) {
        return { passed: true, iterations: i + 1, issues: allIssues, escalated: false };
      }
    }

    return {
      passed: false,
      iterations: maxIterations,
      issues: allIssues,
      escalated: allIssues.length > 0,
    };
  }

  handleFailure(workerId: string, subtask: SubTask, error: Error): RecoveryDecision {
    const failureType = this.recovery.classifyFailure(error.message, { taskId: subtask.id });
    const decision = this.recovery.decide(subtask.id, failureType);

    eventBus.publish({
      type: "feedback:recovery",
      workerId,
      action: decision.action,
      reason: decision.reason,
    });

    return decision;
  }

  private async detectWorkerCompletion(workerId: string, worker: WorkerState, subtask: SubTask): Promise<void> {
    // Session died — check DB for result
    const completed = this.store.listTasks({ agentName: worker.agentName, status: "completed" });
    if (completed.length > 0) {
      const t = completed[0];
      this.pool.markCompleted(workerId, t.result ?? "", {
        tokenUsage: t.tokenUsage,
        costUsd: t.costUsd,
      });
    } else {
      const failed = this.store.listTasks({ agentName: worker.agentName, status: "failed" });
      if (failed.length > 0) {
        this.pool.markFailed(workerId, failed[0].result ?? "Task failed");
      } else {
        // Session gone but no DB result — treat as failure
        this.pool.markFailed(workerId, "Worker session terminated without result");
      }
    }
    this.stopMonitoring(workerId);
  }

  private detectResultMarkers(workerId: string, output: string, worker: WorkerState): void {
    const seen = this.processedMarkers.get(workerId) ?? new Set<string>();

    // [ORC:DONE]
    if (output.includes("[ORC:DONE]") && !seen.has("ORC:DONE")) {
      seen.add("ORC:DONE");
      eventBus.publish({ type: "worker:signal_done", workerId });
    }

    // [ORC:RESULT files=a.ts,b.ts] summary
    const resultPattern = /\[ORC:RESULT\s+files=([^\]]+)\]\s+(.+)$/gm;
    let m;
    while ((m = resultPattern.exec(output)) !== null) {
      const fingerprint = `ORC:RESULT:${m[1]}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      const files = m[1].split(",").map((f) => f.trim());
      const summary = m[2].trim();
      eventBus.publish({ type: "worker:result_marker", workerId, files, summary });
    }

    // [ORC:PROGRESS n%] description
    const progressPattern = /\[ORC:PROGRESS\s+(\d+)%\]/g;
    let pm;
    while ((pm = progressPattern.exec(output)) !== null) {
      const pct = parseInt(pm[1], 10);
      const fingerprint = `ORC:PROGRESS:${pct}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      this.pool.updateProgress(workerId, pct);
    }

    this.processedMarkers.set(workerId, seen);
  }

  private detectBusMessages(workerId: string, output: string, worker: WorkerState, subtask: SubTask): void {
    if (!this.workerBus) return;

    const pattern = /\[ORC:BUS:(\w+)\s+to=(\S+?)(?:\s+meta=(\{[^}]*\}))?\]\s+(.+)$/gm;
    const seen = this.processedMarkers.get(workerId) ?? new Set<string>();

    let match;
    while ((match = pattern.exec(output)) !== null) {
      const [raw, type, target, metaJson, content] = match;
      const fingerprint = `${type}:${target}:${content.slice(0, 50)}`;

      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      let metadata: Record<string, unknown> | undefined;
      if (metaJson) {
        try { metadata = JSON.parse(metaJson); } catch { /* ignore malformed meta */ }
      }

      const validTypes = new Set(["artifact", "request", "status", "warning", "dependency"]);
      if (!validTypes.has(type)) continue;

      // "supervisor" target → event only, no bus delivery
      if (target === "supervisor") {
        eventBus.publish({
          type: "workerbus:message",
          messageId: `marker-${Date.now().toString(36)}`,
          from: worker.agentName,
          to: "supervisor",
          messageType: type,
        });
        continue;
      }

      // Route via WorkerBus
      this.workerBus.send({
        from: worker.agentName,
        to: target as string,
        type: type as WorkerMessageType,
        content,
        metadata: metadata as { files?: string[]; apis?: string[]; schemas?: string[]; ports?: number[] },
        taskRef: subtask.parentTaskId,
        subtaskRef: subtask.id,
      });
    }

    this.processedMarkers.set(workerId, seen);
  }

  private parseTurnProgress(
    output: string,
    worker: WorkerState,
  ): Partial<WorkerTurnProgress> {
    const progress: Partial<WorkerTurnProgress> = {};

    // Detect turn number from "Turn X/Y" pattern
    const turnMatch = output.match(/Turn\s+(\d+)\/(\d+)/i);
    if (turnMatch) {
      progress.currentTurn = parseInt(turnMatch[1], 10);
    }

    // Detect tool use
    const toolMatch = output.match(/(?:tool_use|Using tool|Tool:)\s*[:\s]*(\w+)/i);
    if (toolMatch) {
      progress.lastToolUse = toolMatch[1];
    }

    // Detect file modifications
    const files: string[] = [];
    const filePattern = /(?:wrote|created?|modified?|updated?)\s+[`"]?([a-zA-Z0-9_/.\\-]+\.[a-zA-Z]{1,10})[`"]?/gi;
    let match;
    while ((match = filePattern.exec(output)) !== null) {
      if (match[1] && !files.includes(match[1])) files.push(match[1]);
    }
    if (files.length > 0) progress.filesModified = files;

    // Detect test execution
    if (/(?:test|spec)\s+(?:passed|failed|running)/i.test(output)) {
      progress.testsRun = true;
      progress.testsPassed = /(?:all\s+)?tests?\s+passed/i.test(output);
    }

    // Last output (last 200 chars)
    progress.lastOutput = output.slice(-200);

    return progress;
  }

  private detectOffTrack(output: string, subtask: SubTask): { offTrack: boolean; reason: string } {
    // Extract keywords from subtask prompt
    const promptWords = new Set(
      subtask.prompt.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [],
    );

    // Extract keywords from recent output (last 1000 chars)
    const recentOutput = output.slice(-1000);
    const outputWords = new Set(
      recentOutput.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [],
    );

    // Jaccard similarity
    const intersection = [...promptWords].filter(w => outputWords.has(w));
    const union = new Set([...promptWords, ...outputWords]);
    const similarity = union.size > 0 ? intersection.length / union.size : 0;

    if (similarity < 0.05 && outputWords.size > 20) {
      return {
        offTrack: true,
        reason: `Low relevance (${(similarity * 100).toFixed(1)}%) between task prompt and recent output`,
      };
    }

    return { offTrack: false, reason: "" };
  }

  private detectFailurePattern(output: string): string | null {
    const recentOutput = output.slice(-500);
    const patterns: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /ENOENT|no such file/i, label: "File not found" },
      { pattern: /EACCES|permission denied/i, label: "Permission denied" },
      { pattern: /SyntaxError|TypeError|ReferenceError/i, label: "Runtime error" },
      { pattern: /npm ERR!|bun install.*failed/i, label: "Package install failure" },
      { pattern: /FATAL|panic|segfault/i, label: "Fatal error" },
      { pattern: /compilation? (?:error|failed)|build failed/i, label: "Build failure" },
    ];

    for (const { pattern, label } of patterns) {
      if (pattern.test(recentOutput)) return label;
    }

    return null;
  }

  stopAll(): void {
    for (const [workerId] of this.timers) {
      this.stopMonitoring(workerId);
    }
  }

  clear(): void {
    this.stopAll();
    this.checkpoints.clear();
    this.correctionCounts.clear();
    this.processedMarkers.clear();
  }
}
