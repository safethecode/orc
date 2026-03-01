import { TreeSitterBashParser, type ParsedCommand } from "./tree-sitter-parser.ts";

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

// Shared tree-sitter parser instance
let sharedParser: TreeSitterBashParser | null = null;

export async function initParser(): Promise<boolean> {
  sharedParser = new TreeSitterBashParser();
  return sharedParser.initialize();
}

// AST-based classification using tree-sitter parsed data
function classifyFromAST(parsed: ParsedCommand): SafetyLevel | null {
  const DANGEROUS_COMMANDS = new Set([
    "rm", "rmdir", "mkfs", "fdisk", "dd", "killall", "pkill",
    "shutdown", "reboot", "halt", "poweroff",
  ]);

  const SAFE_COMMAND_NAMES = new Set([
    "ls", "cat", "head", "tail", "echo", "pwd", "whoami", "date",
    "wc", "which", "env", "printenv", "file", "stat", "du", "df",
    "free", "uname", "hostname",
  ]);

  // Check if any command is dangerous
  for (const cmd of [...parsed.commands, ...parsed.subcommands]) {
    if (DANGEROUS_COMMANDS.has(cmd)) return "forbidden";
  }

  // Check for dangerous redirect targets
  const sensitiveTargets = ["/etc/passwd", "/etc/shadow", ".ssh/"];
  for (const redirect of parsed.redirects) {
    if (sensitiveTargets.some(t => redirect.includes(t))) return "forbidden";
  }

  // Check for pipe-to-shell pattern
  if (parsed.pipes) {
    const cmds = parsed.commands;
    const lastCmd = cmds[cmds.length - 1];
    if (["sh", "bash", "zsh", "eval"].includes(lastCmd)) {
      if (cmds.some(c => ["curl", "wget"].includes(c))) return "forbidden";
    }
  }

  // All commands are in safe list
  if (parsed.commands.every(c => SAFE_COMMAND_NAMES.has(c)) &&
      parsed.subcommands.length === 0 &&
      parsed.redirects.length === 0 &&
      !parsed.backgrounded) {
    return "safe";
  }

  return null; // inconclusive, fall through to regex
}

// Enhanced classify function: tries AST first, then falls back to regex
export function classifyCommandEnhanced(command: string): SafetyLevel {
  // Try AST-based classification first
  if (sharedParser?.isReady()) {
    const parsed = sharedParser.parse(command);
    if (parsed) {
      const astResult = classifyFromAST(parsed);
      if (astResult !== null) return astResult;
    }
  }

  // Fall back to regex-based classification
  return classifyCommand(command);
}
