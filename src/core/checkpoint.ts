import type { Checkpoint } from "../config/types.ts";
import type { Store } from "../db/store.ts";
import { eventBus } from "./events.ts";

export class CheckpointManager {
  private autoInterval: number;
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(
    private store: Store,
    private workDir: string,
    options?: { autoIntervalMs?: number },
  ) {
    this.autoInterval = options?.autoIntervalMs ?? 0; // 0 = disabled
  }

  async create(taskId: string, agentName: string, label: string, metadata?: Record<string, unknown>): Promise<Checkpoint> {
    const sha = await this.captureGitState(agentName);
    const cp: Checkpoint = {
      id: `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      taskId,
      agentName,
      sha,
      label,
      metadata: metadata ?? {},
      createdAt: new Date().toISOString(),
    };

    this.store.saveCheckpoint(cp);
    return cp;
  }

  async rollback(checkpointId: string): Promise<boolean> {
    const checkpoints = this.listAll();
    const cp = checkpoints.find((c) => c.id === checkpointId);
    if (!cp) return false;

    try {
      const proc = Bun.spawn(
        ["git", "checkout", cp.sha, "--", "."],
        { cwd: this.workDir, stdout: "pipe", stderr: "pipe" },
      );
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  }

  async rollbackToLatest(taskId: string): Promise<boolean> {
    const latest = this.store.getLatestCheckpoint(taskId);
    if (!latest) return false;
    return this.rollback(latest.id);
  }

  list(taskId: string): Checkpoint[] {
    return this.store.getCheckpoints(taskId);
  }

  getLatest(taskId: string): Checkpoint | null {
    return this.store.getLatestCheckpoint(taskId);
  }

  startAutoCheckpoint(taskId: string, agentName: string): void {
    if (this.autoInterval <= 0) return;
    if (this.timers.has(taskId)) return;

    let counter = 0;
    const timer = setInterval(async () => {
      counter++;
      try {
        await this.create(taskId, agentName, `auto-${counter}`);
      } catch {
        // git state may be dirty or unavailable
      }
    }, this.autoInterval);

    this.timers.set(taskId, timer);
  }

  stopAutoCheckpoint(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(taskId);
    }
  }

  stopAll(): void {
    for (const [taskId, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  private listAll(): Checkpoint[] {
    // Get all checkpoints (use a broad query since we don't have a specific task)
    // This is a fallback; prefer list(taskId) when possible
    return this.store.getCheckpoints("");
  }

  private async captureGitState(label: string): Promise<string> {
    try {
      // Stage everything and create a temporary commit object (doesn't affect HEAD)
      const treeProc = Bun.spawn(
        ["git", "stash", "create", `checkpoint: ${label}`],
        { cwd: this.workDir, stdout: "pipe", stderr: "pipe" },
      );
      const sha = (await new Response(treeProc.stdout).text()).trim();
      if (sha) return sha;

      // If stash create returns empty, working tree is clean — use HEAD
      const headProc = Bun.spawn(
        ["git", "rev-parse", "HEAD"],
        { cwd: this.workDir, stdout: "pipe", stderr: "pipe" },
      );
      return (await new Response(headProc.stdout).text()).trim();
    } catch {
      return "unknown";
    }
  }
}
