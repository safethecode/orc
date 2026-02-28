// ── Doctor: System Diagnostics ────────────────────────────────────────
// Comprehensive health check for the orchestrator environment

import { stat } from "node:fs/promises";
import { homedir } from "node:os";

export interface DiagnosticResult {
  check: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  durationMs: number;
}

const TIMEOUT_MS = 5_000;

export class DoctorDiagnostics {
  constructor() {}

  /** Run all diagnostic checks in parallel */
  async runAll(): Promise<DiagnosticResult[]> {
    const checks = await Promise.all([
      this.checkBunVersion(),
      this.checkGitAvailable(),
      this.checkProviderKeys(),
      this.checkClaudeCli(),
      this.checkDiskSpace(),
      this.checkLspAvailable(),
      this.checkMcpServers(),
      this.checkAstGrep(),
      this.checkGhCli(),
      this.checkConfigFile(),
    ]);

    return checks;
  }

  /** Check Bun runtime version (>= 1.0 required) */
  async checkBunVersion(): Promise<DiagnosticResult> {
    const start = performance.now();

    try {
      const output = await this.exec("bun", ["--version"]);
      const version = output.trim();
      const durationMs = Math.round(performance.now() - start);

      // Parse major version
      const match = version.match(/^(\d+)\./);
      if (!match) {
        return { check: "Bun", status: "warn", detail: `Unknown version format: ${version}`, durationMs };
      }

      const major = parseInt(match[1], 10);
      if (major >= 1) {
        return { check: "Bun", status: "pass", detail: `v${version}`, durationMs };
      }

      return { check: "Bun", status: "fail", detail: `v${version} (requires >= 1.0)`, durationMs };
    } catch (err) {
      return {
        check: "Bun",
        status: "fail",
        detail: `Not found: ${this.errorMessage(err)}`,
        durationMs: Math.round(performance.now() - start),
      };
    }
  }

