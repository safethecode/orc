import { $ } from "bun";
import { writeFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────

export interface AutoCommitResult {
  committed: boolean;
  hash?: string;
  message?: string;
  error?: string;
}

// ── Co-author constants ─────────────────────────────────────────────────

const CO_AUTHOR = "Co-Authored-By: orc-agent <hello@sson.tech>";
const CO_AUTHOR_PATTERN = /Co-Authored-By:.*$/gim;

// ── Git commit-msg hook ─────────────────────────────────────────────────

const COMMIT_MSG_HOOK = `#!/bin/sh
# orc: enforce co-author tag on every commit
MSG_FILE="$1"

# Strip all existing Co-Authored-By lines
sed -i '' '/^Co-Authored-By:/d' "$MSG_FILE" 2>/dev/null || sed -i '/^Co-Authored-By:/d' "$MSG_FILE"

# Strip trailing blank lines
sed -i '' -e :a -e '/^\\n*$/{$d;N;ba' -e '}' "$MSG_FILE" 2>/dev/null || sed -i -e :a -e '/^\\n*$/{$d;N;ba' -e '}' "$MSG_FILE"

# Append our co-author
printf '\\n\\n${CO_AUTHOR}' >> "$MSG_FILE"
`;

/**
 * Install a commit-msg git hook that forces the orc-agent co-author tag.
 * Strips any existing Co-Authored-By (Claude, Codex, etc.) and appends ours.
 */
export async function installCommitHook(repoDir: string): Promise<void> {
  const hooksDir = join(repoDir, ".git", "hooks");
  const hookPath = join(hooksDir, "commit-msg");

  await mkdir(hooksDir, { recursive: true });
  await writeFile(hookPath, COMMIT_MSG_HOOK, "utf-8");
  await chmod(hookPath, 0o755);
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

// ── One-shot auto-commit ────────────────────────────────────────────────

/**
 * Auto-commit any uncommitted changes left by an agent.
 * Runs in the given working directory (main repo or worktree).
 */
export async function autoCommit(
  agentName: string,
  cwd: string,
): Promise<AutoCommitResult> {
  try {
    // Check for any changes (staged, unstaged, untracked)
    const status = await $`git -C ${cwd} status --porcelain`.text();
    if (!status.trim()) {
      return { committed: false };
    }

    // Build commit message from changed files
    const lines = status.trim().split("\n");
    const summary = buildCommitSummary(lines);
    const message = `${summary}\n\n${CO_AUTHOR}`;

    // Stage all changes
    await $`git -C ${cwd} add -A`.quiet();

    // Commit (--no-verify to skip our own hook since we already have the right co-author)
    await $`git -C ${cwd} commit --no-verify -m ${message}`.quiet();

    // Get the commit hash
    const hash = (await $`git -C ${cwd} rev-parse --short HEAD`.text()).trim();

    // Push (best-effort)
    try {
      await $`git -C ${cwd} push`.quiet();
    } catch {
      // push failure is non-fatal
    }

    return { committed: true, hash, message: summary };
  } catch (e) {
    return {
      committed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Commit message generation ───────────────────────────────────────────

function buildCommitSummary(statusLines: string[]): string {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code.includes("D")) {
      deleted.push(file);
    } else if (code.includes("?") || code.includes("A")) {
      added.push(file);
    } else {
      modified.push(file);
    }
  }

  const total = added.length + modified.length + deleted.length;
  if (total === 0) return "chore: update files";

  // Single file → precise message
  if (total === 1) {
    const file = added[0] || modified[0] || deleted[0];
    if (added.length) return `feat: add ${file}`;
    if (deleted.length) return `chore: remove ${file}`;
    return `fix: update ${file}`;
  }

  // Detect common directory
  const allFiles = [...added, ...modified, ...deleted];
  const commonDir = findCommonDir(allFiles);
  const scope = commonDir ? ` in ${commonDir}` : "";

  if (added.length && !modified.length && !deleted.length) {
    return `feat: add ${added.length} files${scope}`;
  }
  if (deleted.length && !added.length && !modified.length) {
    return `chore: remove ${deleted.length} files${scope}`;
  }
  if (modified.length && !added.length && !deleted.length) {
    return `fix: update ${modified.length} files${scope}`;
  }

  return `chore: update ${total} files${scope}`;
}

function findCommonDir(files: string[]): string {
  if (files.length === 0) return "";
  const parts = files.map((f) => f.split("/"));
  const first = parts[0];
  let depth = 0;

  for (let i = 0; i < first.length - 1; i++) {
    if (parts.every((p) => p[i] === first[i])) {
      depth = i + 1;
    } else {
      break;
    }
  }

  return depth > 0 ? first.slice(0, depth).join("/") : "";
}
