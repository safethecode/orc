import { describe, it, expect, beforeEach } from "bun:test";
import { DistributedTracer } from "../src/core/distributed-trace.ts";

describe("DistributedTracer", () => {
  let tracer: DistributedTracer;

  beforeEach(() => {
    tracer = new DistributedTracer(10);
  });

  describe("startTrace", () => {
    it("creates a root span with valid hex IDs", () => {
      const ctx = tracer.startTrace("supervisor.execute", "supervisor");
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it("root span has null parentSpanId", () => {
      const ctx = tracer.startTrace("supervisor.execute", "supervisor");
      const span = tracer.getSpan(ctx.spanId);
      expect(span).toBeDefined();
      expect(span!.parentSpanId).toBeNull();
    });

    it("root span starts as active with ok status", () => {
      const ctx = tracer.startTrace("supervisor.execute", "supervisor");
      const span = tracer.getSpan(ctx.spanId);
      expect(span!.status).toBe("ok");
      expect(span!.endTime).toBeNull();
      expect(span!.durationMs).toBeNull();
    });

    it("tags are stored on the span", () => {
      const ctx = tracer.startTrace("supervisor.execute", "supervisor", {
        taskId: "t-123",
        promptLength: 500,
      });
      const span = tracer.getSpan(ctx.spanId);
      expect(span!.tags["taskId"]).toBe("t-123");
      expect(span!.tags["promptLength"]).toBe(500);
    });
  });

  describe("startSpan", () => {
    it("creates a child span with correct parent", () => {
      const rootCtx = tracer.startTrace("supervisor.execute", "supervisor");
      const childCtx = tracer.startSpan(rootCtx, "decomposer.decompose", "decomposer");

      expect(childCtx.traceId).toBe(rootCtx.traceId);
      expect(childCtx.spanId).not.toBe(rootCtx.spanId);

      const child = tracer.getSpan(childCtx.spanId);
      expect(child!.parentSpanId).toBe(rootCtx.spanId);
    });

    it("child span IDs are valid hex", () => {
      const rootCtx = tracer.startTrace("test", "svc");
      const childCtx = tracer.startSpan(rootCtx, "child.op", "child-svc");
      expect(childCtx.spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it("supports deep nesting", () => {
      const root = tracer.startTrace("root", "svc-a");
      const child1 = tracer.startSpan(root, "child1", "svc-b");
      const child2 = tracer.startSpan(child1, "child2", "svc-c");
      const child3 = tracer.startSpan(child2, "child3", "svc-d");

      const span3 = tracer.getSpan(child3.spanId);
      expect(span3!.parentSpanId).toBe(child2.spanId);

      const trace = tracer.getTrace(root.traceId);
      expect(trace).toHaveLength(4);
    });
  });

  describe("endSpan", () => {
    it("records duration and removes from active", () => {
      const ctx = tracer.startTrace("test", "svc");
      expect(tracer.getActiveSpans()).toHaveLength(1);

      tracer.endSpan(ctx.spanId, "ok");

      expect(tracer.getActiveSpans()).toHaveLength(0);
      const span = tracer.getSpan(ctx.spanId);
      expect(span!.endTime).not.toBeNull();
      expect(span!.durationMs).toBeGreaterThanOrEqual(0);
      expect(span!.status).toBe("ok");
    });

    it("records error status and message", () => {
      const ctx = tracer.startTrace("test", "svc");
      tracer.endSpan(ctx.spanId, "error", "Something went wrong");

      const span = tracer.getSpan(ctx.spanId);
      expect(span!.status).toBe("error");
      expect(span!.tags["error.message"]).toBe("Something went wrong");
    });

    it("records cancelled status", () => {
      const ctx = tracer.startTrace("test", "svc");
      tracer.endSpan(ctx.spanId, "cancelled");

      const span = tracer.getSpan(ctx.spanId);
      expect(span!.status).toBe("cancelled");
    });

    it("no-ops on unknown span ID", () => {
      tracer.endSpan("nonexistent-id");
      // Should not throw
    });
  });

  describe("addEvent", () => {
    it("adds timestamped events to spans", () => {
      const ctx = tracer.startTrace("test", "svc");
      tracer.addEvent(ctx.spanId, "tool.used", { tool: "write", file: "test.ts" });
      tracer.addEvent(ctx.spanId, "error.detected", { code: 404 });

      const span = tracer.getSpan(ctx.spanId);
      expect(span!.events).toHaveLength(2);
      expect(span!.events[0].name).toBe("tool.used");
      expect(span!.events[0].attributes["tool"]).toBe("write");
      expect(span!.events[1].name).toBe("error.detected");
      expect(span!.events[1].attributes["code"]).toBe(404);
    });

    it("events have valid timestamps", () => {
      const before = Date.now();
      const ctx = tracer.startTrace("test", "svc");
      tracer.addEvent(ctx.spanId, "evt");
      const after = Date.now();

      const span = tracer.getSpan(ctx.spanId);
      expect(span!.events[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(span!.events[0].timestamp).toBeLessThanOrEqual(after);
    });

    it("works on ended spans too", () => {
      const ctx = tracer.startTrace("test", "svc");
      tracer.endSpan(ctx.spanId);
      tracer.addEvent(ctx.spanId, "late-event");

      const span = tracer.getSpan(ctx.spanId);
      expect(span!.events).toHaveLength(1);
    });
  });

  describe("addTags", () => {
    it("adds tags to existing span", () => {
      const ctx = tracer.startTrace("test", "svc", { initial: true });
      tracer.addTags(ctx.spanId, { taskId: "t-456", count: 3 });

      const span = tracer.getSpan(ctx.spanId);
      expect(span!.tags["initial"]).toBe(true);
      expect(span!.tags["taskId"]).toBe("t-456");
      expect(span!.tags["count"]).toBe(3);
    });

    it("overwrites existing tags", () => {
      const ctx = tracer.startTrace("test", "svc", { key: "old" });
      tracer.addTags(ctx.spanId, { key: "new" });

      const span = tracer.getSpan(ctx.spanId);
      expect(span!.tags["key"]).toBe("new");
    });
  });

  describe("getTrace", () => {
    it("returns all spans in a trace", () => {
      const root = tracer.startTrace("root", "svc");
      tracer.startSpan(root, "child1", "svc");
      tracer.startSpan(root, "child2", "svc");

      const spans = tracer.getTrace(root.traceId);
      expect(spans).toHaveLength(3);
    });

    it("returns undefined for nonexistent trace", () => {
      expect(tracer.getTrace("nonexistent")).toBeUndefined();
    });
  });

  describe("getActiveSpans", () => {
    it("returns only active (unfinished) spans", () => {
      const root = tracer.startTrace("root", "svc");
      const child = tracer.startSpan(root, "child", "svc");

      expect(tracer.getActiveSpans()).toHaveLength(2);

      tracer.endSpan(child.spanId);
      expect(tracer.getActiveSpans()).toHaveLength(1);

      tracer.endSpan(root.spanId);
      expect(tracer.getActiveSpans()).toHaveLength(0);
    });

    it("contains no stale entries after clearing", () => {
      tracer.startTrace("test", "svc");
      expect(tracer.getActiveSpans()).toHaveLength(1);

      tracer.clear();
      expect(tracer.getActiveSpans()).toHaveLength(0);
    });
  });

  describe("getRecentTraces", () => {
    it("returns traces sorted newest first", () => {
      // Manually set different start times to ensure deterministic ordering
      const ctx1 = tracer.startTrace("first", "svc");
      const span1 = tracer.getSpan(ctx1.spanId)!;
      span1.startTime = 1000;

      const ctx2 = tracer.startTrace("second", "svc");
      const span2 = tracer.getSpan(ctx2.spanId)!;
      span2.startTime = 2000;

      const ctx3 = tracer.startTrace("third", "svc");
      const span3 = tracer.getSpan(ctx3.spanId)!;
      span3.startTime = 3000;

      const recent = tracer.getRecentTraces(10);
      expect(recent).toHaveLength(3);
      expect(recent[0].rootOperation).toBe("third");
      expect(recent[2].rootOperation).toBe("first");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) tracer.startTrace(`op-${i}`, "svc");
      const recent = tracer.getRecentTraces(2);
      expect(recent).toHaveLength(2);
    });

    it("reports correct status", () => {
      const ctx1 = tracer.startTrace("ok-trace", "svc");
      tracer.endSpan(ctx1.spanId, "ok");

      const ctx2 = tracer.startTrace("err-trace", "svc");
      tracer.endSpan(ctx2.spanId, "error");

      const ctx3 = tracer.startTrace("in-progress-trace", "svc");

      const recent = tracer.getRecentTraces(10);
      const inProgress = recent.find(t => t.rootOperation === "in-progress-trace");
      const okTrace = recent.find(t => t.rootOperation === "ok-trace");
      const errTrace = recent.find(t => t.rootOperation === "err-trace");

      expect(inProgress!.status).toBe("in_progress");
      expect(okTrace!.status).toBe("ok");
      expect(errTrace!.status).toBe("error");
    });

    it("lists unique services", () => {
      const root = tracer.startTrace("multi", "svc-a");
      tracer.startSpan(root, "child", "svc-b");
      tracer.startSpan(root, "child2", "svc-a");

      const recent = tracer.getRecentTraces(10);
      expect(recent[0].services).toContain("svc-a");
      expect(recent[0].services).toContain("svc-b");
      expect(recent[0].services).toHaveLength(2);
    });
  });

  describe("formatTrace", () => {
    it("produces a tree-like output", () => {
      const root = tracer.startTrace("supervisor.execute", "supervisor");
      const child1 = tracer.startSpan(root, "decomposer.decompose", "decomposer");
      const grandchild = tracer.startSpan(child1, "domain.detect", "decomposer");
      tracer.endSpan(grandchild.spanId);
      tracer.endSpan(child1.spanId);
      const child2 = tracer.startSpan(root, "worker.run", "worker-pool");
      tracer.endSpan(child2.spanId);
      tracer.endSpan(root.spanId);

      const output = tracer.formatTrace(root.traceId);
      expect(output).toContain("supervisor.execute");
      expect(output).toContain("decomposer.decompose");
      expect(output).toContain("domain.detect");
      expect(output).toContain("worker.run");
      expect(output).toContain("OK");
    });

    it("shows RUNNING for active spans", () => {
      const root = tracer.startTrace("test", "svc");
      tracer.startSpan(root, "still-going", "svc");

      const output = tracer.formatTrace(root.traceId);
      expect(output).toContain("RUNNING");
    });

    it("shows ERROR for failed spans", () => {
      const root = tracer.startTrace("test", "svc");
      const child = tracer.startSpan(root, "failed-op", "svc");
      tracer.endSpan(child.spanId, "error");
      tracer.endSpan(root.spanId, "error");

      const output = tracer.formatTrace(root.traceId);
      expect(output).toContain("ERROR");
    });

    it("returns empty message for unknown trace", () => {
      const output = tracer.formatTrace("nonexistent");
      expect(output).toContain("(empty)");
    });

    it("handles deep nesting with proper indentation", () => {
      const root = tracer.startTrace("root", "svc");
      const l1 = tracer.startSpan(root, "level1", "svc");
      const l2 = tracer.startSpan(l1, "level2", "svc");
      const l3 = tracer.startSpan(l2, "level3", "svc");
      tracer.endSpan(l3.spanId);
      tracer.endSpan(l2.spanId);
      tracer.endSpan(l1.spanId);
      tracer.endSpan(root.spanId);

      const output = tracer.formatTrace(root.traceId);
      // All levels should be present
      expect(output).toContain("level1");
      expect(output).toContain("level2");
      expect(output).toContain("level3");
    });
  });

  describe("search", () => {
    it("finds spans by operation name", () => {
      const root = tracer.startTrace("supervisor.execute", "supervisor");
      tracer.startSpan(root, "decomposer.decompose", "decomposer");
      tracer.startSpan(root, "worker.run", "worker-pool");

      const results = tracer.search({ operationName: "decomposer" });
      expect(results).toHaveLength(1);
      expect(results[0].operationName).toBe("decomposer.decompose");
    });

    it("finds spans by service name", () => {
      const root = tracer.startTrace("root", "supervisor");
      tracer.startSpan(root, "op1", "worker-pool");
      tracer.startSpan(root, "op2", "worker-pool");

      const results = tracer.search({ serviceName: "worker-pool" });
      expect(results).toHaveLength(2);
    });

    it("finds spans by status", () => {
      const root = tracer.startTrace("root", "svc");
      const child = tracer.startSpan(root, "failed-op", "svc");
      tracer.endSpan(child.spanId, "error");
      tracer.endSpan(root.spanId, "ok");

      const errors = tracer.search({ status: "error" });
      expect(errors).toHaveLength(1);
      expect(errors[0].operationName).toBe("failed-op");
    });

    it("finds spans by tag", () => {
      const root = tracer.startTrace("root", "svc", { taskId: "t-123" });
      tracer.startSpan(root, "child", "svc");

      const results = tracer.search({ tag: { key: "taskId", value: "t-123" } });
      expect(results).toHaveLength(1);
    });

    it("finds spans by minimum duration", () => {
      const root = tracer.startTrace("root", "svc");
      const fast = tracer.startSpan(root, "fast-op", "svc");
      tracer.endSpan(fast.spanId); // very fast

      // Manually set duration on span for deterministic test
      const fastSpan = tracer.getSpan(fast.spanId);
      fastSpan!.durationMs = 5;

      const slow = tracer.startSpan(root, "slow-op", "svc");
      tracer.endSpan(slow.spanId);
      const slowSpan = tracer.getSpan(slow.spanId);
      slowSpan!.durationMs = 500;

      const results = tracer.search({ minDurationMs: 100 });
      expect(results).toHaveLength(1);
      expect(results[0].operationName).toBe("slow-op");
    });

    it("combines multiple search criteria", () => {
      const root = tracer.startTrace("root", "supervisor");
      const c1 = tracer.startSpan(root, "worker.run", "worker-pool");
      tracer.endSpan(c1.spanId, "ok");
      const c2 = tracer.startSpan(root, "worker.run", "worker-pool");
      tracer.endSpan(c2.spanId, "error");

      const results = tracer.search({
        operationName: "worker",
        serviceName: "worker-pool",
        status: "error",
      });
      expect(results).toHaveLength(1);
    });
  });

  describe("eviction", () => {
    it("evicts oldest completed traces when maxTraces exceeded", () => {
      const smallTracer = new DistributedTracer(3);

      const ctx1 = smallTracer.startTrace("trace1", "svc");
      smallTracer.endSpan(ctx1.spanId);

      const ctx2 = smallTracer.startTrace("trace2", "svc");
      smallTracer.endSpan(ctx2.spanId);

      const ctx3 = smallTracer.startTrace("trace3", "svc");
      smallTracer.endSpan(ctx3.spanId);

      // This should trigger eviction of trace1
      smallTracer.startTrace("trace4", "svc");

      expect(smallTracer.getTrace(ctx1.traceId)).toBeUndefined();
      expect(smallTracer.getTrace(ctx2.traceId)).toBeDefined();
    });

    it("does not evict traces with active spans", () => {
      const smallTracer = new DistributedTracer(2);

      // trace1 is still active (no endSpan)
      const ctx1 = smallTracer.startTrace("active-trace", "svc");

      const ctx2 = smallTracer.startTrace("completed-trace", "svc");
      smallTracer.endSpan(ctx2.spanId);

      // Trigger eviction — should evict completed, not active
      smallTracer.startTrace("new-trace", "svc");

      expect(smallTracer.getTrace(ctx1.traceId)).toBeDefined();
      expect(smallTracer.getTrace(ctx2.traceId)).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("removes all traces and active spans", () => {
      const root = tracer.startTrace("test", "svc");
      tracer.startSpan(root, "child", "svc");

      tracer.clear();

      expect(tracer.getActiveSpans()).toHaveLength(0);
      expect(tracer.getTrace(root.traceId)).toBeUndefined();
      expect(tracer.getRecentTraces()).toHaveLength(0);
    });
  });

  describe("parent-child relationships", () => {
    it("maintains correct tree structure", () => {
      const root = tracer.startTrace("root", "svc");
      const a = tracer.startSpan(root, "a", "svc");
      const b = tracer.startSpan(root, "b", "svc");
      const a1 = tracer.startSpan(a, "a1", "svc");
      const a2 = tracer.startSpan(a, "a2", "svc");

      const spanA = tracer.getSpan(a.spanId);
      const spanB = tracer.getSpan(b.spanId);
      const spanA1 = tracer.getSpan(a1.spanId);
      const spanA2 = tracer.getSpan(a2.spanId);

      expect(spanA!.parentSpanId).toBe(root.spanId);
      expect(spanB!.parentSpanId).toBe(root.spanId);
      expect(spanA1!.parentSpanId).toBe(a.spanId);
      expect(spanA2!.parentSpanId).toBe(a.spanId);
    });
  });

  describe("trace ID format", () => {
    it("trace IDs are 32-char hex (128-bit, OpenTelemetry compatible)", () => {
      for (let i = 0; i < 10; i++) {
        const ctx = tracer.startTrace("test", "svc");
        expect(ctx.traceId).toHaveLength(32);
        expect(ctx.traceId).toMatch(/^[0-9a-f]+$/);
      }
    });

    it("span IDs are 16-char hex (64-bit, OpenTelemetry compatible)", () => {
      for (let i = 0; i < 10; i++) {
        const ctx = tracer.startTrace("test", "svc");
        expect(ctx.spanId).toHaveLength(16);
        expect(ctx.spanId).toMatch(/^[0-9a-f]+$/);
      }
    });

    it("all IDs are unique", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const ctx = tracer.startTrace("test", "svc");
        ids.add(ctx.traceId);
        ids.add(ctx.spanId);
      }
      expect(ids.size).toBe(100); // 50 trace IDs + 50 span IDs
    });
  });
});
