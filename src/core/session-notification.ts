export class SessionNotifier {
  private lastNotification: Map<string, number> = new Map();
  private dedupeIntervalMs = 30_000;

  constructor() {}

  notify(title: string, body: string): void {
    if (this.shouldDedup(title)) return;

    this.lastNotification.set(title, Date.now());

    switch (this.platform) {
      case "macos":
        this.sendMacOS(title, body);
        break;
      case "linux":
        this.sendLinux(title, body);
        break;
      default:
        // Unsupported platform — silently skip
        break;
    }
  }

  private sendMacOS(title: string, body: string): void {
    const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const escapedBody = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const proc = Bun.spawn([
      "osascript",
      "-e",
      `display notification "${escapedBody}" with title "${escapedTitle}"`,
    ], {
      stdout: "ignore",
      stderr: "ignore",
    });

    proc.unref();
  }

  private sendLinux(title: string, body: string): void {
    const proc = Bun.spawn(["notify-send", title, body], {
      stdout: "ignore",
      stderr: "ignore",
    });

    proc.unref();
  }

  private shouldDedup(title: string): boolean {
    const last = this.lastNotification.get(title);
    if (last === undefined) return false;
    return Date.now() - last < this.dedupeIntervalMs;
  }

  private get platform(): "macos" | "linux" | "unsupported" {
    if (process.platform === "darwin") return "macos";
    if (process.platform === "linux") return "linux";
    return "unsupported";
  }
}
