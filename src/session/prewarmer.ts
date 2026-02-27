export class ConnectionPrewarmer {
  private warmed = false;
  private pending: Promise<void> | null = null;
  private warmHost: string | null = null;

  async prewarm(host = "api.anthropic.com", _port = 443): Promise<void> {
    if (this.warmed && this.warmHost === host) return;

    this.warmHost = host;
    this.pending = Bun.dns
      .lookup(host, { family: 4 })
      .then(() => {
        this.warmed = true;
      })
      .catch(() => {
        this.warmed = false;
      });

    await this.pending;
    this.pending = null;
  }

  cancel(): void {
    this.pending = null;
    this.warmed = false;
    this.warmHost = null;
  }

  get isWarmed(): boolean {
    return this.warmed;
  }
}
