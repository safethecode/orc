async function run(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

export async function createGhostCommit(
  message?: string,
): Promise<string | null> {
  // Check if we're in a git repo
  const rev = await run(["rev-parse", "--git-dir"]);
  if (!rev) return null;

  // Create a stash-like commit without modifying working tree
  const sha = await run(["stash", "create", message ?? "ghost snapshot"]);

  // If nothing to stash, use current HEAD
  if (!sha) {
    return await run(["rev-parse", "HEAD"]);
  }

  return sha;
}

export async function diffFromGhost(ghostSha: string): Promise<string> {
  const result = await run(["diff", ghostSha, "--"]);
  return result ?? "";
}
