import { eventBus } from "./events.ts";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export interface WorktreeInfo {
  path: string;
  branch: string;
  agentId?: string;
  createdAt: string;
  head?: string;
}

export class GitWorktreeManager {
  private worktrees: Map<string, WorktreeInfo> = new Map();
  private baseDir: string;
  private worktreeDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? process.cwd();
    this.worktreeDir = join(this.baseDir, ".orchestrator", "worktrees");
  }

  async create(agentId: string, branch?: string): Promise<WorktreeInfo> {
    await mkdir(this.worktreeDir, { recursive: true });

    const timestamp = Date.now().toString(36);
    const branchName = branch ?? `orc-${agentId}-${timestamp}`;
    const worktreePath = this.getWorktreePath(agentId);

    const { exitCode, stdout } = await this.git(
      ["worktree", "add", worktreePath, "-b", branchName],
      this.baseDir,
    );

    if (exitCode !== 0) {
      throw new Error(`Failed to create worktree for agent ${agentId}: ${stdout}`);
    }

    // Get HEAD commit hash of the new worktree
    let head: string | undefined;
    try {
      const result = await this.git(["rev-parse", "HEAD"], worktreePath);
      if (result.exitCode === 0) head = result.stdout.trim();
    } catch {
      // Non-critical — worktree still created
    }

    const info: WorktreeInfo = {
      path: worktreePath,
      branch: branchName,
      agentId,
      createdAt: new Date().toISOString(),
      head,
    };

    this.worktrees.set(agentId, info);

    eventBus.publish({
      type: "worker:spawn",
      workerId: agentId,
      provider: "git-worktree",
      model: "",
      role: "worktree",
    });

    return info;
  }

  async remove(agentId: string): Promise<void> {
    const info = this.worktrees.get(agentId);
    if (!info) return;

    const { exitCode, stdout } = await this.git(
      ["worktree", "remove", info.path, "--force"],
      this.baseDir,
    );

    if (exitCode !== 0) {
      throw new Error(`Failed to remove worktree for agent ${agentId}: ${stdout}`);
    }

    this.worktrees.delete(agentId);
  }

  async list(): Promise<WorktreeInfo[]> {
    const { exitCode, stdout } = await this.git(
      ["worktree", "list", "--porcelain"],
      this.baseDir,
    );

    if (exitCode !== 0) return [...this.worktrees.values()];

    const entries = this.parsePorcelain(stdout);

    // Reconcile with in-memory map: update head values from live data
    for (const entry of entries) {
      for (const [agentId, info] of this.worktrees) {
        if (info.path === entry.path) {
          info.head = entry.head;
          info.branch = entry.branch || info.branch;
        }
      }
    }

    return [...this.worktrees.values()];
  }

  getForAgent(agentId: string): WorktreeInfo | undefined {
    return this.worktrees.get(agentId);
  }

  async merge(
    agentId: string,
    targetBranch?: string,
  ): Promise<{ success: boolean; conflicts: string[] }> {
    const info = this.worktrees.get(agentId);
    if (!info) {
      return { success: false, conflicts: [`No worktree found for agent ${agentId}`] };
    }

    const target = targetBranch ?? "main";

    // Switch to target branch in main repo
    const checkoutResult = await this.git(["checkout", target], this.baseDir);
    if (checkoutResult.exitCode !== 0) {
      // Try "master" if "main" fails and no explicit target was given
      if (!targetBranch) {
        const masterResult = await this.git(["checkout", "master"], this.baseDir);
        if (masterResult.exitCode !== 0) {
          return {
            success: false,
            conflicts: [`Cannot checkout target branch: ${checkoutResult.stdout}`],
          };
        }
      } else {
        return {
          success: false,
          conflicts: [`Cannot checkout ${target}: ${checkoutResult.stdout}`],
        };
      }
    }

    // Merge the worktree branch with --no-ff
    const mergeResult = await this.git(
      ["merge", "--no-ff", info.branch],
      this.baseDir,
    );

    if (mergeResult.exitCode === 0) {
      eventBus.publish({
        type: "merge:progress",
        stage: "complete",
        status: `merged ${info.branch}`,
      });
      return { success: true, conflicts: [] };
    }

    // Merge failed — extract conflict file list
    const conflictResult = await this.git(
      ["diff", "--name-only", "--diff-filter=U"],
      this.baseDir,
    );

    const conflicts = conflictResult.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    // Abort the failed merge to leave the repo in a clean state
    await this.git(["merge", "--abort"], this.baseDir);

    eventBus.publish({
      type: "merge:progress",
      stage: "conflict",
      status: `${conflicts.length} conflicts in ${info.branch}`,
    });

    return { success: false, conflicts };
  }

  async reset(agentId: string): Promise<void> {
    const info = this.worktrees.get(agentId);
    if (!info) return;

    const resetResult = await this.git(["reset", "--hard", "HEAD"], info.path);
    if (resetResult.exitCode !== 0) {
      throw new Error(`Failed to reset worktree for agent ${agentId}: ${resetResult.stdout}`);
    }

    const cleanResult = await this.git(["clean", "-fd"], info.path);
    if (cleanResult.exitCode !== 0) {
      throw new Error(`Failed to clean worktree for agent ${agentId}: ${cleanResult.stdout}`);
    }
  }

  async cleanupAll(): Promise<{ removed: number; errors: string[] }> {
    let removed = 0;
    const errors: string[] = [];

    const agentIds = [...this.worktrees.keys()];

    for (const agentId of agentIds) {
      try {
        await this.remove(agentId);
        removed++;
      } catch (err) {
        errors.push(
          `${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Prune any stale worktree refs that git still tracks
    await this.git(["worktree", "prune"], this.baseDir);

    eventBus.publish({
      type: "cleanup:run",
      succeeded: removed,
      failed: errors.length,
    });

    return { removed, errors };
  }

  async isSupported(): Promise<boolean> {
    const { exitCode } = await this.git(["worktree", "list"], this.baseDir);
    return exitCode === 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async git(
    args: string[],
    cwd?: string,
  ): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: cwd ?? this.baseDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    // Combine stdout and stderr for error reporting
    const output = exitCode !== 0 ? `${stdout}\n${stderr}`.trim() : stdout.trim();

    return { stdout: output, exitCode };
  }

  private getWorktreePath(agentId: string): string {
    return join(this.worktreeDir, agentId);
  }

  private parsePorcelain(output: string): Array<{
    path: string;
    head?: string;
    branch?: string;
  }> {
    const entries: Array<{ path: string; head?: string; branch?: string }> = [];
    const blocks = output.split("\n\n").filter(Boolean);

    for (const block of blocks) {
      const lines = block.split("\n");
      let path = "";
      let head: string | undefined;
      let branch: string | undefined;

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          path = line.slice("worktree ".length);
        } else if (line.startsWith("HEAD ")) {
          head = line.slice("HEAD ".length);
        } else if (line.startsWith("branch ")) {
          // "branch refs/heads/foo" -> "foo"
          const ref = line.slice("branch ".length);
          branch = ref.replace("refs/heads/", "");
        }
      }

      if (path) {
        entries.push({ path, head, branch });
      }
    }

    return entries;
  }
}
