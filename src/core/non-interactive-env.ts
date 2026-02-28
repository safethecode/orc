/** Interactive commands that would hang in non-interactive mode */
const INTERACTIVE_COMMANDS = [
  "vim", "nvim", "nano", "emacs", "vi", "pico",
  "less", "more", "htop", "top", "man", "ssh",
];

/** Git-specific env vars to prevent interactive prompts */
const GIT_NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_PAGER: "cat",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};

/**
 * Non-Interactive Environment Hook — prevents agents from running
 * interactive commands that would hang in headless / agent mode.
 */
export class NonInteractiveGuard {
  private interactiveSet: Set<string>;

  constructor() {
    this.interactiveSet = new Set(INTERACTIVE_COMMANDS);
  }

  /** Check if a command string starts with an interactive program */
  isInteractive(command: string): boolean {
    const trimmed = command.trim();
    if (!trimmed) return false;

    // Extract the base command (first token), handling env prefixes and sudo
    const baseCommand = this.extractBaseCommand(trimmed);
    return this.interactiveSet.has(baseCommand);
  }

  /** Get env vars that should be set for all git commands */
  getGitEnv(): Record<string, string> {
    return { ...GIT_NON_INTERACTIVE_ENV };
  }

  /** Wrap a command to make it non-interactive (prepend env vars for git commands) */
  wrapCommand(cmd: string): string {
    const trimmed = cmd.trim();
    if (!trimmed) return cmd;

    const baseCommand = this.extractBaseCommand(trimmed);

    // For git commands, prepend non-interactive env vars
    if (baseCommand === "git") {
      const envPrefix = Object.entries(GIT_NON_INTERACTIVE_ENV)
        .map(([k, v]) => `${k}=${this.shellEscape(v)}`)
        .join(" ");
      return `${envPrefix} ${trimmed}`;
    }

    return cmd;
  }

  /** Get a warning message for interactive commands */
  getWarning(command: string): string {
    const baseCommand = this.extractBaseCommand(command.trim());
    return `Blocked: "${baseCommand}" is an interactive command that would hang in agent mode. Use a non-interactive alternative instead.`;
  }

  /**
   * Extract the base command name from a command string.
   * Handles patterns like:
   *   - "vim file.txt"        -> "vim"
   *   - "sudo vim file.txt"   -> "vim"
   *   - "env FOO=bar vim"     -> "vim"
   *   - "/usr/bin/vim"        -> "vim"
   */
  private extractBaseCommand(command: string): string {
    const tokens = command.split(/\s+/);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      // Skip "sudo"
      if (token === "sudo") continue;

      // Skip "env" prefix and any KEY=VALUE assignments after it
      if (token === "env") continue;

      // Skip environment variable assignments (KEY=VALUE)
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;

      // Strip path prefix: /usr/bin/vim -> vim
      const basename = token.includes("/") ? token.split("/").pop()! : token;
      return basename;
    }

    // Fallback: return the first token stripped of path
    const first = tokens[0] ?? "";
    return first.includes("/") ? first.split("/").pop()! : first;
  }

  /** Escape a value for safe shell embedding */
  private shellEscape(value: string): string {
    // If value contains no special chars, return as-is
    if (/^[a-zA-Z0-9_.=/-]+$/.test(value)) return value;
    // Otherwise, single-quote it (escaping any existing single quotes)
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
}
