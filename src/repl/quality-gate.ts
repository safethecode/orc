import type { CritiqueResult } from "../config/types.ts";

function isConversationalRole(role: string): boolean {
  const lower = role.toLowerCase();
  return lower.includes("conversational") || lower.includes("assistant") || lower === "conversation";
}

export function runQualityGate(
  context: { agentRole: string; prompt: string; toolUseCount?: number },
  result: string,
): CritiqueResult {
  const issues: string[] = [];
  const improvements: string[] = [];

  // Heuristic checks (fast, no LLM call)
  // Skip length check for conversational agents (Sam etc.) — short replies are normal
  if (!isConversationalRole(context.agentRole) && result.length < 30) {
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

  // Intent without action: text declares action but zero tools were used
  if (!isConversationalRole(context.agentRole) && (context.toolUseCount ?? -1) === 0) {
    const ACTION_INTENT = /겠습니다|할게요|하겠|시작합니다|진행하겠|진행합니다|let\s+me|i['']ll\s|i\s+will\s|i['']m\s+going\s+to/i;
    if (ACTION_INTENT.test(result)) {
      issues.push("Intent without action: declared actions but used zero tools");
      improvements.push("Use tools to execute actions instead of just describing them");
    }
  }

  const passed = issues.length === 0;

  return {
    passes: passed,
    issues,
    improvements,
    confidence: passed ? "high" : issues.length > 2 ? "low" : "medium",
  };
}
