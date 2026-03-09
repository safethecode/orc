/**
 * Activity phases determine how long silence is "normal".
 *
 * - init:      Waiting for first API token — Opus can take 1-3 min.
 * - post_tool: Tool just executed, waiting for next API response.
 * - streaming:  Was actively receiving text — silence is abnormal.
 */
export type StallPhase = "init" | "post_tool" | "streaming";

export interface StallWatchdogOptions {
  onWarn: (elapsedMs: number, phase: StallPhase) => void;
  onAutoAbort: (elapsedMs: number, phase: StallPhase) => void;
}

const PHASE_THRESHOLDS: Record<StallPhase, { warnMs: number; abortMs: number }> = {
  init:      { warnMs: 180_000, abortMs: 300_000 }, // 3m warn, 5m abort
  post_tool: { warnMs: 120_000, abortMs: 240_000 }, // 2m warn, 4m abort
  streaming: { warnMs:  60_000, abortMs: 180_000 }, // 1m warn, 3m abort
};

/**
 * Phase-aware stall detector for single-agent streamer.
 * Thresholds adapt based on what the agent was doing when it went silent.
 */
export class StallWatchdog {
  private lastEventAt = Date.now();
  private phase: StallPhase = "init";
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = false;

  private readonly onWarn: (ms: number, phase: StallPhase) => void;
  private readonly onAutoAbort: (ms: number, phase: StallPhase) => void;

  constructor(opts: StallWatchdogOptions) {
    this.onWarn = opts.onWarn;
    this.onAutoAbort = opts.onAutoAbort;
  }

  /** Update activity timestamp and phase. */
  touch(phase?: StallPhase): void {
    this.lastEventAt = Date.now();
    if (phase) this.phase = phase;
    this.warned = false;
  }

  /** Begin monitoring. Checks every 5 seconds. */
  start(): void {
    this.lastEventAt = Date.now();
    this.phase = "init";
    this.warned = false;
    this.timer = setInterval(() => this.check(), 5_000);
  }

  /** Stop monitoring and clean up. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.warned = false;
  }

  private check(): void {
    const elapsed = Date.now() - this.lastEventAt;
    const thresholds = PHASE_THRESHOLDS[this.phase];

    if (elapsed >= thresholds.abortMs) {
      this.onAutoAbort(elapsed, this.phase);
      this.stop();
      return;
    }

    if (elapsed >= thresholds.warnMs && !this.warned) {
      this.warned = true;
      this.onWarn(elapsed, this.phase);
    }
  }
}
