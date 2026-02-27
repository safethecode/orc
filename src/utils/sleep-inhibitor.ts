export class SleepInhibitor {
  private proc: ReturnType<typeof Bun.spawn> | null = null;

  get active(): boolean {
    return this.proc !== null;
  }

  acquire(): void {
    if (this.proc) return;
    if (process.platform !== "darwin") return;

    this.proc = Bun.spawn(["caffeinate", "-i"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  release(): void {
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
  }
}
