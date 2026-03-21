import { $ } from "bun";
import { dirname } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────

export interface AutoCommitResult {
  committed: boolean;
  hash?: string;
  message?: string;
  error?: string;
  /** Number of atomic commits created (for batch results) */
  commitCount?: number;
}

// ── Periodic commit watcher ─────────────────────────────────────────────

const COMMIT_INTERVAL_MS = 30_000; // check every 30 seconds

/**
 * Watches for uncommitted changes and auto-commits them periodically.
 * Returns a stop function to clear the interval.
 */
export function startCommitWatcher(
  agentName: string,
  cwd: string,
  onCommit?: (result: AutoCommitResult) => void,
): () => void {
  const timer = setInterval(async () => {
    const result = await autoCommit(agentName, cwd);
    if (result.committed && onCommit) {
      onCommit(result);
    }
  }, COMMIT_INTERVAL_MS);

  return () => clearInterval(timer);
}

// ── One-shot auto-commit (atomic) ───────────────────────────────────────

/**
 * Auto-commit any uncommitted changes left by an agent.
 * Groups files by directory and creates atomic commits per group.
 */
export async function autoCommit(
  _agentName: string,
  cwd: string,
): Promise<AutoCommitResult> {
  try {
    const status = await $`git -C ${cwd} status --porcelain`.text();
    if (!status.trim()) {
      return { committed: false };
    }

    const lines = status.trim().split("\n");
    const groups = groupByDirectory(lines);
    let lastHash = "";
    let lastMessage = "";
    let commitCount = 0;

    for (const group of groups) {
      const message = buildGroupCommitMessage(group);
      const files = group.files.map(f => f.path);

      // Stage only files in this group
      for (const file of files) {
        await $`git -C ${cwd} add -- ${file}`.quiet();
      }

      // Commit
      try {
        await $`git -C ${cwd} commit -m ${message}`.quiet();
        lastHash = (await $`git -C ${cwd} rev-parse --short HEAD`.text()).trim();
        lastMessage = message;
        commitCount++;
      } catch {
        // Nothing to commit (maybe already staged by previous group)
      }
    }

    if (commitCount === 0) {
      return { committed: false };
    }

    // Push once after all atomic commits (best-effort)
    try {
      await $`git -C ${cwd} push`.quiet();
    } catch {
      // push failure is non-fatal
    }

    return { committed: true, hash: lastHash, message: lastMessage, commitCount };
  } catch (e) {
    return {
      committed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── File grouping ───────────────────────────────────────────────────────

interface FileEntry {
  path: string;
  status: "added" | "modified" | "deleted";
}

interface FileGroup {
  directory: string;
  files: FileEntry[];
}

/**
 * Group changed files by their immediate parent directory.
 * Single files get their own group (= their own commit).
 */
function groupByDirectory(statusLines: string[]): FileGroup[] {
  const entries: FileEntry[] = [];

  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path) continue;

    let status: FileEntry["status"];
    if (code.includes("D")) status = "deleted";
    else if (code.includes("?") || code.includes("A")) status = "added";
    else status = "modified";

    entries.push({ path, status });
  }

  // Group by parent directory
  const dirMap = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const dir = dirname(entry.path);
    const existing = dirMap.get(dir);
    if (existing) existing.push(entry);
    else dirMap.set(dir, [entry]);
  }

  return Array.from(dirMap.entries()).map(([directory, files]) => ({
    directory,
    files,
  }));
}

/**
 * Build a commit message for a group of files in the same directory.
 */
function buildGroupCommitMessage(group: FileGroup): string {
  const { files, directory } = group;
  const scope = directory !== "." ? ` in ${directory}` : "";

  // Single file → precise message
  if (files.length === 1) {
    const f = files[0];
    if (f.status === "added") return `feat: add ${f.path}`;
    if (f.status === "deleted") return `chore: remove ${f.path}`;
    return `fix: update ${f.path}`;
  }

  // Multiple files in same directory
  const added = files.filter(f => f.status === "added");
  const modified = files.filter(f => f.status === "modified");
  const deleted = files.filter(f => f.status === "deleted");

  if (added.length && !modified.length && !deleted.length) {
    return `feat: add ${added.length} files${scope}`;
  }
  if (deleted.length && !added.length && !modified.length) {
    return `chore: remove ${deleted.length} files${scope}`;
  }
  if (modified.length && !added.length && !deleted.length) {
    return `fix: update ${modified.length} files${scope}`;
  }

  return `chore: update ${files.length} files${scope}`;
}
