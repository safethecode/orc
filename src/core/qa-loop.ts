import type { QAConfig, QAIssue, QAResult } from "../config/types.ts";

export const DEFAULT_QA_CONFIG: QAConfig = {
  maxIterations: 3,
  recurringIssueThreshold: 2,
};

export function buildReviewPrompt(task: {
  prompt: string;
  result: string;
  criteria: string[];
}): string {
  const criteriaList = task.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `Review the following task result against acceptance criteria:

Task: ${task.prompt}

Result:
${task.result}

Acceptance Criteria:
${criteriaList}

For each issue found, provide:
- description: what's wrong
- severity: "critical" | "major" | "minor"
- file: affected file (if applicable)
- suggestion: how to fix

Respond in JSON format:
{
  "passed": boolean,
  "issues": [{ "description": "...", "severity": "...", "file": "...", "suggestion": "..." }]
}`;
}

export function buildFixPrompt(issues: QAIssue[]): string {
  const issueList = issues
    .map((i, idx) => {
      let line = `${idx + 1}. [${i.severity}] ${i.description}`;
      if (i.file) line += ` (${i.file})`;
      if (i.suggestion) line += `\n   Suggestion: ${i.suggestion}`;
      return line;
    })
    .join("\n");

  return `Fix the following issues:\n\n${issueList}\n\nApply the fixes and return the corrected implementation.`;
}

function tokenizeDescription(desc: string): Set<string> {
  return new Set(
    desc.toLowerCase().split(/\s+/).filter((t) => t.length > 2),
  );
}

export function detectRecurringIssues(
  history: QAIssue[][],
  threshold: number,
): QAIssue[] {
  if (history.length < 2) return [];

  const recurring: QAIssue[] = [];
  const latest = history[history.length - 1];

  for (const issue of latest) {
    const issueTokens = tokenizeDescription(issue.description);
    let occurrences = 0;

    for (let i = 0; i < history.length - 1; i++) {
      for (const prev of history[i]) {
        const prevTokens = tokenizeDescription(prev.description);
        // Jaccard similarity
        let intersection = 0;
        for (const t of issueTokens) {
          if (prevTokens.has(t)) intersection++;
        }
        const union = issueTokens.size + prevTokens.size - intersection;
        if (union > 0 && intersection / union >= 0.5) {
          occurrences++;
          break;
        }
      }
    }

    if (occurrences >= threshold) {
      recurring.push(issue);
    }
  }

  return recurring;
}

export function shouldEscalate(result: QAResult, config: QAConfig): boolean {
  if (result.iterations >= config.maxIterations) return true;
  if (result.escalated) return true;
  return false;
}
