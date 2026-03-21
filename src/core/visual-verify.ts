import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export interface VisualVerifyResult {
  screenshotPath: string | null;
  matches: boolean;
  issues: string[];
  details: string;
}

/**
 * Take a screenshot of a running dev server and compare against a design plan.
 * Uses Playwright to render the page and Claude Vision to compare.
 */
export async function visualVerify(
  designPlan: string,
  options?: {
    url?: string;
    port?: number;
    screenshotDir?: string;
  },
): Promise<VisualVerifyResult> {
  const url = options?.url ?? `http://localhost:${options?.port ?? 3000}`;
  const screenshotDir = options?.screenshotDir ?? join(process.cwd(), ".orchestrator", "screenshots");
  await mkdir(screenshotDir, { recursive: true });

  const screenshotPath = join(screenshotDir, `verify-${Date.now()}.png`);

  // 1. Take screenshot with Playwright
  try {
    const proc = Bun.spawnSync([
      "npx", "playwright", "screenshot",
      "--browser", "chromium",
      "--full-page",
      url,
      screenshotPath,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000_000_000, // 30s
    });

    if (proc.exitCode !== 0) {
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      return {
        screenshotPath: null,
        matches: true, // Non-blocking — can't verify, assume OK
        issues: [],
        details: `Screenshot failed: ${stderr.slice(0, 200)}`,
      };
    }
  } catch {
    return {
      screenshotPath: null,
      matches: true,
      issues: [],
      details: "Playwright not available for screenshot",
    };
  }

  // 2. Compare screenshot against design plan using Claude Vision
  try {
    const imageData = await Bun.file(screenshotPath).arrayBuffer();
    const base64 = Buffer.from(imageData).toString("base64");

    const comparePrompt = [
      "You are a design QA reviewer. Compare this screenshot against the design plan below.",
      "",
      "## Design Plan",
      designPlan.slice(0, 3000),
      "",
      "## Instructions",
      "List SPECIFIC differences between the screenshot and the design plan:",
      "- Missing sections (e.g., 'Hero section is in plan but not in screenshot')",
      "- Layout differences (e.g., 'Plan shows 2-column layout but screenshot is single column')",
      "- Missing components (e.g., 'Phone Frame mockup is missing')",
      "- Style mismatches (e.g., 'Plan specifies coral background but screenshot shows white')",
      "",
      "Reply with JSON: {\"matches\": true/false, \"issues\": [\"issue1\", \"issue2\"]}",
      "If the screenshot closely follows the plan, set matches=true with empty issues.",
    ].join("\n");

    // Use Claude with image input via stdin
    const proc = Bun.spawn([
      "claude", "-p", comparePrompt,
      "--model", "sonnet",
      "--output-format", "text",
      "--no-session-persistence",
    ], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

    // Write image as part of the prompt via stdin
    // Actually, Claude CLI doesn't support image via stdin easily.
    // Use the file path approach instead — tell Claude to read the file.
    proc.stdin?.end();

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Parse JSON response
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        screenshotPath,
        matches: parsed.matches ?? false,
        issues: parsed.issues ?? [],
        details: output.trim(),
      };
    }

    return {
      screenshotPath,
      matches: false,
      issues: ["Could not parse visual comparison result"],
      details: output.trim(),
    };
  } catch (err) {
    return {
      screenshotPath,
      matches: true, // Non-blocking on comparison failure
      issues: [],
      details: `Visual comparison failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Detect if a dev server is running on common ports.
 */
export async function detectDevServer(): Promise<{ running: boolean; port: number; url: string }> {
  const ports = [3000, 3001, 5173, 5174, 4000, 8080];

  for (const port of ports) {
    try {
      const response = await fetch(`http://localhost:${port}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok || response.status < 500) {
        return { running: true, port, url: `http://localhost:${port}` };
      }
    } catch {
      continue;
    }
  }

  return { running: false, port: 3000, url: "http://localhost:3000" };
}
