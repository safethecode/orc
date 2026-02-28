// ── Custom Commands: User-Definable Slash Commands ───────────────────
// Loads command definitions from project and user config directories,
// supports template expansion with $1/$2 placeholders, @file refs, and !`cmd` shell execution.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";

export interface CommandDefinition {
  name: string;
  description: string;
  template: string;        // prompt template with $1, $2 placeholders
  agent?: string;          // override agent
  model?: string;          // override model
  maxTurns?: number;
}

/**
 * Simple YAML-like key-value parser for command definition files.
 * Supports top-level scalar keys only (no nesting, no arrays).
 * Strings can be quoted or unquoted; multiline values use | or > are not supported.
 */
function parseSimpleYaml(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function isCommandDefinition(obj: unknown): obj is CommandDefinition {
  if (obj === null || typeof obj !== "object") return false;
  const c = obj as Record<string, unknown>;
  return (
    typeof c.name === "string" &&
    typeof c.description === "string" &&
    typeof c.template === "string"
  );
}

function parseCommandFile(raw: Record<string, string>): CommandDefinition | null {
  if (!raw.name || !raw.description || !raw.template) return null;

  const def: CommandDefinition = {
    name: raw.name,
    description: raw.description,
    template: raw.template,
  };

  if (raw.agent) def.agent = raw.agent;
  if (raw.model) def.model = raw.model;
  if (raw.maxTurns) {
    const n = parseInt(raw.maxTurns, 10);
    if (!isNaN(n) && n > 0) def.maxTurns = n;
  }

  return def;
}

/**
 * Execute a shell command and return its stdout.
 * Used for !`cmd` template expansion.
 */
async function execCapture(cmd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["sh", "-c", cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim();
  } catch {
    return "";
  }
}

export class CustomCommandLoader {
  private commands: Map<string, CommandDefinition> = new Map();
  private searchPaths: string[];

  constructor(projectDir: string) {
    this.searchPaths = [
      join(projectDir, ".orchestrator", "commands"),
      join(process.env.HOME ?? "", ".orchestrator", "commands"),
    ];
  }

  /** Load all command definitions from search paths */
  async loadAll(): Promise<number> {
    this.commands.clear();

    for (const searchPath of this.searchPaths) {
      if (!existsSync(searchPath)) continue;

      let entries: string[];
      try {
        entries = await readdir(searchPath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith(".json") && !entry.endsWith(".yaml") && !entry.endsWith(".yml")) {
          continue;
        }

        const filePath = join(searchPath, entry);
        await this.loadFile(filePath);
      }
    }

    return this.commands.size;
  }

  private async loadFile(filePath: string): Promise<void> {
    try {
      const file = Bun.file(filePath);
      const text = await file.text();

      let def: CommandDefinition | null = null;

      if (filePath.endsWith(".json")) {
        const parsed = JSON.parse(text) as unknown;
        if (isCommandDefinition(parsed)) {
          def = parsed;
        }
      } else {
        // YAML-like parsing
        const raw = parseSimpleYaml(text);
        def = parseCommandFile(raw);
      }

      if (def) {
        this.commands.set(def.name, def);
      }
    } catch {
      // Skip malformed files
    }
  }

  /** Get a command by name */
  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  /** List all commands */
  list(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  /** Execute a command: expand template with args */
  expand(name: string, args: string[]): string | null {
    const cmd = this.commands.get(name);
    if (!cmd) return null;

    let result = cmd.template;

    // Replace $1, $2, ... with corresponding args
    for (let i = 0; i < args.length; i++) {
      const placeholder = `$${i + 1}`;
      result = result.replaceAll(placeholder, args[i]);
    }

    // Remove unreplaced positional placeholders ($3, $4, etc.)
    result = result.replace(/\$\d+/g, "");

    return result.trim();
  }

  /**
   * Expand template with async operations: !`cmd` shell execution.
   * @file references are left for the file-ref resolver.
   */
  async expandAsync(name: string, args: string[]): Promise<string | null> {
    let result = this.expand(name, args);
    if (result === null) return null;

    // Replace !`cmd` with shell execution result
    const shellPattern = /!`([^`]+)`/g;
    const matches = [...result.matchAll(shellPattern)];

    for (const match of matches) {
      const fullMatch = match[0];
      const shellCmd = match[1];
      const output = await execCapture(shellCmd);
      result = result!.replace(fullMatch, output);
    }

    return result;
  }

  /** Check if a string matches a custom command */
  isCustomCommand(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return false;

    // Extract the command name (first word after /)
    const spaceIdx = trimmed.indexOf(" ");
    const name = spaceIdx === -1
      ? trimmed.slice(1)
      : trimmed.slice(1, spaceIdx);

    return this.commands.has(name);
  }

  /** Parse input into command name and args */
  parse(input: string): { name: string; args: string[] } | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;

    const parts = trimmed.slice(1).split(/\s+/);
    const name = parts[0];
    if (!this.commands.has(name)) return null;

    return { name, args: parts.slice(1) };
  }

  /** Reload commands (for hot-reload) */
  async reload(): Promise<number> {
    return this.loadAll();
  }

  /** Format command list for help display */
  formatHelp(): string {
    const cmds = this.list();
    if (cmds.length === 0) return "No custom commands loaded.";

    const lines: string[] = ["Custom Commands:"];

    for (const cmd of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
      let line = `  /${cmd.name} — ${cmd.description}`;
      const extras: string[] = [];
      if (cmd.agent) extras.push(`agent: ${cmd.agent}`);
      if (cmd.model) extras.push(`model: ${cmd.model}`);
      if (cmd.maxTurns) extras.push(`maxTurns: ${cmd.maxTurns}`);
      if (extras.length > 0) {
        line += ` (${extras.join(", ")})`;
      }
      lines.push(line);
    }

    return lines.join("\n");
  }
}
