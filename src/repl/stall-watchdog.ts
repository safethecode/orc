export interface StallWatchdogOptions {
  warnMs?: number;
  suggestAbortMs?: number;
  autoAbortMs?: number;
  onWarn: (elapsedMs: number) => void;
  onSuggestAbort: (elapsedMs: number) => void;
  onAutoAbort: (elapsedMs: number) => void;
}

/**
 * Monitors a single-agent streamer for inactivity.
 * Calls back at escalating thresholds when no events arrive.
 */
export class StallWatchdog {
  private lastEventAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = false;
  private suggestedAbort = false;

  private readonly warnMs: number;
  private readonly suggestAbortMs: number;
  private readonly autoAbortMs: number;
  private readonly onWarn: (ms: number) => void;
  private readonly onSuggestAbort: (ms: number) => void;
  private readonly onAutoAbort: (ms: number) => void;

  constructor(opts: StallWatchdogOptions) {
    this.warnMs = opts.warnMs ?? 30_000;
    this.suggestAbortMs = opts.suggestAbortMs ?? 60_000;
    this.autoAbortMs = opts.autoAbortMs ?? 120_000;
    this.onWarn = opts.onWarn;
    this.onSuggestAbort = opts.onSuggestAbort;
    this.onAutoAbort = opts.onAutoAbort;
  }

  /** Reset inactivity timer — call on every streamer event. */
  touch(): void {
    this.lastEventAt = Date.now();
    this.warned = false;
    this.suggestedAbort = false;
  }

  /** Begin monitoring. Checks every 5 seconds. */
  start(): void {
    this.lastEventAt = Date.now();
    this.timer = setInterval(() => this.check(), 5_000);
  }

  /** Stop monitoring and clean up. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.warned = false;
    this.suggestedAbort = false;
  }

  private check(): void {
    const elapsed = Date.now() - this.lastEventAt;

    if (elapsed >= this.autoAbortMs) {
      this.onAutoAbort(elapsed);
      this.stop();
      return;
    }

    if (elapsed >= this.suggestAbortMs && !this.suggestedAbort) {
      this.suggestedAbort = true;
      this.onSuggestAbort(elapsed);
      return;
    }

    if (elapsed >= this.warnMs && !this.warned) {
      this.warned = true;
      this.onWarn(elapsed);
    }
  }
}
