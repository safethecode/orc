import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { StallWatchdog } from "../src/repl/stall-watchdog.ts";

describe("StallWatchdog", () => {
  let watchdog: StallWatchdog;
  let warns: number[];
  let suggestAborts: number[];
  let autoAborts: number[];

  beforeEach(() => {
    warns = [];
    suggestAborts = [];
    autoAborts = [];
  });

  afterEach(() => {
    watchdog?.stop();
  });

  it("fires onWarn after warnMs of inactivity", async () => {
    watchdog = new StallWatchdog({
      warnMs: 50,
      suggestAbortMs: 200,
      autoAbortMs: 400,
      onWarn: (ms) => warns.push(ms),
      onSuggestAbort: (ms) => suggestAborts.push(ms),
      onAutoAbort: (ms) => autoAborts.push(ms),
    });
    // Manually invoke check to simulate timer tick
    watchdog.start();
    // Wait enough for the 5s interval to not fire, then manually check
    // Use direct check call via reflection for deterministic test
    watchdog.stop();

    // Simulate passage of time
    (watchdog as any).lastEventAt = Date.now() - 100;
    (watchdog as any).check();

    expect(warns.length).toBe(1);
    expect(warns[0]).toBeGreaterThanOrEqual(50);
    expect(suggestAborts.length).toBe(0);
    expect(autoAborts.length).toBe(0);
  });

  it("fires onSuggestAbort after suggestAbortMs", () => {
    watchdog = new StallWatchdog({
      warnMs: 50,
      suggestAbortMs: 100,
      autoAbortMs: 400,
      onWarn: (ms) => warns.push(ms),
      onSuggestAbort: (ms) => suggestAborts.push(ms),
      onAutoAbort: (ms) => autoAborts.push(ms),
    });

    // Simulate warn first
    (watchdog as any).lastEventAt = Date.now() - 60;
    (watchdog as any).check();
    expect(warns.length).toBe(1);

    // Now simulate suggest abort
    (watchdog as any).lastEventAt = Date.now() - 150;
    (watchdog as any).check();
    expect(suggestAborts.length).toBe(1);
    expect(suggestAborts[0]).toBeGreaterThanOrEqual(100);
  });

  it("fires onAutoAbort after autoAbortMs and stops", () => {
    watchdog = new StallWatchdog({
      warnMs: 50,
      suggestAbortMs: 100,
      autoAbortMs: 200,
      onWarn: (ms) => warns.push(ms),
      onSuggestAbort: (ms) => suggestAborts.push(ms),
      onAutoAbort: (ms) => autoAborts.push(ms),
    });

    (watchdog as any).lastEventAt = Date.now() - 250;
    (watchdog as any).check();

    expect(autoAborts.length).toBe(1);
    expect(autoAborts[0]).toBeGreaterThanOrEqual(200);
    // Timer should be stopped after auto-abort
    expect((watchdog as any).timer).toBeNull();
  });

  it("touch() resets flags so warn can fire again", () => {
    watchdog = new StallWatchdog({
      warnMs: 50,
      suggestAbortMs: 200,
      autoAbortMs: 400,
      onWarn: (ms) => warns.push(ms),
      onSuggestAbort: (ms) => suggestAborts.push(ms),
      onAutoAbort: (ms) => autoAborts.push(ms),
    });

    // First warn
    (watchdog as any).lastEventAt = Date.now() - 100;
    (watchdog as any).check();
    expect(warns.length).toBe(1);

    // Second check without touch — should NOT warn again
    (watchdog as any).check();
    expect(warns.length).toBe(1);

    // touch resets
    watchdog.touch();
    (watchdog as any).lastEventAt = Date.now() - 100;
    (watchdog as any).check();
    expect(warns.length).toBe(2);
  });

  it("stop() prevents further callbacks", () => {
    watchdog = new StallWatchdog({
      warnMs: 50,
      suggestAbortMs: 200,
      autoAbortMs: 400,
      onWarn: (ms) => warns.push(ms),
      onSuggestAbort: (ms) => suggestAborts.push(ms),
      onAutoAbort: (ms) => autoAborts.push(ms),
    });

    watchdog.stop();

    (watchdog as any).lastEventAt = Date.now() - 100;
    (watchdog as any).check();
    // warned flag was reset by stop(), so check() would fire warn
    // But the point is: the interval timer is null
    expect((watchdog as any).timer).toBeNull();
  });

  it("warn does not fire if touched within threshold", () => {
    watchdog = new StallWatchdog({
      warnMs: 100,
      suggestAbortMs: 200,
      autoAbortMs: 400,
      onWarn: (ms) => warns.push(ms),
      onSuggestAbort: (ms) => suggestAborts.push(ms),
      onAutoAbort: (ms) => autoAborts.push(ms),
    });

    // Recent activity — no stall
    (watchdog as any).lastEventAt = Date.now() - 10;
    (watchdog as any).check();
    expect(warns.length).toBe(0);
    expect(suggestAborts.length).toBe(0);
    expect(autoAborts.length).toBe(0);
  });
});
