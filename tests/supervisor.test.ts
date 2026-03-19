import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../src/db/schema.ts";
import { Store } from "../src/db/store.ts";
import { Supervisor } from "../src/core/supervisor.ts";
import type { SupervisorDeps } from "../src/core/supervisor.ts";
import type { OrchestratorConfig, SubTask } from "../src/config/types.ts";
import { Inbox } from "../src/messaging/inbox.ts";
import { ContextCompressor } from "../src/messaging/context-compressor.ts";
import { decompose } from "../src/core/decomposer.ts";
import { WorkerPool } from "../src/core/worker-pool.ts";

function buildMockDeps(): SupervisorDeps {
  const db = initDb(":memory:");
  const store = new Store(db);
  const inbox = new Inbox(store, db);
  const compressor = new ContextCompressor();

  const config: OrchestratorConfig = {
    orchestrator: {
      sessionPrefix: "orc-",
      maxConcurrentAgents: 3,
      dataDir: "/tmp/orc-test",
      db: ":memory:",
      logDir: "/tmp/orc-test/logs",
    },
    budget: { defaultMaxPerTask: 0.5 },
    providers: {
      claude: {
        command: "claude",
        defaultModel: "sonnet",
        flags: ["-p"],
        capabilities: {
          models: ["haiku", "sonnet", "opus"],
          strengths: ["code-generation", "architecture", "debugging"],
          weaknesses: [],
          maxContextTokens: 200000,
          supportsStreaming: true,
          supportsToolUse: true,
          costTier: "high",
        },
      },
    },
    routing: {
      tiers: {
        simple: { model: "haiku", keywords: ["format", "rename"] },
        medium: { model: "sonnet", keywords: ["refactor", "test"] },
        complex: { model: "opus", keywords: ["architect", "design"] },
      },
    },
    supervisor: {
      enabled: true,
      workerTimeout: 5000,
      maxRetries: 1,
      costAware: true,
      preferredProviders: ["claude"],
      multiTurn: {
        defaultMaxTurns: 5,
        simpleMaxTurns: 2,
        standardMaxTurns: 5,
        complexMaxTurns: 10,
        checkpointIntervalTurns: 3,
        progressPollIntervalMs: 500,
        idleTimeoutMs: 3000,
      },
      feedback: {
        enabled: false,
        checkIntervalMs: 1000,
        maxCorrections: 2,
        qualityGateOnComplete: false,
        qaLoopOnFail: false,
      },
      workerBus: { enabled: true, broadcastArtifacts: false },
      contextPropagation: {
        enabled: false,
        includeCodebaseMap: false,
        includeMemory: false,
        maxContextTokens: 2000,
        summarizeSiblingResults: false,
      },
    },
  };

  return {
    config,
    workerStrategy: {
      spawn: mock(async (_subtask: SubTask, _maxTurns: number, _prompt: string) => {
        store.registerAgent("test-worker", "claude", "sonnet");
        store.createTask({ id: _subtask.id, prompt: _subtask.prompt, tier: "sonnet" });
        store.updateTask(_subtask.id, {
          agentName: "test-worker",
          status: "completed",
          result: "done",
          tokenUsage: 100,
          costUsd: 0.01,
        });
        return { agentName: "test-worker", sessionId: "test-session" };
      }),
      waitForResult: mock(async () => ({
        result: "done",
        tokenUsage: 100,
        costUsd: 0.01,
        inputTokens: 50,
        outputTokens: 50,
      })),
      stop: mock(async () => {}),
      isAlive: mock(async () => true),
      captureOutput: mock(async () => ""),
      sendInput: mock(async () => {}),
    },
    sessionManager: {
      isAlive: mock(async () => true),
      sendInput: mock(async () => {}),
      getSession: mock(() => null),
      getSessionName: mock((name: string) => `orc-${name}`),
      captureOutput: mock(async () => ""),
      listActiveSessions: mock(() => []),
      spawnSession: mock(async () => ({
        name: "test",
        agentName: "test",
        pid: null,
        createdAt: new Date().toISOString(),
        status: "running" as const,
      })),
      destroySession: mock(async () => {}),
      destroyAll: mock(async () => {}),
    } as any,
    checkpointManager: {
      create: mock(async () => ({
        id: "cp-test",
        taskId: "task-test",
        agentName: "test",
        sha: "abc123",
        label: "test",
        metadata: {},
        createdAt: new Date().toISOString(),
      })),
      startAutoCheckpoint: mock(() => {}),
      stopAutoCheckpoint: mock(() => {}),
      stopAll: mock(() => {}),
    } as any,
    recoveryManager: {
      classifyFailure: mock(() => "unknown" as const),
      detectCircularFix: mock(() => false),
      decide: mock(() => ({
        action: "retry" as const,
        reason: "test",
      })),
      recordAttempt: mock(() => {}),
    } as any,
    contextBuilder: {
      buildContext: mock(async () => ""),
      formatContext: mock(() => ""),
    } as any,
    inbox,
    compressor,
    store,
  };
}

