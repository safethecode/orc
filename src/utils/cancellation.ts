export class CancellationToken {
  private controller: AbortController;

  constructor() {
    this.controller = new AbortController();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  cancel(): void {
    this.controller.abort();
  }

  throwIfCancelled(): void {
    if (this.cancelled) {
      throw new Error("Operation cancelled");
    }
  }

  static child(parent: CancellationToken): CancellationToken {
    const child = new CancellationToken();
    if (parent.cancelled) {
      child.cancel();
    } else {
      parent.signal.addEventListener("abort", () => child.cancel(), {
        once: true,
      });
    }
    return child;
  }
}
