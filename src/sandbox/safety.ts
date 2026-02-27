export type SafetyLevel = "safe" | "prompt" | "forbidden";

const SAFE_COMMANDS: string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "echo",
  "pwd",
  "whoami",
  "date",
  "wc",
  "which",
  "env",
  "printenv",
  "file",
  "stat",
  "du",
  "df",
  "free",
  "uname",
  "hostname",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git remote",
  "git stash list",
  "node --version",
  "bun --version",
  "npm --version",
  "python --version",
  "tsc --version",
  "cargo --version",
  "rustc --version",
  "go version",
];

const DANGEROUS_PATTERNS: RegExp[] = [
  // Destructive file operations
  /\brm\s+(-\w*r|-\w*f)\b/,
  /\brmdir\b/,
  /\bchmod\s+777\b/,
  /\bchmod\s+(-\w*R)\b/,
  /\bchown\s+(-\w*R)\b/,

  // Pipe-to-shell (exfiltration / RCE)
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/,

  // Low-level disk operations
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bfdisk\b/,

  // Dangerous git operations
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+(-\w*f)\b/,

  // SQL destructive statements
  /\bDROP\s+TABLE\b/i,
  /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i,

  // Process killing
  /\bkill\s+-9\b/,
  /\bkillall\b/,
  /\bpkill\b/,

  // Writing to sensitive paths
  />\s*\/etc\/passwd/,
  />\s*\/etc\/shadow/,
  />\s*~?\/?\.ssh\//,
];

export function classifyCommand(command: string): SafetyLevel {
  const trimmed = command.trim();

  // Check exact safe commands (match from start)
  for (const safe of SAFE_COMMANDS) {
    if (trimmed === safe || trimmed.startsWith(safe + " ")) {
      return "safe";
    }
  }

  // Check dangerous patterns against the full command
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "forbidden";
    }
  }

  return "prompt";
}
