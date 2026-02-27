import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../src/db/schema.ts";
import { Store } from "../src/db/store.ts";

describe("Store + Schema integration", () => {
  let db: Database;
  let store: Store;

  beforeEach(() => {
    db = initDb(":memory:");
    store = new Store(db);
  });

  // ── Schema ──────────────────────────────────────────────────────────

  it("initDb creates all tables without error", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    const names = tables.map((t) => t.name);
    expect(names).toContain("agents");
    expect(names).toContain("tasks");
    expect(names).toContain("messages");
    expect(names).toContain("file_locks");
    expect(names).toContain("token_usage");
    expect(names).toContain("session_snapshots");
    expect(names).toContain("worker_messages");
    expect(names).toContain("feedback_checkpoints");
    expect(names).toContain("checkpoints");
    expect(names).toContain("decisions");
  });

  // ── Tasks ───────────────────────────────────────────────────────────

  it("createTask + getTask roundtrip", () => {
    store.createTask({
      id: "task-1",
      prompt: "fix the bug",
      tier: "sonnet",
    });

    const task = store.getTask("task-1");
    expect(task).not.toBeNull();
    expect(task!.id).toBe("task-1");
    expect(task!.prompt).toBe("fix the bug");
    expect(task!.tier).toBe("sonnet");
    expect(task!.status).toBe("queued");
    expect(task!.tokenUsage).toBe(0);
    expect(task!.costUsd).toBe(0);
  });

  it("getTask returns null for missing id", () => {
    expect(store.getTask("nonexistent")).toBeNull();
  });

  it("updateTask changes status, result, tokenUsage, costUsd", () => {
    store.createTask({ id: "task-2", prompt: "test", tier: "haiku" });

    store.updateTask("task-2", {
      status: "completed",
      result: "all good",
      tokenUsage: 500,
      costUsd: 0.05,
    });

    const task = store.getTask("task-2")!;
    expect(task.status).toBe("completed");
    expect(task.result).toBe("all good");
    expect(task.tokenUsage).toBe(500);
    expect(task.costUsd).toBe(0.05);
  });

  it("listTasks filtering by status", () => {
    store.createTask({ id: "t-a", prompt: "a", tier: "sonnet" });
    store.createTask({ id: "t-b", prompt: "b", tier: "sonnet" });
    store.updateTask("t-a", { status: "completed" });

    const queued = store.listTasks({ status: "queued" });
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe("t-b");

    const completed = store.listTasks({ status: "completed" });
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe("t-a");
  });

  it("listTasks filtering by agentName", () => {
    store.registerAgent("worker-1", "claude", "sonnet");
    store.createTask({ id: "t-x", prompt: "x", tier: "sonnet" });
    store.createTask({ id: "t-y", prompt: "y", tier: "sonnet" });
    store.updateTask("t-x", { agentName: "worker-1" });

    const assigned = store.listTasks({ agentName: "worker-1" });
    expect(assigned).toHaveLength(1);
    expect(assigned[0].id).toBe("t-x");
  });

  // ── Agents ──────────────────────────────────────────────────────────

  it("registerAgent + listAgents + updateAgentStatus", () => {
    store.registerAgent("agent-a", "claude", "sonnet");
    store.registerAgent("agent-b", "codex", "opus");

    const agents = store.listAgents();
    expect(agents).toHaveLength(2);

    const names = agents.map((a) => a.name);
    expect(names).toContain("agent-a");
    expect(names).toContain("agent-b");

    // Default status
    const agentA = agents.find((a) => a.name === "agent-a")!;
    expect(agentA.status).toBe("idle");

    // Update status
    store.updateAgentStatus("agent-a", "running");
    const updated = store.getAgent("agent-a")!;
    expect(updated.status).toBe("running");
  });

  // ── Messages ────────────────────────────────────────────────────────

  it("addMessage + getUnreadMessages + markMessageRead", () => {
    store.registerAgent("sender", "claude", "sonnet");
    store.registerAgent("receiver", "claude", "sonnet");

    store.addMessage({
      id: "msg-1",
      from: "sender",
      to: "receiver",
      content: "hello",
      taskRef: "task-ref",
    });

    const unread = store.getUnreadMessages("receiver");
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe("msg-1");
    expect(unread[0].from).toBe("sender");
    expect(unread[0].to).toBe("receiver");
    expect(unread[0].content).toBe("hello");
    expect(unread[0].read).toBe(false);

    store.markMessageRead("msg-1");
    const afterRead = store.getUnreadMessages("receiver");
    expect(afterRead).toHaveLength(0);
  });

  // ── Snapshots ───────────────────────────────────────────────────────

  it("saveSnapshot + getLatestSnapshot", () => {
    store.saveSnapshot({
      id: "snap-1",
      sessionName: "repl",
      turnsJson: JSON.stringify([{ role: "user", content: "hello" }]),
      language: "en",
      summary: "greeting",
      turnCount: 1,
    });

    const latest = store.getLatestSnapshot("repl");
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe("snap-1");
    expect(latest!.turnCount).toBe(1);
    expect(latest!.summary).toBe("greeting");
    expect(latest!.language).toBe("en");
  });

  it("listSnapshots returns ordered results", async () => {
    store.saveSnapshot({
      id: "snap-a",
      turnsJson: "[]",
      turnCount: 2,
    });

    // Ensure a distinct timestamp for ordering (SQLite datetime has second precision)
    await new Promise((r) => setTimeout(r, 1100));

    store.saveSnapshot({
      id: "snap-b",
      turnsJson: "[]",
      turnCount: 5,
    });

    const list = store.listSnapshots();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].id).toBe("snap-b");
  });

  // ── Worker Messages ─────────────────────────────────────────────────

  it("addWorkerMessage + getWorkerMessages", () => {
    store.addWorkerMessage({
      id: "wm-1",
      from: "worker-a",
      to: "worker-b",
      type: "artifact",
      content: "done with files",
      metadata: { files: ["src/a.ts"] },
      taskRef: "task-42",
      subtaskRef: "st-1",
    });

    const msgs = store.getWorkerMessages("task-42");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe("wm-1");
    expect(msgs[0].from).toBe("worker-a");
    expect(msgs[0].to).toBe("worker-b");
    expect(msgs[0].type).toBe("artifact");
    expect(msgs[0].content).toBe("done with files");
    expect(msgs[0].metadata).toEqual({ files: ["src/a.ts"] });
  });

  it("getWorkerMessages filters by toAgent", () => {
    store.addWorkerMessage({
      id: "wm-2",
      from: "w-a",
      to: "w-b",
      type: "status",
      content: "msg for b",
      taskRef: "task-99",
      subtaskRef: "st-2",
    });
    store.addWorkerMessage({
      id: "wm-3",
      from: "w-a",
      to: "all",
      type: "artifact",
      content: "broadcast",
      taskRef: "task-99",
      subtaskRef: "st-2",
    });
    store.addWorkerMessage({
      id: "wm-4",
      from: "w-a",
      to: "w-c",
      type: "status",
      content: "msg for c",
      taskRef: "task-99",
      subtaskRef: "st-3",
    });

    const forB = store.getWorkerMessages("task-99", "w-b");
    // Should get the direct message + the broadcast
    expect(forB).toHaveLength(2);
    const ids = forB.map((m) => m.id);
    expect(ids).toContain("wm-2");
    expect(ids).toContain("wm-3");
  });

  // ── Feedback Checkpoints ────────────────────────────────────────────

  it("saveFeedbackCheckpoint + getFeedbackCheckpoints", () => {
    store.saveFeedbackCheckpoint({
      id: "fc-1",
      workerId: "w-1",
      subtaskId: "st-1",
      turn: 3,
      capturedOutput: "some output",
      filesModified: ["src/foo.ts"],
      assessment: "continue",
      correction: null,
    });
    store.saveFeedbackCheckpoint({
      id: "fc-2",
      workerId: "w-1",
      subtaskId: "st-1",
      turn: 5,
      capturedOutput: "more output",
      filesModified: ["src/foo.ts", "src/bar.ts"],
      assessment: "correct",
      correction: "fix the import",
    });

    const checkpoints = store.getFeedbackCheckpoints("w-1");
    expect(checkpoints).toHaveLength(2);

    expect(checkpoints[0].turn).toBe(3);
    expect(checkpoints[0].assessment).toBe("continue");
    expect(checkpoints[0].correctionSent).toBeNull();

    expect(checkpoints[1].turn).toBe(5);
    expect(checkpoints[1].assessment).toBe("correct");
    expect(checkpoints[1].correctionSent).toBe("fix the import");
    expect(checkpoints[1].filesModified).toEqual([
      "src/foo.ts",
      "src/bar.ts",
    ]);
  });
});
