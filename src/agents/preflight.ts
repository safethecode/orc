import { $ } from "bun";

export interface PreflightResult {
  passed: boolean;
  checks: Array<{
    tool: string;
    available: boolean;
    version?: string;
    error?: string;
  }>;
}

export async function checkRequirements(
  requires: string[],
): Promise<PreflightResult> {
  const checks: PreflightResult["checks"] = [];

  for (const tool of requires) {
    try {
      const which = await $`which ${tool}`.quiet();
      if (which.exitCode !== 0) {
        checks.push({ tool, available: false, error: "not found in PATH" });
        continue;
      }

      let version: string | undefined;
      try {
        const ver = await $`${tool} --version`.quiet();
        if (ver.exitCode === 0) {
          version = ver.text().trim().split("\n")[0];
        }
      } catch {
        // --version not supported; tool is still available
      }

      checks.push({ tool, available: true, version });
    } catch {
      checks.push({ tool, available: false, error: "not found in PATH" });
    }
  }

  return {
    passed: checks.every((c) => c.available),
    checks,
  };
}

export function formatPreflightReport(result: PreflightResult): string {
  const lines = ["Preflight Check Results", "======================", ""];

  for (const check of result.checks) {
    const status = check.available ? "PASS" : "FAIL";
    let line = `[${status}] ${check.tool}`;
    if (check.version) {
      line += ` (${check.version})`;
    }
    if (check.error) {
      line += ` - ${check.error}`;
    }
    lines.push(line);
  }

  lines.push("");
  lines.push(result.passed ? "All checks passed." : "Some checks failed.");

  return lines.join("\n");
}
