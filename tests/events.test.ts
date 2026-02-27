import { describe, it, expect, mock } from "bun:test";
import { OrcEventBus } from "../src/core/events.ts";

describe("OrcEventBus", () => {
  it("publish + on event delivery", () => {
    const bus = new OrcEventBus();
    const received: unknown[] = [];

    bus.on("agent:start", (e) => received.push(e));
    bus.publish({
      type: "agent:start",
      agent: "test",
      tier: "sonnet",
      reason: "test run",
    });

    expect(received).toHaveLength(1);
    expect((received[0] as any).agent).toBe("test");
    expect((received[0] as any).tier).toBe("sonnet");
  });

  it("multiple listeners receive same event", () => {
    const bus = new OrcEventBus();
    const listenerA = mock(() => {});
    const listenerB = mock(() => {});

    bus.on("agent:done", listenerA as any);
    bus.on("agent:done", listenerB as any);

    bus.publish({
      type: "agent:done",
      agent: "test",
      cost: 0.01,
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 1000,
    });

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  it("removeListener stops delivery", () => {
    const bus = new OrcEventBus();
    const handler = mock(() => {});

    bus.on("agent:error", handler as any);

    bus.publish({ type: "agent:error", agent: "test", message: "fail" });
    expect(handler).toHaveBeenCalledTimes(1);

    bus.removeListener("agent:error", handler as any);

    bus.publish({ type: "agent:error", agent: "test", message: "fail again" });
    expect(handler).toHaveBeenCalledTimes(1); // still 1
  });

  it("different event types do not cross", () => {
    const bus = new OrcEventBus();
    const startHandler = mock(() => {});
    const errorHandler = mock(() => {});

    bus.on("agent:start", startHandler as any);
    bus.on("agent:error", errorHandler as any);

    bus.publish({
      type: "agent:start",
      agent: "a",
      tier: "sonnet",
      reason: "test",
    });

    expect(startHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledTimes(0);
  });

  it("wildcard * receives all events", () => {
    const bus = new OrcEventBus();
    const allEvents: unknown[] = [];

    bus.on("*", (e) => allEvents.push(e));

    bus.publish({
      type: "agent:start",
      agent: "a",
      tier: "haiku",
      reason: "",
    });
    bus.publish({ type: "agent:error", agent: "b", message: "err" });

    expect(allEvents).toHaveLength(2);
    expect((allEvents[0] as any).type).toBe("agent:start");
    expect((allEvents[1] as any).type).toBe("agent:error");
  });
});
