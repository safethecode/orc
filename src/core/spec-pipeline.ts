import type { SpecPhase, SpecConfig, SpecResult } from "../config/types.ts";

export const PHASE_CONFIGS: Record<string, SpecConfig> = {
  simple: {
    phases: ["discovery", "spec", "planning"],
    skipResearch: true,
  },
  standard: {
    phases: ["discovery", "requirements", "spec", "critique", "planning"],
  },
  complex: {
    phases: ["discovery", "requirements", "research", "spec", "critique", "planning", "validation"],
  },
};

export function selectPhases(complexity: string): SpecPhase[] {
  const config = PHASE_CONFIGS[complexity] ?? PHASE_CONFIGS.standard;
  return config.phases;
}

export function buildPhasePrompt(
  phase: SpecPhase,
  context: { task: string; previousOutputs: Map<SpecPhase, string> },
): string {
  const prev = [...context.previousOutputs.entries()]
    .map(([p, out]) => `## ${p} phase output:\n${out}`)
    .join("\n\n");

  const preamble = prev ? `Previous phase outputs:\n${prev}\n\n` : "";

  switch (phase) {
    case "discovery":
      return `${preamble}Analyze this task and identify key requirements, constraints, and unknowns:\n\nTask: ${context.task}`;

    case "requirements":
      return `${preamble}Based on the discovery, create a detailed list of requirements:\n\nTask: ${context.task}\n\nFormat as:\n- Functional requirements\n- Non-functional requirements\n- Constraints`;

    case "research":
      return `${preamble}Research what existing patterns, libraries, or approaches could be used:\n\nTask: ${context.task}`;

    case "spec":
      return `${preamble}Create a detailed technical specification:\n\nTask: ${context.task}\n\nInclude:\n- Architecture decisions\n- Data structures\n- API contracts\n- Error handling strategy`;

    case "critique":
      return `${preamble}Critically review the specification for gaps, risks, and improvements:\n\nTask: ${context.task}`;

    case "planning":
      return `${preamble}Create an implementation plan with ordered steps:\n\nTask: ${context.task}\n\nFormat as numbered steps with file paths and descriptions.`;

    case "validation":
      return `${preamble}Define validation criteria and test plan:\n\nTask: ${context.task}\n\nInclude:\n- Acceptance criteria\n- Test scenarios\n- Edge cases`;

    default:
      return `${preamble}Process this phase: ${phase}\n\nTask: ${context.task}`;
  }
}

export function parseSpecResult(output: string): SpecResult {
  // Try JSON parse first
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.requirements) return parsed as SpecResult;
    }
  } catch {}

  // Fallback: extract from text
  const requirements: string[] = [];
  const acceptanceCriteria: string[] = [];
  const implementationSteps: string[] = [];
  const risks: string[] = [];

  const lines = output.split("\n");
  let section = "";

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/requirement/i.test(lower)) { section = "req"; continue; }
    if (/acceptance|criteria/i.test(lower)) { section = "ac"; continue; }
    if (/implementation|step|plan/i.test(lower)) { section = "impl"; continue; }
    if (/risk|concern|warning/i.test(lower)) { section = "risk"; continue; }

    const trimmed = line.replace(/^[\s\-*\d.]+/, "").trim();
    if (!trimmed) continue;

    switch (section) {
      case "req": requirements.push(trimmed); break;
      case "ac": acceptanceCriteria.push(trimmed); break;
      case "impl": implementationSteps.push(trimmed); break;
      case "risk": risks.push(trimmed); break;
    }
  }

  const complexity: "simple" | "standard" | "complex" =
    implementationSteps.length > 10 ? "complex" :
    implementationSteps.length > 4 ? "standard" : "simple";

  return { requirements, acceptanceCriteria, implementationSteps, risks, estimatedComplexity: complexity };
}