describe("Supervisor", () => {
  let deps: SupervisorDeps;
  let supervisor: Supervisor;

  beforeEach(() => {
    deps = buildMockDeps();
    supervisor = new Supervisor(deps, {
      workerTimeoutMs: 5000,
      maxRetries: 1,
    });
  });

  afterEach(() => {
    // Clean up pool timers
    supervisor.getPool().clear();
  });

  it("constructs without error", () => {
    expect(supervisor).toBeDefined();
    expect(supervisor.getPool()).toBeDefined();
    expect(supervisor.getProviderSelector()).toBeDefined();
    expect(supervisor.getWorkerBus()).toBeDefined();
  });

  it("decompose produces subtasks from a simple prompt", () => {
    const result = decompose("fix the typo in readme", "parent-1");
    expect(result.subtasks.length).toBeGreaterThanOrEqual(1);
    expect(result.subtasks[0].parentTaskId).toBe("parent-1");
    expect(result.subtasks[0].prompt).toContain("fix the typo");
    expect(result.executionPlan).toBeDefined();
    expect(result.executionPlan.phases.length).toBeGreaterThanOrEqual(1);
  });

  it("decompose produces multiple subtasks for multi-domain prompt", () => {
    const result = decompose(
      "Create a REST API with database migrations and add React frontend components. Write integration tests for the endpoints.",
      "parent-2",
    );
    // Multiple domains detected (backend, database, frontend, testing)
    expect(result.subtasks.length).toBeGreaterThan(1);
    expect(result.executionPlan.phases.length).toBeGreaterThanOrEqual(1);
  });

  it("execute with single subtask triggers executeSingleFallback", async () => {
    const result = await supervisor.execute("task-1", "rename foo to bar");

    expect(result.taskId).toBe("task-1");
    expect(result).toHaveProperty("mergedOutput");
    expect(result).toHaveProperty("totalTokens");
    expect(result).toHaveProperty("totalCost");

    // workerStrategy.spawn should have been called
    expect(deps.workerStrategy.spawn).toHaveBeenCalled();
  }, 30000);

  it("worker pool spawn + markCompleted + markFailed lifecycle", () => {
    const pool = new WorkerPool({ timeoutMs: 60000, maxRetries: 2 });

    const subtask: SubTask = {
      id: "st-test",
      prompt: "test task",
      parentTaskId: "parent",
      dependencies: [],
      provider: "claude",
      model: "sonnet",
      agentRole: "coder",
      priority: 1,
      status: "queued",
      result: null,
      estimatedTokens: 1000,
      actualTokens: 0,
      startedAt: null,
      completedAt: null,
    };

    const worker = pool.spawn(subtask, "agent-1", 10);
    expect(worker.status).toBe("spawning");
    expect(worker.maxTurns).toBe(10);

    pool.markRunning(worker.id);
    expect(pool.get(worker.id)!.status).toBe("running");

    pool.markCompleted(worker.id, "result text", {
      tokenUsage: 200,
      costUsd: 0.02,
    });
    const completed = pool.get(worker.id)!;
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("result text");
    expect(completed.tokenUsage).toBe(200);
    expect(completed.costUsd).toBe(0.02);
    expect(completed.progress).toBe(100);

    // Spawn another and fail it
    const worker2 = pool.spawn(subtask, "agent-2", 5);
    pool.markFailed(worker2.id, "network error");
    expect(pool.get(worker2.id)!.status).toBe("failed");
    expect(pool.get(worker2.id)!.error).toBe("network error");

    pool.clear();
  });
});
