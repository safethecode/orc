export class FrameLimiter {
  private lastFlush = 0;
  private pending: string | null = null;
  private timer: Timer | null = null;

  constructor(private minIntervalMs: number = 16) {}

  write(text: string, flush: (text: string) => void): void {
    this.pending = this.pending ? this.pending + text : text;

    const now = performance.now();
    const elapsed = now - this.lastFlush;

    if (elapsed >= this.minIntervalMs) {
      this.clearTimer();
      this.flush(flush);
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush(flush);
      }, this.minIntervalMs - elapsed);
    }
  }

  drain(flush: (text: string) => void): void {
    this.clearTimer();
    this.flush(flush);
  }

  dispose(): void {
    this.clearTimer();
    this.pending = null;
  }

  private flush(flush: (text: string) => void): void {
    if (this.pending) {
      const text = this.pending;
      this.pending = null;
      this.lastFlush = performance.now();
      flush(text);
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
