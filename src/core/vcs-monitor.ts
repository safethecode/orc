import { watch, existsSync, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";

export interface BranchChangeEvent {
  previous: string;
  current: string;
  timestamp: string;
}

/**
 * Watches .git/HEAD for branch changes and emits "branch:switch" events.
 * Useful for agents that need to react to VCS context changes (e.g. resetting
 * state, reloading config, or updating dashboard status).
 */
export class VcsMonitor extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private currentBranch: string = "";
  private projectDir: string;

  constructor(projectDir?: string) {
    super();
    this.projectDir = resolve(projectDir ?? process.cwd());

    // Read initial branch if we're in a git repo
    if (this.isGitRepo()) {
      this.currentBranch = this.readBranch();
    }
  }

  /** Start watching .git/HEAD for changes. */
  start(): void {
    if (this.watcher) return;
    if (!this.isGitRepo()) return;

    const headPath = join(this.projectDir, ".git", "HEAD");

    this.watcher = watch(headPath, (eventType) => {
      if (eventType !== "change") return;

      const newBranch = this.readBranch();
      if (newBranch && newBranch !== this.currentBranch) {
        const event: BranchChangeEvent = {
          previous: this.currentBranch,
          current: newBranch,
          timestamp: new Date().toISOString(),
        };

        this.currentBranch = newBranch;
        this.emit("branch:switch", event);
      }
    });

    // Don't let the watcher keep the process alive
    this.watcher.unref();
  }

  /** Stop watching. */
  stop(): void {
    if (!this.watcher) return;
    this.watcher.close();
    this.watcher = null;
  }

  /** Get current branch name. */
  getCurrentBranch(): string {
    return this.currentBranch;
  }

  /**
   * Parse branch from .git/HEAD content.
   * "ref: refs/heads/main" -> "main"
   * A detached HEAD (raw SHA) returns the first 8 chars of the hash.
   */
  private parseBranch(headContent: string): string {
    const trimmed = headContent.trim();

    if (trimmed.startsWith("ref: refs/heads/")) {
      return trimmed.slice("ref: refs/heads/".length);
    }

    // Detached HEAD — return short hash
    if (/^[0-9a-f]{40}$/.test(trimmed)) {
      return trimmed.slice(0, 8);
    }

    return trimmed;
  }

  /** Check if the project directory contains a .git directory with a HEAD file. */
  isGitRepo(): boolean {
    return existsSync(join(this.projectDir, ".git", "HEAD"));
  }

  /** Read and parse the current branch from .git/HEAD synchronously via Bun. */
  private readBranch(): string {
    try {
      const headPath = join(this.projectDir, ".git", "HEAD");
      // Use synchronous read since we need the value immediately for comparison
      const content = require("node:fs").readFileSync(headPath, "utf-8");
      return this.parseBranch(content);
    } catch {
      return "";
    }
  }
}
