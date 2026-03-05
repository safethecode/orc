import { $ } from "bun";

export interface AutoCommitResult {
  committed: boolean;
  hash?: string;
  message?: string;
  error?: string;
}

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
    const message = `${summary}\n\nCo-Authored-By: orc-agent <hello@sson.tech>`;

    // Stage all changes
    await $`git -C ${cwd} add -A`.quiet();

    // Commit
    await $`git -C ${cwd} commit -m ${message}`.quiet();

    // Get the commit hash
    const hash = (await $`git -C ${cwd} rev-parse --short HEAD`.text()).trim();

    // Push (best-effort, don't fail if push fails)
    try {
      await $`git -C ${cwd} push`.quiet();
    } catch {
      // push failure is non-fatal (might be offline, no remote, etc.)
    }

    return { committed: true, hash, message: summary };
  } catch (e) {
    return {
      committed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Derive a Karma-style commit message from `git status --porcelain` output.
 */
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

  // Detect dominant action
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
