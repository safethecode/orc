/**
 * Two-stage LLM review gate.
 *
 * Stage 1 — Spec Compliance: "Did the output satisfy the original requirements?"
 * Stage 2 — Code Quality:    "Is the code quality acceptable?"
 *
 * Each stage runs a single Haiku call (fast + cheap ~$0.001).
 */

export interface ReviewResult {
  stage: "spec" | "quality";
  passed: boolean;
  issues: string[];
  summary: string;
}

export interface ReviewGateConfig {
  enabled: boolean;
  maxFixAttempts?: number;  // default 1
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseReviewJSON(raw: string): { passed: boolean; issues: string[]; summary: string } {
  // Try to extract JSON from the response (may be wrapped in markdown fences)
  const jsonMatch = raw.match(/\{[\s\S]*"passed"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      return {
        passed: Boolean(obj.passed),
        issues: Array.isArray(obj.issues) ? obj.issues.map(String) : [],
        summary: String(obj.summary ?? ""),
      };
    } catch { /* fall through */ }
  }

  // Fallback: look for explicit pass/fail keywords
  const lower = raw.toLowerCase();
  if (lower.includes("[pass]") || lower.includes("passed")) {
    return { passed: true, issues: [], summary: raw.slice(0, 200) };
  }
  return { passed: false, issues: ["Could not parse review output"], summary: raw.slice(0, 200) };
}

async function runHaiku(prompt: string): Promise<string> {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--model", "haiku", "--output-format", "text", "--dangerously-skip-permissions"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim();
}

// ── Stage 1: Spec Compliance ─────────────────────────────────────────

export async function reviewSpec(taskPrompt: string, result: string): Promise<ReviewResult> {
  const prompt = `You are a spec compliance reviewer. Check if the agent's output satisfies the original task requirements.

## Original Task
${taskPrompt.slice(0, 2000)}

## Agent Output
${result.slice(0, 4000)}

Respond with ONLY a JSON object (no markdown fences):
{"passed": true/false, "issues": ["list of unmet requirements"], "summary": "one-sentence verdict"}`;

  const raw = await runHaiku(prompt);
  const parsed = parseReviewJSON(raw);
  return { stage: "spec", ...parsed };
}

// ── Stage 2: Code Quality ────────────────────────────────────────────

export async function reviewQuality(result: string): Promise<ReviewResult> {
  const prompt = `You are a code quality reviewer. Check the following agent output for quality issues.

Check for: TODO/FIXME markers, error traces, incomplete implementations, security issues, missing error handling.

## Agent Output
${result.slice(0, 4000)}

Respond with ONLY a JSON object (no markdown fences):
{"passed": true/false, "issues": ["list of quality issues"], "summary": "one-sentence verdict"}`;

  const raw = await runHaiku(prompt);
  const parsed = parseReviewJSON(raw);
  return { stage: "quality", ...parsed };
}
