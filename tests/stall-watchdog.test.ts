import { describe, it, expect, afterEach } from "bun:test";
import { StallWatchdog, type StallPhase } from "../src/repl/stall-watchdog.ts";

describe("StallWatchdog", () => {
  let watchdog: StallWatchdog;
  let warns: Array<{ ms: number; phase: StallPhase }>;
  let aborts: Array<{ ms: number; phase: StallPhase }>;

  function create() {
    warns = [];
    aborts = [];
    watchdog = new StallWatchdog({
      onWarn: (ms, phase) => warns.push({ ms, phase }),
      onAutoAbort: (ms, phase) => aborts.push({ ms, phase }),
    });
    return watchdog;
  }

  afterEach(() => {
    watchdog?.stop();
  });

  it("init phase: does NOT warn before 180s", () => {
    create();
    // 60s into init — no warning (unlike old 30s threshold)
    (watchdog as any).lastEventAt = Date.now() - 60_000;
    (watchdog as any).check();
    expect(warns.length).toBe(0);
  });

  it("init phase: warns after 180s", () => {
    create();
    (watchdog as any).lastEventAt = Date.now() - 190_000;
    (watchdog as any).check();
    expect(warns.length).toBe(1);
    expect(warns[0].phase).toBe("init");
  });

  it("init phase: aborts after 300s", () => {
    create();
    (watchdog as any).lastEventAt = Date.now() - 310_000;
    (watchdog as any).check();
    expect(aborts.length).toBe(1);
    expect(aborts[0].phase).toBe("init");
  });

  it("streaming phase: warns after 60s", () => {
    create();
    watchdog.touch("streaming");
    (watchdog as any).lastEventAt = Date.now() - 70_000;
    (watchdog as any).check();
    expect(warns.length).toBe(1);
    expect(warns[0].phase).toBe("streaming");
  });

  it("streaming phase: aborts after 180s", () => {
    create();
    watchdog.touch("streaming");
    (watchdog as any).lastEventAt = Date.now() - 190_000;
    (watchdog as any).check();
    expect(aborts.length).toBe(1);
  });

  it("post_tool phase: does NOT warn at 60s (normal tool wait)", () => {
    create();
    watchdog.touch("post_tool");
    (watchdog as any).lastEventAt = Date.now() - 60_000;
    (watchdog as any).check();
    expect(warns.length).toBe(0);
  });

  it("post_tool phase: warns after 120s", () => {
    create();
    watchdog.touch("post_tool");
    (watchdog as any).lastEventAt = Date.now() - 130_000;
    (watchdog as any).check();
    expect(warns.length).toBe(1);
    expect(warns[0].phase).toBe("post_tool");
  });

  it("touch() resets warned flag", () => {
    create();
    watchdog.touch("streaming");
    (watchdog as any).lastEventAt = Date.now() - 70_000;
    (watchdog as any).check();
    expect(warns.length).toBe(1);

    // touch resets — second warn after next stall
    watchdog.touch("streaming");
    (watchdog as any).lastEventAt = Date.now() - 70_000;
    (watchdog as any).check();
    expect(warns.length).toBe(2);
  });

  it("touch(phase) transitions phase", () => {
    create();
    expect((watchdog as any).phase).toBe("init");
    watchdog.touch("post_tool");
    expect((watchdog as any).phase).toBe("post_tool");
    watchdog.touch("streaming");
    expect((watchdog as any).phase).toBe("streaming");
  });

  it("stop() clears timer", () => {
    create();
    watchdog.start();
    expect((watchdog as any).timer).not.toBeNull();
    watchdog.stop();
    expect((watchdog as any).timer).toBeNull();
  });

  it("no warn if activity is recent", () => {
    create();
    watchdog.touch("streaming");
    (watchdog as any).lastEventAt = Date.now() - 5_000;
    (watchdog as any).check();
    expect(warns.length).toBe(0);
    expect(aborts.length).toBe(0);
  });
});
