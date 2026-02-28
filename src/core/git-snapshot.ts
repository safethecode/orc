export interface Snapshot {
  id: string;
  treeSha: string;
  messageIndex: number;
  label: string;
  createdAt: string;
  files: string[];
}

export interface UndoResult {
  success: boolean;
  filesReverted: string[];
  error?: string;
}

export class GitSnapshotManager {
  private snapshots: Snapshot[] = [];
  private currentIndex = -1;
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  async isGitRepo(): Promise<boolean> {
    try {
      const output = await this.git("rev-parse", "--git-dir");
      return output.length > 0;
    } catch {
      return false;
    }
  }

  async capture(messageIndex: number, label?: string): Promise<Snapshot | null> {
    if (!(await this.isGitRepo())) return null;

    try {
      // Stage all changes so write-tree captures everything
      await this.git("add", "-A");

      // Get the tree SHA without creating a commit
      const treeSha = await this.git("write-tree");
      if (!treeSha) return null;

      // Determine which files changed compared to the previous snapshot
      let files: string[] = [];
      if (this.currentIndex >= 0) {
        const prevSha = this.snapshots[this.currentIndex].treeSha;
        try {
          const diffOutput = await this.git(
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            prevSha,
            treeSha,
          );
          files = diffOutput
            .split("\n")
            .map((f) => f.trim())
            .filter(Boolean);
        } catch {
          // First snapshot or diff failure — list all tracked files
          files = await this.getTrackedFiles();
        }
      } else {
        files = await this.getTrackedFiles();
      }

      const snapshot: Snapshot = {
        id: `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        treeSha,
        messageIndex,
        label: label ?? `turn-${messageIndex}`,
        createdAt: new Date().toISOString(),
        files,
      };

      // If we've undone and are capturing a new snapshot, truncate redo history
      if (this.currentIndex < this.snapshots.length - 1) {
        this.snapshots = this.snapshots.slice(0, this.currentIndex + 1);
      }

      this.snapshots.push(snapshot);
      this.currentIndex = this.snapshots.length - 1;

      return snapshot;
    } catch {
      return null;
    }
  }

  async undo(): Promise<UndoResult> {
    if (!this.canUndo()) {
      return { success: false, filesReverted: [], error: "Nothing to undo" };
    }

    const targetIndex = this.currentIndex - 1;
    const targetSnapshot = this.snapshots[targetIndex];

    try {
      // Restore the tree from the target snapshot
      await this.git("read-tree", targetSnapshot.treeSha);
      await this.git("checkout-index", "-a", "-f");

      // Determine which files were reverted (files from the snapshot we're undoing)
      const undoneSnapshot = this.snapshots[this.currentIndex];
      this.currentIndex = targetIndex;

      return { success: true, filesReverted: undoneSnapshot.files };
    } catch (err) {
      return {
        success: false,
        filesReverted: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async redo(): Promise<UndoResult> {
    if (!this.canRedo()) {
      return { success: false, filesReverted: [], error: "Nothing to redo" };
    }

    const targetIndex = this.currentIndex + 1;
    const targetSnapshot = this.snapshots[targetIndex];

    try {
      await this.git("read-tree", targetSnapshot.treeSha);
      await this.git("checkout-index", "-a", "-f");

      this.currentIndex = targetIndex;

      return { success: true, filesReverted: targetSnapshot.files };
    } catch (err) {
      return {
        success: false,
        filesReverted: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async diff(snapshotId: string): Promise<string> {
    const snapshot = this.snapshots.find((s) => s.id === snapshotId);
    if (!snapshot) return "";

    try {
      // diff-tree comparing snapshot tree against current HEAD tree
      const output = await this.git("diff-tree", "-p", snapshot.treeSha, "HEAD");
      return output;
    } catch {
      return "";
    }
  }

  list(): Snapshot[] {
    return [...this.snapshots];
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  canUndo(): boolean {
    return this.currentIndex > 0;
  }

  canRedo(): boolean {
    return this.currentIndex < this.snapshots.length - 1;
  }

  private async git(...args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
    }

    return stdout.trim();
  }

  private async getTrackedFiles(): Promise<string[]> {
    try {
      const output = await this.git("ls-files");
      return output
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
