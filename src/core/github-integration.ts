export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  author: string;
  url: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  branch: string;
  baseBranch: string;
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export class GitHubIntegration {
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
  }

  /** Check if gh CLI is installed and authenticated. */
  async isAvailable(): Promise<boolean> {
    try {
      const { exitCode } = await this.gh(["--version"]);
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  /** Create a new git branch, optionally from a base branch. */
  async createBranch(name: string, baseBranch?: string): Promise<void> {
    const args = ["checkout", "-b", name];
    if (baseBranch) args.push(baseBranch);

    const { exitCode, stdout } = await this.git(args);
    if (exitCode !== 0) {
      throw new Error(`Failed to create branch "${name}": ${stdout}`);
    }
  }

  /** Create a pull request and return the PR URL. */
  async createPR(
    title: string,
    body: string,
    opts?: { base?: string; draft?: boolean; labels?: string[] },
  ): Promise<string> {
    const args = ["pr", "create", "--title", title, "--body", body];

    if (opts?.base) {
      args.push("--base", opts.base);
    }
    if (opts?.draft) {
      args.push("--draft");
    }
    if (opts?.labels?.length) {
      for (const label of opts.labels) {
        args.push("--label", label);
      }
    }

    const { exitCode, stdout } = await this.gh(args);
    if (exitCode !== 0) {
      throw new Error(`Failed to create PR: ${stdout}`);
    }

    // gh pr create prints the PR URL on success
    return stdout.trim();
  }

  /** Get pull request info by number. Returns null if not found. */
  async getPR(number: number): Promise<PullRequestInfo | null> {
    const fields = [
      "number",
      "title",
      "body",
      "state",
      "headRefName",
      "baseRefName",
      "author",
      "url",
      "additions",
      "deletions",
      "changedFiles",
    ].join(",");

    const { exitCode, stdout } = await this.gh([
      "pr",
      "view",
      String(number),
      "--json",
      fields,
    ]);

    if (exitCode !== 0) return null;

    try {
      const data = JSON.parse(stdout);
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        state: data.state,
        branch: data.headRefName,
        baseBranch: data.baseRefName,
        author: data.author?.login ?? "",
        url: data.url,
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
        changedFiles: data.changedFiles ?? 0,
      };
    } catch {
      return null;
    }
  }

  /** Get the diff for a pull request. */
  async getPRDiff(number: number): Promise<string> {
    const { exitCode, stdout } = await this.gh([
      "pr",
      "diff",
      String(number),
    ]);

    if (exitCode !== 0) return "";
    return stdout;
  }

  /** Checkout a PR branch locally. */
  async checkoutPR(number: number): Promise<void> {
    const { exitCode, stdout } = await this.gh([
      "pr",
      "checkout",
      String(number),
    ]);

    if (exitCode !== 0) {
      throw new Error(`Failed to checkout PR #${number}: ${stdout}`);
    }
  }

  /** Get issue info by number. Returns null if not found. */
  async getIssue(number: number): Promise<IssueInfo | null> {
    const fields = [
      "number",
      "title",
      "body",
      "labels",
      "state",
      "author",
      "url",
    ].join(",");

    const { exitCode, stdout } = await this.gh([
      "issue",
      "view",
      String(number),
      "--json",
      fields,
    ]);

    if (exitCode !== 0) return null;

    try {
      const data = JSON.parse(stdout);
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        labels: (data.labels ?? []).map((l: { name: string }) => l.name),
        state: data.state,
        author: data.author?.login ?? "",
        url: data.url,
      };
    } catch {
      return null;
    }
  }

  /** List issues with optional filters. */
  async listIssues(opts?: {
    state?: "open" | "closed" | "all";
    labels?: string[];
    limit?: number;
  }): Promise<IssueInfo[]> {
    const fields = [
      "number",
      "title",
      "body",
      "state",
      "labels",
      "author",
      "url",
    ].join(",");

    const args = ["issue", "list", "--json", fields];

    if (opts?.state) {
      args.push("--state", opts.state);
    }
    if (opts?.labels?.length) {
      for (const label of opts.labels) {
        args.push("--label", label);
      }
    }
    if (opts?.limit !== undefined) {
      args.push("--limit", String(opts.limit));
    }

    const { exitCode, stdout } = await this.gh(args);
    if (exitCode !== 0) return [];

    try {
      const items: any[] = JSON.parse(stdout);
      return items.map((data) => ({
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        labels: (data.labels ?? []).map((l: { name: string }) => l.name),
        state: data.state,
        author: data.author?.login ?? "",
        url: data.url,
      }));
    } catch {
      return [];
    }
  }

  /** Create an issue and return the issue URL. */
  async createIssue(
    title: string,
    body: string,
    labels?: string[],
  ): Promise<string> {
    const args = ["issue", "create", "--title", title, "--body", body];

    if (labels?.length) {
      for (const label of labels) {
        args.push("--label", label);
      }
    }

    const { exitCode, stdout } = await this.gh(args);
    if (exitCode !== 0) {
      throw new Error(`Failed to create issue: ${stdout}`);
    }

    return stdout.trim();
  }

  /** Comment on a PR or issue. */
  async comment(
    type: "pr" | "issue",
    number: number,
    body: string,
  ): Promise<void> {
    const { exitCode, stdout } = await this.gh([
      type,
      "comment",
      String(number),
      "--body",
      body,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `Failed to comment on ${type} #${number}: ${stdout}`,
      );
    }
  }

  /** Push current branch to origin, optionally with --force-with-lease. */
  async push(force?: boolean): Promise<void> {
    // Determine the current branch name
    const branchResult = await this.git([
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);

    if (branchResult.exitCode !== 0) {
      throw new Error(`Failed to determine current branch: ${branchResult.stdout}`);
    }

    const branch = branchResult.stdout.trim();
    const args = ["push", "-u", "origin", branch];

    if (force) {
      args.push("--force-with-lease");
    }

    const { exitCode, stdout } = await this.git(args);
    if (exitCode !== 0) {
      throw new Error(`Failed to push branch "${branch}": ${stdout}`);
    }
  }

  /** Get current repo info (owner, name, url). Returns null if not in a gh repo. */
  async getRepoInfo(): Promise<{
    owner: string;
    name: string;
    url: string;
  } | null> {
    const { exitCode, stdout } = await this.gh([
      "repo",
      "view",
      "--json",
      "owner,name,url",
    ]);

    if (exitCode !== 0) return null;

    try {
      const data = JSON.parse(stdout);
      return {
        owner: data.owner?.login ?? data.owner ?? "",
        name: data.name,
        url: data.url,
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async gh(
    args: string[],
  ): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(["gh", ...args], {
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const output =
      exitCode !== 0 ? `${stdout}\n${stderr}`.trim() : stdout.trim();

    return { stdout: output, exitCode };
  }

  private async git(
    args: string[],
  ): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const output =
      exitCode !== 0 ? `${stdout}\n${stderr}`.trim() : stdout.trim();

    return { stdout: output, exitCode };
  }
}
