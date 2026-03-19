import type { SubTask } from "../config/types.ts";

/**
 * Result returned when a worker completes execution.
 */
export interface WorkerResult {
  result: string;
  tokenUsage: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Handle returned after spawning a worker, used to track and interact with it.
 */
export interface WorkerHandle {
  agentName: string;
  sessionId: string;
}

/**
 * Options that can influence how a worker is spawned.
 */
export interface SpawnOptions {
  /** Working directory override — used for git worktree isolation. */
  workdir?: string;
}

/**
 * Abstracts the worker execution model so the Supervisor can run workers
 * via tmux sessions (CLI/headless) or AgentStreamer subprocesses (REPL).
 */
export interface WorkerExecutionStrategy {
  spawn(
    subtask: SubTask,
    maxTurns: number,
    enrichedPrompt: string,
    options?: SpawnOptions,
  ): Promise<WorkerHandle>;

  waitForResult(
    handle: WorkerHandle,
    timeoutMs: number,
  ): Promise<WorkerResult | null>;

  stop(handle: WorkerHandle): Promise<void>;

  isAlive(handle: WorkerHandle): Promise<boolean>;

  captureOutput(handle: WorkerHandle, lines?: number): Promise<string>;

  sendInput(handle: WorkerHandle, message: string): Promise<void>;
}
