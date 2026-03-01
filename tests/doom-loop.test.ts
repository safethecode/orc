import { describe, test, expect } from "bun:test";
import { DoomLoopDetector } from "../src/core/doom-loop.ts";

describe("DoomLoopDetector", () => {
  test("should be enabled by default", () => {
    const detector = new DoomLoopDetector();
    expect(detector.isEnabled()).toBe(true);
  });

  test("should accept enabled config", () => {
    const detector = new DoomLoopDetector({ enabled: false });
    expect(detector.isEnabled()).toBe(false);
  });

  test("should detect repetitions when enabled", () => {
    const detector = new DoomLoopDetector({ enabled: true, maxRepetitions: 3 });

    detector.record("read", "file.txt");
    detector.record("read", "file.txt");
    const result = detector.record("read", "file.txt");

    expect(result.triggered).toBe(true);
    expect(result.count).toBe(3);
    expect(result.tool).toBe("read");
  });

  test("should not detect repetitions when disabled", () => {
    const detector = new DoomLoopDetector({ enabled: false, maxRepetitions: 3 });

    detector.record("read", "file.txt");
    detector.record("read", "file.txt");
    detector.record("read", "file.txt");
    detector.record("read", "file.txt");
    const result = detector.record("read", "file.txt");

    expect(result.triggered).toBe(false);
    expect(result.count).toBe(0);
  });

  test("should allow enabling/disabling dynamically", () => {
    const detector = new DoomLoopDetector({ enabled: true, maxRepetitions: 3 });

    expect(detector.isEnabled()).toBe(true);

    detector.disable();
    expect(detector.isEnabled()).toBe(false);

    // Should not trigger when disabled (and not record in history)
    detector.record("read", "file.txt");
    detector.record("read", "file.txt");
    detector.record("read", "file.txt");
    const result1 = detector.record("read", "file.txt");
    expect(result1.triggered).toBe(false);
    expect(result1.count).toBe(0);

    detector.enable();
    expect(detector.isEnabled()).toBe(true);

    // When re-enabled, history is still empty (no recording happened while disabled)
    // So we need to record 3 times to trigger
    detector.record("read", "file.txt"); // 1st call after re-enable
    detector.record("read", "file.txt"); // 2nd call
    const result2 = detector.record("read", "file.txt"); // 3rd call - should trigger
    expect(result2.triggered).toBe(true);
    expect(result2.count).toBe(3);
  });

  test("should reset history", () => {
    const detector = new DoomLoopDetector({ enabled: true, maxRepetitions: 3 });

    detector.record("read", "file.txt");
    detector.record("read", "file.txt");

    detector.reset();

    // After reset, count should start from 0
    const result = detector.record("read", "file.txt");
    expect(result.triggered).toBe(false);
    expect(result.count).toBe(1);
  });
});
