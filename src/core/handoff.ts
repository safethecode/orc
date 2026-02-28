// ── Handoff: Session Transfer Context ─────────────────────────────────
// Generates structured context for transferring work between sessions

export interface HandoffContext {
  sessionSummary: string;
  gitStatus: string;
  activeTodos: string[];
  recentDecisions: string[];
  activeBoulder?: string;
  recentFiles: string[];
  timestamp: string;
}

export class HandoffGenerator {
  constructor() {}

  /** Generate a complete handoff document */
  async generate(opts: {
    conversation: Array<{ role: string; content: string }>;
    projectDir?: string;
  }): Promise<string> {
    const cwd = opts.projectDir ?? process.cwd();

    // Gather all context in parallel
    const [gitStatus, recentFiles] = await Promise.all([
      this.gatherGitStatus(cwd),
      this.gatherRecentFiles(cwd),
    ]);

    const sessionSummary = this.summarizeConversation(opts.conversation);
    const recentDecisions = this.extractDecisions(opts.conversation);
    const activeTodos = this.extractTodos(opts.conversation);
    const activeBoulder = await this.detectActiveBoulder(cwd);

    const ctx: HandoffContext = {
      sessionSummary,
      gitStatus,
      activeTodos,
      recentDecisions,
      activeBoulder: activeBoulder ?? undefined,
      recentFiles,
      timestamp: new Date().toISOString(),
    };

    return this.formatMarkdown(ctx);
  }

  /** Gather git status: current branch, short status, recent commits */
  async gatherGitStatus(cwd?: string): Promise<string> {
    const projectDir = cwd ?? process.cwd();
    const sections: string[] = [];

    // Current branch
    try {
      const branch = await this.git(["branch", "--show-current"], projectDir);
      sections.push(`Branch: ${branch}`);
    } catch {
      sections.push("Branch: (not a git repository or detached HEAD)");
    }

    // Short status
    try {
      const status = await this.git(["status", "--short"], projectDir);
      if (status.length > 0) {
        sections.push(`\nChanges:\n${status}`);
      } else {
        sections.push("\nWorking tree clean");
      }
    } catch {
      // Not a git repo
    }

    // Recent commits
    try {
      const log = await this.git(["log", "--oneline", "-5"], projectDir);
      if (log.length > 0) {
        sections.push(`\nRecent commits:\n${log}`);
      }
    } catch {
      // No commits or not a git repo
    }

    return sections.join("\n");
  }

