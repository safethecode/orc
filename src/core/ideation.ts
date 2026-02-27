import type { IdeationDimension, Idea, IdeationResult } from "../config/types.ts";

export const DIMENSION_PROMPTS: Record<IdeationDimension, string> = {
  improvements: "Identify functional improvements and missing features that would add value.",
  quality: "Analyze code quality issues: duplication, naming, structure, test coverage gaps.",
  performance: "Find performance bottlenecks: unnecessary computations, N+1 queries, missing caching.",
  security: "Audit for security vulnerabilities: injection, auth issues, data exposure, OWASP top 10.",
  documentation: "Identify missing or outdated documentation, unclear APIs, missing examples.",
  ux: "Analyze user experience: confusing workflows, missing feedback, accessibility issues.",
};

export function buildIdeationPrompt(
  dimension: IdeationDimension,
  codeContext: string,
): string {
  return `Analyze the following codebase from the "${dimension}" perspective:

${DIMENSION_PROMPTS[dimension]}

Code context:
${codeContext}

Return your analysis as JSON:
{
  "ideas": [
    {
      "dimension": "${dimension}",
      "title": "short title",
      "description": "detailed description",
      "priority": "low" | "medium" | "high",
      "effort": "low" | "medium" | "high",
      "files": ["affected/files.ts"]
    }
  ],
  "summary": "brief overall assessment"
}`;
}

export function parseIdeationResponse(response: string): Idea[] {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.ideas)) {
        return parsed.ideas.map((i: Record<string, unknown>) => ({
          dimension: i.dimension as IdeationDimension,
          title: String(i.title ?? ""),
          description: String(i.description ?? ""),
          priority: ["low", "medium", "high"].includes(i.priority as string) ? i.priority : "medium",
          effort: ["low", "medium", "high"].includes(i.effort as string) ? i.effort : "medium",
          files: Array.isArray(i.files) ? i.files : undefined,
        }));
      }
    }
  } catch {}
  return [];
}

export function prioritizeIdeas(ideas: Idea[]): Idea[] {
  const priorityScore = { high: 3, medium: 2, low: 1 };
  const effortScore = { low: 3, medium: 2, high: 1 };

  return [...ideas].sort((a, b) => {
    const scoreA = priorityScore[a.priority] + effortScore[a.effort];
    const scoreB = priorityScore[b.priority] + effortScore[b.effort];
    return scoreB - scoreA;
  });
}
