import type { SessionInsights } from "../config/types.ts";

export function buildInsightPrompt(sessionData: {
  turns: string;
  diff?: string;
  taskPrompt: string;
}): string {
  const diffSection = sessionData.diff
    ? `\nGit diff from session:\n${sessionData.diff}\n`
    : "";

  return `Extract insights from this coding session:

Task: ${sessionData.taskPrompt}

Session turns:
${sessionData.turns}
${diffSection}

Analyze and return JSON:
{
  "subtasksCompleted": ["list of completed subtasks"],
  "discoveries": {
    "filesUnderstood": { "path": "purpose" },
    "patternsFound": ["patterns discovered"],
    "gotchasEncountered": ["gotchas and pitfalls found"]
  },
  "whatWorked": ["approaches that worked well"],
  "whatFailed": ["approaches that failed or had issues"],
  "recommendations": ["recommendations for future sessions"]
}`;
}

export function parseInsights(response: string): SessionInsights {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        subtasksCompleted: Array.isArray(parsed.subtasksCompleted) ? parsed.subtasksCompleted : [],
        discoveries: {
          filesUnderstood: typeof parsed.discoveries?.filesUnderstood === "object" ? parsed.discoveries.filesUnderstood : {},
          patternsFound: Array.isArray(parsed.discoveries?.patternsFound) ? parsed.discoveries.patternsFound : [],
          gotchasEncountered: Array.isArray(parsed.discoveries?.gotchasEncountered) ? parsed.discoveries.gotchasEncountered : [],
        },
        whatWorked: Array.isArray(parsed.whatWorked) ? parsed.whatWorked : [],
        whatFailed: Array.isArray(parsed.whatFailed) ? parsed.whatFailed : [],
        recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      };
    }
  } catch {}

  return {
    subtasksCompleted: [],
    discoveries: { filesUnderstood: {}, patternsFound: [], gotchasEncountered: [] },
    whatWorked: [],
    whatFailed: [],
    recommendations: [],
  };
}

export function mergeInsights(existing: SessionInsights, newInsights: SessionInsights): SessionInsights {
  const dedup = (arr: string[]) => [...new Set(arr)];
  return {
    subtasksCompleted: dedup([...existing.subtasksCompleted, ...newInsights.subtasksCompleted]),
    discoveries: {
      filesUnderstood: { ...existing.discoveries.filesUnderstood, ...newInsights.discoveries.filesUnderstood },
      patternsFound: dedup([...existing.discoveries.patternsFound, ...newInsights.discoveries.patternsFound]),
      gotchasEncountered: dedup([...existing.discoveries.gotchasEncountered, ...newInsights.discoveries.gotchasEncountered]),
    },
    whatWorked: dedup([...existing.whatWorked, ...newInsights.whatWorked]),
    whatFailed: dedup([...existing.whatFailed, ...newInsights.whatFailed]),
    recommendations: dedup([...existing.recommendations, ...newInsights.recommendations]),
  };
}

export function formatInsightsForPrompt(insights: SessionInsights): string {
  const sections: string[] = [];

  if (insights.discoveries.patternsFound.length > 0) {
    sections.push(`Patterns: ${insights.discoveries.patternsFound.join(", ")}`);
  }
  if (insights.discoveries.gotchasEncountered.length > 0) {
    sections.push(`Gotchas: ${insights.discoveries.gotchasEncountered.join(", ")}`);
  }
  if (insights.whatWorked.length > 0) {
    sections.push(`What worked: ${insights.whatWorked.join(", ")}`);
  }
  if (insights.recommendations.length > 0) {
    sections.push(`Recommendations: ${insights.recommendations.join(", ")}`);
  }

  return sections.length > 0
    ? `\nPrevious session insights:\n${sections.join("\n")}\n`
    : "";
}
