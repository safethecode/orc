export class PasteDetector {
  private timestamps: number[] = [];
  private readonly burstThresholdMs: number;
  private readonly burstMinChars: number;

  constructor(thresholdMs = 5, minChars = 4) {
    this.burstThresholdMs = thresholdMs;
    this.burstMinChars = minChars;
  }

  recordKeystroke(): boolean {
    const now = Date.now();
    this.timestamps.push(now);
    if (this.timestamps.length > 20) this.timestamps.shift();

    if (this.timestamps.length < this.burstMinChars) return false;
    const recent = this.timestamps.slice(-this.burstMinChars);
    const avgInterval =
      (recent[recent.length - 1] - recent[0]) / (recent.length - 1);
    return avgInterval < this.burstThresholdMs;
  }

  reset(): void {
    this.timestamps = [];
  }
}
