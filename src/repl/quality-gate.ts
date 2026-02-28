import type { CritiqueResult } from "../config/types.ts";

export function runQualityGate(
  context: { agentRole: string; prompt: string },
  result: string,
): CritiqueResult {
  const issues: string[] = [];
  const improvements: string[] = [];

  // Heuristic checks (fast, no LLM call)
  if (result.length < 50) {
    issues.push("Result is suspiciously short");
  }

  if (/TODO|FIXME|HACK|XXX/i.test(result)) {
    issues.push("Contains TODO/FIXME markers");
    improvements.push("Resolve all TODO/FIXME items before completion");
  }

  if (/error|Error|ERROR/.test(result) && /traceback|stack trace|at .+\(.+:\d+/i.test(result)) {
    issues.push("Result contains error traces");
    improvements.push("Fix errors before reporting completion");
  }

  if (result.includes("I cannot") || result.includes("I'm unable") || result.includes("I don't have")) {
    issues.push("Agent reported inability to complete task");
  }

  const passed = issues.length === 0;

  return {
    passes: passed,
    issues,
    improvements,
    confidence: passed ? "high" : issues.length > 2 ? "low" : "medium",
  };
}