  /** Check git availability */
  async checkGitAvailable(): Promise<DiagnosticResult> {
    const start = performance.now();

    try {
      const output = await this.exec("git", ["--version"]);
      const version = output.trim();
      return {
        check: "Git",
        status: "pass",
        detail: version,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err) {
      return {
        check: "Git",
        status: "fail",
        detail: `Not found: ${this.errorMessage(err)}`,
        durationMs: Math.round(performance.now() - start),
      };
    }
  }

  /** Check provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) */
  async checkProviderKeys(): Promise<DiagnosticResult> {
    const start = performance.now();

    const keys = [
      { name: "ANTHROPIC_API_KEY", value: process.env.ANTHROPIC_API_KEY },
      { name: "OPENAI_API_KEY", value: process.env.OPENAI_API_KEY },
      { name: "GEMINI_API_KEY", value: process.env.GEMINI_API_KEY },
    ];

    const present = keys.filter((k) => k.value && k.value.length > 0);
    const missing = keys.filter((k) => !k.value || k.value.length === 0);
    const durationMs = Math.round(performance.now() - start);

    if (present.length === 0) {
      return {
        check: "Provider Keys",
        status: "warn",
        detail: `No API keys set (${keys.map((k) => k.name).join(", ")})`,
        durationMs,
      };
    }

    const presentNames = present.map((k) => k.name).join(", ");
    const missingNames = missing.map((k) => k.name).join(", ");

    if (missing.length > 0) {
      return {
        check: "Provider Keys",
        status: "pass",
        detail: `Set: ${presentNames} | Missing: ${missingNames}`,
        durationMs,
      };
    }

    return {
      check: "Provider Keys",
      status: "pass",
      detail: `All set: ${presentNames}`,
      durationMs,
    };
  }

  /** Check Claude CLI availability */
  async checkClaudeCli(): Promise<DiagnosticResult> {
    const start = performance.now();

    try {
      const output = await this.exec("claude", ["--version"]);
      const version = output.trim().split("\n")[0];
      return {
        check: "Claude CLI",
        status: "pass",
        detail: version,
        durationMs: Math.round(performance.now() - start),
      };
    } catch {
      // Fallback: try which
      try {
        const whichOutput = await this.exec("which", ["claude"]);
        return {
          check: "Claude CLI",
          status: "pass",
          detail: `Found at ${whichOutput.trim()}`,
          durationMs: Math.round(performance.now() - start),
        };
      } catch {
        return {
          check: "Claude CLI",
          status: "fail",
          detail: "claude CLI not found",
          durationMs: Math.round(performance.now() - start),
        };
      }
    }
  }

  /** Check ~/.orchestrator/ directory and available disk space */
  async checkDiskSpace(): Promise<DiagnosticResult> {
    const start = performance.now();
    const orchDir = `${homedir()}/.orchestrator`;

    try {
      const dirStat = await stat(orchDir);
      if (!dirStat.isDirectory()) {
        return {
          check: "Disk/Config Dir",
          status: "warn",
          detail: `${orchDir} exists but is not a directory`,
          durationMs: Math.round(performance.now() - start),
        };
      }

      // Try to get free disk space via df
      try {
        const dfOutput = await this.exec("df", ["-h", orchDir]);
        const lines = dfOutput.trim().split("\n");
        if (lines.length >= 2) {
          // Parse df output: Filesystem Size Used Avail Use% Mounted
          const parts = lines[1].split(/\s+/);
          const available = parts[3] ?? "unknown";
          const usePercent = parts[4] ?? "unknown";

          // Warn if usage is over 90%
          const percentNum = parseInt(usePercent.replace("%", ""), 10);
          const status = percentNum >= 90 ? "warn" : "pass";

          return {
            check: "Disk/Config Dir",
            status,
            detail: `${orchDir} exists | ${available} free (${usePercent} used)`,
            durationMs: Math.round(performance.now() - start),
          };
        }
      } catch {
        // df failed; just report the dir exists
      }

      return {
        check: "Disk/Config Dir",
        status: "pass",
        detail: `${orchDir} exists`,
        durationMs: Math.round(performance.now() - start),
      };
    } catch {
      return {
        check: "Disk/Config Dir",
        status: "warn",
        detail: `${orchDir} does not exist (will be created on first run)`,
        durationMs: Math.round(performance.now() - start),
      };
    }
  }

  /** Check if common LSP servers are installed */
  async checkLspAvailable(): Promise<DiagnosticResult> {
    const start = performance.now();

    const servers = [
      { name: "typescript-language-server", bin: "typescript-language-server" },
      { name: "vscode-langservers", bin: "vscode-json-language-server" },
      { name: "biome", bin: "biome" },
    ];

    const found: string[] = [];
    const missing: string[] = [];

    for (const server of servers) {
      try {
        await this.exec("which", [server.bin]);
        found.push(server.name);
      } catch {
        missing.push(server.name);
      }
    }

    const durationMs = Math.round(performance.now() - start);

    if (found.length === 0) {
      return {
        check: "LSP Servers",
        status: "warn",
        detail: `None found (checked: ${servers.map((s) => s.bin).join(", ")})`,
        durationMs,
      };
    }

    return {
      check: "LSP Servers",
      status: "pass",
      detail: `Found: ${found.join(", ")}${missing.length > 0 ? ` | Missing: ${missing.join(", ")}` : ""}`,
      durationMs,
    };
  }

  /** Check if any MCP server configuration exists */
  async checkMcpServers(): Promise<DiagnosticResult> {
    const start = performance.now();

    const locations = [
      `${homedir()}/.orchestrator/mcp.json`,
      `${homedir()}/.orchestrator/mcp-servers.json`,
      "./.orchestrator/mcp.json",
      "./mcp.json",
    ];

    const found: string[] = [];

    for (const path of locations) {
      try {
        const file = Bun.file(path);
        if (await file.exists()) {
          found.push(path);
        }
      } catch {
        // Not accessible
      }
    }

    const durationMs = Math.round(performance.now() - start);

    if (found.length === 0) {
      return {
        check: "MCP Config",
        status: "warn",
        detail: "No MCP server configuration found",
        durationMs,
      };
    }

    return {
      check: "MCP Config",
      status: "pass",
      detail: `Found: ${found.join(", ")}`,
      durationMs,
    };
  }

  /** Check if ast-grep (sg) is installed */
  async checkAstGrep(): Promise<DiagnosticResult> {
    const start = performance.now();

    try {
      const output = await this.exec("sg", ["--version"]);
      const version = output.trim().split("\n")[0];
      return {
        check: "ast-grep (sg)",
        status: "pass",
        detail: version,
        durationMs: Math.round(performance.now() - start),
      };
    } catch {
      return {
        check: "ast-grep (sg)",
        status: "warn",
        detail: "sg not installed (optional: enables AST-based code search)",
        durationMs: Math.round(performance.now() - start),
      };
    }
  }

  /** Check GitHub CLI availability */
  async checkGhCli(): Promise<DiagnosticResult> {
    const start = performance.now();

    try {
      const output = await this.exec("gh", ["--version"]);
      const version = output.trim().split("\n")[0];
      return {
        check: "GitHub CLI (gh)",
        status: "pass",
        detail: version,
        durationMs: Math.round(performance.now() - start),
      };
    } catch {
      return {
        check: "GitHub CLI (gh)",
        status: "warn",
        detail: "gh not installed (optional: enables GitHub integration)",
        durationMs: Math.round(performance.now() - start),
      };
    }
  }

  /** Check if orchestrator config file exists */
  async checkConfigFile(): Promise<DiagnosticResult> {
    const start = performance.now();

    const locations = [
      { path: `${homedir()}/.orchestrator/config.json`, label: "global" },
      { path: "./orchestrator.json", label: "project" },
      { path: "./.orchestrator/config.json", label: "project (.orchestrator/)" },
    ];

    const found: string[] = [];

    for (const loc of locations) {
      try {
        const file = Bun.file(loc.path);
        if (await file.exists()) {
          found.push(`${loc.label}: ${loc.path}`);
        }
      } catch {
        // Not accessible
      }
    }

    const durationMs = Math.round(performance.now() - start);

    if (found.length === 0) {
      return {
        check: "Config File",
        status: "warn",
        detail: "No config file found (using defaults)",
        durationMs,
      };
    }

    return {
      check: "Config File",
      status: "pass",
      detail: found.join("; "),
      durationMs,
    };
  }

  /** Format results for terminal display */
  formatResults(results: DiagnosticResult[]): string {
    const lines: string[] = [];

    const maxCheckLen = Math.max(...results.map((r) => r.check.length));

    for (const r of results) {
      const icon = r.status === "pass" ? "\u2713" : r.status === "warn" ? "\u26A0" : "\u2717";
      const paddedCheck = r.check.padEnd(maxCheckLen);
      lines.push(`  ${icon} ${paddedCheck}  ${r.detail} (${r.durationMs}ms)`);
    }

    const passed = results.filter((r) => r.status === "pass").length;
    const warned = results.filter((r) => r.status === "warn").length;
    const failed = results.filter((r) => r.status === "fail").length;

    lines.push("");
    lines.push(`  ${passed} passed, ${warned} warnings, ${failed} failed`);

    return lines.join("\n");
  }

  /** Format results as JSON */
  formatJson(results: DiagnosticResult[]): string {
    return JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        results,
        summary: {
          total: results.length,
          passed: results.filter((r) => r.status === "pass").length,
          warnings: results.filter((r) => r.status === "warn").length,
          failed: results.filter((r) => r.status === "fail").length,
        },
      },
      null,
      2,
    );
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  /** Execute a command with timeout, returning stdout */
  private async exec(cmd: string, args: string[]): Promise<string> {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const result = await Promise.race([
      (async () => {
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(`${cmd} exited with code ${exitCode}: ${stderr.trim()}`);
        }
        return stdout;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          proc.kill();
          reject(new Error(`${cmd} timed out after ${TIMEOUT_MS}ms`));
        }, TIMEOUT_MS),
      ),
    ]);

    return result;
  }

  /** Extract error message from unknown error */
  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
