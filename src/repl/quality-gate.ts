import type { CritiqueResult } from "../config/types.ts";
import { parseCritiqueResponse } from "../core/critique.ts";

const QG_TIMEOUT_MS = 15_000;
const QG_MODELS = ["haiku", "sonnet", "haiku", "sonnet"] as const;
let qgRound = 0;

function nextModel(): string {
  const model = QG_MODELS[qgRound % QG_MODELS.length];
  qgRound++;
  return model;
}

function isConversationalRole(role: string): boolean {
  const lower = role.toLowerCase();
  return lower.includes("conversational") || lower.includes("assistant") || lower === "conversation";
}

function isDesignRole(role: string): boolean {
  return role.toLowerCase().includes("design");
}

function runHeuristicChecks(
  context: { agentRole: string; prompt: string; toolUseCount?: number },
  result: string,
): CritiqueResult {
  const issues: string[] = [];
  const improvements: string[] = [];

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

  if (isDesignRole(context.agentRole) && result.length > 200) {
    if (!/This UI follows|Reference:|레퍼런스:|참고:/i.test(result)) {
      issues.push("Design output missing reference declaration");
      improvements.push("Declare reference products before generating UI (PRIORITY 0 protocol)");
    }
    const gradientCount = (result.match(/linear-gradient|radial-gradient|bg-gradient/g) || []).length;
    if (gradientCount > 1) {
      issues.push(`Gradient abuse: ${gradientCount} gradients detected`);
      improvements.push("Real SaaS products use flat solid colors, not gradients");
    }
    const colorBadges = new Set((result.match(/bg-(red|green|blue|yellow|purple|pink|indigo|teal|orange|amber|violet|rose|emerald|cyan|fuchsia|lime)-\d+/g) || []));
    if (colorBadges.size > 3) {
      issues.push(`Rainbow syndrome: ${colorBadges.size} distinct badge colors`);
      improvements.push("Use gray as default badge color. Max 3 colors: gray + red (danger) + green (success)");
    }
    if (/backdrop-blur-(?:lg|xl|2xl|3xl)|glass|glassmorphism/i.test(result)) {
      issues.push("Glassmorphism detected");
      improvements.push("Production SaaS uses solid backgrounds with subtle borders, not glass effects");
    }
    if (/rounded-(?:2xl|3xl|full)|border-radius:\s*(?:1[6-9]|[2-9]\d|\d{3,})px/i.test(result)) {
      issues.push("Oversized border-radius detected");
      improvements.push("Max radius: 8-12px for cards, 6px for inputs. Never rounded-2xl on containers");
    }
    if (/hover:.*scale|transform.*scale\(1\.[0-9]/i.test(result)) {
      issues.push("scale() hover effect detected");
      improvements.push("Use bg-color shift only for hover. Never scale() on cards");
    }
    if (/shadow-(?:lg|xl|2xl)|box-shadow:\s*0\s+\d{2,}/i.test(result)) {
      issues.push("Heavy shadows detected");
      improvements.push("Use border instead of shadows. Real products use border-gray-200, not shadow-lg");
    }
    const svgCount = (result.match(/<svg[\s>]/gi) || []).length;
    if (svgCount > 2) {
      issues.push(`Hand-written SVG icons: ${svgCount} found`);
      improvements.push("Use lucide-react for icons, never hand-write SVG");
    }
  }

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

export async function runQualityGate(
  context: { agentRole: string; prompt: string; toolUseCount?: number },
  result: string,
): Promise<CritiqueResult> {
  const heuristic = runHeuristicChecks(context, result);
  if (!heuristic.passes) return heuristic;

  try {
    return await runLLMEvaluation(context, result);
  } catch {
    return heuristic;
  }
}

async function runLLMEvaluation(
  context: { agentRole: string; prompt: string },
  result: string,
): Promise<CritiqueResult> {
  const truncated = result.length > 8000 ? `${result.slice(0, 8000)}\n...[truncated]` : result;
  const prompt = buildQualityPrompt(context.agentRole, context.prompt, truncated);
  const model = nextModel();

  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--model", model, "--output-format", "text", "--max-turns", "1"],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error("quality gate timeout"));
    }, QG_TIMEOUT_MS),
  );

  const stdout = await Promise.race([new Response(proc.stdout).text(), timeout]);
  await proc.exited;
  return parseCritiqueResponse(stdout);
}

function buildQualityPrompt(agentRole: string, task: string, result: string): string {
  const designRules = isDesignRole(agentRole) ? `
4. DESIGN RULES — Check for these specific violations:
   - Missing reference declaration (must cite a real product as reference before generating UI)
   - Gradient abuse (linear-gradient, radial-gradient, bg-gradient — real SaaS uses flat solid colors)
   - Rainbow badge syndrome (4+ distinct bg-color utilities — max 3: gray + red + green)
   - Glassmorphism / backdrop-blur (production SaaS uses solid backgrounds with subtle borders)
   - Oversized border-radius (rounded-2xl, rounded-3xl, rounded-full on containers)
   - scale() hover effects (use bg-color shift only, never scale() on cards)
   - Heavy shadows (shadow-lg, shadow-xl — use border-gray-200 instead)
   - Hand-written SVG icons (must use lucide-react, never hand-write <svg>/<path>)` : "";

  return `You are a code quality reviewer. Evaluate if the agent completed the task correctly.

Task given to "${agentRole}" agent:
${task}

Agent's output (may include tool usage and text):
${result}

Evaluate:
1. COMPLETION — Did the agent actually complete the requested task, or just describe/plan it?
2. CORRECTNESS — If code was written, is it likely correct? Any obvious bugs or logic errors?
3. RELEVANCE — Does the output match what was asked? Did the agent go off-track?${designRules}

Respond in JSON only:
{"passes":true/false,"issues":["..."],"improvements":["..."],"confidence":"low"|"medium"|"high"}`;
}
