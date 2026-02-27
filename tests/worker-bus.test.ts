import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../src/db/schema.ts";
import { Store } from "../src/db/store.ts";
import { WorkerBus } from "../src/core/worker-bus.ts";
import { Inbox } from "../src/messaging/inbox.ts";
import type { WorkerManifest } from "../src/config/types.ts";

describe("WorkerBus", () => {
  let db: Database;
  let store: Store;
  let inbox: Inbox;
  let bus: WorkerBus;

  const mockSessionManager = {
    sendInput: mock(async () => {}),
    getSession: mock(() => null),
    isAlive: mock(async () => true),
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
  } as any;

  beforeEach(() => {
    db = initDb(":memory:");
    store = new Store(db);
    inbox = new Inbox(store, db);
    bus = new WorkerBus(inbox, mockSessionManager, store);
    mockSessionManager.sendInput.mockClear();
  });

  it("registerWorker + getSiblings filtering", () => {
    const taskPrefix = "task-abc";

    const manifest1: WorkerManifest = {
      agentName: "worker-1",
      subtaskId: `${taskPrefix}-st-1`,
      role: "coder",
      domain: "backend",
      prompt: "implement API endpoint",
    };
    const manifest2: WorkerManifest = {
      agentName: "worker-2",
      subtaskId: `${taskPrefix}-st-2`,
      role: "tester",
      domain: "testing",
      prompt: "write tests for API",
    };
    const manifest3: WorkerManifest = {
      agentName: "worker-3",
      subtaskId: "other-task-st-3",
      role: "coder",
      domain: "frontend",
      prompt: "build UI",
    };

    bus.registerWorker(manifest1);
    bus.registerWorker(manifest2);
    bus.registerWorker(manifest3);

    // getSiblings filters by taskRef prefix and excludes the given agent
    const siblings = bus.getSiblings(taskPrefix, "worker-1");
    expect(siblings).toHaveLength(1);
    expect(siblings[0].agentName).toBe("worker-2");

    // Without exclusion
    const allSiblings = bus.getSiblings(taskPrefix);
    expect(allSiblings).toHaveLength(2);
  });

  it("send creates message with id and timestamp", () => {
    bus.registerWorker({
      agentName: "sender",
      subtaskId: "st-1",
      role: "coder",
      domain: "backend",
      prompt: "test",
    });

    const msg = bus.send({
      from: "sender",
      to: "receiver",
      type: "status",
      content: "progress update",
      taskRef: "task-1",
      subtaskRef: "st-1",
    });

    expect(msg.id).toBeDefined();
    expect(msg.id.startsWith("wm-")).toBe(true);
    expect(msg.timestamp).toBeDefined();
    expect(msg.content).toBe("progress update");
    expect(msg.type).toBe("status");
  });

  it("send persists message to database", () => {
    bus.registerWorker({
      agentName: "sender",
      subtaskId: "st-1",
      role: "coder",
      domain: "backend",
      prompt: "test",
    });

    bus.send({
      from: "sender",
      to: "receiver",
      type: "artifact",
      content: "files created",
      taskRef: "task-db",
      subtaskRef: "st-1",
    });

    const dbMessages = store.getWorkerMessages("task-db");
    expect(dbMessages).toHaveLength(1);
    expect(dbMessages[0].content).toBe("files created");
  });

  it("broadcastArtifact sends to all workers", () => {
    bus.registerWorker({
      agentName: "worker-a",
      subtaskId: "st-1",
      role: "coder",
      domain: "backend",
      prompt: "backend work",
    });
    bus.registerWorker({
      agentName: "worker-b",
      subtaskId: "st-2",
      role: "tester",
      domain: "testing",
      prompt: "test work",
    });

    bus.broadcastArtifact("worker-a", "task-bcast", {
      files: ["src/api.ts"],
      apis: ["/api/users"],
      schemas: ["UserSchema"],
    });

    const msgs = bus.getMessagesByTask("task-bcast");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("artifact");
    expect(msgs[0].to).toBe("all");
    expect(msgs[0].content).toContain("src/api.ts");
    expect(msgs[0].content).toContain("/api/users");
  });

  it("getMessagesFor filtering", () => {
    bus.registerWorker({
      agentName: "sender",
      subtaskId: "st-1",
      role: "coder",
      domain: "backend",
      prompt: "test",
    });

    bus.send({
      from: "sender",
      to: "target-a",
      type: "status",
      content: "for a",
      taskRef: "task-f",
      subtaskRef: "st-1",
    });
    bus.send({
      from: "sender",
      to: "target-b",
      type: "status",
      content: "for b",
      taskRef: "task-f",
      subtaskRef: "st-1",
    });
    bus.send({
      from: "sender",
      to: "all",
      type: "artifact",
      content: "for everyone",
      taskRef: "task-f",
      subtaskRef: "st-1",
    });

    const forA = bus.getMessagesFor("target-a");
    expect(forA).toHaveLength(2); // direct + broadcast
    expect(forA.some((m) => m.content === "for a")).toBe(true);
    expect(forA.some((m) => m.content === "for everyone")).toBe(true);

    const forB = bus.getMessagesFor("target-b");
    expect(forB).toHaveLength(2); // direct + broadcast
  });

  it("getMessagesByTask filtering", () => {
    bus.registerWorker({
      agentName: "sender",
      subtaskId: "st-1",
      role: "coder",
      domain: "backend",
      prompt: "test",
    });

    bus.send({
      from: "sender",
      to: "recv",
      type: "status",
      content: "msg 1",
      taskRef: "task-x",
      subtaskRef: "st-1",
    });
    bus.send({
      from: "sender",
      to: "recv",
      type: "status",
      content: "msg 2",
      taskRef: "task-y",
      subtaskRef: "st-2",
    });

    const taskX = bus.getMessagesByTask("task-x");
    expect(taskX).toHaveLength(1);
    expect(taskX[0].taskRef).toBe("task-x");
  });

  it("clearTask removes messages for that task", () => {
    bus.registerWorker({
      agentName: "sender",
      subtaskId: "st-1",
      role: "coder",
      domain: "backend",
      prompt: "test",
    });

    bus.send({
      from: "sender",
      to: "recv",
      type: "status",
      content: "keep",
      taskRef: "task-keep",
      subtaskRef: "st-1",
    });
    bus.send({
      from: "sender",
      to: "recv",
      type: "status",
      content: "remove",
      taskRef: "task-remove",
      subtaskRef: "st-2",
    });

    bus.clearTask("task-remove");

    expect(bus.getMessagesByTask("task-remove")).toHaveLength(0);
    expect(bus.getMessagesByTask("task-keep")).toHaveLength(1);
  });

  it("formatSiblingContext generates context string", () => {
    const taskPrefix = "task-ctx";

    bus.registerWorker({
      agentName: "worker-1",
      subtaskId: `${taskPrefix}-st-1`,
      role: "coder",
      domain: "backend",
      prompt: "implement API endpoints for user management module",
    });
    bus.registerWorker({
      agentName: "worker-2",
      subtaskId: `${taskPrefix}-st-2`,
      role: "tester",
      domain: "testing",
      prompt: "write unit tests for the API",
    });

    const context = bus.formatSiblingContext(taskPrefix, "worker-1");
    expect(context).toContain("Sibling workers:");
    expect(context).toContain("worker-2");
    expect(context).toContain("tester");
    expect(context).toContain("testing");

    // Excluding nonexistent agent returns all
    const allContext = bus.formatSiblingContext(taskPrefix);
    expect(allContext).toContain("worker-1");
    expect(allContext).toContain("worker-2");
  });

  it("formatSiblingContext returns empty string when no siblings", () => {
    const context = bus.formatSiblingContext("nonexistent-task", "nobody");
    expect(context).toBe("");
  });
});