  /** Gather recently changed files from the last 5 commits */
  async gatherRecentFiles(cwd?: string): Promise<string[]> {
    const projectDir = cwd ?? process.cwd();

    try {
      const output = await this.git(["diff", "--name-only", "HEAD~5..HEAD"], projectDir);
      if (!output.trim()) return [];

      return output
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      // Fewer than 5 commits or not a git repo — try against root
      try {
        const output = await this.git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"], projectDir);
        return output
          .split("\n")
          .map((f) => f.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    }
  }

  /** Summarize conversation by taking the last N turns, truncated */
  summarizeConversation(
    conversation: Array<{ role: string; content: string }>,
    maxTurns?: number,
  ): string {
    const limit = maxTurns ?? 10;
    const recent = conversation.slice(-limit);

    if (recent.length === 0) {
      return "No conversation history available.";
    }

    const lines: string[] = [];

    for (const turn of recent) {
      const role = turn.role === "user" ? "User" : "Assistant";
      const content = turn.content.length > 200
        ? turn.content.slice(0, 200) + "..."
        : turn.content;

      // Collapse whitespace and newlines for compact display
      const compact = content.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
      lines.push(`- **${role}**: ${compact}`);
    }

    return lines.join("\n");
  }

  /** Format the handoff context as clean markdown */
  formatMarkdown(ctx: HandoffContext): string {
    const sections: string[] = [];

    sections.push("# Session Handoff");
    sections.push("");

    // Summary
    sections.push("## Summary");
    sections.push("");
    sections.push(ctx.sessionSummary);
    sections.push("");

    // Git status
    sections.push("## Git Status");
    sections.push("");
    sections.push("```");
    sections.push(ctx.gitStatus);
    sections.push("```");
    sections.push("");

    // Recent files
    if (ctx.recentFiles.length > 0) {
      sections.push("## Recent Files");
      sections.push("");
      for (const file of ctx.recentFiles) {
        sections.push(`- \`${file}\``);
      }
      sections.push("");
    }

    // Active work (boulder)
    if (ctx.activeBoulder) {
      sections.push("## Active Work");
      sections.push("");
      sections.push(ctx.activeBoulder);
      sections.push("");
    }

    // Active todos
    if (ctx.activeTodos.length > 0) {
      sections.push("## TODOs");
      sections.push("");
      for (const todo of ctx.activeTodos) {
        sections.push(`- [ ] ${todo}`);
      }
      sections.push("");
    }

    // Decisions
    if (ctx.recentDecisions.length > 0) {
      sections.push("## Decisions");
      sections.push("");
      for (const decision of ctx.recentDecisions) {
        sections.push(`- ${decision}`);
      }
      sections.push("");
    }

    // Timestamp
    sections.push("## Timestamp");
    sections.push("");
    sections.push(`Generated: ${ctx.timestamp}`);
    sections.push("");

    return sections.join("\n");
  }

  /** Copy text to system clipboard (macOS: pbcopy, Linux: xclip) */
  async copyToClipboard(text: string): Promise<boolean> {
    const platform = process.platform;

    let cmd: string;
    let args: string[];

    if (platform === "darwin") {
      cmd = "pbcopy";
      args = [];
    } else if (platform === "linux") {
      cmd = "xclip";
      args = ["-selection", "clipboard"];
    } else {
      // Unsupported platform
      return false;
    }

    try {
      const proc = Bun.spawn([cmd, ...args], {
        stdin: new Blob([text]),
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  /** Execute a git command and return stdout */
  private async git(args: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
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

  /** Extract decisions from assistant turns in the conversation */
  private extractDecisions(conversation: Array<{ role: string; content: string }>): string[] {
    const decisions: string[] = [];

    // Scan recent assistant turns for decision-like language
    const assistantTurns = conversation
      .filter((t) => t.role === "assistant")
      .slice(-10);

    for (const turn of assistantTurns) {
      const patterns = [
        /(?:I'll|I will|Let's|We should|Going to|Decided to)\s+(.{15,150})/gi,
        /(?:Decision|Approach|Strategy):\s*(.{15,150})/gi,
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(turn.content)) !== null) {
          const decision = match[1].trim()
            .replace(/\.\s*$/, "")
            .replace(/\n/g, " ")
            .trim();

          if (decision.length >= 15 && !decisions.includes(decision)) {
            decisions.push(
              decision.length > 150 ? decision.slice(0, 150) + "..." : decision,
            );
          }

          if (decisions.length >= 8) break;
        }
        if (decisions.length >= 8) break;
      }
      if (decisions.length >= 8) break;
    }

    return decisions;
  }

  /** Extract TODO items from conversation */
  private extractTodos(conversation: Array<{ role: string; content: string }>): string[] {
    const todos: string[] = [];

    // Look through recent turns for TODO-like items
    const recent = conversation.slice(-15);

    for (const turn of recent) {
      const patterns = [
        /(?:TODO|todo|To do|TO DO):\s*(.{10,200})/g,
        /(?:still need to|need to|should also|remaining:)\s+(.{10,200})/gi,
        /- \[ \]\s+(.{10,200})/g,
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(turn.content)) !== null) {
          const todo = match[1].trim()
            .replace(/\n/g, " ")
            .trim();

          if (todo.length >= 10 && !todos.includes(todo)) {
            todos.push(
              todo.length > 200 ? todo.slice(0, 200) + "..." : todo,
            );
          }

          if (todos.length >= 10) break;
        }
        if (todos.length >= 10) break;
      }
      if (todos.length >= 10) break;
    }

    return todos;
  }

  /** Detect active boulder state if any */
  private async detectActiveBoulder(cwd: string): Promise<string | null> {
    const boulderDir = `${cwd}/.orchestrator/boulder`;

    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(boulderDir);
      const jsonFiles = entries.filter((e) => e.endsWith(".json"));

      if (jsonFiles.length === 0) return null;

      // Find the most recent in_progress or paused boulder
      let latest: { task: string; status: string; resumeHint: string; progress: string } | null = null;
      let latestTime = 0;

      for (const entry of jsonFiles) {
        try {
          const file = Bun.file(`${boulderDir}/${entry}`);
          const data = await file.json() as {
            task: string;
            status: string;
            resumeHint: string;
            currentStepIndex: number;
            totalSteps: number;
            lastUpdatedAt: string;
          };

          if (data.status !== "in_progress" && data.status !== "paused") continue;

          const updatedAt = new Date(data.lastUpdatedAt).getTime();
          if (updatedAt > latestTime) {
            latestTime = updatedAt;
            latest = {
              task: data.task,
              status: data.status,
              resumeHint: data.resumeHint,
              progress: `${data.currentStepIndex}/${data.totalSteps} steps`,
            };
          }
        } catch {
          // Skip corrupt files
        }
      }

      if (!latest) return null;

      return [
        `Task: ${latest.task}`,
        `Status: ${latest.status}`,
        `Progress: ${latest.progress}`,
        `Resume hint: ${latest.resumeHint}`,
      ].join("\n");
    } catch {
      // No boulder directory
      return null;
    }
  }
}
