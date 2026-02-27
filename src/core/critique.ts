import type { CritiqueResult, CritiqueChecklist } from "../config/types.ts";

export function buildCritiquePrompt(task: { prompt: string; result: string }): string {
  // Build a self-critique prompt that validates task results
  // Checklist: pattern adherence, error handling, completeness, code quality
  // Ask for JSON response with { passes, issues, improvements, confidence }
  return `Review the following task result for quality:

Task: ${task.prompt}

Result:
${task.result}

Evaluate against this checklist:
1. Pattern adherence - Does the code follow established patterns?
2. Error handling - Are errors properly caught and handled?
3. Completeness - Is the implementation complete?
4. Code quality - Is the code clean, readable, and maintainable?

Respond in JSON format:
{
  "passes": boolean,
  "issues": ["list of issues found"],
  "improvements": ["suggested improvements"],
  "confidence": "low" | "medium" | "high"
}`;
}

export function parseCritiqueResponse(response: string): CritiqueResult {
  // Try JSON parse first
  try {
    const trimmed = response.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        passes: Boolean(parsed.passes),
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
        confidence: ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "medium",
      };
    }
  } catch {}

  // Fallback: keyword extraction from text
  const issues: string[] = [];
  const improvements: string[] = [];
  const lines = response.split("\n");
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/\b(issue|problem|missing|bug|error)\b/.test(lower)) {
      issues.push(line.trim());
    }
    if (/\b(improve|suggest|recommend|consider|should)\b/.test(lower)) {
      improvements.push(line.trim());
    }
  }

  return {
    passes: issues.length === 0,
    issues,
    improvements,
    confidence: issues.length === 0 ? "medium" : "low",
  };
}

export function shouldProceed(result: CritiqueResult): boolean {
  return result.confidence === "high" && result.issues.length === 0;
}
