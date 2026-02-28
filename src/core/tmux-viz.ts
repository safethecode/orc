export interface TmuxPane {
  id: string;
  agentName: string;
  paneId: string;
  status: "running" | "completed" | "failed";
}

export interface TmuxVizConfig {
  enabled: boolean;
  layout: "tiled" | "even-horizontal" | "even-vertical";
  autoCleanup: boolean;
}

export class TmuxVisualizer {
  private panes: Map<string, TmuxPane> = new Map();
  private sessionName: string | null = null;
  private config: TmuxVizConfig;

  constructor(config?: Partial<TmuxVizConfig>) {
    this.config = {
      enabled: true,
      layout: "tiled",
      autoCleanup: true,
      ...config,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.enabled) return false;
    if (!process.env.TMUX) return false;

    try {
      const proc = Bun.spawn(["which", "tmux"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  async createSession(name: string): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    try {
      // Check if session already exists
      const listOutput = await this.tmux(
        "list-sessions",
        "-F",
        "#{session_name}",
      );
      const sessions = listOutput
        .trim()
        .split("\n")
        .filter((s) => s.length > 0);

      if (sessions.includes(name)) {
        this.sessionName = name;
        return true;
      }

      // Create a new detached session
      await this.tmux("new-session", "-d", "-s", name);
      this.sessionName = name;
      return true;
    } catch {
      return false;
    }
  }

  async createPane(agentName: string): Promise<TmuxPane | null> {
    if (!(await this.isAvailable())) return null;

    const target = this.sessionName ?? "";
    if (!target) return null;

    try {
      // Split the window to create a new pane
      const output = await this.tmux(
        "split-window",
        "-t",
        target,
        "-h",
        "-P",
        "-F",
        "#{pane_id}",
      );

      const paneId = output.trim();
      if (!paneId) return null;

      // Set the pane title
      await this.tmux("select-pane", "-t", paneId, "-T", agentName);

      // Apply layout after adding a pane
      await this.applyLayout();

      const pane: TmuxPane = {
        id: `${agentName}-${Date.now()}`,
        agentName,
        paneId,
        status: "running",
      };

      this.panes.set(agentName, pane);
      return pane;
    } catch {
      return null;
    }
  }

  async sendToPane(agentName: string, text: string): Promise<void> {
    const pane = this.panes.get(agentName);
    if (!pane) return;

    try {
      await this.tmux("send-keys", "-t", pane.paneId, text, "Enter");
    } catch {
      // Pane may have been destroyed externally
    }
  }

  updateStatus(
    agentName: string,
    status: "running" | "completed" | "failed",
  ): void {
    const pane = this.panes.get(agentName);
    if (!pane) return;

    pane.status = status;

    if (
      this.config.autoCleanup &&
      (status === "completed" || status === "failed")
    ) {
      this.removePane(agentName).catch(() => {});
    }
  }

  async removePane(agentName: string): Promise<void> {
    const pane = this.panes.get(agentName);
    if (!pane) return;

    try {
      await this.tmux("kill-pane", "-t", pane.paneId);
    } catch {
      // Pane may already be gone
    }

    this.panes.delete(agentName);
  }

  async applyLayout(): Promise<void> {
    if (!this.sessionName) return;

    try {
      await this.tmux(
        "select-layout",
        "-t",
        this.sessionName,
        this.config.layout,
      );
    } catch {
      // Layout may fail if only one pane remains
    }
  }

  async cleanup(): Promise<void> {
    const names = [...this.panes.keys()];
    for (const name of names) {
      await this.removePane(name);
    }

    // If we created the session, kill it
    if (this.sessionName) {
      try {
        await this.tmux("kill-session", "-t", this.sessionName);
      } catch {
        // Session may already be gone
      }
      this.sessionName = null;
    }
  }

  listPanes(): TmuxPane[] {
    return [...this.panes.values()];
  }

  private async tmux(...args: string[]): Promise<string> {
    const proc = Bun.spawn(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `tmux ${args[0]} failed (exit ${code}): ${stderr.trim()}`,
      );
    }

    return stdout;
  }
}
