import { join } from "path";

export interface WorktreeInfo {
  path: string;
  branch: string;
  agentName: string;
  taskId: string;
}

export class WorktreeManager {
  private baseDir: string;
  private worktrees: Map<string, WorktreeInfo>;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.worktrees = new Map();
  }

  private getWorktreePath(agentName: string, taskId: string): string {
    return join(this.baseDir, ".worktrees", `${agentName}-${taskId}`);
  }

  private getBranchName(agentName: string, taskId: string): string {
    return `orch/${agentName}/${taskId}`;
  }

  private key(agentName: string, taskId: string): string {
    return `${agentName}-${taskId}`;
  }

  private async git(args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.baseDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
    }

    return stdout.trim();
  }

  async create(agentName: string, taskId: string): Promise<WorktreeInfo> {
    const worktreePath = this.getWorktreePath(agentName, taskId);
    const branch = this.getBranchName(agentName, taskId);

    await this.git([
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
    ]);

    const info: WorktreeInfo = {
      path: worktreePath,
      branch,
      agentName,
      taskId,
    };

    this.worktrees.set(this.key(agentName, taskId), info);
    return info;
  }

  async remove(agentName: string, taskId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(agentName, taskId);
    const branch = this.getBranchName(agentName, taskId);

    try {
      await this.git(["worktree", "remove", worktreePath, "--force"]);
    } catch {
      // worktree may already be removed
    }

    try {
      await this.git(["branch", "-D", branch]);
    } catch {
      // branch may already be deleted
    }

    this.worktrees.delete(this.key(agentName, taskId));
  }

  async removeByAgent(agentName: string): Promise<void> {
    const toRemove: WorktreeInfo[] = [];
    for (const info of this.worktrees.values()) {
      if (info.agentName === agentName) {
        toRemove.push(info);
      }
    }

    for (const info of toRemove) {
      await this.remove(info.agentName, info.taskId);
    }
  }

  async list(): Promise<WorktreeInfo[]> {
    return Array.from(this.worktrees.values());
  }

  async cleanup(): Promise<void> {
    const entries = Array.from(this.worktrees.values());
    for (const info of entries) {
      await this.remove(info.agentName, info.taskId);
    }

    try {
      await this.git(["worktree", "prune"]);
    } catch {
      // ignore prune errors
    }
  }
}
